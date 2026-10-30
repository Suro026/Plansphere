import { hasAtLeast, type UserRole } from "./permissions";

/**
 * What goes into an account's sign-in token, and how it stays inside Firebase's limit.
 *
 * Firebase caps custom claims at 1,000 bytes. A fest id is 20 characters, so an account that manages many events cannot
 * carry them all as a list. The claims are only ever a HINT, though: the rules and the API take their authority from the
 * membership documents (`festMembers/{fest}__{uid}`), read live. So the strategy has two modes, and neither weakens
 * anything:
 *
 *  - inline: the fests the account holds an event role on are listed in `fm`. The rules know without a read which fests to
 *    check a membership for. Cheapest; used while the list fits.
 *  - lookup: the list is too long, so `fx: true` replaces it. The rules then look for the membership document of whichever
 *    fest is being asked about (one extra read, only for these accounts). Same authority, no list.
 *
 * What cannot be shrunk is the legacy `festIds` list (the pre-membership scope), because the older rules read it straight
 * from the token. An account whose legacy list alone will not fit is refused with an instruction to move it to event roles,
 * rather than being given a truncated list that silently drops access.
 *
 * `role` is what the app lets the account into (raised for an event role); `br` is what the account itself is, which is
 * what the older rules read. Neither is ever `super_admin` unless the account already was.
 */

/** Firebase's hard limit on the serialized claims. */
export const CLAIMS_LIMIT_BYTES = 1000;
/** What we allow ourselves, leaving headroom for a claim Firebase or a later change adds. */
export const CLAIMS_BUDGET_BYTES = 900;
/** Past this many event roles the list is not carried in the token, even if it would fit. */
export const MAX_INLINE_MEMBERSHIPS = 8;

export class ClaimsTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`The sign-in claims would be ${bytes} bytes; the limit is ${CLAIMS_LIMIT_BYTES}.`);
    this.name = "ClaimsTooLargeError";
  }
}

export interface ClaimsInput {
  /** The account's own role (profile), before any event role raises it. */
  role: UserRole;
  /** Its legacy, pre-membership fest scope. */
  festIds: readonly string[];
  /** The fests it holds an active event role on. */
  memberFestIds: readonly string[];
  /** The role the memberships need, if any: `admin` for a head, admin or coordinator; `volunteer` for a volunteer. */
  ceiling?: UserRole | undefined;
  mustChangePassword?: boolean | undefined;
}

export interface BuiltClaims {
  claims: Record<string, unknown>;
  /** True when the memberships are looked up by the rules rather than listed in the token. */
  lookup: boolean;
  bytes: number;
}

const sizeOf = (claims: Record<string, unknown>): number => new TextEncoder().encode(JSON.stringify(claims)).length;

export const buildClaims = (input: ClaimsInput): BuiltClaims => {
  const members = Array.from(new Set(input.memberFestIds));
  const raised = input.ceiling && !hasAtLeast(input.role, input.ceiling) ? input.ceiling : input.role;

  const base: Record<string, unknown> = {
    role: raised,
    ...(members.length > 0 ? { br: input.role } : {}),
    festIds: [...input.festIds],
    ...(input.mustChangePassword ? { mustChangePassword: true } : {}),
  };
  if (members.length === 0) {
    const bytes = sizeOf(base);
    if (bytes > CLAIMS_BUDGET_BYTES) throw new ClaimsTooLargeError(bytes);
    return { claims: base, lookup: false, bytes };
  }

  const inline = { ...base, fm: members };
  const inlineBytes = sizeOf(inline);
  if (members.length <= MAX_INLINE_MEMBERSHIPS && inlineBytes <= CLAIMS_BUDGET_BYTES) return { claims: inline, lookup: false, bytes: inlineBytes };

  const lookup = { ...base, fx: true };
  const bytes = sizeOf(lookup);
  if (bytes > CLAIMS_BUDGET_BYTES) throw new ClaimsTooLargeError(bytes);
  return { claims: lookup, lookup: true, bytes };
};

/**
 * Does a token already carry what `buildClaims` would write now? Used to notice a token that predates a grant or a
 * revocation, so the client can be told to sign in fresh. Only the event-role part is compared.
 */
export const memberClaimsInSync = (token: { fm?: unknown; fx?: unknown; br?: unknown }, expected: BuiltClaims["claims"]): boolean => {
  const sameList = (a: unknown, b: unknown) => {
    const left = Array.isArray(a) ? [...a].map(String).sort() : [];
    const right = Array.isArray(b) ? [...b].map(String).sort() : [];
    return left.length === right.length && left.every((id, i) => id === right[i]);
  };
  return sameList(token.fm, expected.fm) && (token.fx === true) === (expected.fx === true) && (token.br ?? null) === (expected.br ?? null);
};
