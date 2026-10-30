import { z } from "zod";
import { idSchema, shortTextSchema } from "@/core/models/common";
import { ROLE_LABELS, creatableRoles } from "@/core/models/user";
import { ApiError, handler, ok, readBody, requirePermission } from "@/server/api";
import { applyClaims } from "@/server/credentials";
import { audit } from "@/server/audit";
import { assertPlatformGrantAllowed, deregisterPlatformStaff } from "@/server/platform-boundary";
import {
  COLLECTIONS,
  FieldValue,
  adminAuth,
  adminDb,
} from "@/server/firebase-admin";

/**
 * Editing and removing staff accounts.
 *
 * Who may touch whom follows the same matrix as creation: a super admin
 * reaches every account, an admin only the volunteers of the fests they
 * manage. The extra guards below exist because their failure modes are
 * unrecoverable from inside the app — a super admin who demotes themselves,
 * or removes the last remaining super admin, locks the project out of its own
 * administration and the only way back is a script run against the service
 * account.
 */

const updateStaffSchema = z
  .object({
    name: shortTextSchema.optional(),
    designation: shortTextSchema.optional(),
    role: z.enum(["volunteer", "admin", "super_admin"]).optional(),
    festIds: z.array(idSchema).optional(),
    disabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nothing to update",
  });

/** Number of enabled super admins, used for the lockout guards. */
const countActiveSuperAdmins = async (): Promise<number> => {
  const snapshot = await adminDb()
    .collection(COLLECTIONS.users)
    .where("role", "==", "super_admin")
    .get();

  return snapshot.docs.filter((doc) => doc.data().disabled !== true).length;
};

/** Pre-refactor documents kept the scope under `organizer.festIds`. */
const festIdsOf = (data: Record<string, unknown>): string[] => {
  if (Array.isArray(data.festIds)) return data.festIds as string[];
  const legacy = (data.organizer as { festIds?: string[] } | undefined)?.festIds;
  return Array.isArray(legacy) ? legacy : [];
};

/** PATCH /api/admin/staff/[id] */
export const PATCH = handler(async (request, context) => {
  const caller = await requirePermission(request, "staff:manage");
  const { id } = await context.params;

  if (!id) throw ApiError.badRequest("Missing staff id.");

  const input = await readBody(request, updateStaffSchema);

  const db = adminDb();
  const auth = adminAuth();

  const ref = db.collection(COLLECTIONS.users).doc(id);
  const snapshot = await ref.get();

  if (!snapshot.exists) throw ApiError.notFound("No such staff account.");

  const current = snapshot.data() ?? {};
  // `organizer` was the old name for what is now `volunteer`.
  const currentRole = (current.role === "organizer" ? "volunteer" : current.role) as string | undefined;
  const currentFestIds = festIdsOf(current);

  if (currentRole === "student") {
    throw ApiError.unprocessable(
      "That account is a student. Students are not staff — invite them from " +
        "the staff list to give them a role.",
    );
  }

  // An admin may only edit the volunteers of a fest they manage, and may only
  // ever set the volunteer role. Everything else is a super admin action.
  if (caller.role !== "super_admin") {
    const allowed: readonly string[] = creatableRoles(caller.role);

    if (currentRole === undefined || !allowed.includes(currentRole)) {
      throw ApiError.forbidden("Only a super admin can change that account.");
    }

    if (input.role !== undefined && !allowed.includes(input.role)) {
      throw ApiError.forbidden("Only a super admin can grant that role.");
    }

    if (!currentFestIds.some((festId) => caller.festIds.includes(festId))) {
      throw ApiError.forbidden("That account belongs to a fest you do not manage.");
    }

    for (const festId of input.festIds ?? []) {
      if (!caller.festIds.includes(festId)) throw ApiError.forbidden("You do not manage that fest.");
    }
  }

  // With the platform boundary enforced, the registry is the only way onto the platform team.
  if (input.role === "super_admin" && currentRole !== "super_admin") await assertPlatformGrantAllowed();

  const losingSuperAdmin =
    currentRole === "super_admin" &&
    ((input.role !== undefined && input.role !== "super_admin") || input.disabled === true);

  if (losingSuperAdmin) {
    if (id === caller.uid) {
      throw ApiError.unprocessable(
        "You cannot remove your own super admin access — you would be locked " +
          "out immediately. Ask another super admin to do it.",
      );
    }

    if ((await countActiveSuperAdmins()) <= 1) {
      throw ApiError.unprocessable(
        "This is the last active super admin. Promote someone else first, " +
          "otherwise nobody will be able to administer the project.",
      );
    }
  }

  const role = (input.role ?? currentRole ?? "volunteer") as "volunteer" | "admin" | "super_admin";
  const festIds = input.festIds ?? currentFestIds;

  if (role !== "super_admin" && festIds.length === 0) {
    throw ApiError.unprocessable(`A ${ROLE_LABELS[role].toLowerCase()} needs at least one fest assigned.`);
  }

  for (const festId of input.festIds ?? []) {
    const fest = await db.collection(COLLECTIONS.fests).doc(festId).get();
    if (!fest.exists) throw ApiError.unprocessable(`No fest with id "${festId}".`);
  }

  // Claims first. If the document write fails afterwards the claim is merely
  // ahead of its mirror, which `authenticate` resolves by taking the weaker of
  // the two — whereas the reverse order would leave a stale claim granting
  // access the record says was removed.
  if (input.role !== undefined || input.festIds !== undefined) {
    await applyClaims(id, {
      role,
      festIds,
      // A pending temporary password survives a role change.
      ...(current.mustChangePassword === true ? { mustChangePassword: true } : {}),
    });
  }

  if (input.disabled !== undefined) {
    await auth.updateUser(id, { disabled: input.disabled });
    if (input.disabled) await auth.revokeRefreshTokens(id);
  }

  // Leaving the platform team also leaves the registry, so a later change of role cannot quietly bring the power back.
  // (Disabling the account is enough on its own to shut it out, and re-enabling it should not need the script.)
  if (currentRole === "super_admin" && input.role !== undefined && input.role !== "super_admin") await deregisterPlatformStaff(id);

  await ref.update({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.role !== undefined ? { role } : {}),
    ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
    ...(input.festIds !== undefined ? { festIds } : {}),
    ...(input.designation !== undefined ? { designation: input.designation } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await audit(caller, {
    action: "staff_updated",
    summary: `Updated ${current.name ?? current.fullName ?? current.email}: ${[
      input.role !== undefined && input.role !== currentRole ? `role ${currentRole} → ${role}` : null,
      input.disabled !== undefined ? (input.disabled ? "disabled" : "re-enabled") : null,
      input.festIds !== undefined ? `scoped to ${festIds.length} fest(s)` : null,
      input.name !== undefined ? "name" : null,
    ]
      .filter(Boolean)
      .join(", ") || "details"}`,
    subjectType: "user",
    subjectId: id,
    ...(festIds[0] ? { festId: festIds[0] } : {}),
  });

  return ok({ id, role, festIds, disabled: input.disabled ?? current.disabled === true });
});

/**
 * DELETE /api/admin/staff/[id]
 *
 * Removes both the Auth account and the profile document. The previous
 * project deleted only the Firestore record, which left the person able to
 * sign in perfectly well — they simply had no profile, and a route guard that
 * read the document treated it as "not staff" while Firebase still considered
 * them a valid, authenticated user.
 */
export const DELETE = handler(async (request, context) => {
  const caller = await requirePermission(request, "staff:manage");
  const { id } = await context.params;

  if (!id) throw ApiError.badRequest("Missing staff id.");

  if (id === caller.uid) {
    throw ApiError.unprocessable("You cannot delete your own account.");
  }

  const db = adminDb();
  const ref = db.collection(COLLECTIONS.users).doc(id);
  const snapshot = await ref.get();

  if (!snapshot.exists) throw ApiError.notFound("No such staff account.");

  const data = snapshot.data() ?? {};
  const role = data.role === "organizer" ? "volunteer" : data.role;

  if (role === "student") throw ApiError.unprocessable("That account is a student, not staff.");

  if (caller.role !== "super_admin") {
    if (role !== "volunteer") throw ApiError.forbidden("Only a super admin can delete that account.");
    if (!festIdsOf(data).some((festId) => caller.festIds.includes(festId))) {
      throw ApiError.forbidden("That account belongs to a fest you do not manage.");
    }
  }

  if (role === "super_admin" && (await countActiveSuperAdmins()) <= 1) {
    throw ApiError.unprocessable("This is the last active super admin.");
  }

  // Auth first: if this succeeds and the document delete fails, the leftover
  // document is inert. The reverse would leave a sign-in-capable account with
  // no record of what it was.
  await adminAuth()
    .deleteUser(id)
    .catch((error: { code?: string }) => {
      if (error.code !== "auth/user-not-found") throw error;
    });

  await ref.delete();
  if (role === "super_admin") await deregisterPlatformStaff(id);

  await audit(caller, {
    action: "staff_deleted",
    summary: `Deleted staff account ${data.name ?? data.fullName ?? data.email}`,
    subjectType: "user",
    subjectId: id,
  });

  return ok({ id, deleted: true });
});
