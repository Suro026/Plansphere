import { ROLE_LABELS, createStaffSchema, generateStaffCode } from "@/core/models/user";
import { creatableRoles, isFestOwner } from "@/core/permissions";
import { ApiError, handler, ok, readBody, requirePermission, requireRole } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, FieldValue, adminAuth, adminDb } from "@/server/firebase-admin";
import { randomBytes } from "@/server/serialize";
import { applyClaims, temporaryPassword } from "@/server/credentials";
import { emailService } from "@/server/email";
import { staffInviteLink } from "@/server/auth-links";
import { audit } from "@/server/audit";
import { assertPlatformGrantAllowed } from "@/server/platform-boundary";
import { staffInviteEmail } from "@/server/email/templates";

/**
 * Invite-only staff accounts.
 *
 * This route grants a role above `student` to *someone else's* account. The
 * one other place a role is ever granted is `POST /api/register-event`,
 * which promotes the caller's *own* account to admin, scoped to the event
 * they just registered — self-elevation, not an invitation. Everything else
 * reads the role from the Auth token's custom claim, and the Firestore rules
 * refuse any client write that touches `role`.
 *
 * Who may create whom comes from `creatableRoles()` in the permission matrix:
 * a super admin creates any role, an admin creates volunteers for the fests
 * they manage, and an admin who owns a fest (registered it — `Fest.ownerId`)
 * may also create admins for that one fest. Nobody else gets here.
 */

/**
 * POST /api/admin/staff — create a volunteer, admin or super admin.
 *
 * The new account is given a temporary password, mailed to them with a
 * set-your-own-password link, and marked `mustChangePassword`. Until they
 * clear it, every privileged route refuses — so the mailed credential can do
 * nothing except become a real password.
 */
export const POST = handler(async (request) => {
  const caller = await requirePermission(request, "staff:createVolunteer");
  const input = await readBody(request, createStaffSchema);
  const db = adminDb();

  // A plain admin may also create other admins, but only for a fest they
  // themselves own — the account that registered it through self-service
  // (Fest.ownerId). Checked before deciding what they may create.
  let isOwnerOfAllTargets = false;
  if (caller.role === "admin" && input.role === "admin" && input.festIds.length > 0) {
    const ownershipChecks = await Promise.all(
      input.festIds.map(async (festId) => {
        const fest = await db.collection(COLLECTIONS.fests).doc(festId).get();
        return fest.exists && isFestOwner(caller.uid, fest.data() as { ownerId?: string });
      }),
    );
    isOwnerOfAllTargets = ownershipChecks.every(Boolean);
  }

  if (!creatableRoles(caller.role, isOwnerOfAllTargets).includes(input.role)) {
    throw ApiError.forbidden(
      input.role === "volunteer"
        ? "You cannot create staff accounts."
        : "Only a super admin, or the account that registered this fest, can create admin accounts for it.",
    );
  }

  // With the platform boundary enforced, the registry is the only way onto the platform team.
  if (input.role === "super_admin") await assertPlatformGrantAllowed();

  // An admin may only hand out access to fests they themselves manage — an
  // owner already has their own fest in scope from registering it.
  for (const festId of input.festIds) {
    if (!caller.festIds.includes(festId) && caller.role !== "super_admin") {
      throw ApiError.forbidden("You do not manage that fest.");
    }
  }

  const auth = adminAuth();

  // Reject an address that already has an account rather than silently
  // upgrading it: promoting an existing student is a different, deliberate
  // action and belongs on the PATCH route.
  try {
    const existing = await auth.getUserByEmail(input.email);

    throw ApiError.conflict(
      `${input.email} already has an account (${existing.uid}). ` + `Change their role from the staff list instead of re-inviting them.`,
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;

    const code = (error as { code?: string }).code;

    // Anything other than "no such user" is a real failure worth surfacing.
    if (code !== "auth/user-not-found") throw error;
  }

  // A volunteer or admin scoped to no fests can see nothing, which looks like
  // a broken account rather than a deliberate one. Only a super admin is
  // unscoped by design.
  if (input.role !== "super_admin" && input.festIds.length === 0) {
    throw ApiError.unprocessable(
      `A ${ROLE_LABELS[input.role].toLowerCase()} needs at least one fest assigned, otherwise they will not be able to see anything after signing in.`,
    );
  }

  // Verify every referenced fest exists, so a typo does not produce an
  // account scoped to a fest id that will never match.
  for (const festId of input.festIds) {
    const fest = await db.collection(COLLECTIONS.fests).doc(festId).get();
    if (!fest.exists) throw ApiError.unprocessable(`No fest with id "${festId}".`);
  }

  const password = temporaryPassword();
  // The code people actually quote: "ADM-2026-K4P7". Not a credential.
  const staffCode = generateStaffCode(input.role, new Date().getFullYear(), randomBytes);
  const created = await auth.createUser({
    email: input.email,
    displayName: input.name,
    password,
    emailVerified: false,
    disabled: false,
  });

  try {
    await applyClaims(created.uid, { role: input.role, festIds: input.festIds, mustChangePassword: true });

    await db
      .collection(COLLECTIONS.users)
      .doc(created.uid)
      .set({
        id: created.uid,
        uid: created.uid,
        email: input.email,
        name: input.name,
        ...(input.phone ? { phone: input.phone } : {}),
        ...(input.designation ? { designation: input.designation } : {}),
        staffCode,
        role: input.role,
        festIds: input.festIds,
        emailVerified: false,
        disabled: false,
        // Staff have nothing more to fill in; the invitation is the profile.
        profileCompleted: true,
        mustChangePassword: true,
        createdBy: caller.uid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
  } catch (error) {
    // Do not leave an Auth account with no profile and no claims behind: it
    // would be able to sign in and land in a broken, roleless state.
    await auth.deleteUser(created.uid).catch(() => undefined);
    throw error;
  }

  await audit(caller, {
    action: "staff_created",
    summary: `Created ${ROLE_LABELS[input.role].toLowerCase()} account for ${input.name} (${input.email})`,
    subjectType: "user",
    subjectId: created.uid,
    ...(input.festIds[0] ? { festId: input.festIds[0] } : {}),
    details: { role: input.role, festIds: input.festIds, staffCode },
  });

  // The email carries both: a link that expires, and the temporary password
  // for the case where the link has aged out by the time they read it.
  const setPasswordLink = await staffInviteLink(input.email);
  const mailer = emailService();

  const delivery = await mailer.send(
    staffInviteEmail({
      to: input.email,
      fullName: input.name,
      roleLabel: ROLE_LABELS[input.role],
      setPasswordLink,
      temporaryPassword: password,
      invitedBy: caller.email,
      meta: { userId: created.uid, subjectType: "user", subjectId: created.uid, ...(input.festIds[0] ? { festId: input.festIds[0] } : {}) },
    }),
  );

  return ok(
    {
      user: { id: created.uid, email: input.email, name: input.name, role: input.role, festIds: input.festIds, staffCode },
      invite: {
        emailed: mailer.canSend && delivery.ok,
        provider: mailer.name,
        setPasswordLink,
        /**
         * Shown once, to the person who just created the account, in the
         * panel they created it from. Firebase keeps only a hash, so this is
         * the sole moment the value exists outside the mail that carries it —
         * it is never written to Firestore, and the account is locked to
         * changing it on first sign-in anyway.
         */
        temporaryPassword: password,
      },
    },
    201,
  );
}, { rateLimit: RATE_LIMITS.authenticated.staff });

/** GET /api/admin/staff — list non-student accounts. */
export const GET = handler(async (request) => {
  const caller = await requireRole(request, "admin");
  const auth = adminAuth();

  const snapshot = await adminDb()
    .collection(COLLECTIONS.users)
    .where("role", "in", ["volunteer", "admin", "super_admin"])
    .get();

  // Auth holds the sign-in metadata Firestore does not: whether the invite
  // was ever used, and when they were last here. One batched lookup.
  const ids = snapshot.docs.map((doc) => ({ uid: doc.id }));
  const authUsers = new Map<string, { lastSignIn: string | null; created: string | null }>();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = await auth.getUsers(ids.slice(i, i + 100)).catch(() => null);
    for (const u of batch?.users ?? []) {
      authUsers.set(u.uid, { lastSignIn: u.metadata.lastSignInTime ?? null, created: u.metadata.creationTime ?? null });
    }
  }

  const staff = snapshot.docs
    .map((doc) => {
      const data = doc.data();
      const meta = authUsers.get(doc.id);
      const festIds: string[] = data.festIds ?? data.organizer?.festIds ?? [];

      return {
        id: doc.id,
        email: data.email ?? "",
        name: data.name ?? data.fullName ?? "",
        role: data.role === "organizer" ? "volunteer" : (data.role ?? "volunteer"),
        designation: data.designation ?? data.organizer?.designation ?? null,
        staffCode: data.staffCode ?? null,
        festIds,
        disabled: data.disabled === true,
        mustChangePassword: data.mustChangePassword === true,
        createdAt: data.createdAt?.toDate?.()?.toISOString() ?? meta?.created ?? null,
        lastSignInAt: meta?.lastSignIn ? new Date(meta.lastSignIn).toISOString() : null,
        activated: Boolean(meta?.lastSignIn),
      };
    })
    // An admin sees the staff of the fests they manage; a super admin sees all.
    .filter((row) => caller.role === "super_admin" || row.festIds.some((id) => caller.festIds.includes(id)));

  staff.sort((a, b) => a.name.localeCompare(b.name));

  return ok({ staff });
});
