import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { mintUser, resetAuth, resetFirestore, seedFest, type TestUser } from "./harness";

/**
 * POST /api/uploads through the real handler, against the real Firebase Auth
 * and Firestore emulators — RBAC, ownership checks and the audit log are all
 * genuine. Supabase Storage itself is faked in-memory: there is no local
 * Supabase stack available here. The fake implements exactly the surface
 * src/server/storage calls (`upload`, `getPublicUrl`, `createSignedUrl`,
 * `remove`), so every assertion below about what actually gets written —
 * bytes, content type, custom metadata — still exercises the real pipeline
 * in src/server/storage/{image,upload}.ts, just against a fake backend.
 */

const { fakeObjects, resetFakeStorage } = vi.hoisted(() => {
  const objects = new Map<string, { bytes: Buffer; contentType: string; metadata: Record<string, string> }>();
  return { fakeObjects: objects, resetFakeStorage: () => objects.clear() };
});

vi.mock("@/server/storage/client", () => {
  const BUCKETS = { eventAssets: "event-assets", certificates: "certificates", avatars: "avatars", uploads: "uploads" } as const;
  const PUBLIC_BUCKETS = new Set<string>([BUCKETS.eventAssets, BUCKETS.avatars]);
  const isPublicBucket = (bucket: string) => PUBLIC_BUCKETS.has(bucket);

  const from = (bucket: string) => ({
    upload: async (path: string, bytes: Buffer, options: { contentType: string; metadata?: Record<string, string> }) => {
      fakeObjects.set(`${bucket}/${path}`, { bytes: Buffer.from(bytes), contentType: options.contentType, metadata: options.metadata ?? {} });
      return { data: { path, id: path, fullPath: `${bucket}/${path}` }, error: null };
    },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.local/storage/v1/object/public/${bucket}/${path}` } }),
    createSignedUrl: async (path: string, expiresIn: number) => ({
      data: { signedUrl: `https://fake.supabase.local/storage/v1/object/sign/${bucket}/${path}?token=fake&expiresIn=${expiresIn}` },
      error: null,
    }),
    remove: async (paths: string[]) => {
      for (const p of paths) fakeObjects.delete(`${bucket}/${p}`);
      return { data: null, error: null };
    },
  });

  const client = {
    storage: {
      from,
      getBucket: async (id: string) => ({ data: { id, name: id, public: isPublicBucket(id) }, error: null }),
    },
  };

  return {
    BUCKETS,
    isPublicBucket,
    supabaseAdmin: () => client,
    isStorageConfigured: () => true,
    resetStorageClientForTests: () => undefined,
  };
});

// Imported after the mock so the route (and everything it pulls in under
// src/server/storage/) resolves against the fake client above.
const { POST: upload } = await import("@/app/api/uploads/route");

let student: TestUser;
let admin: TestUser;
let otherVolunteer: TestUser;
let volunteer: TestUser;

const png = (w = 64, h = 64) => sharp({ create: { width: w, height: h, channels: 4, background: "#9184d9" } }).png().toBuffer();

const send = async (user: TestUser | null, query: string, file: { bytes: Buffer; name: string; type: string } | null, headers: Record<string, string> = {}) => {
  const form = new FormData();
  if (file) form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  const request = new Request(`http://localhost:3000/api/uploads?${query}`, {
    method: "POST",
    headers: { ...(user ? { authorization: `Bearer ${user.idToken}` } : {}), ...headers },
    body: file ? form : undefined,
  });
  const res = await upload(request, { params: Promise.resolve({}) });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body };
};

beforeAll(async () => {
  await resetAuth();
  student = await mintUser({ name: "Uploader Student" });
  admin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Fest Admin" });
  otherVolunteer = await mintUser({ role: "volunteer", festIds: ["fest2"], name: "Other Org" });
  volunteer = await mintUser({ role: "volunteer", festIds: ["fest1"], name: "Fest Org" });
});

beforeEach(async () => {
  resetFakeStorage();
  await resetFirestore();
  for (const u of [student, admin, otherVolunteer, volunteer]) {
    const festIds = u === otherVolunteer ? ["fest2"] : ["fest1"];
    await adminDb()
      .collection(COLLECTIONS.users)
      .doc(u.uid)
      .set({
        id: u.uid,
        email: u.email,
        name: u.name,
        role: u.role,
        festIds: u.role === "student" ? [] : festIds,
        emailVerified: true,
        profileCompleted: true,
        mustChangePassword: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(u.role === "student" ? { college: "T", phone: "+919000000000" } : {}),
      });
  }
  await seedFest();
  await seedFest({ id: "fest2", slug: "other" });
});

describe("authorization", () => {
  it("requires a signed-in caller", async () => {
    expect((await send(null, "kind=festBanner&id=fest1", { bytes: await png(), name: "a.png", type: "image/png" })).status).toBe(401);
  });

  it("students and volunteers cannot upload fest banners; volunteers of other fests cannot upload posters here", async () => {
    const file = { bytes: await png(), name: "banner.png", type: "image/png" };
    expect((await send(student, "kind=festBanner&id=fest1", file)).status).toBe(403);
    expect((await send(volunteer, "kind=festBanner&id=fest1", file)).status).toBe(403);
    expect((await send(otherVolunteer, "kind=eventPoster&id=fest1", file)).status).toBe(403);
    expect((await send(admin, "kind=festBanner&id=fest1", file)).status).toBe(201);
  });

  it("an admin may upload an event poster for their own fest; a volunteer may not", async () => {
    // Artwork is an admin capability: a volunteer only scans.
    expect((await send(volunteer, "kind=eventPoster&id=fest1", { bytes: await png(), name: "p.png", type: "image/png" })).status).toBe(403);
    const ok = await send(admin, "kind=eventPoster&id=fest1", { bytes: await png(), name: "poster.png", type: "image/png" });
    expect(ok.status).toBe(201);
    expect(String(ok.body.path)).toMatch(/^fests\/fest1\/posters\/[0-9a-f-]{36}\.png$/);
  });

  it("a profile photo always lands under the caller, whatever id is passed", async () => {
    const ok = await send(student, `kind=profilePhoto&id=${admin.uid}`, { bytes: await png(), name: "me.png", type: "image/png" });
    expect(ok.status).toBe(201);
    expect(String(ok.body.path)).toMatch(new RegExp(`^users/${student.uid}/photo/[0-9a-f-]{36}\\.png$`));
  });

  it("an event head identity upload accepts either an image or a PDF, for any signed-in account", async () => {
    const imageUpload = await send(student, "kind=eventHeadIdentity", { bytes: await png(), name: "id.png", type: "image/png" });
    expect(imageUpload.status).toBe(201);
    expect(imageUpload.body.bucket).toBe("uploads");
    expect(String(imageUpload.body.path)).toMatch(new RegExp(`^users/${student.uid}/identity/[0-9a-f-]{36}\\.png$`));

    const pdfUpload = await send(student, "kind=eventHeadIdentity", { bytes: Buffer.from("%PDF-1.4\n%authorization letter\n"), name: "letter.pdf", type: "application/pdf" });
    expect(pdfUpload.status).toBe(201);
    expect(pdfUpload.body.contentType).toBe("application/pdf");
    expect(String(pdfUpload.body.path)).toMatch(new RegExp(`^users/${student.uid}/identity/[0-9a-f-]{36}\\.pdf$`));
  });

  it("rejects unknown kinds, missing ids and ids that could traverse", async () => {
    const file = { bytes: await png(), name: "x.png", type: "image/png" };
    expect((await send(admin, "kind=anything&id=fest1", file)).status).toBe(400);
    expect((await send(admin, "kind=festBanner&id=..%2F..%2Fcertificates", file)).status).toBe(400);
    expect((await send(admin, "kind=festBanner", file)).status).toBe(400);
    // An id outside the caller's scope is refused before its existence is
    // revealed; only an unscoped super admin ever sees the 404.
    expect((await send(admin, "kind=festBanner&id=nope", file)).status).toBe(403); // admins are unscoped; the fest must exist
  });
});

describe("content validation", () => {
  it("rejects an executable renamed to .png with an image content type (415)", async () => {
    const spoofed = Buffer.concat([Buffer.from("MZ"), Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(300)]);
    const res = await send(admin, "kind=festBanner&id=fest1", { bytes: spoofed, name: "innocent.png", type: "image/png" });
    expect(res.status).toBe(415);
    expect(res.body.code).toBe("unsupported-type");
    expect(String(res.body.error)).toMatch(/executables/i);
  });

  it("rejects SVG and HTML however they are declared", async () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>`);
    expect((await send(admin, "kind=festLogo&id=fest1", { bytes: svg, name: "logo.svg", type: "image/svg+xml" })).status).toBe(415);
    expect((await send(admin, "kind=festLogo&id=fest1", { bytes: svg, name: "logo.png", type: "image/png" })).status).toBe(415);
    const html = Buffer.from(`<!doctype html><html><script>1</script></html>`);
    expect((await send(admin, "kind=festLogo&id=fest1", { bytes: html, name: "logo.jpg", type: "image/jpeg" })).status).toBe(415);
  });

  it("rejects oversized files before decoding (413)", async () => {
    // 2 MB logo limit: a 2.5 MB body with a valid PNG header.
    const big = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(2.5 * 1024 * 1024)]);
    const res = await send(admin, "kind=festLogo&id=fest1", { bytes: big, name: "big.png", type: "image/png" });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("too-large");
    const declared = await send(admin, "kind=festBanner&id=fest1", { bytes: await png(), name: "a.png", type: "image/png" }, { "content-length": String(50 * 1024 * 1024) });
    expect(declared.status).toBe(413);
  });

  it("rejects an empty or missing file and a non-multipart body", async () => {
    expect((await send(admin, "kind=festBanner&id=fest1", null)).status).toBe(400);
    expect((await send(admin, "kind=festBanner&id=fest1", { bytes: Buffer.alloc(0), name: "e.png", type: "image/png" })).status).toBe(400);
  });
});

describe("what is stored", () => {
  it("lands in the bucket under a random name with the detected type, no EXIF, and provenance metadata", async () => {
    const exif = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#123456" } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: "remove me" } } })
      .toBuffer();
    const res = await send(admin, "kind=festBanner&id=fest1", { bytes: exif, name: "../../../etc/passwd.jpg", type: "application/octet-stream" });
    expect(res.status).toBe(201);
    expect(res.body.bucket).toBe("event-assets");
    expect(res.body.contentType).toBe("image/jpeg");
    expect(String(res.body.path)).toMatch(/^fests\/fest1\/banners\/[0-9a-f-]{36}\.jpg$/);
    expect(String(res.body.path)).not.toContain("passwd");
    expect(String(res.body.url)).toBe(`https://fake.supabase.local/storage/v1/object/public/event-assets/${res.body.path}`);

    const stored = fakeObjects.get(`event-assets/${res.body.path}`);
    expect(stored).toBeDefined();
    expect(stored!.contentType).toBe("image/jpeg");
    expect(stored!.metadata.uploadedBy).toBe(admin.uid);
    expect(stored!.metadata.kind).toBe("festBanner");
    const decoded = await sharp(stored!.bytes).metadata();
    expect(decoded.exif).toBeUndefined();
    expect(stored!.bytes.toString("latin1")).not.toContain("remove me");

    const auditRows = await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", "file_uploaded").get();
    expect(auditRows.size).toBe(1);
  });
});
