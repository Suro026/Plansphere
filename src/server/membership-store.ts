import { membershipSchema, type Membership } from "@/core/models/membership";
import { COLLECTIONS, adminDb } from "./firebase-admin";
import { toDates } from "./serialize";

/**
 * Reads of the `festMembers` collection that other server modules depend on. Kept free of anything that writes claims,
 * so `credentials.ts` (which writes them) can use it without a cycle.
 */

/** A raw `festMembers` document, validated. A malformed one is dropped, never trusted. */
export const parseMembership = (id: string, data: Record<string, unknown> | undefined): Membership | null => {
  if (!data) return null;
  const parsed = membershipSchema.safeParse({ ...toDates<Record<string, unknown>>(data), id });
  return parsed.success ? parsed.data : null;
};

/**
 * The account's memberships that carry authority right now: `active` only. Suspended and revoked ones are read as
 * nothing, which is what makes both take effect on the very next request.
 */
export const loadActiveMemberships = async (uid: string): Promise<Membership[]> => {
  const snapshot = await adminDb().collection(COLLECTIONS.festMembers).where("userId", "==", uid).where("status", "==", "active").limit(500).get();
  return snapshot.docs.map((doc) => parseMembership(doc.id, doc.data())).filter((member): member is Membership => member !== null);
};
