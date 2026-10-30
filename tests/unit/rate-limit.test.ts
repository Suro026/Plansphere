import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountSubject,
  clearRateLimit,
  clientIp,
  rateLimit,
  rateLimitAll,
  rateLimitHeaders,
  rateLimitPolicy,
  resetRateLimitPolicy,
  retryMessage,
} from "@/server/rate-limit";

const unique = (bucket: string) => `${bucket}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

describe("rateLimit (memory store)", () => {
  beforeEach(() => {
    delete process.env.RATE_LIMIT_DISABLED;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });
  afterEach(() => {
    process.env.RATE_LIMIT_DISABLED = "1";
    vi.useRealTimers();
  });

  it("allows up to the limit, then refuses with Retry-After and RateLimit-* headers", async () => {
    const rule = { bucket: unique("t"), limit: 3, windowSeconds: 60 };
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await rateLimit(rule, "user-a"));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]!.remaining).toBe(0);
    const h = rateLimitHeaders(results[3]!);
    expect(h["Retry-After"]).toBeDefined();
    expect(h["RateLimit-Limit"]).toBe("3");
    expect(h["RateLimit-Remaining"]).toBe("0");
    expect(rateLimitHeaders(results[0]!)["Retry-After"]).toBeUndefined();
  });

  it("keys by subject, so one caller cannot exhaust another's budget", async () => {
    const rule = { bucket: unique("s"), limit: 1, windowSeconds: 60 };
    expect((await rateLimit(rule, "a")).allowed).toBe(true);
    expect((await rateLimit(rule, "a")).allowed).toBe(false);
    expect((await rateLimit(rule, "b")).allowed).toBe(true);
  });

  it("applies exponential backoff on auth rules and never locks out permanently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T10:00:00Z"));
    const rule = { bucket: unique("b"), limit: 2, windowSeconds: 60, backoff: { baseSeconds: 15, maxSeconds: 120 } };

    await rateLimit(rule, "acct:x");
    await rateLimit(rule, "acct:x");
    const first = await rateLimit(rule, "acct:x"); // 1st overage → 15 s block
    expect(first.allowed).toBe(false);
    expect(first.strikes).toBe(1);
    expect(first.retryAfter).toBe(15);

    // Still blocked 10 s later, with the remaining wait reported.
    vi.advanceTimersByTime(10_000);
    const still = await rateLimit(rule, "acct:x");
    expect(still.allowed).toBe(false);
    expect(still.retryAfter).toBe(5);

    // Block over, but the window is still full → 2nd overage → 30 s.
    vi.advanceTimersByTime(6_000);
    const second = await rateLimit(rule, "acct:x");
    expect(second.allowed).toBe(false);
    expect(second.strikes).toBe(2);
    expect(second.retryAfter).toBe(30);

    // A fresh window after the block: allowed again — no permanent lockout.
    vi.advanceTimersByTime(61_000);
    expect((await rateLimit(rule, "acct:x")).allowed).toBe(true);
  });

  it("caps the backoff at maxSeconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T10:00:00Z"));
    const rule = { bucket: unique("c"), limit: 1, windowSeconds: 1, backoff: { baseSeconds: 15, maxSeconds: 40 } };
    let last = 0;
    for (let i = 0; i < 5; i += 1) {
      await rateLimit(rule, "acct:y"); // fills the 1-request window
      const over = await rateLimit(rule, "acct:y");
      expect(over.allowed).toBe(false);
      last = over.retryAfter;
      vi.advanceTimersByTime((over.retryAfter + 2) * 1000);
    }
    expect(last).toBe(40);
  });

  it("clearRateLimit forgets both the window and the penalty", async () => {
    const rule = { bucket: unique("r"), limit: 1, windowSeconds: 60, backoff: { baseSeconds: 15, maxSeconds: 60 } };
    await rateLimit(rule, "acct:z");
    expect((await rateLimit(rule, "acct:z")).allowed).toBe(false);
    await clearRateLimit(rule, ["acct:z"]);
    expect((await rateLimit(rule, "acct:z")).allowed).toBe(true);
  });

  it("rateLimitAll returns the first refusal across per-IP and per-account keys", async () => {
    const rule = { bucket: unique("m"), limit: 1, windowSeconds: 60 };
    await rateLimit(rule, "ip:1.1.1.1");
    const r = await rateLimitAll([
      { rule, subject: "ip:1.1.1.1" },
      { rule, subject: accountSubject("Someone@Example.com") },
    ]);
    expect(r?.allowed).toBe(false);
    expect(r?.subject).toBe("ip:1.1.1.1");
    expect(accountSubject("Someone@Example.com ")).toBe("acct:someone@example.com");
  });

  it("can be switched off for incidents and tests", async () => {
    process.env.RATE_LIMIT_DISABLED = "1";
    const rule = { bucket: unique("o"), limit: 1, windowSeconds: 60 };
    expect((await rateLimit(rule, "a")).allowed).toBe(true);
    expect((await rateLimit(rule, "a")).allowed).toBe(true);
  });

  it("phrases the wait for humans", () => {
    const base = { allowed: false, limit: 5, remaining: 0, store: "memory" as const, bucket: "x", subject: "y" };
    expect(retryMessage({ ...base, retryAfter: 45 })).toBe("Too many requests. Try again in 45 seconds.");
    expect(retryMessage({ ...base, retryAfter: 600, strikes: 2 })).toBe("Too many attempts. Try again in 10 minutes.");
    expect(retryMessage({ ...base, retryAfter: 3600, strikes: 6 })).toBe("Too many attempts. Try again in 1 hour.");
  });

  it("reads the first x-forwarded-for hop", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } }))).toBe("203.0.113.9");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});

describe("rateLimitPolicy", () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_OVERRIDES;
    resetRateLimitPolicy();
  });

  it("is tiered: auth stricter than public, public stricter than authenticated", () => {
    const p = rateLimitPolicy();
    expect(p.auth.login.limit).toBeLessThan(p.public.default.limit);
    expect(p.public.default.limit).toBeLessThan(p.authenticated.default.limit);
    expect(p.auth.login.backoff).toBeDefined();
    expect(p.auth.passwordReset.backoff).toBeDefined();
    expect((p.public.verify as { backoff?: unknown }).backoff).toBeUndefined();
  });

  it("takes per-bucket overrides from RATE_LIMIT_OVERRIDES and ignores junk", () => {
    process.env.RATE_LIMIT_OVERRIDES = JSON.stringify({ "auth.login": { limit: 9, windowSeconds: 120 }, "public.verify": { limit: -5 }, "nope.bucket": { limit: 1 } });
    resetRateLimitPolicy();
    const p = rateLimitPolicy();
    expect(p.auth.login.limit).toBe(9);
    expect(p.auth.login.windowSeconds).toBe(120);
    expect(p.auth.login.backoff).toBeDefined(); // untouched
    expect(p.public.verify.limit).toBe(60); // negative ignored

    process.env.RATE_LIMIT_OVERRIDES = "{not json";
    resetRateLimitPolicy();
    expect(rateLimitPolicy().auth.login.limit).toBe(5);
  });
});
