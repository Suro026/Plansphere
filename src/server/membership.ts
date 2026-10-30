import { festAccess } from "@/core/access";
import {
  FEST_ROLE_LABELS,
  membershipIdFor,
  type AssignMember,
  type FestRole,
  type Membership,
  type UpdateMember,
} from "@/core/models/membership";
import { USER_ROLES, type UserRole } from "@/core/permissions";
import { ApiError, type Caller } from "./api";
import { applyClaims, temporaryPassword } from "./credentials";
import { emailService } from "./email";
import { staffInviteEmail } from "./email/templates";
import { staffInviteLink } from "./auth-links";
import { audit } from "./audit";
import { COLLECTIONS, FieldValue, adminAuth, adminDb } from "./firebase-admin";
import { loadActiveMemberships, parseMembership } from "./membership-store";
import { compact } from "./serialize";

/**
 * Event-level roles: assigning, changing, suspending and revoking the people who work on one main event.
 *
 * Every rule about *who may do this to whom* is here, in one place, so the routes stay thin and the tests can name the
 * rule they are checking:
 *
 *  - The Event Head (and the platform) may assign admins, coordinators and volunteers to any sub-events of the fest.
 *  - An admin may assign volunteers only, and only to sub-events they are assigned to themselves.
 *  - Nobody assigns, changes or revokes their own membership. Nobody can create a head here: there is exactly one per
 *    main event, and it comes from approving the application (or the platform handing the event over).
 *  - A membership is the whole of someone's authority on its fest. Writing one never edits the person's profile role or
 *    their legacy fest list, and it never produces `super_admin`.
 */

const normaliseRole = (value: unknown): UserRole | undefined =>
  value === "organizer" ? "volunteer" : USER_ROLES.includes(value as UserRole) ? (value as UserRole) : undefined;

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? (value as unknown[]).filter((item): item is string => typeof item === "string") : [];

/** How the caller stands towards this fest's people. `null`: not at all. */
export type Manager = "platform" | "head" | "admin" | "legacy-admin";

export const managerOf = (caller: Caller, fest: { ownerId?: unknown }, festId: string): Manager | null => {
  const access = festAccess(caller, festId);
  if (access.kind === "platform") return "platform";
  if (access.kind === "member") {
    if (access.member.role === "head") return "head";
    return access.member.role === "admin" ? "admin" : null;
  }
  if (access.kind === "legacy" && caller.role !== "volunteer") {
    // Before memberships, the account that registered the fest could staff it with admins; everyone else could add volunteers.
    return fest.ownerId === caller.uid ? "head" : "legacy-admin";
  }
  return null;
};

/** The Event Head's powers: every role, every sub-event. */
const isFestWide = (manager: Manager) => manager === "platform" || manager === "head";

const loadFest = async (festId: string) => {
  const snapshot = await adminDb().collection(COLLECTIONS.fests).doc(festId).get();
  if (!snapshot.exists) throw ApiError.notFound("No such event.");
  return { name: String(snapshot.data()?.name ?? "this event"), ownerId: snapshot.data()?.ownerId as string | undefined };
};

/** Every id must be a sub-event of this fest. A competition from another main event is not assignable here. */
const assertEventsBelongToFest = async (festId: string, eventIds: string[]): Promise<void> => {
  const unique = Array.from(new Set(eventIds));
  const refs = unique.map((id) => adminDb().collection(COLLECTIONS.events).doc(id));
  const docs = refs.length > 0 ? await adminDb().getAll(...refs) : [];
  const bad = docs.filter((doc) => !doc.exists || doc.data()?.festId !== festId);
  if (bad.length > 0) throw ApiError.unprocessable("One of those competitions is not part of this event.");
};

/**
 * What the manager may hand out: an admin keeps to volunteers, on sub-events they work on themselves. The head and the
 * platform are not limited.
 */
const assertMayGrant = (caller: Caller, manager: Manager, festId: string, role: FestRole, eventIds: string[]): void => {
  if (isFestWide(manager)) return;
  if (role !== "volunteer") throw ApiError.forbidden("Only the Event Head can assign admins and coordinators.");
  if (manager === "admin") {
    const own = caller.memberships[festId]?.eventIds ?? [];
    if (!eventIds.every((id) => own.includes(id))) throw ApiError.forbidden("You can only assign volunteers to the competitions you are assigned to yourself.");
  }
};

/**
 * Re-derives the claims after a change that has ALREADY COMMITTED. The membership documents are the authority and the API
 * reads them live, so the grant or revocation is in force whatever happens here; a claims write that fails (an Auth outage,
 * a legacy scope too large for a token) must neither fail the request nor skip its audit entry. It is reported as `pending`
 * instead, and repaired by `/api/me/access` the next time the person opens the app, or by `migrate:memberships`.
 */
const syncAfterCommit = async (uid: string): Promise<"synced" | "pending"> => {
  try {
    await syncMemberAccess(uid);
    return "synced";
  } catch (error) {
    console.error("[membership] claims sync pending for", uid, error instanceof Error ? error.message : "unknown error");
    return "pending";
  }
};

/** Re-derives the account's claims and its `memberOf` mirror from its active memberships. Call after any change. */
export const syncMemberAccess = async (uid: string): Promise<void> => {
  const db = adminDb();
  const members = await loadActiveMemberships(uid);
  const ref = db.collection(COLLECTIONS.users).doc(uid);
  await ref.set({ memberOf: members.map((member) => member.festId), updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  const profile = (await ref.get()).data();
  if (!profile) return;
  // The profile's own role and fests are the account's legacy authority; `applyClaims` adds the memberships on top.
  await applyClaims(
    uid,
    {
      role: normaliseRole(profile.role) ?? "student",
      festIds: stringList(profile.festIds),
      mustChangePassword: profile.mustChangePassword === true,
    },
    { revoke: false },
  );
};

/* ───────────── reading ───────────── */

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: FestRole;
  eventIds: string[];
  duties: string[];
  status: string;
  createdAt: string | null;
  revokedAt: string | null;
}

export const listMembers = async (caller: Caller, festId: string): Promise<MemberRow[]> => {
  const fest = await loadFest(festId);
  const manager = managerOf(caller, fest, festId);
  if (!manager) throw ApiError.forbidden("You do not manage the people on this event.");

  const snapshot = await adminDb().collection(COLLECTIONS.festMembers).where("festId", "==", festId).limit(500).get();
  const members = snapshot.docs.map((doc) => parseMembership(doc.id, doc.data())).filter((member): member is Membership => member !== null);

  // An admin sees the volunteers on their own competitions - the people they are allowed to manage - and nobody else.
  const own = manager === "admin" ? (caller.memberships[festId]?.eventIds ?? []) : null;
  const visible = own ? members.filter((member) => member.role === "volunteer" && member.eventIds.some((id) => own.includes(id))) : manager === "legacy-admin" ? members.filter((member) => member.role === "volunteer") : members;

  const profiles = visible.length > 0 ? await adminDb().getAll(...visible.map((member) => adminDb().collection(COLLECTIONS.users).doc(member.userId))) : [];
  const byId = new Map(profiles.map((doc) => [doc.id, doc.data()] as const));

  return visible
    .map((member) => {
      const profile = byId.get(member.userId);
      return {
        userId: member.userId,
        name: String(profile?.name ?? profile?.fullName ?? ""),
        email: String(profile?.email ?? ""),
        role: member.role,
        eventIds: member.eventIds,
        duties: member.duties,
        status: member.status,
        createdAt: member.createdAt.toISOString(),
        revokedAt: member.revokedAt ? member.revokedAt.toISOString() : null,
      };
    })
    .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
};

/* ───────────── writing ───────────── */

const memberRef = (festId: string, uid: string) => adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor(festId, uid));

/** Finds the account for an email, or creates an invited one with a temporary password (mailed, shown once). */
const accountFor = async (caller: Caller, input: AssignMember, festName: string, role: FestRole) => {
  const auth = adminAuth();
  let existingUid: string | null = null;
  try {
    const existing = await auth.getUserByEmail(input.email);
    if (existing.disabled) throw ApiError.conflict("That account is disabled.");
    existingUid = existing.uid;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
  }

  if (existingUid) {
    if (existingUid === caller.uid) throw ApiError.forbidden("You cannot assign yourself a role.");
    const profile = (await adminDb().collection(COLLECTIONS.users).doc(existingUid).get()).data();
    if (!profile) throw ApiError.unprocessable("That account is not set up yet. Ask them to sign in once, then try again.");
    // Platform accounts are a separate authority. They have no use for an event role and must not be tangled with one.
    if (profile.role === "super_admin") throw ApiError.conflict("That is a Plansphere platform account, which does not take event roles.");
    return { uid: existingUid, created: false as const };
  }

  const password = temporaryPassword();
  const created = await auth.createUser({ email: input.email, displayName: input.name ?? input.email, password, emailVerified: false, disabled: false });
  try {
    await adminDb()
      .collection(COLLECTIONS.users)
      .doc(created.uid)
      .set({
        id: created.uid,
        uid: created.uid,
        email: input.email,
        name: input.name ?? input.email,
        role: "student",
        festIds: [],
        emailVerified: false,
        disabled: false,
        profileCompleted: true,
        mustChangePassword: true,
        createdBy: caller.uid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
  } catch (error) {
    await auth.deleteUser(created.uid).catch(() => undefined);
    throw error;
  }

  const setPasswordLink = await staffInviteLink(input.email);
  const mailer = emailService();
  const delivery = await mailer.send(
    staffInviteEmail({
      to: input.email,
      fullName: input.name ?? input.email,
      roleLabel: `${FEST_ROLE_LABELS[role]} · ${festName}`,
      setPasswordLink,
      temporaryPassword: password,
      invitedBy: caller.email,
      meta: { userId: created.uid, subjectType: "user", subjectId: created.uid },
    }),
  );
  return { uid: created.uid, created: true as const, invite: { emailed: mailer.canSend && delivery.ok, setPasswordLink, temporaryPassword: password } };
};

export const assignMember = async (caller: Caller, festId: string, input: AssignMember) => {
  const fest = await loadFest(festId);
  const manager = managerOf(caller, fest, festId);
  if (!manager) throw ApiError.forbidden("You do not manage the people on this event.");
  assertMayGrant(caller, manager, festId, input.role, input.eventIds);
  await assertEventsBelongToFest(festId, input.eventIds);

  const account = await accountFor(caller, input, fest.name, input.role);

  // Someone already staff on this fest the old way would be silently narrowed by a membership. Migrate them instead.
  const profile = (await adminDb().collection(COLLECTIONS.users).doc(account.uid).get()).data();
  if (stringList(profile?.festIds).includes(festId) && normaliseRole(profile?.role) !== "student") {
    throw ApiError.conflict("That person is already staff on this event under the older scheme. Migrate them to an event role first.");
  }

  const ref = memberRef(festId, account.uid);
  await adminDb().runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (current.exists && current.data()?.status === "active") throw ApiError.conflict("That person already has a role on this event. Change it instead.");
    tx.set(
      ref,
      compact({
        id: ref.id,
        festId,
        userId: account.uid,
        role: input.role,
        eventIds: Array.from(new Set(input.eventIds)),
        duties: input.role === "volunteer" ? Array.from(new Set(input.duties)) : [],
        status: "active",
        createdBy: caller.uid,
        createdAt: current.exists ? current.data()?.createdAt : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }),
    );
    // The mirror the API uses to find a person's memberships is written in the same commit as the membership itself, so a
    // later failure can never leave a membership the API does not look for.
    tx.set(adminDb().collection(COLLECTIONS.users).doc(account.uid), { memberOf: FieldValue.arrayUnion(festId), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  const claimsSync = await syncAfterCommit(account.uid);

  await audit(caller, {
    action: "member_assigned",
    summary: `Assigned ${FEST_ROLE_LABELS[input.role].toLowerCase()} on "${fest.name}"`.slice(0, 200),
    festId,
    subjectType: "user",
    subjectId: account.uid,
    details: { role: input.role, events: input.eventIds.length, duties: input.duties, newAccount: account.created, ...(claimsSync === "pending" ? { claimsSync } : {}) },
  });

  return { userId: account.uid, role: input.role, ...(claimsSync === "pending" ? { claimsSync } : {}), ...(account.created ? { invite: account.invite } : {}) };
};

/** May the manager change this particular member? Same rules as granting, plus: never yourself, never the head. */
const loadManageable = async (caller: Caller, festId: string, targetUid: string) => {
  const fest = await loadFest(festId);
  const manager = managerOf(caller, fest, festId);
  if (!manager) throw ApiError.forbidden("You do not manage the people on this event.");
  if (targetUid === caller.uid) throw ApiError.forbidden("You cannot change your own role. Ask the Event Head.");

  const snapshot = await memberRef(festId, targetUid).get();
  const member = parseMembership(snapshot.id, snapshot.data());
  if (!member) throw ApiError.notFound("That person has no role on this event.");
  if (member.role === "head") throw ApiError.forbidden("The Event Head is not changed here. Only the Plansphere team can hand an event over.");
  if (!isFestWide(manager)) {
    if (member.role !== "volunteer") throw ApiError.forbidden("Only the Event Head can change admins and coordinators.");
    const own = manager === "admin" ? (caller.memberships[festId]?.eventIds ?? []) : null;
    if (own && !member.eventIds.some((id) => own.includes(id))) throw ApiError.forbidden("That volunteer is not on any of your competitions.");
  }
  return { fest, manager, member };
};

export const updateMember = async (caller: Caller, festId: string, targetUid: string, patch: UpdateMember) => {
  const { fest, manager, member } = await loadManageable(caller, festId, targetUid);
  if (member.status === "revoked") throw ApiError.conflict("That access was revoked. Assign the person again instead.");

  const role = patch.role ?? member.role;
  const eventIds = patch.eventIds ?? member.eventIds;
  assertMayGrant(caller, manager, festId, role, eventIds);
  if (patch.eventIds) await assertEventsBelongToFest(festId, patch.eventIds);

  const duties = role === "volunteer" ? (patch.duties ?? member.duties) : [];
  if (role === "volunteer" && duties.length === 0) throw ApiError.unprocessable("Give a volunteer at least one duty.");
  if (role !== "volunteer" && patch.duties && patch.duties.length > 0) throw ApiError.unprocessable("Duties are for volunteers.");

  await memberRef(festId, targetUid).update({
    role,
    eventIds: Array.from(new Set(eventIds)),
    duties: Array.from(new Set(duties)),
    ...(patch.status ? { status: patch.status } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const claimsSync = await syncAfterCommit(targetUid);

  await audit(caller, {
    action: "member_updated",
    summary: `Updated ${FEST_ROLE_LABELS[role].toLowerCase()} on "${fest.name}"${patch.status ? ` · ${patch.status}` : ""}`.slice(0, 200),
    festId,
    subjectType: "user",
    subjectId: targetUid,
    details: { role, status: patch.status ?? member.status, ...(claimsSync === "pending" ? { claimsSync } : {}) },
  });
  return { userId: targetUid, role, status: patch.status ?? member.status, ...(claimsSync === "pending" ? { claimsSync } : {}) };
};

export const revokeMember = async (caller: Caller, festId: string, targetUid: string) => {
  const { fest, member } = await loadManageable(caller, festId, targetUid);
  if (member.status === "revoked") return { userId: targetUid, status: "revoked" as const };

  await memberRef(festId, targetUid).update({ status: "revoked", revokedAt: FieldValue.serverTimestamp(), revokedBy: caller.uid, updatedAt: FieldValue.serverTimestamp() });
  const claimsSync = await syncAfterCommit(targetUid);

  await audit(caller, {
    action: "member_revoked",
    summary: `Revoked ${FEST_ROLE_LABELS[member.role].toLowerCase()} access on "${fest.name}"`.slice(0, 200),
    festId,
    subjectType: "user",
    subjectId: targetUid,
    ...(claimsSync === "pending" ? { details: { claimsSync } } : {}),
  });
  return { userId: targetUid, status: "revoked" as const, ...(claimsSync === "pending" ? { claimsSync } : {}) };
};

/**
 * Hands the Event Head role to someone else: the old head's membership is revoked, the new one's created, in one
 * transaction, so there is never a moment with two heads or none. Only the platform reaches this (the fest `transfer`
 * action). A new head that is itself a platform account needs no membership.
 */
export const transferHead = async (festId: string, fromUid: string | undefined, toUid: string, byUid: string): Promise<void> => {
  const db = adminDb();
  const toProfile = (await db.collection(COLLECTIONS.users).doc(toUid).get()).data();
  const toIsPlatform = normaliseRole(toProfile?.role) === "super_admin";

  await db.runTransaction(async (tx) => {
    const fromRef = fromUid && fromUid !== toUid ? memberRef(festId, fromUid) : null;
    const fromSnap = fromRef ? await tx.get(fromRef) : null;

    if (fromRef && fromSnap?.exists && fromSnap.data()?.role === "head") {
      tx.update(fromRef, { status: "revoked", revokedAt: FieldValue.serverTimestamp(), revokedBy: byUid, updatedAt: FieldValue.serverTimestamp() });
    }
    if (!toIsPlatform) {
      const toRef = memberRef(festId, toUid);
      tx.set(toRef, {
        id: toRef.id,
        festId,
        userId: toUid,
        role: "head",
        eventIds: [],
        duties: [],
        status: "active",
        createdBy: byUid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(db.collection(COLLECTIONS.users).doc(toUid), { memberOf: FieldValue.arrayUnion(festId), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
  });

  if (fromUid && fromUid !== toUid) await syncAfterCommit(fromUid);
  if (!toIsPlatform) await syncAfterCommit(toUid);
};
