import { OPEN_BOUNDARY, decidePlatform, readBoundary, type PlatformBoundary, type PlatformDecision } from "@/core/platform";
import { COLLECTIONS, FieldValue, adminDb } from "./firebase-admin";
import { ApiError } from "./errors";

/**
 * The server side of the platform boundary (`core/platform.ts`).
 *
 * Reads are by the Admin SDK; nothing here is reachable from a client, and the only writer of the two documents is
 * `scripts/platform-staff.mjs`. A read that fails is a failure, not an open door: `authenticate` lets the error stand, so an
 * unreachable registry blocks the super admin's request rather than skipping the check.
 */

export const loadBoundary = async (): Promise<PlatformBoundary> => {
  const snapshot = await adminDb().collection(COLLECTIONS.platformConfig).doc("boundary").get();
  return snapshot.exists ? readBoundary(snapshot.data()) : OPEN_BOUNDARY;
};

export const resolvePlatform = async (uid: string, secondFactor: string | null | undefined): Promise<PlatformDecision> => {
  const boundary = await loadBoundary();
  // Not enforced: the registry is not consulted at all, exactly as before the boundary existed.
  if (!boundary.enforce) return { ok: true };
  const staff = await adminDb().collection(COLLECTIONS.platformStaff).doc(uid).get();
  return decidePlatform({ boundary, staff: staff.exists ? (staff.data() ?? {}) : null, secondFactor });
};

/**
 * Once the boundary is enforced the registry is the only way onto the platform team, so the app refuses to mint a
 * `super_admin` itself: the account it made would carry the role and none of the power. Say so, instead of silently
 * creating something useless.
 */
export const assertPlatformGrantAllowed = async (): Promise<void> => {
  if ((await loadBoundary()).enforce) {
    throw ApiError.unprocessable("Platform accounts are managed with `npm run platform-staff`, not from the app. See docs/PLATFORM-BOUNDARY.md.");
  }
};

/**
 * An account that stops being a super admin (demoted, disabled or deleted) leaves the registry too, so that a later change
 * of its role cannot silently bring the platform power back. Best effort: the role change is what removes the power.
 */
export const deregisterPlatformStaff = async (uid: string): Promise<void> => {
  const ref = adminDb().collection(COLLECTIONS.platformStaff).doc(uid);
  const snapshot = await ref.get();
  if (!snapshot.exists || snapshot.data()?.status === "removed") return;
  await ref.set({ status: "removed", removedAt: FieldValue.serverTimestamp(), removedBy: "app" }, { merge: true });
};
