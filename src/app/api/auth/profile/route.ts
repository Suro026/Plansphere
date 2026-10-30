import { isProfileComplete, studentProfileSchema, updateUserSchema } from "@/core/models/user";
import { ApiError, authenticate, handler, ok, readBody } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { compact } from "@/server/serialize";
import { audit } from "@/server/audit";

/**
 * POST /api/auth/profile — finish a student profile after sign-up.
 *
 * Reachable while `profileCompleted` is false, which is the state a new
 * account is in, so it cannot use `requireRole`'s completeness expectations.
 * The server decides whether the profile now counts as complete; the client
 * does not get to assert it.
 */
export const POST = handler(async (request) => {
  const caller = await authenticate(request);
  const input = await readBody(request, studentProfileSchema);

  const completed = isProfileComplete({ role: caller.role, ...input });

  await adminDb()
    .collection(COLLECTIONS.users)
    .doc(caller.uid)
    .set(
      compact({
        id: caller.uid,
        uid: caller.uid,
        email: caller.email,
        name: input.name.trim(),
        phone: input.phone.trim(),
        college: input.college.trim(),
        studentId: input.studentId?.trim(),
        department: input.department?.trim(),
        year: input.year,
        role: caller.role,
        profileCompleted: completed,
        updatedAt: FieldValue.serverTimestamp(),
      }),
      { merge: true },
    );

  return ok({ profileCompleted: completed });
}, { rateLimit: RATE_LIMITS.authenticated.default });

/**
 * PATCH /api/auth/profile — edit your own profile.
 *
 * Every field here is the account holder's own to change. The ones that are
 * not — role, scope, whether the account is disabled, the sign-in address —
 * are absent from `updateUserSchema` and refused by the Firestore rules for
 * good measure, so this route cannot be used to promote anyone, including
 * oneself.
 */
export const PATCH = handler(async (request) => {
  const caller = await authenticate(request);
  const input = await readBody(request, updateUserSchema);

  if (Object.keys(input).length === 0) throw ApiError.badRequest("Nothing to update.");

  const db = adminDb();
  const ref = db.collection(COLLECTIONS.users).doc(caller.uid);
  const existing = (await ref.get()).data() ?? {};

  const merged = { ...existing, ...input };
  const completed = isProfileComplete({
    role: caller.role,
    name: String(merged.name ?? ""),
    phone: merged.phone ? String(merged.phone) : undefined,
    college: merged.college ? String(merged.college) : undefined,
  });

  await ref.set(
    compact({ ...input, profileCompleted: completed, updatedAt: FieldValue.serverTimestamp() }),
    { merge: true },
  );

  await audit(caller, {
    action: "profile_updated",
    summary: `Updated their own profile · ${Object.keys(input).join(", ")}`,
    subjectType: "user",
    subjectId: caller.uid,
  });

  return ok({ profileCompleted: completed, updated: Object.keys(input) });
}, { rateLimit: RATE_LIMITS.authenticated.default });
