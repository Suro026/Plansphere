import { z } from "zod";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { audit } from "@/server/audit";

const bodySchema = z.object({ reason: z.string().trim().min(3, "Say why").max(500) });

/**
 * POST /api/admin/certificates/[id]/revoke
 *
 * The document stays — so the number can never be reissued and the verify
 * page can say "revoked" rather than "never existed" — but it disappears
 * from the holder's list and the PDF renders with a banner.
 */
export const POST = handler(async (request, context) => {
  const caller = await requirePermission(request, "certificate:revoke");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing certificate id.");
  const { reason } = await readBody(request, bodySchema);

  const db = adminDb();
  const ref = db.collection(COLLECTIONS.certificates).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw ApiError.notFound("No such certificate.");
  const c = snap.data()!;
  requireFestAccess(caller, String(c.festId), String(c.eventId));
  if (c.revoked === true) return ok({ revoked: true, already: true });

  await ref.update({
    revoked: true,
    revokedAt: FieldValue.serverTimestamp(),
    revokedReason: reason,
    revokedBy: caller.uid,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await audit(caller, {
    action: "certificate_revoked",
    summary: `Revoked ${c.certificateNumber} (${c.recipientName}, ${c.eventTitle}) — ${reason}`,
    festId: String(c.festId),
    eventId: String(c.eventId),
    subjectType: "certificate",
    subjectId: id,
  });

  return ok({ revoked: true });
});
