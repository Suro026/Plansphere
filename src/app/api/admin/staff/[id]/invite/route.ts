import { ApiError, handler, ok, requirePermission } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { staffInviteLink } from "@/server/auth-links";
import { emailService } from "@/server/email";
import { staffInviteEmail } from "@/server/email/templates";

/** POST /api/admin/staff/[id]/invite — re-send the password-set link. */
export const POST = handler(async (request, context) => {
  const caller = await requirePermission(request, "staff:manage");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing staff id.");

  const snap = await adminDb().collection(COLLECTIONS.users).doc(id).get();
  if (!snap.exists) throw ApiError.notFound("No such staff account.");
  const data = snap.data()!;
  if (data.role === "student") throw ApiError.unprocessable("That account is a student.");

  const link = await staffInviteLink(String(data.email));
  const mailer = emailService();
  const delivery = await mailer.send(
    staffInviteEmail({
      to: String(data.email),
      fullName: String(data.name ?? data.fullName ?? "there"),
      roleLabel: String(data.role).replace("_", " "),
      setPasswordLink: link,
      invitedBy: caller.email,
      meta: { userId: id, subjectType: "user", subjectId: id, ...(Array.isArray(data.organizer?.festIds) && data.organizer.festIds[0] ? { festId: String(data.organizer.festIds[0]) } : {}) },
    }),
  );

  return ok({ emailed: mailer.canSend && delivery.ok, provider: mailer.name, ...(mailer.canSend ? {} : { setPasswordLink: link }) });
}, { rateLimit: RATE_LIMITS.authenticated.staff });
