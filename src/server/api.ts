import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { decideAccess } from "@/core/access";
import { memberCeiling, type Membership } from "@/core/models/membership";
import { PLATFORM_DENIAL_MESSAGES, type PlatformDenial } from "@/core/platform";
import { USER_ROLES, can, hasAtLeast, type Permission, type UserRole } from "@/core/permissions";
import {
  AdminNotConfiguredError,
  COLLECTIONS,
  adminAuth,
  adminDb,
} from "./firebase-admin";
import { appCheckMode, verifyAppCheck } from "./app-check";
import { loadActiveMemberships } from "./membership-store";
import { resolvePlatform } from "./platform-boundary";
import { ApiError, describeError, fieldErrors, logError, toClientError } from "./errors";
import {
  accountSubject,
  clientIp,
  ipSubject,
  logRateLimited,
  rateLimitAll,
  rateLimitHeaders,
  rateLimitPolicy,
  retryMessage,
  uidSubject,
  type RateLimitRule,
} from "./rate-limit";

/**
 * Shared plumbing for the privileged API routes.
 *
 * Every route in `app/api` runs with Admin credentials, so authorisation is
 * not optional and must not be re-implemented per route. `requireRole` is the
 * single gate: it verifies the caller's Firebase ID token, confirms the
 * account is still active, and checks the role — all before the handler body
 * runs.
 */

export { ApiError, PUBLIC_MESSAGES } from "./errors";

export interface Caller {
  uid: string;
  email: string;
  emailVerified: boolean;
  /**
   * The account's OWN role, as its profile and token say. Event memberships never change it: a volunteer at one fest who
   * is Event Head of another is still a volunteer at the first, and every older scope check reads this.
   */
  role: UserRole;
  /**
   * The role the coarse API gate (`requirePermission`, `requireRole`) lets this account through as: its own, raised to
   * what its event memberships need, never to `super_admin`. What it may do on a given fest is `requireFestAccess`.
   */
  ceiling: UserRole;
  /** Fests a pre-membership (legacy) account is scoped to. Ignored for a super admin. */
  festIds: string[];
  /** Active event-level memberships, by fest id. The authority for every fest listed here. */
  memberships: Record<string, Membership>;
  /** The permission this request was authorised under, set by `requirePermission`. */
  permission?: Permission;
  /** The event-role claims the token carries (`fm`, `fx`, `br`), so a token that predates a grant can be noticed. */
  tokenClaims: { fm?: unknown; fx?: unknown; br?: unknown };
  /**
   * Set when the account's token says `super_admin` but the platform boundary refused it (not on the registry, suspended, or
   * no second factor). `role` and `ceiling` have then already been lowered to what an ordinary account is.
   */
  platformDenied?: PlatformDenial;
  /** True while a temporary password is still in force. */
  mustChangePassword: boolean;
  profileCompleted: boolean;
}

/**
 * Resolves the caller from the `Authorization: Bearer <idToken>` header.
 *
 * `checkRevoked` is on deliberately. It costs an extra lookup, but without it
 * a token stays usable for up to an hour after a super admin disables the
 * account — which is exactly the window in which someone would be trying to
 * use it.
 */
export const authenticate = async (request: Request): Promise<Caller> => {
  const header = request.headers.get("authorization") ?? "";

  if (!header.toLowerCase().startsWith("bearer ")) {
    throw ApiError.unauthorized();
  }

  const token = header.slice(7).trim();

  if (!token) throw ApiError.unauthorized();

  let decoded;

  try {
    decoded = await adminAuth().verifyIdToken(token, true);
  } catch (error) {
    if (error instanceof AdminNotConfiguredError) throw error;
    // Expired, malformed, revoked, or issued by a different project.
    throw ApiError.unauthorized("Your session has expired. Sign in again.");
  }

  // The token's `role` claim is authoritative, but a disabled account must be
  // shut out immediately, so the user document is read on every privileged
  // call rather than trusting the claim alone.
  const snapshot = await adminDb().collection(COLLECTIONS.users).doc(decoded.uid).get();

  if (!snapshot.exists) {
    throw ApiError.forbidden("Your account is not set up. Contact an organizer.");
  }

  const data = snapshot.data() ?? {};

  if (data.disabled === true) {
    throw ApiError.forbidden("This account has been disabled.");
  }

  // "organizer" was the old name for what is now "volunteer"; a token minted
  // before the refactor still carries it until it is refreshed.
  const readRole = (value: unknown): UserRole | undefined =>
    value === "organizer" ? "volunteer" : USER_ROLES.includes(value as UserRole) ? (value as UserRole) : undefined;

  const claimRole = readRole(decoded.role);
  const docRole = readRole(data.role);

  // If the two disagree, take the weaker of them. A mirror that drifted must
  // never be able to grant more than the token does, and vice versa.
  let role: UserRole =
    claimRole && docRole
      ? hasAtLeast(claimRole, docRole)
        ? docRole
        : claimRole
      : (claimRole ?? docRole ?? "student");

  // The platform boundary. "super_admin" is the platform team, and once the boundary is enforced the role alone is not
  // enough: the account must also be on the platform registry (and, when required, have signed in with a second factor).
  // One that is not is an ordinary account from here on - every gate below sees a student - and the reason is kept so the
  // refusal can say why. Only an account that already is a super admin is looked up, so nobody else pays for the read.
  let platformDenied: PlatformDenial | undefined;
  if (role === "super_admin") {
    const secondFactor = (decoded.firebase as { sign_in_second_factor?: string } | undefined)?.sign_in_second_factor;
    const decision = await resolvePlatform(decoded.uid, secondFactor);
    if (!decision.ok) {
      platformDenied = decision.reason;
      role = "student";
    }
  }

  // Scope comes from the document, not the claim: a super admin reassigning
  // fests must take effect without waiting for the token to refresh, and the
  // document is re-read on every privileged call anyway.
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? (value as unknown[]).filter((id): id is string => typeof id === "string") : [];
  const festIds = data.festIds !== undefined ? strings(data.festIds) : strings(data.organizer?.festIds);

  // Event-level memberships are read live, never from the token: a grant takes effect on the next request and a
  // suspension or revocation on the very next one. The profile's `memberOf` mirror (written only by the server) just
  // saves the query for the many accounts that hold none.
  const memberships: Record<string, Membership> = {};
  if (strings(data.memberOf).length > 0) {
    for (const member of await loadActiveMemberships(decoded.uid)) memberships[member.festId] = member;
  }
  const memberRole = memberCeiling(Object.values(memberships));
  const ceiling: UserRole = memberRole && !hasAtLeast(role, memberRole) ? memberRole : role;

  return {
    uid: decoded.uid,
    email: (decoded.email ?? data.email ?? "").toLowerCase(),
    emailVerified: decoded.email_verified === true,
    role,
    ceiling,
    festIds,
    memberships,
    tokenClaims: { fm: decoded.fm, fx: decoded.fx, br: decoded.br },
    ...(platformDenied ? { platformDenied } : {}),
    mustChangePassword: data.mustChangePassword === true,
    profileCompleted: data.profileCompleted === true,
  };
};

/** The refusal for a caller who is short of a role or permission - says why when the platform boundary is the reason. */
const refusal = (caller: Caller): ApiError => ApiError.forbidden(caller.platformDenied ? PLATFORM_DENIAL_MESSAGES[caller.platformDenied] : undefined);

/**
 * A temporary password may do exactly one thing: become a real one.
 *
 * Staff accounts are created with a mailed password, so until it is changed
 * the account is treated as not yet in the hands of its owner. Every route
 * except the password change itself refuses.
 */
export const requirePasswordChanged = (caller: Caller): void => {
  if (caller.mustChangePassword) {
    throw new ApiError(403, "must-change-password", "Set a new password before continuing. You are signed in with a temporary one.");
  }
};

/**
 * Authenticates, then enforces a minimum role.
 *
 * Prefer `requirePermission` for anything but a coarse area guard: a rank
 * says who is senior, a permission says who may act.
 */
export const requireRole = async (request: Request, minimum: UserRole): Promise<Caller> => {
  const caller = await authenticate(request);

  if (!hasAtLeast(caller.ceiling, minimum)) {
    throw refusal(caller);
  }
  requirePasswordChanged(caller);

  return caller;
};

/**
 * Authenticates and checks one capability from the permission matrix,
 * optionally within a fest's scope. This is the check every privileged route
 * should use — it reads the same table the rules and the UI read.
 */
export const requirePermission = async (request: Request, permission: Permission, festId?: string): Promise<Caller> => {
  const caller = await authenticate(request);
  requirePasswordChanged(caller);

  if (!can(caller.ceiling, permission)) throw refusal(caller);
  caller.permission = permission;
  if (festId !== undefined) requireFestAccess(caller, festId);

  return caller;
};

/**
 * True when the caller may act on this fest. A super admin is unscoped;
 * every other staff role is limited to the fests assigned to them.
 */
export const canManageFest = (caller: Caller, festId: string, eventId?: string): boolean =>
  decideAccess(caller, festId, { permission: caller.permission, eventId }).ok;

/**
 * May this caller act on this fest - and, when the route is about one sub-event, on that sub-event?
 *
 * Pass `eventId` from any route that works on a single competition. A caller with a membership other than Event Head is
 * let through only for the sub-events they are assigned and only for permissions their role has; leave `eventId` out and
 * only the head (or the platform, or a legacy fest-wide account) passes. The permission is the one `requirePermission`
 * authorised the request under. See `core/access.ts`.
 */
export const requireFestAccess = (caller: Caller, festId: string, eventId?: string): void => {
  const decision = decideAccess(caller, festId, { permission: caller.permission, eventId });
  if (!decision.ok) throw ApiError.forbidden(decision.reason);
};

/** Parses and validates a JSON body, turning Zod issues into a 400. */
export const readBody = async <T>(request: Request, schema: ZodType<T>): Promise<T> => {
  let raw: unknown;

  try {
    raw = await request.json();
  } catch {
    throw ApiError.badRequest("Expected a JSON body.");
  }

  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    throw ApiError.badRequest("Some fields need fixing.", fieldErrors(parsed.error));
  }

  return parsed.data;
};

/**
 * How a route is rate limited. A single rule is keyed by uid when signed in,
 * else by IP. Auth routes pass several checks — per IP and per account — and
 * the account subject usually comes out of the request body.
 */
export type RateLimitSpec =
  | RateLimitRule
  | Array<{
      rule: RateLimitRule;
      by: "ip" | "uid" | "uid-or-ip" | ((request: Request) => Promise<string | null> | string | null);
    }>
  | false;

export interface HandlerOptions {
  /**
   * Rate limiting for the route. Omitted → the tier default applies
   * (`authenticated.default` keyed by uid for signed-in calls, else
   * `public.default` keyed by IP). `false` opts out (nothing does).
   */
  rateLimit?: RateLimitSpec;
  /** Check the App Check token (monitor or enforce per APP_CHECK_ENFORCE). Default: on for POST/PATCH/DELETE. */
  appCheck?: boolean;
}

/** Reads `email` out of a JSON body without consuming it — for per-account auth limits. */
export const emailFromBody = async (request: Request): Promise<string | null> => {
  try {
    const body = (await request.clone().json()) as { email?: unknown };
    return typeof body.email === "string" && body.email.includes("@") ? accountSubject(body.email) : null;
  } catch {
    return null;
  }
};

const resolveChecks = async (spec: RateLimitSpec | undefined, request: Request, uid: string | null) => {
  if (spec === false) return [];
  const policy = rateLimitPolicy();
  if (spec === undefined) {
    return uid ? [{ rule: policy.authenticated.default, subject: uidSubject(uid) }] : [{ rule: policy.public.default, subject: ipSubject(request) }];
  }
  if (!Array.isArray(spec)) return [{ rule: spec, subject: uid ? uidSubject(uid) : ipSubject(request) }];
  const out: Array<{ rule: RateLimitRule; subject: string | null }> = [];
  for (const { rule, by } of spec) {
    const subject =
      by === "ip" ? ipSubject(request)
      : by === "uid" ? (uid ? uidSubject(uid) : null)
      : by === "uid-or-ip" ? (uid ? uidSubject(uid) : ipSubject(request))
      : await by(request);
    out.push({ rule, subject });
  }
  return out;
};



/** The uid from a bearer token without verifying it — for logs and rate-limit keys only. */
const unverifiedUid = (request: Request): string | null => {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { sub?: string };
    return typeof json.sub === "string" ? json.sub : null;
  } catch {
    return null;
  }
};

/**
 * Wraps a route handler so no route has to write the same plumbing:
 *
 *  - a request id (`x-request-id`, honoured if the client sent one)
 *  - rate limiting and App Check, when asked for
 *  - one structured JSON log line per request (method, path, status, ms,
 *    uid, request id) — what Vercel's log search and alerts key on
 *  - error mapping: ApiError → its status; Admin SDK not configured → 503;
 *    transient Firestore failures → 503 with Retry-After; Zod → 400;
 *    anything else → 500, logged and reported to Sentry with the request id
 *
 * An Admin SDK stack trace can name collections, document ids and the
 * service account, none of which belongs in a client response, so the
 * 500 body is always generic and the request id is the way to find it.
 */
export const handler = (
  fn: (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>,
  options: HandlerOptions = {},
) => {
  return async (request: Request, context: { params: Promise<Record<string, string>> }): Promise<Response> => {
    const started = Date.now();
    const requestId = request.headers.get("x-request-id")?.slice(0, 64) || randomUUID();
    const url = new URL(request.url);
    const uid = unverifiedUid(request);
    let response: Response;
    let extra: Record<string, unknown> = {};

    let budgetHeaders: Record<string, string> = {};
    const finish = (res: Response): Response => {
      res.headers.set("x-request-id", requestId);
      for (const [k, v] of Object.entries(budgetHeaders)) if (!res.headers.has(k)) res.headers.set(k, v);
      const line = { at: "api", id: requestId, method: request.method, path: url.pathname, status: res.status, ms: Date.now() - started, uid, ip: clientIp(request), ...extra };
      (res.status >= 500 ? console.error : res.status >= 400 ? console.warn : console.info)("[api]", JSON.stringify(line));
      return res;
    };

    try {
      const budget = await rateLimitAll(await resolveChecks(options.rateLimit, request, uid));
      if (budget) {
        extra = { ...extra, rl: `${budget.bucket} ${budget.remaining}/${budget.limit}` };
        budgetHeaders = rateLimitHeaders(budget);
        if (!budget.allowed) {
          logRateLimited(budget, request, requestId);
          response = NextResponse.json({ error: retryMessage(budget), code: "rate-limited", retryAfter: budget.retryAfter }, { status: 429, headers: rateLimitHeaders(budget) });
          return finish(response);
        }
      }

      const checkApp = options.appCheck ?? request.method !== "GET";
      if (checkApp) {
        const verdict = await verifyAppCheck(request);
        extra = { ...extra, appCheck: verdict };
        if (appCheckMode() === "enforced" && verdict !== "valid" && verdict !== "skipped") {
          response = NextResponse.json({ error: "This request did not come from the Plansphere app.", code: "app-check" }, { status: 401 });
          return finish(response);
        }
      }

      response = await fn(request, context);
      return finish(response);
    } catch (error) {
      const client = toClientError(error, requestId);
      extra = { ...extra, error: client.kind === "expected" ? `${client.body.code}` : describeError(error).name };
      logError(error, { requestId, method: request.method, path: url.pathname, uid, ip: clientIp(request) }, client.kind);
      return finish(NextResponse.json(client.body, { status: client.status, headers: client.headers }));
    }
  };
};

export const ok = <T>(data: T, status = 200): Response => NextResponse.json(data, { status });
