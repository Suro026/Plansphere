import { buildClaims, memberClaimsInSync } from "@/core/claims";
import { memberCeiling } from "@/core/models/membership";
import { ok, handler, authenticate, requirePasswordChanged } from "@/server/api";
import { syncMemberAccess } from "@/server/membership";

/**
 * GET /api/me/access — the caller's own event roles, for the menus.
 *
 * Read live from the memberships, so a role granted, suspended or revoked a moment ago is what the screens show. It
 * describes the caller to themselves and decides nothing: every route and rule checks for itself.
 *
 * It also repairs a lag. The rules read an event role through the sign-in token's claims, and a token minted before a role
 * was granted (or revoked) does not carry it. When the token and the memberships disagree, the claims are rewritten from
 * the memberships (idempotent, and safe to repeat) and `refreshToken` tells the client to sign in fresh, so the first
 * screen after a grant works without the person having to sign out. If the claims cannot be written (too many events for
 * a token), that is reported as `claimsError` rather than hidden: the API still honours every role.
 */
export const GET = handler(async (request) => {
  const caller = await authenticate(request);
  requirePasswordChanged(caller);

  const members = Object.values(caller.memberships);
  let refreshToken = false;
  let claimsError = false;
  // A super admin the platform boundary has turned away reads as a student here, and their claims would be rewritten from
  // that lowered role; they are not this route's to repair.
  if (!caller.platformDenied) {
    try {
      const expected = buildClaims({
        role: caller.role,
        festIds: caller.festIds,
        memberFestIds: members.map((member) => member.festId),
        ceiling: memberCeiling(members),
        mustChangePassword: caller.mustChangePassword,
      });
      if (!memberClaimsInSync(caller.tokenClaims, expected.claims)) {
        await syncMemberAccess(caller.uid);
        refreshToken = true;
      }
    } catch {
      claimsError = true;
    }
  }

  return ok({
    role: caller.role,
    festIds: caller.festIds,
    refreshToken,
    ...(claimsError ? { claimsError } : {}),
    ...(caller.platformDenied ? { platformDenied: caller.platformDenied } : {}),
    memberships: members.map((member) => ({
      festId: member.festId,
      role: member.role,
      eventIds: member.eventIds,
      duties: member.duties,
    })),
  });
});
