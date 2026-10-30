// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BUCKETS, PUBLIC_BUCKETS } from "@/server/storage/client";
import { EXPECTED_BUCKETS, classifyStorageError, cleanEnvValue, diagnoseStorage, inspectStorageEnv, type StorageProbeClient } from "@/server/storage/diagnose";

/**
 * Why is storage unhealthy? A fake Supabase client stands in for the real one, so every cause can be produced on demand.
 * Two properties matter beyond the diagnosis itself: no value from the environment ever appears in a report, and a private
 * bucket that has been made public is flagged (that one is a leak, not an outage).
 */

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.c2lnbmF0dXJl`;

const KEY = jwt({ role: "service_role", ref: "abcdefghijklmnop" });
const URL_OK = "https://abcdefghijklmnop.supabase.co";
const env = (over: Record<string, string | undefined> = {}) => ({ SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: KEY, ...over });

const listing = (over: Record<string, boolean | undefined> = {}) =>
  Object.entries(EXPECTED_BUCKETS).flatMap(([name, expectedPublic]) => (over[name] === undefined && name in over ? [] : [{ name, public: over[name] ?? expectedPublic }]));

const healthy = (): StorageProbeClient => ({ storage: { listBuckets: async () => ({ data: listing(), error: null }) } });
const failing = (error: unknown): StorageProbeClient => ({ storage: { listBuckets: async () => ({ data: null, error }) } });
const codes = (report: Awaited<ReturnType<typeof diagnoseStorage>>) => report.problems.map((p) => (p.bucket ? `${p.code}:${p.bucket}` : p.code));

describe("the expected buckets are the app's own", () => {
  it("lists exactly the buckets, and the visibility, that the storage client uses", () => {
    expect(new Set(Object.keys(EXPECTED_BUCKETS))).toEqual(new Set(Object.values(BUCKETS)));
    for (const [name, isPublic] of Object.entries(EXPECTED_BUCKETS)) expect(isPublic, name).toBe(PUBLIC_BUCKETS.has(name as (typeof BUCKETS)[keyof typeof BUCKETS]));
  });

  it("keeps identity documents and certificates private", () => {
    expect(EXPECTED_BUCKETS.uploads).toBe(false);
    expect(EXPECTED_BUCKETS.certificates).toBe(false);
  });
});

describe("reading the environment without printing it", () => {
  it("accepts a project URL and a service-role key", () => {
    expect(inspectStorageEnv(env())).toMatchObject({ url: "ok", key: "service-role", projectMismatch: false, hostedProject: true });
  });

  it("recognises the new-style secret key and the publishable one", () => {
    expect(inspectStorageEnv(env({ SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123" })).key).toBe("service-role");
    expect(inspectStorageEnv(env({ SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_abc123" })).key).toBe("publishable");
  });

  it("recognises the anon key, which is the usual wrong paste", () => {
    expect(inspectStorageEnv(env({ SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "anon", ref: "abcdefghijklmnop" }) })).key).toBe("publishable");
  });

  it("notices a key from another project", () => {
    expect(inspectStorageEnv(env({ SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "service_role", ref: "someotherproject" }) })).projectMismatch).toBe(true);
  });

  it("copes with the quotes and trailing newline a dashboard paste adds", () => {
    expect(cleanEnvValue(`"${KEY}"\n`)).toBe(KEY);
    expect(cleanEnvValue(`  '${URL_OK}'  `)).toBe(URL_OK);
    expect(inspectStorageEnv(env({ SUPABASE_URL: `"${URL_OK}"\n`, SUPABASE_SERVICE_ROLE_KEY: `${KEY}\n` }))).toMatchObject({ url: "ok", key: "service-role" });
    expect(cleanEnvValue(undefined)).toBe("");
  });

  it("flags a key with a line break inside it, a URL with a path, and an unusable URL", () => {
    expect(inspectStorageEnv(env({ SUPABASE_SERVICE_ROLE_KEY: `${KEY.slice(0, 40)}\n${KEY.slice(40)}` })).key).toBe("malformed");
    expect(inspectStorageEnv(env({ SUPABASE_URL: `${URL_OK}/rest/v1` })).url).toBe("has-path");
    expect(inspectStorageEnv(env({ SUPABASE_URL: "not a url" })).url).toBe("invalid");
    expect(inspectStorageEnv(env({ SUPABASE_URL: "http://abcdefghijklmnop.supabase.co" })).url).toBe("not-https");
  });
});

describe("what a failure is called", () => {
  it.each([
    [{ message: "Bucket not found", status: 400 }, "bucket-missing"],
    [{ message: "Invalid API key", status: 401 }, "unauthorized"],
    [{ message: "invalid JWT: unable to parse or verify signature", status: 403 }, "unauthorized"],
    [{ message: "Invalid Compact JWS" }, "unauthorized"],
    [{ message: "fetch failed", originalError: { message: "getaddrinfo ENOTFOUND abc.supabase.co" } }, "unreachable"],
    [{ message: "request timed out" }, "unreachable"],
    [{ message: "x is not a valid HTTP header value" }, "key-malformed"],
    [{ message: "Project paused", status: 540 }, "upstream"],
    [{ message: "Internal error", status: 502 }, "upstream"],
    [{ message: "requested path is invalid", status: 404 }, "wrong-url"],
    [{ message: "something else entirely" }, "unknown"],
    [null, "unknown"],
  ])("%j is %s", (error, expected) => {
    expect(classifyStorageError(error)).toBe(expected);
  });
});

describe("diagnosing storage", () => {
  it("is healthy, and says so, when the key works and every bucket is there as expected", async () => {
    const report = await diagnoseStorage({ env: env(), client: healthy });
    expect(report).toMatchObject({ configured: true, ok: true, problems: [] });
    expect(report.buckets).toHaveLength(Object.keys(EXPECTED_BUCKETS).length);
    expect(report.buckets.every((b) => b.exists && b.public === b.expectedPublic)).toBe(true);
  });

  it("is simply not configured, and not unhealthy, when neither variable is set", async () => {
    let called = false;
    const report = await diagnoseStorage({ env: {}, client: () => ((called = true), healthy()) });
    expect(report).toMatchObject({ configured: false, ok: true });
    expect(called).toBe(false);
  });

  it("fails when only one of the two variables is set - that is a misconfiguration, not 'off'", async () => {
    expect(codes(await diagnoseStorage({ env: env({ SUPABASE_SERVICE_ROLE_KEY: "" }), client: healthy }))).toContain("half-configured");
    expect(codes(await diagnoseStorage({ env: env({ SUPABASE_URL: undefined }), client: healthy }))).toContain("half-configured");
  });

  it("names a wrong key once, not as four missing buckets", async () => {
    const report = await diagnoseStorage({ env: env(), client: () => failing({ message: "Invalid API key", status: 401 }) });
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["unauthorized"]);
  });

  it("names a key of the wrong type without calling Supabase", async () => {
    let called = false;
    const report = await diagnoseStorage({ env: env({ SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "anon", ref: "abcdefghijklmnop" }) }), client: () => ((called = true), healthy()) });
    expect(codes(report)).toEqual(["key-publishable"]);
    expect(called).toBe(false);
  });

  it("names a key from another project", async () => {
    const report = await diagnoseStorage({ env: env({ SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "service_role", ref: "someotherproject" }) }), client: () => failing({ message: "Invalid API key", status: 401 }) });
    expect(codes(report)).toEqual(["project-mismatch", "unauthorized"]);
  });

  it("names an unreachable or paused project", async () => {
    expect(codes(await diagnoseStorage({ env: env(), client: () => failing({ message: "fetch failed" }) }))).toEqual(["unreachable"]);
    expect(codes(await diagnoseStorage({ env: env(), client: () => failing({ message: "paused", status: 540 }) }))).toEqual(["upstream"]);
  });

  it("names a client that throws instead of returning an error", async () => {
    const throwing: StorageProbeClient = { storage: { listBuckets: async () => Promise.reject(new Error("getaddrinfo ENOTFOUND x")) } };
    expect(codes(await diagnoseStorage({ env: env(), client: () => throwing }))).toEqual(["unreachable"]);
    expect(codes(await diagnoseStorage({ env: env(), client: () => { throw new Error("SUPABASE_URL is empty."); } }))).toEqual(["unknown"]);
  });

  it("gives up on a call that never answers", async () => {
    const hang: StorageProbeClient = { storage: { listBuckets: () => new Promise(() => undefined) } };
    const report = await diagnoseStorage({ env: env(), client: () => hang, timeoutMs: 20 });
    expect(codes(report)).toEqual(["unreachable"]);
  });

  it("names each missing bucket", async () => {
    const client: StorageProbeClient = { storage: { listBuckets: async () => ({ data: listing({ uploads: undefined, avatars: undefined }), error: null }) } };
    expect(codes(await diagnoseStorage({ env: env(), client: () => client }))).toEqual(["bucket-missing:avatars", "bucket-missing:uploads"]);
  });

  it("flags a private bucket that has been made public as a leak, and a public one made private as broken", async () => {
    const client: StorageProbeClient = { storage: { listBuckets: async () => ({ data: listing({ uploads: true, certificates: true, "event-assets": false }), error: null }) } };
    const report = await diagnoseStorage({ env: env(), client: () => client });
    expect(codes(report)).toEqual(["bucket-should-be-public:event-assets", "bucket-should-be-private:certificates", "bucket-should-be-private:uploads"]);
    expect(report.problems.find((p) => p.code === "bucket-should-be-private")?.message).toMatch(/PUBLIC/);
  });
});

describe("a report never carries what it was given", () => {
  it("contains neither the key, the URL, nor any part of them, whatever went wrong", async () => {
    const secret = jwt({ role: "service_role", ref: "abcdefghijklmnop", marker: "TOPSECRETMARKER" });
    const environment = env({ SUPABASE_SERVICE_ROLE_KEY: secret });
    const clients = [
      healthy,
      () => failing({ message: `Invalid API key ${secret}`, status: 401 }),
      () => failing({ message: `fetch failed https://abcdefghijklmnop.supabase.co`, originalError: { message: "ENOTFOUND abcdefghijklmnop.supabase.co" } }),
    ];
    for (const client of clients) {
      const text = JSON.stringify(await diagnoseStorage({ env: environment, client }));
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secret.split(".")[1]!);
      expect(text).not.toContain("TOPSECRETMARKER");
      expect(text).not.toContain("abcdefghijklmnop");
      expect(text).not.toContain("supabase.co");
    }
  });
});
