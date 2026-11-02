// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { STEP_TIMEOUT_MS, step, summarise, type Step } from "@/server/health-report";

/**
 * GET /api/health reduces many checks to one status. Two questions matter and used to be one: is the application itself
 * up, and is each dependency? A failing dependency must never read as healthy, and one that hangs must not hold the
 * endpoint (the check is what an operator opens when something is wrong).
 */

afterEach(() => vi.useRealTimers());

const pass: Step = { ok: true, ms: 1 };
const fail: Step = { ok: false, ms: 1, error: { name: "Error", message: "nope" } };

/** Every check the route runs, passing; override the ones a case breaks. */
const checks = (over: Record<string, Step> = {}): Record<string, Step> => ({
  runtime: pass,
  env: pass,
  envValidation: pass,
  serviceAccountParse: pass,
  importFirebaseAdmin: pass,
  importServerModule: pass,
  adminInit: pass,
  firestoreRead: pass,
  firestoreIndexes: pass,
  storage: { ok: true, ms: 1, detail: { configured: true } },
  authAdmin: pass,
  monitoring: pass,
  payments: pass,
  ...over,
});

describe("step", () => {
  it("reports success with its detail and timing", async () => {
    const result = await step(async () => ({ fests: 1 }));
    expect(result.ok).toBe(true);
    expect(result.detail).toEqual({ fests: 1 });
  });

  it("reports a throw as a failure with the error's name and message, not as an exception", async () => {
    const result = await step(async () => {
      throw new TypeError("boom");
    });
    expect(result).toMatchObject({ ok: false, error: { name: "TypeError", message: "boom" } });
  });

  it("fails a dependency that never answers instead of hanging the endpoint", async () => {
    vi.useFakeTimers();
    const pending = step(() => new Promise<void>(() => undefined));
    await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS + 1);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error?.name).toBe("TimeoutError");
    expect(result.error?.message).toContain("did not answer within");
  });

  it("honours a longer limit for a slow check, and does not leave its timer running", async () => {
    vi.useFakeTimers();
    const pending = step(async () => ({ done: true }), 40_000);
    await vi.advanceTimersByTimeAsync(0);
    expect((await pending).ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("summarise", () => {
  it("is ok, with every service ok, when every check passes", () => {
    expect(summarise(checks())).toEqual({ status: "ok", services: { application: "ok", firebase: "ok", storage: "ok", payments: "ok" } });
  });

  it("calls a storage failure degraded: the application is up, storage is the one thing failing", () => {
    const result = summarise(checks({ storage: fail }));
    expect(result.status).toBe("degraded");
    expect(result.services).toEqual({ application: "ok", firebase: "ok", storage: "failing", payments: "ok" });
  });

  it("calls a payments failure degraded, and does not blame storage for it", () => {
    const result = summarise(checks({ payments: fail }));
    expect(result.status).toBe("degraded");
    expect(result.services.storage).toBe("ok");
    expect(result.services.payments).toBe("failing");
  });

  it("calls a missing composite index degraded: some queries fail, the app still serves", () => {
    expect(summarise(checks({ firestoreIndexes: fail })).status).toBe("degraded");
  });

  it.each(["firestoreRead", "authAdmin", "adminInit", "serviceAccountParse", "envValidation"])("calls a failing %s down: the app cannot serve without it", (name) => {
    expect(summarise(checks({ [name]: fail })).status).toBe("down");
  });

  it("calls storage failing with Firestore failing down, and still reports each service on its own", () => {
    const result = summarise(checks({ firestoreRead: fail, storage: fail }));
    expect(result.status).toBe("down");
    expect(result.services).toMatchObject({ firebase: "failing", storage: "failing", payments: "ok" });
  });

  it("treats a check it does not know as critical, so a new failing check cannot read as merely degraded", () => {
    expect(summarise(checks({ somethingNew: fail })).status).toBe("down");
  });

  it("says storage is disabled, not ok, when it is deliberately not configured", () => {
    const result = summarise(checks({ storage: { ok: true, ms: 1, detail: { configured: false } } }));
    expect(result.status).toBe("ok");
    expect(result.services.storage).toBe("disabled");
  });
});
