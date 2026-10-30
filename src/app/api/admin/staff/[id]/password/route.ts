import { ApiError, handler, ok, requirePermission } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";
import { applyClaims, temporaryPassword } from "@/server/credentials";
import { creatableRoles } from "@/core/models/user";
import { emailService } from "@/server/email";
import { staffInviteLink } from "@/server/auth-links";
import { staffInviteEmail } from "@/server/email/templates";
import { ROLE_LABELS } from "@/core/models/user";
import { audit } from "@/server/audit";

/**
 * POST /api/admin/staff/[id]/password — issue a fresh temporary password.
 *
 * For the case the invitation describes but no flow covered: the admin never
 * received the email, or read it three weeks later and the link had expired.
 * The new password is mailed *and* returned once in this response, because
 * the super admin sitting with them on the phone is the fallback for a mail
 * system that is not working.
 *
 * What it is not: a way to read someone's password. Firebase stores only a
 * hash, nothing here can recover the existing one, and the value returned
 * exists for the length of this response — it is never written to Firestore.
 * Issuing one invalidates the old password and every open session, which is
 * also what makes this the right button for "that account may be compromised".
 */
export const POST = handler(async (request, context) => {
  const caller = await requirePermission(request, "staff:manage");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing staff id.");

  const db = adminDb();
  const ref = db.collection(COLLECTIONS.users).doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw ApiError.notFound("No such staff account.");

  const data = snapshot.data() ?? {};
  const role = data.role === "organizer" ? "volunteer" : String(data.role ?? "");

  if (role === "student") throw ApiError.unprocessable("That account is a student. Students reset their own password from the sign-in page.");

  // An admin may do this for the volunteers they manage; everything above
  // that is the super admin's.
  if (caller.role !== "super_admin") {
    const allowed: readonly string[] = creatableRoles(caller.role);
    if (!allowed.includes(role)) throw ApiError.forbidden("Only a super admin can reset that account.");
    const festIds: string[] = Array.isArray(data.festIds) ? data.festIds : [];
    if (!festIds.some((festId) => caller.festIds.includes(festId))) {
      throw ApiError.forbidden("That account belongs to a fest you do not manage.");
    }
  }

  const password = temporaryPassword();
  const auth = adminAuth();

  await auth.updateUser(id, { password });
  await applyClaims(id, {
    role: role as "volunteer" | "admin" | "super_admin",
    festIds: Array.isArray(data.festIds) ? (data.festIds as string[]) : [],
    mustChangePassword: true,
  });
  await ref.update({ mustChangePassword: true });

  const email = String(data.email ?? "");
  const mailer = emailService();
  const setPasswordLink = await staffInviteLink(email);

  const delivery = await mailer.send(
    staffInviteEmail({
      to: email,
      fullName: String(data.name ?? data.fullName ?? "there"),
      roleLabel: ROLE_LABELS[(role as "volunteer" | "admin" | "super_admin") ?? "volunteer"],
      setPasswordLink,
      temporaryPassword: password,
      invitedBy: caller.email,
      meta: { userId: id, subjectType: "user", subjectId: id },
    }),
  );

  await audit(caller, {
    action: "staff_password_reset",
    summary: `Issued a new temporary password for ${data.name ?? data.fullName ?? email}`,
    subjectType: "user",
    subjectId: id,
    details: { emailed: mailer.canSend && delivery.ok },
  });

  return ok({
    id,
    email,
    // Shown once, in the panel, then gone. Not stored anywhere.
    temporaryPassword: password,
    setPasswordLink,
    emailed: mailer.canSend && delivery.ok,
    provider: mailer.name,
  });
}, { rateLimit: RATE_LIMITS.auth.passwordReset });
