import { homeForRole, type UserRole } from "@/core/permissions";
import type { Session } from "@/core/services/auth-service";
import type { User } from "@/core/models/user";

/**
 * Where a session belongs right now.
 *
 * Three gates, in order, before anyone reaches the app proper:
 *
 *   1. a temporary password must become a real one
 *   2. an unverified student must confirm their address
 *   3. a student profile must be complete enough to put on a pass
 *
 * The same order is enforced server-side (`requirePasswordChanged`, the
 * verified-email check on registration, and `profileCompleted`), so this is
 * only about sending people somewhere useful — never about safety.
 */
export const postAuthDestination = (
  session: Pick<Session, "role" | "emailVerified" | "mustChangePassword">,
  profile: Pick<User, "profileCompleted"> | null,
  next?: string,
): string => {
  if (session.mustChangePassword) return "/change-password";
  if (session.role === "student" && !session.emailVerified) {
    return next ? `/verify-email?next=${encodeURIComponent(next)}` : "/verify-email";
  }
  if (session.role === "student" && profile && !profile.profileCompleted) {
    return next ? `/complete-profile?next=${encodeURIComponent(next)}` : "/complete-profile";
  }
  return next || homeForRole(session.role as UserRole);
};
