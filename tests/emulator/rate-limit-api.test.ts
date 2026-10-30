import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { resetRateLimitPolicy } from "@/server/rate-limit";
import { POST as passwordReset } from "@/app/api/auth/password-reset/route";
import { POST as attempt } from "@/app/api/auth/attempt/route";
import { POST as register } from "@/app/api/registrations/route";
import { GET as verify } from "@/app/api/verify/[number]/route";
import { GET as staffList } from "@/app/api/admin/staff/route";
import { callRoute, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * Rate limiting through the real route handlers. The emulator setup disables
 * limiting for the other suites; this file turns it on with tight overrides
 * so a handful of calls is enough to see every behaviour.
 */

const ip = (addr: string) => ({ "x-forwarded-for": addr });
let student: TestUser;
let admin: TestUser;

beforeAll(async () => {
  delete process.env.RATE_LIMIT_DISABLED;
  process.env.RATE_LIMIT_OVERRIDES = JSON.stringify({
    "auth.password-reset": { limit: 2, windowSeconds: 600, backoff: { baseSeconds: 5, maxSeconds: 40 } },
    "auth.login": { limit: 2, windowSeconds: 600, backoff: { baseSeconds: 5, maxSeconds: 40 } },
    "auth.attempt": { limit: 100, windowSeconds: 60 },
    "public.verify": { limit: 3, windowSeconds: 60 },
    "authenticated.registration": { limit: 2, windowSeconds: 60 },
    "authenticated.default": { limit: 3, windowSeconds: 60 },
  });
  resetRateLimitPolicy();
  await resetAuth();
  student = await mintUser({ name: "Limited Student" });
  admin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Limited Admin" });
});

afterAll(() => {
  process.env.RATE_LIMIT_DISABLED = "1";
  delete process.env.RATE_LIMIT_OVERRIDES;
  resetRateLimitPolicy();
});

beforeEach(async () => {
  await resetFirestore();
  for (const u of [student, admin]) {
    await adminDb().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, fullName: u.name, role: u.role, emailVerified: true, createdAt: new Date(), updatedAt: new Date(), ...(u.role === "student" ? { student: { college: "T" } } : { organizer: { festIds: ["fest1"] } }) });
  }
  await seedFest();
  await seedEvent({ capacity: 100 });
});

describe("auth tier — per IP and per account with backoff", () => {
  it("password reset: 3rd request from one IP is 429 with Retry-After; another IP still passes for a different account", async () => {
    const body = { email: "victim@plansphere.test" };
    const a = await callRoute(passwordReset, { path: "/api/auth/password-reset", body, headers: ip("198.51.100.1") });
    const b = await callRoute(passwordReset, { path: "/api/auth/password-reset", body: { email: "other@plansphere.test" }, headers: ip("198.51.100.1") });
    const c = await callRoute(passwordReset, { path: "/api/auth/password-reset", body: { email: "third@plansphere.test" }, headers: ip("198.51.100.1") });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(c.status).toBe(429);
    expect(c.body.code).toBe("rate-limited");
    expect(c.body.retryAfter).toBeGreaterThan(0);
    expect(c.body.error).toMatch(/Try again in \d+ seconds/);

    const elsewhere = await callRoute(passwordReset, { path: "/api/auth/password-reset", body: { email: "fourth@plansphere.test" }, headers: ip("198.51.100.2") });
    expect(elsewhere.status).toBe(200);
  });

  it("password reset: the same account from many IPs is limited too", async () => {
    const body = { email: "target@plansphere.test" };
    expect((await callRoute(passwordReset, { path: "/api/auth/password-reset", body, headers: ip("203.0.113.10") })).status).toBe(200);
    expect((await callRoute(passwordReset, { path: "/api/auth/password-reset", body, headers: ip("203.0.113.11") })).status).toBe(200);
    const third = await callRoute(passwordReset, { path: "/api/auth/password-reset", body, headers: ip("203.0.113.12") });
    expect(third.status).toBe(429);
  });

  it("login throttle: failures escalate the backoff, success clears it", async () => {
    const email = "brute@plansphere.test";
    const at = (phase: string, addr = "192.0.2.7") => callRoute(attempt, { path: "/api/auth/attempt", body: { kind: "login", email, phase }, headers: ip(addr) });

    expect((await at("before")).status).toBe(200);
    expect((await at("failed")).body.ok).toBe(true); // 1st failure (attempt 1 already counted by "before"? no — each call is a hit)
    const second = await at("failed"); // over the limit of 2 → strike 1 → 5 s
    expect(second.body.ok).toBe(false);
    expect(second.body.retryAfter).toBe(5);
    expect(second.body.message).toMatch(/Too many attempts/);

    const blocked = await at("before");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.body.retryAfter)).toBeLessThanOrEqual(5);

    await new Promise((r) => setTimeout(r, 5200));
    const again = await at("failed"); // window still full → strike 2 → 10 s
    expect(again.body.ok).toBe(false);
    expect(again.body.retryAfter).toBe(10);

    // A successful sign-in (reported by the client) clears the account and IP keys.
    expect((await at("succeeded")).status).toBe(200);
    expect((await at("before")).status).toBe(200);
  }, 20_000);
});

describe("public tier", () => {
  it("certificate lookups are limited per IP and carry RateLimit-* headers", async () => {
    let last: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
    for (let i = 0; i < 4; i += 1) {
      last = await callRoute(verify, { path: "/api/verify/FF-2026-ABCDEFGH", method: "GET", params: { number: "FF-2026-ABCDEFGH" }, headers: ip("198.51.100.50") });
      if (i < 3) expect(last.status).toBe(200);
    }
    expect(last.status).toBe(429);
    expect(last.body.code).toBe("rate-limited");
    // Another IP is unaffected.
    expect((await callRoute(verify, { path: "/api/verify/FF-2026-ABCDEFGH", method: "GET", params: { number: "FF-2026-ABCDEFGH" }, headers: ip("198.51.100.51") })).status).toBe(200);
  });
});

describe("authenticated tier", () => {
  it("registration calls are limited per account, not per IP", async () => {
    const body = { eventId: "ev1", teamName: "Solo", members: [{ name: student.name, email: student.email }] };
    const r1 = await callRoute(register, { path: "/api/registrations", token: student.idToken, body, headers: ip("10.0.0.1") });
    const r2 = await callRoute(register, { path: "/api/registrations", token: student.idToken, body, headers: ip("10.0.0.2") });
    const r3 = await callRoute(register, { path: "/api/registrations", token: student.idToken, body, headers: ip("10.0.0.3") });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(409); // already registered — still a counted call
    expect(r3.status).toBe(429); // 3rd call from the same account
  });

  it("routes without an explicit rule fall under the authenticated default", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await callRoute(staffList, { path: "/api/admin/staff", method: "GET", token: admin.idToken, headers: ip("10.0.0.9") })).status);
    }
    expect(statuses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(statuses[3]).toBe(429);
  });
});

describe("GET /api/health redaction", () => {
  it("shows pass/fail only to anonymous callers and details to a super admin", async () => {
    const { GET: health } = await import("@/app/api/health/route");
    const anon = await callRoute(health, { path: "/api/health", method: "GET" });
    expect(anon.body.detail).toBe("redacted");
    const anonText = JSON.stringify(anon.body);
    expect(anonText).not.toContain("project_id");
    expect(anonText).not.toContain("client_email");
    expect(anonText).not.toContain("message");
    for (const check of Object.values(anon.body.checks as Record<string, Record<string, unknown>>)) {
      expect(Object.keys(check).sort()).toEqual(["ms", "ok"]);
    }

    const superAdmin = await mintUser({ role: "super_admin", name: "Root" });
    const full = await callRoute(health, { path: "/api/health", method: "GET", token: superAdmin.idToken });
    expect(full.body.detail).toBe("full");
    expect((full.body.checks as Record<string, { detail?: unknown }>).runtime?.detail).toBeDefined();

    // A signed-in student gets the redacted view too.
    const asStudent = await callRoute(health, { path: "/api/health", method: "GET", token: student.idToken });
    expect(asStudent.body.detail).toBe("redacted");
  });
});
