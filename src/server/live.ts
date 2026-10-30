import { festAccess } from "@/core/access";
import { hasAtLeast } from "@/core/permissions";
import { ApiError, canManageFest, requireFestAccess, type Caller } from "./api";
import { COLLECTIONS, adminDb } from "./firebase-admin";

/**
 * The Live Event Engine's one bespoke scoping rule: a volunteer may score a
 * match only at the arena their shift assigns them to.
 *
 * This sits beside `canManageFest`/`inScope` rather than inside the
 * permission matrix, for the same reason fest scoping itself is a side
 * channel on the user document rather than a matrix concept — arena
 * assignment is data (a `Shift`), not a role, and admin+ already bypasses it
 * entirely via the fest-level check every other admin route uses.
 */
export const requireArenaAccess = async (caller: Caller, festId: string, arenaId: string | undefined, eventId?: string): Promise<void> => {
  // A member of this fest is governed by the membership alone: scoring needs the duty (or an admin's or coordinator's
  // role) and the match's sub-event to be one they are assigned. The head scores anywhere in the fest.
  if (festAccess(caller, festId).kind === "member") {
    requireFestAccess(caller, festId, eventId);
    return;
  }

  if (hasAtLeast(caller.role, "admin")) {
    requireFestAccess(caller, festId);
    return;
  }

  if (!canManageFest(caller, festId)) throw ApiError.forbidden("You do not manage this fest.");
  if (!arenaId) throw ApiError.forbidden("This match has no arena assigned yet.");

  const snap = await adminDb()
    .collection(COLLECTIONS.shifts)
    .where("festId", "==", festId)
    .where("userId", "==", caller.uid)
    .where("duty", "==", "scoring")
    .where("post", "==", arenaId)
    .get();

  const active = snap.docs.some((doc) => doc.data().cancelled !== true);
  if (!active) throw ApiError.forbidden("You are not assigned to score at this arena.");
};
