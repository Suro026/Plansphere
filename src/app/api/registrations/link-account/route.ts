import { authenticate, handler, ok } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";

/**
 * POST /api/registrations/link-account
 *
 * A teammate is often typed into a registration by email before they have an
 * account. When they later sign up with that address, this stamps their new
 * uid onto those entries so "My events" shows the team and, later, the
 * certificate reaches them. Idempotent; safe to call more than once.
 */
export const POST = handler(async (request) => {
  const caller = await authenticate(request);
  const db = adminDb();

  const matches = await db
    .collection(COLLECTIONS.registrations)
    .where("memberEmails", "array-contains", caller.email)
    .limit(200)
    .get();

  let linked = 0;
  const batch = db.batch();

  for (const doc of matches.docs) {
    const members = (doc.data().members ?? []) as Array<Record<string, unknown>>;
    let changed = false;

    const next = members.map((m) => {
      if (String(m.email).toLowerCase() === caller.email && m.userId !== caller.uid) {
        changed = true;
        return { ...m, userId: caller.uid };
      }
      return m;
    });

    if (changed) {
      batch.update(doc.ref, { members: next, updatedAt: FieldValue.serverTimestamp() });
      linked += 1;
    }
  }

  if (linked) await batch.commit();

  return ok({ linked });
}, { rateLimit: RATE_LIMITS.authenticated.registration });
