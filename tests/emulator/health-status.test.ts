import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { callRoute } from "./harness";

/**
 * GET /api/health through the real handler: whether the application is up and whether each dependency is are two separate answers,
 * and each service says for itself whether it is working. The Supabase client and Firestore are replaced where a case needs
 * a dependency to fail, so every state can be produced on demand.
 *
 * Not asserted here: that every OTHER check passes. That depends on the machine's Firebase credential (the emulators have
 * none), so these tests read each service's own verdict and the overall status only where the case fixes it.
 */

const state = vi.hoisted(() => ({
  storage: null as null | { data: unknown; error: unknown },
  firestoreDown: false,
}));

vi.mock("@/server/storage/client", () => ({
  supabaseAdmin: () => ({ storage: { listBuckets: async () => state.storage }, from: () => ({}) }),
}));

vi.mock("@/server/firebase-admin", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/firebase-admin")>();
  return {
    ...real,
    adminDb: () => {
      if (state.firestoreDown) throw new Error("Firestore is unavailable");
      return real.adminDb();
    },
  };
});

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const URL_OK = "https://abcdefghijklmnop.supabase.co";
const KEY = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "service_role", ref: "abcdefghijklmnop" })}.c2lnbmF0dXJl`;
const buckets = [
  { name: "event-assets", public: true },
  { name: "avatars", public: true },
  { name: "certificates", public: false },
  { name: "uploads", public: false },
];
const healthyStorage = { data: buckets, error: null };

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) saved[key] = process.env[key];
  process.env.SUPABASE_URL = URL_OK;
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  state.firestoreDown = false;
  process.env.SUPABASE_URL = URL_OK;
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
});

const health = async () => {
  const { GET } = await import("@/app/api/health/route");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const res = await callRoute(GET, { path: "/api/health", method: "GET" });
  return { res, body: res.body as { ok: boolean; status: string; application: { available: boolean }; services: Record<string, string>; checks: Record<string, { ok: boolean }> } };
};

describe("the service verdicts", () => {
  it("shows storage ok when it is healthy", async () => {
    state.storage = healthyStorage;
    const { body } = await health();
    expect(body.services.storage).toBe("ok");
    expect(body.checks.storage?.ok).toBe(true);
    expect(body.application.available).toBe(true);
  });

  it("shows storage failing, and no other service blamed for it, when storage is down", async () => {
    state.storage = { data: null, error: { message: "Invalid API key", status: 401 } };
    const { res, body } = await health();
    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.services.storage).toBe("failing");
    expect(body.application.available).toBe(true);
    expect(body.status).not.toBe("ok");
    // The same dependency that failed before this change, now reported as its own service.
    expect(body.checks.storage?.ok).toBe(false);
  });

  it("does not call storage healthy when a bucket is missing", async () => {
    state.storage = { data: buckets.filter((b) => b.name !== "uploads"), error: null };
    const { body } = await health();
    expect(body.services.storage).toBe("failing");
  });

  it("says storage is disabled, not ok, on a deployment that has none configured", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    state.storage = healthyStorage;
    const { body } = await health();
    expect(body.services.storage).toBe("disabled");
    expect(body.checks.storage?.ok).toBe(true);
  });
});

describe("application versus dependency", () => {
  it("reports Firestore down as the application being down, and still reports storage on its own", async () => {
    state.storage = healthyStorage;
    state.firestoreDown = true;
    const { res, body } = await health();
    expect(res.status).toBe(503);
    expect(body.status).toBe("down");
    expect(body.services.firebase).toBe("failing");
    expect(body.services.storage).toBe("ok");
    expect(body.application.available).toBe(true);
  });

  it("reports both failing when both are, each by its own name", async () => {
    state.storage = { data: null, error: { message: "fetch failed" } };
    state.firestoreDown = true;
    const { body } = await health();
    expect(body.status).toBe("down");
    expect(body.services).toMatchObject({ firebase: "failing", storage: "failing" });
  });
});

describe("what an anonymous caller is shown", () => {
  it("is a verdict per service and pass/fail per check, never a message, the project or the key", async () => {
    state.storage = { data: null, error: { message: `Invalid API key ${KEY} for ${URL_OK}`, status: 401 } };
    const { res, body } = await health();
    expect(Object.keys(body.checks.storage ?? {}).sort()).toEqual(["ms", "ok"]);
    const everything = JSON.stringify(res.body);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("abcdefghijklmnop");
    expect(everything).not.toContain("supabase.co");
  });

  it("is never cached", async () => {
    state.storage = healthyStorage;
    const { GET } = await import("@/app/api/health/route");
    const response = await GET(new Request("http://localhost:3000/api/health"));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
