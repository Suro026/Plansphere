import * as Sentry from "@sentry/nextjs";

/**
 * Rate limiting for every API route.
 *
 * Three tiers, one policy table (`RATE_LIMIT_POLICY`), overridable per bucket
 * from the environment without a deploy:
 *
 *   auth          — strict: sign-in, sign-up, password reset, verification.
 *                   Limited per IP *and* per account, with exponential
 *                   backoff: exceeding a window earns a temporary block that
 *                   doubles each time (15 s → 30 s → … → 1 h), and decays.
 *                   Nobody is ever locked out permanently.
 *   public        — moderate: certificate/ticket lookups, health, cron.
 *   authenticated — loose: student and admin APIs, per account.
 *
 * Two stores: Upstash Redis (shared across serverless instances) when
 * UPSTASH_REDIS_REST_URL/TOKEN are set, else per-instance memory. Failing
 * open is deliberate — a store outage must not lock every user out.
 *
 * Every refusal is logged as one `[ratelimit]` JSON line; repeated
 * penalties on one key are reported to Sentry as a probable attack.
 */

/* ───────────── policy ───────────── */

export interface RateLimitRule {
  /** Stable name: tier.bucket, also the log/metric key. */
  bucket: string;
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * Exponential backoff after the window is exceeded: the first overage
   * blocks for `baseSeconds`, the next for double, up to `maxSeconds`.
   * Strikes decay after `maxSeconds * 2` without a new overage.
   */
  backoff?: { baseSeconds: number; maxSeconds: number };
}

type Tier = "auth" | "public" | "authenticated";

const AUTH_BACKOFF = { baseSeconds: 15, maxSeconds: 60 * 60 };

/**
 * Defaults. Override any entry with the RATE_LIMIT_OVERRIDES env var, a JSON
 * object keyed by bucket, e.g.
 *   {"auth.login":{"limit":10,"windowSeconds":900},"public.verify":{"limit":120}}
 */
const DEFAULT_POLICY = {
  auth: {
    /** Sign-in attempts. Per IP and per email. Failures add strikes. */
    login: { bucket: "auth.login", limit: 5, windowSeconds: 15 * 60, backoff: AUTH_BACKOFF },
    /** Account creation. Per IP and per email. */
    signup: { bucket: "auth.signup", limit: 3, windowSeconds: 60 * 60, backoff: AUTH_BACKOFF },
    /** Password-reset email. Per IP and per email. */
    passwordReset: { bucket: "auth.password-reset", limit: 3, windowSeconds: 15 * 60, backoff: AUTH_BACKOFF },
    /** Verification email resend. Per IP and per account. */
    verification: { bucket: "auth.verification", limit: 3, windowSeconds: 15 * 60, backoff: AUTH_BACKOFF },
    /** The throttle endpoint itself, per IP, so it cannot be used to probe. */
    attempt: { bucket: "auth.attempt", limit: 60, windowSeconds: 60 },
  },
  public: {
    verify: { bucket: "public.verify", limit: 60, windowSeconds: 60 },
    health: { bucket: "public.health", limit: 30, windowSeconds: 60 },
    cron: { bucket: "public.cron", limit: 10, windowSeconds: 60 },
    /** Payment-provider webhooks. Signature-checked, so this only bounds abuse of the endpoint. */
    webhook: { bucket: "public.webhook", limit: 300, windowSeconds: 60 },
    /** Anything public without its own rule. */
    default: { bucket: "public.default", limit: 60, windowSeconds: 60 },
  },
  authenticated: {
    /** Registering, team changes, cancelling — per account. */
    registration: { bucket: "authenticated.registration", limit: 20, windowSeconds: 60 },
    /** Fan-outs that email people. */
    announcement: { bucket: "authenticated.announcement", limit: 5, windowSeconds: 10 * 60 },
    /** Certificate generation and delivery runs. */
    certificates: { bucket: "authenticated.certificates", limit: 6, windowSeconds: 10 * 60 },
    /** Staff account creation and invites. */
    staff: { bucket: "authenticated.staff", limit: 20, windowSeconds: 10 * 60 },
    /** Self-service event registration — the one route that lets any signed-in account create platform content. */
    registerEvent: { bucket: "authenticated.register-event", limit: 3, windowSeconds: 24 * 60 * 60 },
    /** Image uploads: each one decodes and re-encodes on the server. */
    uploads: { bucket: "authenticated.uploads", limit: 20, windowSeconds: 10 * 60 },
    /** Registration exports: reads the whole fest's roster, builds a file. */
    exports: { bucket: "authenticated.exports", limit: 20, windowSeconds: 10 * 60 },
    /** Starting or resuming a checkout: calls the payment provider. */
    checkout: { bucket: "authenticated.checkout", limit: 10, windowSeconds: 60 },
    /** Everything else a signed-in student or admin does. */
    default: { bucket: "authenticated.default", limit: 240, windowSeconds: 60 },
  },
} satisfies Record<Tier, Record<string, RateLimitRule>>;

export type RateLimitPolicy = typeof DEFAULT_POLICY;

/**
 * The live policy. One set of rule objects for the process lifetime, so a
 * route that captured `RATE_LIMITS.auth.login` at import time sees overrides
 * applied later (env changes, tests): overrides are written *into* the
 * existing objects rather than replacing them.
 */
const POLICY: RateLimitPolicy = structuredClone(DEFAULT_POLICY);
let applied = false;

const applyOverrides = () => {
  const defaults = DEFAULT_POLICY as Record<string, Record<string, RateLimitRule>>;
  const live = POLICY as Record<string, Record<string, RateLimitRule>>;
  let overrides: Record<string, Partial<Pick<RateLimitRule, "limit" | "windowSeconds" | "backoff">>> = {};
  const raw = process.env.RATE_LIMIT_OVERRIDES;
  if (raw) {
    try {
      overrides = JSON.parse(raw) as typeof overrides;
    } catch (error) {
      console.warn("[ratelimit] RATE_LIMIT_OVERRIDES is not valid JSON; using defaults:", error instanceof Error ? error.message : error);
    }
  }
  for (const [tier, rules] of Object.entries(defaults)) {
    for (const [name, base] of Object.entries(rules)) {
      const rule = live[tier]![name]!;
      rule.limit = base.limit;
      rule.windowSeconds = base.windowSeconds;
      if (base.backoff) rule.backoff = { ...base.backoff };
      else delete rule.backoff;
      const o = overrides[rule.bucket];
      if (!o) continue;
      if (typeof o.limit === "number" && o.limit > 0) rule.limit = Math.floor(o.limit);
      if (typeof o.windowSeconds === "number" && o.windowSeconds > 0) rule.windowSeconds = Math.floor(o.windowSeconds);
      if (o.backoff && typeof o.backoff === "object") rule.backoff = { ...(rule.backoff ?? AUTH_BACKOFF), ...o.backoff };
    }
  }
  applied = true;
};

/** The active policy: defaults with RATE_LIMIT_OVERRIDES applied. */
export const rateLimitPolicy = (): RateLimitPolicy => {
  if (!applied) applyOverrides();
  return POLICY;
};

/** Re-read RATE_LIMIT_OVERRIDES (tests; an operator can also call it via a redeploy). */
export const resetRateLimitPolicy = () => {
  applyOverrides();
};

/** Convenience accessor used by routes: `RATE_LIMITS.auth.login` etc. */
export const RATE_LIMITS: RateLimitPolicy = new Proxy({} as RateLimitPolicy, {
  get: (_t, tier) => rateLimitPolicy()[tier as Tier],
});

/* ───────────── store ───────────── */

interface Penalty {
  strikes: number;
  blockedUntil: number;
}

interface Store {
  name: "upstash" | "memory";
  /** Counts a hit in the fixed window; returns the count and seconds to reset. */
  hit(key: string, windowSeconds: number): Promise<{ count: number; ttl: number }>;
  getPenalty(key: string): Promise<Penalty | null>;
  setPenalty(key: string, penalty: Penalty, ttlSeconds: number): Promise<void>;
  clear(keys: string[]): Promise<void>;
}

const windows = new Map<string, { count: number; resetAt: number }>();
const penalties = new Map<string, { penalty: Penalty; expiresAt: number }>();
let lastSweep = 0;

const memoryStore: Store = {
  name: "memory",
  async hit(key, windowSeconds) {
    const now = Date.now();
    if (now - lastSweep > 60_000) {
      for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
      for (const [k, v] of penalties) if (v.expiresAt <= now) penalties.delete(k);
      lastSweep = now;
    }
    const entry = windows.get(key);
    const current = entry && entry.resetAt > now ? entry : { count: 0, resetAt: now + windowSeconds * 1000 };
    current.count += 1;
    windows.set(key, current);
    return { count: current.count, ttl: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  },
  async getPenalty(key) {
    const p = penalties.get(key);
    if (!p || p.expiresAt <= Date.now()) return null;
    return p.penalty;
  },
  async setPenalty(key, penalty, ttlSeconds) {
    penalties.set(key, { penalty, expiresAt: Date.now() + ttlSeconds * 1000 });
  },
  async clear(keys) {
    for (const k of keys) {
      windows.delete(k);
      penalties.delete(k);
    }
  },
};

const upstash = (): { url: string; token: string } | null => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
};

const redis = async (commands: unknown[][]): Promise<Array<{ result?: unknown }> | null> => {
  const cfg = upstash();
  if (!cfg) return null;
  try {
    const res = await fetch(`${cfg.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return (await res.json()) as Array<{ result?: unknown }>;
  } catch {
    return null;
  }
};

const upstashStore: Store = {
  name: "upstash",
  async hit(key, windowSeconds) {
    const rows = await redis([
      ["INCR", key],
      ["EXPIRE", key, String(windowSeconds), "NX"],
      ["TTL", key],
    ]);
    if (!rows) throw new Error("upstash unavailable");
    return { count: Number(rows[0]?.result ?? 0), ttl: Math.max(1, Number(rows[2]?.result ?? windowSeconds)) };
  },
  async getPenalty(key) {
    const rows = await redis([["GET", key]]);
    if (!rows) throw new Error("upstash unavailable");
    const raw = rows[0]?.result;
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw) as Penalty;
    } catch {
      return null;
    }
  },
  async setPenalty(key, penalty, ttlSeconds) {
    const rows = await redis([["SET", key, JSON.stringify(penalty), "EX", String(ttlSeconds)]]);
    if (!rows) throw new Error("upstash unavailable");
  },
  async clear(keys) {
    if (keys.length) await redis([["DEL", ...keys]]);
  },
};

const store = (): Store => (upstash() ? upstashStore : memoryStore);

/* ───────────── core ───────────── */

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the caller may try again (window reset, or end of a backoff block). */
  retryAfter: number;
  store: Store["name"];
  /** Present when a backoff block is in force or was just applied. */
  strikes?: number;
  bucket: string;
  subject: string;
}

const keyFor = (rule: RateLimitRule, subject: string) => `rl:${rule.bucket}:${subject}`;
const penaltyKeyFor = (rule: RateLimitRule, subject: string) => `rlp:${rule.bucket}:${subject}`;

const allowedResult = (rule: RateLimitRule, subject: string, remaining: number, ttl: number, name: Store["name"]): RateLimitResult => ({
  allowed: true,
  limit: rule.limit,
  remaining,
  retryAfter: ttl,
  store: name,
  bucket: rule.bucket,
  subject,
});

/**
 * One check against one rule for one subject. Auth-tier rules with `backoff`
 * escalate a temporary block on each overage instead of counting forever.
 */
export const rateLimit = async (rule: RateLimitRule, subject: string): Promise<RateLimitResult> => {
  // RATE_LIMIT_DISABLED=1 switches limiting off: the test suite hammers one
  // user from one process, and an operator may need it during an incident.
  if (process.env.RATE_LIMIT_DISABLED === "1") return allowedResult(rule, subject, rule.limit, rule.windowSeconds, "memory");

  const s = store();
  const now = Date.now();
  try {
    if (rule.backoff) {
      const penalty = await s.getPenalty(penaltyKeyFor(rule, subject));
      if (penalty && penalty.blockedUntil > now) {
        return { ...allowedResult(rule, subject, 0, Math.ceil((penalty.blockedUntil - now) / 1000), s.name), allowed: false, strikes: penalty.strikes };
      }
    }

    const { count, ttl } = await s.hit(keyFor(rule, subject), rule.windowSeconds);
    if (count <= rule.limit) return allowedResult(rule, subject, rule.limit - count, ttl, s.name);

    if (!rule.backoff) return { ...allowedResult(rule, subject, 0, ttl, s.name), allowed: false };

    // Over the limit on a backoff rule. Attempts made *during* a block never
    // reach here (returned above), so every arrival here is a fresh overage:
    // one more strike, and the block doubles.
    const previous = await s.getPenalty(penaltyKeyFor(rule, subject));
    const effective = (previous?.strikes ?? 0) + 1;
    const blockSeconds = Math.min(rule.backoff.maxSeconds, rule.backoff.baseSeconds * 2 ** (effective - 1));
    const penalty: Penalty = { strikes: effective, blockedUntil: now + blockSeconds * 1000 };
    await s.setPenalty(penaltyKeyFor(rule, subject), penalty, rule.backoff.maxSeconds * 2);
    if (effective >= 4) {
      Sentry.captureMessage(`Repeated rate-limit penalties on ${rule.bucket}`, { level: "warning", tags: { kind: "ratelimit", bucket: rule.bucket }, extra: { subject, strikes: effective, blockSeconds } });
    }
    return { ...allowedResult(rule, subject, 0, blockSeconds, s.name), allowed: false, strikes: effective };
  } catch (error) {
    // Store trouble: let the request through, but say so.
    console.warn("[ratelimit]", JSON.stringify({ event: "store-error", bucket: rule.bucket, error: error instanceof Error ? error.message : String(error) }));
    return allowedResult(rule, subject, rule.limit, rule.windowSeconds, s.name);
  }
};

/**
 * Checks several (rule, subject) pairs — e.g. per IP and per account — and
 * returns the first refusal, else the tightest remaining budget.
 */
export const rateLimitAll = async (checks: Array<{ rule: RateLimitRule; subject: string | null }>): Promise<RateLimitResult | null> => {
  let tightest: RateLimitResult | null = null;
  for (const { rule, subject } of checks) {
    if (!subject) continue;
    const result = await rateLimit(rule, subject);
    if (!result.allowed) return result;
    if (!tightest || result.remaining < tightest.remaining) tightest = result;
  }
  return tightest;
};

/** A strike on an auth key without a request — a failed sign-in reported by the client. */
export const recordAuthFailure = async (rule: RateLimitRule, subject: string): Promise<RateLimitResult> => rateLimit(rule, subject);

/** Clears window and penalty for the subjects — after a successful sign-in. */
export const clearRateLimit = async (rule: RateLimitRule, subjects: string[]): Promise<void> => {
  const keys = subjects.flatMap((subject) => [keyFor(rule, subject), penaltyKeyFor(rule, subject)]);
  await store()
    .clear(keys)
    .catch(() => undefined);
};

/* ───────────── request helpers ───────────── */

/** Best-effort client IP behind Vercel's proxy. */
export const clientIp = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || "unknown";
};

/** Subjects are hashed-ish: lowercase, trimmed, never logged raw for emails. */
export const accountSubject = (email: string): string => `acct:${email.trim().toLowerCase()}`;
export const ipSubject = (request: Request): string => `ip:${clientIp(request)}`;
export const uidSubject = (uid: string): string => `uid:${uid}`;

/** Standard headers so clients (and humans reading curl output) can see the budget. */
export const rateLimitHeaders = (result: RateLimitResult): Record<string, string> => ({
  "RateLimit-Limit": String(result.limit),
  "RateLimit-Remaining": String(result.remaining),
  "RateLimit-Reset": String(result.retryAfter),
  "RateLimit-Policy": `${result.limit};w=${result.retryAfter}`,
  ...(result.allowed ? {} : { "Retry-After": String(result.retryAfter) }),
});

/** Human copy for a 429, with the wait spelled out. */
export const retryMessage = (result: RateLimitResult): string => {
  const s = result.retryAfter;
  const wait = s < 60 ? `${s} second${s === 1 ? "" : "s"}` : s < 3600 ? `${Math.ceil(s / 60)} minute${Math.ceil(s / 60) === 1 ? "" : "s"}` : `${Math.ceil(s / 3600)} hour${Math.ceil(s / 3600) === 1 ? "" : "s"}`;
  return result.strikes ? `Too many attempts. Try again in ${wait}.` : `Too many requests. Try again in ${wait}.`;
};

/** One structured line per refusal — what alerts and dashboards key on. */
export const logRateLimited = (result: RateLimitResult, request: Request, requestId: string): void => {
  const url = new URL(request.url);
  console.warn(
    "[ratelimit]",
    JSON.stringify({
      event: "refused",
      id: requestId,
      bucket: result.bucket,
      // Emails are redacted; ips and uids are what an operator needs.
      subject: result.subject.startsWith("acct:") ? "acct:<redacted>" : result.subject,
      method: request.method,
      path: url.pathname,
      retryAfter: result.retryAfter,
      strikes: result.strikes ?? 0,
      store: result.store,
    }),
  );
};
