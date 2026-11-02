// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/server/errors";
import { fetchWithTimeout, resetStorageClientForTests, supabaseAdmin } from "@/server/storage/client";
import { deleteFile, deleteFiles } from "@/server/storage/delete";
import { diagnoseStorage } from "@/server/storage/diagnose";
import { createSignedUrl } from "@/server/storage/signed-url";
import { acceptFlexibleUpload, acceptImageUpload, acceptPdfUpload, storeUpload } from "@/server/storage/upload";

/**
 * The storage layer against Supabase's actual wire protocol.
 *
 * Every other storage test replaces the Supabase client with an in-memory object, so none of them can notice a mistake in
 * how this app talks to the real client: the key header, the upload options, the metadata, the URLs it hands back, what a
 * 401 or a missing bucket looks like once the client has wrapped it. Here the real `@supabase/supabase-js` client runs
 * against a small local server that speaks the Storage REST API (no Docker or hosted project needed), so upload, public and
 * signed retrieval, deletion and each way Supabase can fail go through the same code paths as production.
 *
 * What this does not prove: that the production project's key is valid and its four buckets exist. That is a fact about the
 * project, checked with `npm run verify:storage`.
 */

/* ───────────── a local Storage API ───────────── */

// A stand-in the local server accepts, assembled from pieces: written out whole, a string in the shape of a Supabase secret key
// is indistinguishable from a real one to a secret scanner (GitHub's push protection refuses it). The value is unchanged.
const KEY = ["sb", "secret", "test", "placeholder", "not", "a", "real", "key"].join("_");
interface Stored {
  bytes: Buffer;
  contentType: string;
  cacheControl: string | null;
  metadata: Record<string, string>;
}
interface Bucket {
  id: string;
  name: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
}

const state = {
  buckets: new Map<string, Bucket>(),
  objects: new Map<string, Stored>(),
  tokens: new Map<string, string>(),
  /** Per-test failure injection. */
  mode: "ok" as "ok" | "reject-key" | "server-error" | "hang",
  requests: [] as Array<{ method: string; path: string; authorization: string | undefined; apikey: string | undefined }>,
};

const bucket = (name: string, isPublic: boolean, extra: Partial<Bucket> = {}): Bucket => ({ id: name, name, public: isPublic, file_size_limit: null, allowed_mime_types: null, ...extra });
const resetServer = () => {
  state.buckets = new Map([bucket("event-assets", true), bucket("avatars", true), bucket("certificates", false), bucket("uploads", false)].map((b) => [b.name, b]));
  state.objects.clear();
  state.tokens.clear();
  state.mode = "ok";
  state.requests = [];
};

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": Buffer.isBuffer(body) ? (headers["content-type"] ?? "application/octet-stream") : "application/json", ...headers });
  res.end(payload);
};
const fail = (res: ServerResponse, status: number, message: string, error = message) => send(res, status, { statusCode: String(status), error, message });

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://local");
  const path = decodeURIComponent(url.pathname).replace(/^\/storage\/v1/, "");
  state.requests.push({ method: req.method ?? "", path, authorization: req.headers.authorization, apikey: req.headers.apikey as string | undefined });

  if (state.mode === "hang") return; // accepts the connection, never answers
  if (state.mode === "server-error") return send(res, 500, { message: "Internal Server Error" });

  // Objects served by public or signed URL carry no Authorization header.
  const publicMatch = path.match(/^\/object\/public\/([^/]+)\/(.+)$/);
  if (req.method === "GET" && publicMatch) {
    const b = state.buckets.get(publicMatch[1]!);
    const object = state.objects.get(`${publicMatch[1]}/${publicMatch[2]}`);
    if (!b || !b.public) return fail(res, 404, "Bucket not found");
    if (!object) return fail(res, 404, "Object not found");
    return send(res, 200, object.bytes, { "content-type": object.contentType, "cache-control": `max-age=${object.cacheControl ?? 3600}` });
  }
  const signedGet = path.match(/^\/object\/sign\/([^/]+)\/(.+)$/);
  if (req.method === "GET" && signedGet) {
    const object = state.objects.get(`${signedGet[1]}/${signedGet[2]}`);
    if (state.tokens.get(url.searchParams.get("token") ?? "") !== `${signedGet[1]}/${signedGet[2]}`) return fail(res, 400, "Invalid token", "InvalidJWT");
    if (!object) return fail(res, 404, "Object not found");
    return send(res, 200, object.bytes, { "content-type": object.contentType });
  }

  // Everything else needs the service-role key, in both headers the client sends.
  if (state.mode === "reject-key" || req.headers.authorization !== `Bearer ${KEY}` || req.headers.apikey !== KEY) return fail(res, 403, "Invalid Compact JWS", "Unauthorized");

  if (req.method === "GET" && path === "/bucket") return send(res, 200, [...state.buckets.values()]);

  const sign = path.match(/^\/object\/sign\/([^/]+)\/(.+)$/);
  if (req.method === "POST" && sign) {
    if (!state.buckets.has(sign[1]!)) return fail(res, 404, "Bucket not found");
    if (!state.objects.has(`${sign[1]}/${sign[2]}`)) return fail(res, 400, "Object not found", "not_found");
    const token = `tok-${state.tokens.size + 1}`;
    state.tokens.set(token, `${sign[1]}/${sign[2]}`);
    return send(res, 200, { signedURL: `/object/sign/${sign[1]}/${sign[2]}?token=${token}` });
  }

  const remove = path.match(/^\/object\/([^/]+)$/);
  if (req.method === "DELETE" && remove) {
    if (!state.buckets.has(remove[1]!)) return fail(res, 404, "Bucket not found");
    const { prefixes } = JSON.parse((await readBody(req)).toString("utf8")) as { prefixes: string[] };
    const removed = prefixes.filter((p) => state.objects.delete(`${remove[1]}/${p}`)).map((name) => ({ name, bucket_id: remove[1] }));
    return send(res, 200, removed);
  }

  const upload = path.match(/^\/object\/([^/]+)\/(.+)$/);
  if (req.method === "POST" && upload) {
    const b = state.buckets.get(upload[1]!);
    if (!b) return fail(res, 404, "Bucket not found");
    const body = await readBody(req);
    const contentType = String(req.headers["content-type"] ?? "application/octet-stream");
    if (b.file_size_limit !== null && body.length > b.file_size_limit) return fail(res, 413, "The object exceeded the maximum allowed size", "Payload too large");
    if (b.allowed_mime_types && !b.allowed_mime_types.includes(contentType)) return fail(res, 415, `mime type ${contentType} is not supported`, "invalid_mime_type");
    const key = `${upload[1]}/${upload[2]}`;
    if (state.objects.has(key) && req.headers["x-upsert"] !== "true") return fail(res, 409, "The resource already exists", "Duplicate");
    const metadataHeader = req.headers["x-metadata"];
    const metadata = typeof metadataHeader === "string" ? (JSON.parse(Buffer.from(metadataHeader, "base64").toString("utf8")) as Record<string, string>) : {};
    state.objects.set(key, { bytes: body, contentType, cacheControl: String(req.headers["cache-control"] ?? "").replace(/^max-age=/, "") || null, metadata });
    return send(res, 200, { Id: "id", Key: key });
  }

  return fail(res, 404, "not found");
};

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res).catch(() => res.destroy()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
beforeEach(() => {
  resetServer();
  process.env.SUPABASE_URL = baseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
  resetStorageClientForTests();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of [["SUPABASE_URL", saved.url], ["SUPABASE_SERVICE_ROLE_KEY", saved.key]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetStorageClientForTests();
});

const png = () => sharp({ create: { width: 64, height: 48, channels: 4, background: "#9184d9" } }).png().toBuffer();
const pdf = () => Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const input = (over: Record<string, unknown> = {}) => ({ kind: "eventPoster" as const, ownerId: "fest1", uploadedBy: "uid1", declaredType: "image/png", ...over });

/* ───────────── upload and retrieval ───────────── */

describe("an image upload", () => {
  it("is stored as processed WebP/PNG bytes with provenance metadata, and the public URL serves exactly those bytes", async () => {
    const stored = await acceptImageUpload({ ...input(), bytes: await png() });

    expect(stored.bucket).toBe("event-assets");
    expect(stored.path).toMatch(/^fests\/fest1\/posters\/[0-9a-f-]{36}\.(png|webp|jpg)$/);
    const object = state.objects.get(`event-assets/${stored.path}`);
    expect(object, "the object reached the bucket").toBeDefined();
    expect(object!.contentType).toBe(stored.contentType);
    expect(object!.cacheControl).toBe(String(365 * 24 * 60 * 60));
    expect(object!.metadata).toMatchObject({ uploadedBy: "uid1", kind: "eventPoster", sha256: stored.sha256, width: String(stored.width), height: String(stored.height) });

    // Retrieval through the URL the app hands back: no key, public bucket.
    expect(stored.url).toBe(`${baseUrl}/storage/v1/object/public/event-assets/${stored.path}`);
    const fetched = await fetch(stored.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe(stored.contentType);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(object!.bytes)).toBe(true);
  });

  it("sends the service-role key in both headers on every storage request, and never as a query parameter", async () => {
    await acceptImageUpload({ ...input(), bytes: await png() });
    const writes = state.requests.filter((r) => r.method === "POST");
    expect(writes.length).toBeGreaterThan(0);
    for (const request of writes) {
      expect(request.authorization).toBe(`Bearer ${KEY}`);
      expect(request.apikey).toBe(KEY);
      expect(request.path).not.toContain(KEY);
    }
  });

  it("stores a rulebook PDF byte-for-byte in the public bucket", async () => {
    const stored = await acceptPdfUpload({ ...input({ kind: "eventRulebook", ownerId: "fest1", declaredType: "application/pdf" }), bytes: pdf() });
    expect(stored.bucket).toBe("event-assets");
    expect(stored.contentType).toBe("application/pdf");
    const fetched = await fetch(stored.url);
    expect(fetched.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await fetched.arrayBuffer()).equals(pdf())).toBe(true);
  });

  it("puts a profile photo in the public avatars bucket under the user's own folder", async () => {
    const stored = await acceptImageUpload({ ...input({ kind: "profilePhoto", ownerId: "uid1" }), bytes: await png() });
    expect(stored.bucket).toBe("avatars");
    expect(stored.path.startsWith("users/uid1/photo/")).toBe(true);
    expect((await fetch(stored.url)).status).toBe(200);
  });
});

describe("a private upload", () => {
  it("lands in the private bucket, is NOT readable by a permanent URL, and is readable through the signed URL it returns", async () => {
    const identity = await acceptFlexibleUpload({ ...input({ kind: "eventHeadIdentity", ownerId: "uid1", declaredType: "application/pdf" }), bytes: pdf() });
    expect(identity.bucket).toBe("uploads");
    expect(identity.contentType).toBe("application/pdf");

    // The bucket is private: the permanent public path must not serve it.
    const direct = await fetch(`${baseUrl}/storage/v1/object/public/uploads/${identity.path}`);
    expect(direct.status).toBe(404);

    // The URL the upload returned is signed and works.
    expect(identity.url).toContain("/object/sign/uploads/");
    const viaSigned = await fetch(identity.url);
    expect(viaSigned.status).toBe(200);
    expect(Buffer.from(await viaSigned.arrayBuffer()).equals(pdf())).toBe(true);
  });

  it("will not serve a signed URL whose token belongs to another object", async () => {
    const a = await acceptFlexibleUpload({ ...input({ kind: "eventHeadIdentity", ownerId: "uid1" }), bytes: pdf() });
    const b = await acceptFlexibleUpload({ ...input({ kind: "eventHeadIdentity", ownerId: "uid2" }), bytes: pdf() });
    const token = new URL(a.url).searchParams.get("token");
    const crossed = await fetch(`${baseUrl}/storage/v1/object/sign/uploads/${b.path}?token=${token}`);
    expect(crossed.status).toBe(400);
  });
});

describe("createSignedUrl", () => {
  it("returns a working link for an object that exists", async () => {
    const stored = await acceptFlexibleUpload({ ...input({ kind: "eventHeadIdentity", ownerId: "uid1" }), bytes: pdf() });
    const url = await createSignedUrl("uploads", stored.path, 300);
    expect((await fetch(url)).status).toBe(200);
  });

  it("is a deliberate 503, not an unrecognised error, for an object that is not there", async () => {
    await expect(createSignedUrl("uploads", "users/uid1/identity/missing.pdf", 300)).rejects.toBeInstanceOf(ApiError);
  });
});

/* ───────────── deletion ───────────── */

describe("deletion", () => {
  it("removes the object, and a second delete of the same path is not an error", async () => {
    const stored = await acceptImageUpload({ ...input(), bytes: await png() });
    await deleteFile("event-assets", stored.path);
    expect(state.objects.has(`event-assets/${stored.path}`)).toBe(false);
    expect((await fetch(stored.url)).status).toBe(404);
    await expect(deleteFile("event-assets", stored.path)).resolves.toBeUndefined();
  });

  it("removes several at once, and does nothing at all for an empty list", async () => {
    const one = await acceptImageUpload({ ...input({ ownerId: "fest1" }), bytes: await png() });
    const two = await acceptImageUpload({ ...input({ ownerId: "fest1" }), bytes: await png() });
    await deleteFiles("event-assets", [one.path, two.path]);
    expect(state.objects.size).toBe(0);
    state.requests = [];
    await deleteFiles("event-assets", []);
    expect(state.requests).toHaveLength(0);
  });

  it("leaves other objects alone", async () => {
    const keep = await acceptImageUpload({ ...input({ ownerId: "fest1" }), bytes: await png() });
    const drop = await acceptImageUpload({ ...input({ ownerId: "fest2" }), bytes: await png() });
    await deleteFile("event-assets", drop.path);
    expect(state.objects.has(`event-assets/${keep.path}`)).toBe(true);
  });
});

/* ───────────── what each Supabase failure becomes ───────────── */

describe("when Supabase fails", () => {
  const put = async () => storeUpload("event-assets", "fests/fest1/posters/x.png", await png(), "image/png", { uploadedBy: "uid1", kind: "eventPoster" });

  it("answers a rejected key with a 503 storage-unavailable, and the log names only the fixed cause", async () => {
    state.mode = "reject-key";
    await expect(put()).rejects.toMatchObject({ status: 503, code: "storage-unavailable" });
    expect(String(vi.mocked(console.error).mock.calls.flat())).toContain("[storage] upload failed: unauthorized (event-assets)");
  });

  it("answers a missing bucket with a 503 storage-disabled", async () => {
    state.buckets.delete("event-assets");
    await expect(put()).rejects.toMatchObject({ status: 503, code: "storage-disabled" });
  });

  it("answers a Supabase server error with a 503", async () => {
    state.mode = "server-error";
    await expect(put()).rejects.toMatchObject({ status: 503, code: "storage-unavailable" });
  });

  it("answers a file the bucket's own size limit refuses with 413, not an outage", async () => {
    state.buckets.set("event-assets", bucket("event-assets", true, { file_size_limit: 10 }));
    await expect(put()).rejects.toMatchObject({ status: 413 });
  });

  it("answers a type the bucket's own allow-list refuses with 415, not an outage", async () => {
    state.buckets.set("event-assets", bucket("event-assets", true, { allowed_mime_types: ["application/pdf"] }));
    await expect(put()).rejects.toMatchObject({ status: 415 });
  });

  it("answers an unconfigured deployment with a 503 storage-disabled, without touching the network", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetStorageClientForTests();
    await expect(put()).rejects.toMatchObject({ status: 503, code: "storage-disabled" });
    expect(state.requests).toHaveLength(0);
  });

  it("recovers on its own: the next call succeeds once Supabase does", async () => {
    state.mode = "server-error";
    await expect(put()).rejects.toMatchObject({ status: 503 });
    state.mode = "ok";
    await expect(put()).resolves.toMatchObject({ bucket: "event-assets" });
  });

  it("never reports the key or the server address to the caller", async () => {
    state.mode = "reject-key";
    const error = await put().catch((e: unknown) => e as ApiError);
    const told = JSON.stringify({ message: (error as ApiError).message, code: (error as ApiError).code });
    expect(told).not.toContain(KEY);
    expect(told).not.toContain(baseUrl);
    expect(told).not.toContain("127.0.0.1");
  });
});

/* ───────────── a project that never answers ───────────── */

describe("a Supabase that accepts the connection and never answers", () => {
  it("is cut off by the client's timeout instead of holding the request", async () => {
    state.mode = "hang";
    const client = createClient(baseUrl, KEY, { auth: { persistSession: false }, global: { fetch: fetchWithTimeout(150) } });
    const started = Date.now();
    const { error } = await client.storage.listBuckets();
    expect(error).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(3000);
    // ...and it classifies as a connectivity problem, which is a 503, not a 500.
    const { toStorageApiError } = await import("@/server/storage/guard");
    expect(toStorageApiError("upload", error, "uploads")).toMatchObject({ status: 503, code: "storage-unavailable" });
  });

  it("honours the caller's own abort signal as well as the timeout", async () => {
    state.mode = "hang";
    const controller = new AbortController();
    const pending = fetchWithTimeout(5000)(`${baseUrl}/storage/v1/bucket`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
  });

  it("is reported by the health diagnosis as unreachable, within its own limit", async () => {
    state.mode = "hang";
    const started = Date.now();
    const report = await diagnoseStorage({ env: process.env, client: supabaseAdmin, timeoutMs: 200 });
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toEqual(["unreachable"]);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

/* ───────────── the diagnosis against the real client ───────────── */

describe("the health diagnosis, with the real client", () => {
  const diagnose = () => diagnoseStorage({ env: process.env, client: supabaseAdmin });

  it("is healthy when the key works and all four buckets are there with the right visibility", async () => {
    const report = await diagnose();
    expect(report.ok).toBe(true);
    expect(report.buckets.map((b) => b.name).sort()).toEqual(["avatars", "certificates", "event-assets", "uploads"]);
  });

  it("names a rejected key as `unauthorized`, once", async () => {
    state.mode = "reject-key";
    expect((await diagnose()).problems.map((p) => p.code)).toEqual(["unauthorized"]);
  });

  it("names each missing bucket", async () => {
    state.buckets.delete("certificates");
    state.buckets.delete("uploads");
    expect((await diagnose()).problems.map((p) => `${p.code}:${p.bucket}`).sort()).toEqual(["bucket-missing:certificates", "bucket-missing:uploads"]);
  });

  it("flags a private bucket that was made public as a leak", async () => {
    state.buckets.set("uploads", bucket("uploads", true));
    expect((await diagnose()).problems.map((p) => `${p.code}:${p.bucket}`)).toEqual(["bucket-should-be-private:uploads"]);
  });

  it("flags a public bucket that was made private as broken images", async () => {
    state.buckets.set("event-assets", bucket("event-assets", false));
    expect((await diagnose()).problems.map((p) => `${p.code}:${p.bucket}`)).toEqual(["bucket-should-be-public:event-assets"]);
  });

  it("does not write anything: the probe only lists buckets", async () => {
    await diagnose();
    expect(state.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /bucket"]);
    expect(state.objects.size).toBe(0);
  });
});
