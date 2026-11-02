import { festAccess } from "@/core/access";
import { scorerSource, type ScorerSource } from "@/core/arena-volunteers";
import { membershipIdFor } from "@/core/models/membership";
import { hasAtLeast } from "@/core/permissions";
import { ApiError, canManageFest, requireFestAccess, type Caller } from "./api";
import { audit } from "./audit";
import { COLLECTIONS, FieldValue, adminDb } from "./firebase-admin";
import { loadFestMemberships, parseMembership } from "./membership-store";
import { compact, docToJson } from "./serialize";

/**
 * The Live Event Engine's one bespoke scoping rule: a volunteer may score a
 * match only at the arena their shift assigns them to.
 *
 * This sits beside `canManageFest`/`inScope` rather than inside the
 * permission matrix, for the same reason fest scoping itself is a side
 * channel on the user document rather than a matrix concept — arena
 * assignment is data (a `Shift`), not a role, and admin+ already bypasses it
 * entirely via the fest-level check every other admin route uses.
 *
 * The rule holds for a volunteer however their authority is held. An event-role
 * volunteer (a membership with the scoring duty) is checked by the membership
 * first - the duty and the match's sub-event - and then by the arena shift, exactly
 * like a fest-scoped one. The shift only ever narrows: it never grants a duty or a
 * sub-event the membership does not already carry.
 */
export const requireArenaAccess = async (caller: Caller, festId: string, arenaId: string | undefined, eventId?: string): Promise<void> => {
  const access = festAccess(caller, festId);

  if (access.kind === "member") {
    // The membership alone decides whether the caller may score this sub-event at all.
    requireFestAccess(caller, festId, eventId);
    // The head, admins and coordinators manage matches and need no shift. A volunteer is rostered to an arena.
    if (access.member.role !== "volunteer") return;
  } else {
    if (hasAtLeast(caller.role, "admin")) {
      requireFestAccess(caller, festId);
      return;
    }
    if (!canManageFest(caller, festId)) throw ApiError.forbidden("You do not manage this fest.");
  }

  if (!arenaId) throw ApiError.forbidden("This match has no arena assigned yet.");
  if (!(await hasScoringShift(festId, caller.uid, arenaId))) throw ApiError.forbidden("You are not assigned to score at this arena.");
};

const hasScoringShift = async (festId: string, userId: string, arenaId: string): Promise<boolean> => {
  const snap = await adminDb()
    .collection(COLLECTIONS.shifts)
    .where("festId", "==", festId)
    .where("userId", "==", userId)
    .where("duty", "==", "scoring")
    .where("post", "==", arenaId)
    .get();
  return snap.docs.some((doc) => doc.data().cancelled !== true);
};

/* ───────────── who may be rostered at an arena ───────────── */

export interface ArenaVolunteer {
  id: string;
  name: string;
  email: string;
  /** How they work this fest: an event role ("event") or the legacy fest-wide scope ("fest"). */
  source: ScorerSource;
}

const toVolunteer = (id: string, profile: Record<string, unknown>, source: ScorerSource): ArenaVolunteer => ({
  id,
  name: String(profile.name ?? profile.fullName ?? profile.email ?? ""),
  email: String(profile.email ?? ""),
  source,
});

/**
 * Everyone the arena picker may offer for a fest: event-role volunteers with the scoring duty, and fest-scoped
 * volunteers. Decided per person by `scorerSource`, the same rule the assignment route enforces.
 */
export const listArenaVolunteers = async (festId: string): Promise<ArenaVolunteer[]> => {
  const db = adminDb();
  const members = await loadFestMemberships(festId);
  const membershipOf = new Map(members.map((member) => [member.userId, member] as const));

  // Event-role volunteers, and the legacy volunteers scoped to this fest. A person can appear in both lists; the
  // membership governs and `scorerSource` says so.
  const legacy = await db.collection(COLLECTIONS.users).where("festIds", "array-contains", festId).get();
  const candidates = new Map<string, Record<string, unknown>>();
  for (const doc of legacy.docs) candidates.set(doc.id, doc.data());

  const memberIds = members.filter((member) => member.status === "active" && member.role === "volunteer").map((member) => member.userId).filter((id) => !candidates.has(id));
  if (memberIds.length > 0) {
    for (const doc of await db.getAll(...memberIds.map((id) => db.collection(COLLECTIONS.users).doc(id)))) if (doc.exists) candidates.set(doc.id, doc.data()!);
  }

  const volunteers: ArenaVolunteer[] = [];
  for (const [id, profile] of candidates) {
    const source = scorerSource(festId, profile, membershipOf.get(id));
    if (source) volunteers.push(toVolunteer(id, profile, source));
  }
  return volunteers.sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
};

/**
 * Rosters one volunteer to score at one arena: a `Shift` with duty "scoring" whose `post` is the arena id. Done here, with
 * the Admin SDK, because the browser cannot do it: it cannot read an event-role volunteer's profile, it cannot tell whether
 * the person may score at all, and a shift written by the client names the volunteer as its creator. Asking twice for the
 * same person and arena is a no-op.
 */
export const assignArenaVolunteer = async (caller: Caller, arenaId: string, userId: string) => {
  const db = adminDb();
  const arenaSnap = await db.collection(COLLECTIONS.arenas).doc(arenaId).get();
  if (!arenaSnap.exists) throw ApiError.notFound("That arena no longer exists.");
  const arena = arenaSnap.data() as { festId: string; name?: string };
  requireFestAccess(caller, arena.festId);

  const [profileSnap, memberSnap] = await Promise.all([
    db.collection(COLLECTIONS.users).doc(userId).get(),
    db.collection(COLLECTIONS.festMembers).doc(membershipIdFor(arena.festId, userId)).get(),
  ]);
  const profile = profileSnap.exists ? (profileSnap.data() as Record<string, unknown>) : undefined;
  const membership = memberSnap.exists ? parseMembership(memberSnap.id, memberSnap.data()) : null;
  if (!profile || !scorerSource(arena.festId, profile, membership)) {
    throw ApiError.unprocessable("That person cannot score at this event. They need the scoring duty on an event role, or a volunteer account on this fest.");
  }

  const existing = await db
    .collection(COLLECTIONS.shifts)
    .where("festId", "==", arena.festId)
    .where("userId", "==", userId)
    .where("duty", "==", "scoring")
    .where("post", "==", arenaId)
    .get();
  const active = existing.docs.find((doc) => doc.data().cancelled !== true);
  if (active) return { shift: docToJson(active), created: false as const };

  const person = toVolunteer(userId, profile, "event");
  const ref = db.collection(COLLECTIONS.shifts).doc();
  await ref.set(
    compact({
      id: ref.id,
      festId: arena.festId,
      userId,
      userName: person.name || person.email,
      userEmail: person.email,
      post: arenaId,
      duty: "scoring",
      date: new Date().toISOString().slice(0, 10),
      startTime: "00:00",
      endTime: "23:59",
      eventIds: [],
      cancelled: false,
      createdBy: caller.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }),
  );

  await audit(caller, {
    action: "shift_created",
    summary: `${person.name || person.email} rostered to score at ${arena.name ?? "an arena"}`,
    festId: arena.festId,
    subjectType: "shift",
    subjectId: ref.id,
    details: { arenaId, userId },
  });

  return { shift: docToJson(await ref.get()), created: true as const };
};
