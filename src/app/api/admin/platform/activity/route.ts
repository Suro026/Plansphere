import { handler, ok, requireRole } from "@/server/api";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";

/**
 * GET /api/admin/platform/activity — what this account has done.
 *
 * Scoped to the caller by construction: the query filters on their own uid
 * and there is no parameter to widen it, so this route cannot become a way to
 * read someone else's trail. The fest-scoped views of the same log live on
 * the console pages and are guarded by `audit:read`.
 */
export const GET = handler(async (request) => {
  const caller = await requireRole(request, "volunteer");

  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 20) || 20, 100);

  const snapshot = await adminDb()
    .collection(COLLECTIONS.auditLog)
    .where("actorId", "==", caller.uid)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  const entries = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      action: String(data.action ?? ""),
      summary: String(data.summary ?? ""),
      festId: data.festId ? String(data.festId) : null,
      subjectType: data.subjectType ? String(data.subjectType) : null,
      createdAt: data.createdAt?.toDate?.()?.toISOString() ?? null,
    };
  });

  return ok({ entries });
});
