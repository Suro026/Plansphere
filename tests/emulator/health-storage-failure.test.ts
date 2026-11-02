import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { callRoute, mintUser, resetAuth, resetFirestore, type TestUser } from "./harness";

/**
 * What /api/health does when storage is unhealthy, through the real handler with the Supabase client replaced.
 *
 * The production incident this pins down: /api/health answered 503 on the storage check alone, and the public answer says
 * only pass/fail. The two causes that fit the evidence are a rejected key and a missing private bucket (`certificates` or
 * `uploads`). Each must (a) fail the check, (b) show an anonymous caller nothing but pass/fail, (c) reach the SERVER log as a
 * fixed code - so the operator can read the cause in the Vercel runtime log - and (d) never put the URL or the key anywhere.
 */

const state = vi.hoisted(() => ({ result: null as null | { data: unknown; error: unknown } }));

vi.mock("@/server/storage/client", () => ({
  supabaseAdmin: () => ({ storage: { listBuckets: async () => state.result }, from: () => ({}) }),
}));

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const URL_OK = "https://abcdefghijklmnop.supabase.co";
const KEY = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "service_role", ref: "abcdefghijklmnop" })}.c2lnbmF0dXJl`;

const allBuckets = [
  { name: "event-assets", public: true },
  { name: "avatars", public: true },
  { name: "certificates", public: false },
  { name: "uploads", public: false },
];

const saved: Record<string, string | undefined> = {};
let superAdmin: TestUser;

beforeAll(async () => {
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) saved[key] = process.env[key];
  process.env.SUPABASE_URL = URL_OK;
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
  // Start from an empty database: an earlier file may have left the platform boundary switched on, which would turn this
  // (unregistered) super admin into an ordinary account and hide the full view the test is about.
  await resetFirestore();
  await resetAuth();
  superAdmin = await mintUser({ role: "super_admin", name: "Health Reader" });
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => vi.restoreAllMocks());

const checkHealth = async (token?: string) => {
  const { GET } = await import("@/app/api/health/route");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const res = await callRoute(GET, { path: "/api/health", method: "GET", token });
  const logged = errors.mock.calls.map((call) => call.map(String).join(" "));
  const storage = (res.body.checks as Record<string, { ok: boolean; detail?: { message?: string } }>).storage;
  if (!storage) throw new Error("the health response has no storage check");
  return { res, logged, storage };
};

describe.each([
  { name: "the key is rejected", result: { data: null, error: { message: "Invalid API key", status: 401 } }, logs: "unauthorized" },
  { name: "the private `certificates` bucket does not exist", result: { data: allBuckets.filter((b) => b.name !== "certificates"), error: null }, logs: "bucket-missing(certificates)" },
  { name: "the private `uploads` bucket does not exist", result: { data: allBuckets.filter((b) => b.name !== "uploads"), error: null }, logs: "bucket-missing(uploads)" },
  { name: "a private bucket was made public", result: { data: allBuckets.map((b) => (b.name === "uploads" ? { ...b, public: true } : b)), error: null }, logs: "bucket-should-be-private(uploads)" },
])("when $name", ({ result, logs }) => {
  it("fails the storage check, shows an anonymous caller only pass/fail, and logs the fixed code on the server", async () => {
    state.result = result;
    const { res, logged, storage } = await checkHealth();

    expect(res.status).toBe(503);
    expect(storage.ok).toBe(false);
    expect(Object.keys(storage).sort()).toEqual(["ms", "ok"]); // the public view carries no message

    const storageLog = logged.find((line) => line.includes("[health] storage unhealthy:"));
    expect(storageLog, "the cause must reach the server log").toContain(logs);
    expect(logged.some((line) => line.includes("[health] failing checks:") && line.includes("storage"))).toBe(true);

    // Nothing from the environment is ever logged or returned.
    const everything = JSON.stringify(res.body) + logged.join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("abcdefghijklmnop");
  });

  it("gives a super admin the sentence that says what to do, still without the URL or the key", async () => {
    state.result = result;
    const { res, storage } = await checkHealth(superAdmin.idToken);
    expect(res.body.detail).toBe("full");
    expect(storage.ok).toBe(false);
    expect(storage.detail?.message ?? JSON.stringify(storage)).toContain(logs.split("(")[0]);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(JSON.stringify(res.body)).not.toContain("abcdefghijklmnop");
  });
});

describe("when storage is healthy", () => {
  it("passes the check and logs no storage failure", async () => {
    state.result = { data: allBuckets, error: null };
    const { storage, logged } = await checkHealth();
    expect(storage.ok).toBe(true);
    expect(logged.some((line) => line.includes("[health] storage unhealthy:"))).toBe(false);
  });
});
