import { memberCan, type Membership } from "./models/membership";

/**
 * Who may be rostered to score at an arena.
 *
 * A person works a fest in one of two ways, and `festAccess` (core/access.ts) says which one governs: an active
 * membership wins over the account's legacy fest scope. The arena picker and the assignment route both ask this one
 * function, so what the admin is offered is exactly what the server will accept.
 *
 *  - "event": an active membership whose role is volunteer and whose duties include scoring. The sub-events they may
 *             score are the membership's own business; the arena shift only says WHERE.
 *  - "fest":  no active membership on this fest, and a volunteer account scoped to it by the profile's `festIds`.
 *
 * Anyone else - a student, an admin (who scores without a shift), a platform account, a disabled account, a suspended or
 * revoked member, a volunteer whose membership has no scoring duty - is not offered and is refused.
 */

export type ScorerSource = "event" | "fest";

export interface ScorerProfile {
  role?: unknown;
  festIds?: unknown;
  disabled?: unknown;
}

export const scorerSource = (
  festId: string,
  profile: ScorerProfile | null | undefined,
  membership: Pick<Membership, "role" | "duties" | "status"> | null | undefined,
): ScorerSource | null => {
  if (!profile || profile.disabled === true) return null;
  if (profile.role === "super_admin") return null;

  // An active membership governs this fest by itself, whatever the profile says. A suspended or revoked one carries no
  // authority and is read as absent, which leaves the legacy scope (if any) as it was.
  if (membership && membership.status === "active") {
    return membership.role === "volunteer" && memberCan(membership, "match:score") ? "event" : null;
  }

  const legacyRole = profile.role === "organizer" ? "volunteer" : profile.role;
  const festIds = Array.isArray(profile.festIds) ? (profile.festIds as unknown[]) : [];
  return legacyRole === "volunteer" && festIds.includes(festId) ? "fest" : null;
};
