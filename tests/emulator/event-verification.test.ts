import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";
import { callRoute, freshToken, mintUser, resetAuth, resetFirestore, seedFest, type TestUser } from "./harness";

/**
 * The event-application lifecycle through the real handlers, against the Firebase Auth and Firestore emulators:
 * a registration is a pending application, only a `fest:verify` holder decides it, and approval makes the applicant the
 * event's one Event Head without touching anything else they have. Supabase Storage is faked in memory (as in
 * uploads-api.test.ts): the upload pipeline, the paths, and who may ask for a link are all the real code.
 */

const { fakeObjects, resetFakeStorage } = vi.hoisted(() => {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  return { fakeObjects: objects, resetFakeStorage: () => objects.clear() };
});

vi.mock("@/server/storage/client", () => {
  const BUCKETS = { eventAssets: "event-assets", certificates: "certificates", avatars: "avatars", uploads: "uploads" } as const;
  const PUBLIC_BUCKETS = new Set<string>([BUCKETS.eventAssets, BUCKETS.avatars]);
  const from = (bucket: string) => ({
    upload: async (path: string, bytes: Buffer, options: { contentType: string }) => {
      fakeObjects.set(`${bucket}/${path}`, { bytes: Buffer.from(bytes), contentType: options.contentType });
      return { data: { path, id: path, fullPath: `${bucket}/${path}` }, error: null };
    },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.local/storage/v1/object/public/${bucket}/${path}` } }),
    createSignedUrl: async (path: string, expiresIn: number) => ({
      data: { signedUrl: `https://fake.supabase.local/storage/v1/object/sign/${bucket}/${path}?token=fake&expiresIn=${expiresIn}` },
      error: null,
    }),
    remove: async () => ({ data: null, error: null }),
  });
  const client = { storage: { from, getBucket: async (id: string) => ({ data: { id, name: id, public: PUBLIC_BUCKETS.has(id) }, error: null }) } };
  return { BUCKETS, isPublicBucket: (bucket: string) => PUBLIC_BUCKETS.has(bucket), supabaseAdmin: () => client, isStorageConfigured: () => true, resetStorageClientForTests: () => undefined };
});

const { POST: registerEvent, GET: myApplications } = await import("@/app/api/register-event/route");
const { POST: decide } = await import("@/app/api/admin/fests/[id]/verification/route");
const { GET: openDocument } = await import("@/app/api/admin/fests/[id]/verification/document/route");
const { GET: reviewQueue } = await import("@/app/api/admin/verifications/route");
const { PATCH: festAction } = await import("@/app/api/admin/fests/[id]/route");
const { POST: createEvent } = await import("@/app/api/admin/events/route");
const { POST: createStaff } = await import("@/app/api/admin/staff/route");
const { POST: upload } = await import("@/app/api/uploads/route");

let reviewer: TestUser;
let secondReviewer: TestUser;
let volunteer: TestUser;
let scopedAdmin: TestUser;
let outsider: TestUser;

const validBody = (name: string, extra: Record<string, unknown> = {}) => ({
  organizationName: "Test Institute of Technology",
  organizationType: "college" as const,
  contactEmail: "events@test-institute.edu",
  city: "Chennai",
  state: "Tamil Nadu",
  name,
  description: "A three-day tech and culture fest.",
  festType: "tech" as const,
  startDate: "2026-11-01",
  endDate: "2026-11-03",
  venue: "Main campus",
  expectedParticipants: 500,
  eventHead: { name: "Meena R. Kumar", designation: "Cultural Secretary", phone: "+919000000000", ...extra },
});

const seedProfile = async (u: TestUser, festIds: string[]) =>
  adminDb()
    .collection(COLLECTIONS.users)
    .doc(u.uid)
    .set({ id: u.uid, email: u.email, name: u.name, role: u.role, festIds, profileCompleted: true, mustChangePassword: false, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });

beforeAll(async () => {
  await resetAuth();
  reviewer = await mintUser({ role: "super_admin", name: "Platform Reviewer" });
  secondReviewer = await mintUser({ role: "super_admin", name: "Second Reviewer" });
  volunteer = await mintUser({ role: "volunteer", festIds: ["other-fest"], name: "Gate Volunteer" });
  scopedAdmin = await mintUser({ role: "admin", festIds: ["other-fest"], name: "Other Fest Admin" });
  outsider = await mintUser({ name: "Unrelated Student" });
});

beforeEach(async () => {
  resetFakeStorage();
  await resetFirestore();
  for (const u of [reviewer, secondReviewer, outsider]) await seedProfile(u, []);
  for (const u of [volunteer, scopedAdmin]) await seedProfile(u, ["other-fest"]);
});

/* ───────────── helpers ───────────── */

const apply = async (user: TestUser, name: string, extra: Record<string, unknown> = {}) =>
  callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: user.idToken, body: validBody(name, extra) });

const decideAs = (user: TestUser, festId: string, body: Record<string, unknown>) =>
  callRoute(decide, { method: "POST", path: `/api/admin/fests/${festId}/verification`, params: { id: festId }, token: user.idToken, body });

const approve = (user: TestUser, festId: string) => decideAs(user, festId, { action: "approve" });

const patchFest = (token: string, festId: string, body: Record<string, unknown>) =>
  callRoute(festAction, { method: "PATCH", path: `/api/admin/fests/${festId}`, params: { id: festId }, token, body });

/** What an account can do, as the server (profile) and the rules (claim) each see it. */
const accessOf = async (user: TestUser) => {
  const profile = (await adminDb().collection(COLLECTIONS.users).doc(user.uid).get()).data();
  const claims = (await adminAuth().getUser(user.uid)).customClaims ?? {};
  return { profile: { role: profile?.role, festIds: profile?.festIds }, claim: { role: claims.role, festIds: claims.festIds } };
};

/** The event-level side of an account: its active memberships, and what it mirrors onto the profile and the claims. */
const membershipsOf = async (user: TestUser) => {
  const docs = (await adminDb().collection(COLLECTIONS.festMembers).where("userId", "==", user.uid).get()).docs.map((d) => d.data());
  const profile = (await adminDb().collection(COLLECTIONS.users).doc(user.uid).get()).data();
  const claims = (await adminAuth().getUser(user.uid)).customClaims ?? {};
  return { docs, memberOf: (profile?.memberOf ?? []) as string[], fm: (claims.fm ?? []) as string[] };
};

const festDoc = async (festId: string) => (await adminDb().collection(COLLECTIONS.fests).doc(festId).get()).data();

const setAccess = async (user: TestUser, role: string, festIds: string[]) => {
  await adminAuth().setCustomUserClaims(user.uid, { role, festIds });
  await adminDb().collection(COLLECTIONS.users).doc(user.uid).set({ role, festIds }, { merge: true });
};

const png = () => sharp({ create: { width: 64, height: 64, channels: 4, background: "#9184d9" } }).png().toBuffer();

const uploadIdentity = async (user: TestUser) => {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(await png())], { type: "image/png" }), "id.png");
  const res = await upload(new Request("http://localhost:3000/api/uploads?kind=eventHeadIdentity", { method: "POST", headers: { authorization: `Bearer ${user.idToken}` }, body: form }), { params: Promise.resolve({}) });
  return { status: res.status, body: (await res.json()) as { path: string; bucket: string; url: string } };
};

/* ───────────── filing ───────────── */

describe("filing an application", () => {
  it("stays pending after submission, with no owner, and says so to the applicant", async () => {
    const applicant = await mintUser({ name: "Applicant One" });
    const res = await apply(applicant, "Pending Fest");
    expect(res.status).toBe(201);
    const festId = res.body.fest.id as string;

    const stored = await festDoc(festId);
    expect(stored?.verification.status).toBe("pending");
    expect(stored).not.toHaveProperty("ownerId");
    expect(stored?.status).toBe("draft");

    const mine = await callRoute(myApplications, { path: "/api/register-event", token: applicant.idToken });
    expect(mine.status).toBe(200);
    expect(mine.body.applications).toHaveLength(1);
    expect(mine.body.applications[0]).toMatchObject({ festId, status: "pending", name: "Pending Fest" });
    expect(String(mine.body.applications[0].message)).toMatch(/approved/i);
  });

  it("shows an applicant only their own applications", async () => {
    const applicant = await mintUser({ name: "Applicant Two" });
    await apply(applicant, "Mine");
    const other = await callRoute(myApplications, { path: "/api/register-event", token: outsider.idToken });
    expect(other.body.applications).toEqual([]);
  });

  it("uploading an identity document grants nothing, and only its private path is kept", async () => {
    const applicant = await mintUser({ name: "Applicant With Document" });
    const before = await accessOf(applicant);

    const uploaded = await uploadIdentity(applicant);
    expect(uploaded.status).toBe(201);
    // Private bucket, under the uploader's own folder, random name.
    expect(uploaded.body.bucket).toBe("uploads");
    expect(uploaded.body.path).toMatch(new RegExp(`^users/${applicant.uid}/identity/[0-9a-f-]+\\.png$`));
    expect(fakeObjects.has(`uploads/${uploaded.body.path}`)).toBe(true);
    expect(await accessOf(applicant)).toEqual(before);

    const res = await apply(applicant, "Document Fest", { idDocumentPath: uploaded.body.path });
    expect(res.status).toBe(201);
    expect(await accessOf(applicant)).toEqual(before);

    // The public fest document carries neither the path nor any link; the private one holds the path, not a URL.
    expect(JSON.stringify(res.body)).not.toContain(uploaded.body.path);
    const priv = (await adminDb().collection(COLLECTIONS.festPrivate).doc(res.body.fest.id).get()).data();
    expect(priv?.verification.documents).toEqual([{ kind: "identity", bucket: "uploads", path: uploaded.body.path }]);
    expect(JSON.stringify(priv)).not.toContain("token=");
  });

  it("refuses a document path that belongs to somebody else", async () => {
    const owner = await mintUser({ name: "Document Owner" });
    const thief = await mintUser({ name: "Path Thief" });
    const uploaded = await uploadIdentity(owner);

    const res = await apply(thief, "Stolen Path Fest", { idDocumentPath: uploaded.body.path });
    expect(res.status).toBe(422);
    expect((await adminDb().collection(COLLECTIONS.fests).get()).size).toBe(0);
  });
});

/* ───────────── a pending applicant ───────────── */

describe("a pending applicant has no authority over the event", () => {
  it("cannot publish, edit, create events, staff it, or approve it - even after signing in again", async () => {
    const applicant = await mintUser({ name: "Pending Applicant" });
    const festId = (await apply(applicant, "Not Yet Fest")).body.fest.id as string;
    const token = await freshToken(applicant);
    const before = await accessOf(applicant);

    expect((await patchFest(token, festId, { action: "edit", changes: { status: "published" } })).status).toBe(403);
    expect((await patchFest(token, festId, { action: "edit", changes: { name: "Renamed" } })).status).toBe(403);
    expect((await callRoute(createEvent, { method: "POST", path: "/api/admin/events", token, body: { festId } })).status).toBe(403);
    expect((await callRoute(createStaff, { method: "POST", path: "/api/admin/staff", token, body: { name: "X", email: `x-${Date.now()}@plansphere.test`, role: "admin", festIds: [festId] } })).status).toBe(403);
    expect((await approve({ ...applicant, idToken: token }, festId)).status).toBe(403);

    expect(await accessOf(applicant)).toEqual(before);
    expect((await festDoc(festId))?.verification.status).toBe("pending");
    expect((await festDoc(festId))?.status).toBe("draft");
  });

  it("cannot be published by anyone, the platform included, until it is approved", async () => {
    const applicant = await mintUser({ name: "Pending Applicant Two" });
    const festId = (await apply(applicant, "Held Back Fest")).body.fest.id as string;

    const res = await patchFest(reviewer.idToken, festId, { action: "edit", changes: { status: "published" } });
    expect(res.status).toBe(409);
    expect((await festDoc(festId))?.status).toBe("draft");
  });

  it("cannot be handed to anyone by transfer while it is under review", async () => {
    const applicant = await mintUser({ name: "Pending Applicant Three" });
    const festId = (await apply(applicant, "Transfer Attempt")).body.fest.id as string;

    const res = await patchFest(reviewer.idToken, festId, { action: "transfer", ownerId: scopedAdmin.uid });
    expect(res.status).toBe(409);
    expect(await festDoc(festId)).not.toHaveProperty("ownerId");
  });
});

/* ───────────── who may decide ───────────── */

describe("who may approve or reject", () => {
  it("no volunteer, admin, applicant or student can, and the application stays pending", async () => {
    const applicant = await mintUser({ name: "Applicant Under Review" });
    const festId = (await apply(applicant, "Authority Fest")).body.fest.id as string;
    // An admin of THIS very event (assigned by the platform) still has no say in who runs it.
    const festAdmin = await mintUser({ role: "admin", festIds: [festId], name: "Assigned Fest Admin" });

    for (const who of [volunteer, scopedAdmin, festAdmin, applicant, outsider]) {
      expect((await approve(who, festId)).status, `approve as ${who.name}`).toBe(403);
      expect((await decideAs(who, festId, { action: "reject", reason: "Not allowed" })).status, `reject as ${who.name}`).toBe(403);
    }
    expect((await callRoute(decide, { method: "POST", path: "/x", params: { id: festId }, body: { action: "approve" } })).status).toBe(401);

    const stored = await festDoc(festId);
    expect(stored?.verification.status).toBe("pending");
    expect(stored).not.toHaveProperty("ownerId");
  });

  it("a reviewer cannot decide their own application", async () => {
    const applicant = await mintUser({ name: "Applicant Who Becomes Reviewer" });
    const festId = (await apply(applicant, "Self Approval Fest")).body.fest.id as string;
    await setAccess(applicant, "super_admin", []);

    const token = await freshToken(applicant);
    expect((await approve({ ...applicant, idToken: token }, festId)).status).toBe(403);
    expect((await decideAs({ ...applicant, idToken: token }, festId, { action: "reject", reason: "Nope" })).status).toBe(403);
    expect((await festDoc(festId))?.verification.status).toBe("pending");
  });

  it("only reviewers see the review queue, and it carries no document or phone number", async () => {
    const applicant = await mintUser({ name: "Queued Applicant" });
    const uploaded = await uploadIdentity(applicant);
    await apply(applicant, "Queued Fest", { idDocumentPath: uploaded.body.path });

    for (const who of [volunteer, scopedAdmin, applicant, outsider]) {
      expect((await callRoute(reviewQueue, { path: "/api/admin/verifications", token: who.idToken })).status).toBe(403);
    }
    const queue = await callRoute(reviewQueue, { path: "/api/admin/verifications", token: reviewer.idToken });
    expect(queue.status).toBe(200);
    expect(queue.body.applications).toHaveLength(1);
    expect(queue.body.applications[0]).toMatchObject({ name: "Queued Fest", hasIdentityDocument: true, applicant: { id: applicant.uid } });
    const text = JSON.stringify(queue.body);
    expect(text).not.toContain(uploaded.body.path);
    expect(text).not.toContain("+919000000000");
  });
});

/* ───────────── approval ───────────── */

describe("approval", () => {
  it("makes the applicant the one Event Head of this event by membership, and nothing else about them changes", async () => {
    const applicant = await mintUser({ name: "Approved Applicant" });
    const festId = (await apply(applicant, "Approved Fest")).body.fest.id as string;
    await seedFest({ id: "unrelated-fest", slug: "unrelated", name: "Unrelated Fest" });
    const before = await accessOf(applicant);

    const res = await approve(reviewer, festId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "approved", ownerId: applicant.uid, festRole: "head" });

    const stored = await festDoc(festId);
    expect(stored?.ownerId).toBe(applicant.uid);
    expect(stored?.verification).toMatchObject({ status: "approved", basis: "review" });

    // The head is a membership on this one fest. Their own role and legacy scope are exactly what they were...
    const member = await membershipsOf(applicant);
    expect(member.docs).toHaveLength(1);
    expect(member.docs[0]).toMatchObject({ festId, userId: applicant.uid, role: "head", status: "active" });
    expect(member.memberOf).toEqual([festId]);
    expect(member.fm).toEqual([festId]);
    expect((await accessOf(applicant)).profile).toEqual(before.profile);
    // ...and it is never the platform's role.
    expect((await accessOf(applicant)).claim.role).not.toBe("super_admin");

    // They run this event - the server reads the membership live, so even their old token works...
    expect((await patchFest(applicant.idToken, festId, { action: "edit", changes: { name: "Approved Fest 2026" } })).status).toBe(200);
    const token = await freshToken(applicant);
    expect((await festDoc(festId))?.name).toBe("Approved Fest 2026");
    // ...and publish it, now that it is approved...
    expect((await patchFest(token, festId, { action: "edit", changes: { status: "published" } })).status).toBe(200);
    // ...but nothing else: not another main event, however it is asked.
    expect((await patchFest(token, "unrelated-fest", { action: "edit", changes: { name: "Hijacked" } })).status).toBe(403);
    expect((await callRoute(createStaff, { method: "POST", path: "/api/admin/staff", token, body: { name: "Intruder", email: `i-${Date.now()}@plansphere.test`, role: "volunteer", festIds: ["unrelated-fest"] } })).status).toBe(403);
    expect((await callRoute(createStaff, { method: "POST", path: "/api/admin/staff", token, body: { name: "Platform", email: `p-${Date.now()}@plansphere.test`, role: "super_admin", festIds: [] } })).status).toBe(403);
  });

  it("cannot be edited into the fest document by an admin: the verification state is the server's alone", async () => {
    const applicant = await mintUser({ name: "Applicant For Forgery Check" });
    const festId = (await apply(applicant, "Forgery Fest")).body.fest.id as string;
    await approve(reviewer, festId);
    const token = await freshToken(applicant);

    // The edit schema has no such field, so it is simply not applied.
    await patchFest(token, festId, { action: "edit", changes: { verification: { status: "pending" }, ownerId: outsider.uid } });
    const stored = await festDoc(festId);
    expect(stored?.verification.status).toBe("approved");
    expect(stored?.ownerId).toBe(applicant.uid);
  });

  it("leaves an existing admin's role and legacy fests alone, and the new fest is a separate membership", async () => {
    const applicant = await mintUser({ name: "Applicant Who Became An Admin" });
    const festId = (await apply(applicant, "Second Event Fest")).body.fest.id as string;
    await setAccess(applicant, "admin", ["other-fest"]);
    const before = await accessOf(applicant);

    const res = await approve(reviewer, festId);
    expect(res.status).toBe(200);
    const access = await accessOf(applicant);
    expect(access.profile).toEqual(before.profile);
    expect(access.profile.festIds).toEqual(["other-fest"]);
    expect(access.claim.festIds).toEqual(["other-fest"]);
    expect((await membershipsOf(applicant)).fm).toEqual([festId]);
  });

  it("does not merge a student's stale scope with the new event: the membership is the whole of their authority here", async () => {
    const applicant = await mintUser({ name: "Student With Leftover Scope" });
    await adminDb().collection(COLLECTIONS.users).doc(applicant.uid).set({ festIds: ["stale-fest"] }, { merge: true });
    const festId = (await apply(applicant, "Stale Scope Fest")).body.fest.id as string;

    await approve(reviewer, festId);
    expect((await accessOf(applicant)).profile).toEqual({ role: "student", festIds: ["stale-fest"] });
    expect((await membershipsOf(applicant)).memberOf).toEqual([festId]);
  });

  it("approves an applicant who is a volunteer at another event: head here, still only a volunteer there", async () => {
    const applicant = await mintUser({ name: "Applicant Turned Volunteer" });
    const festId = (await apply(applicant, "Volunteer And Head Fest")).body.fest.id as string;
    await setAccess(applicant, "volunteer", ["other-fest"]);
    const before = await accessOf(applicant);

    const res = await approve(reviewer, festId);
    expect(res.status).toBe(200);

    // Their account is still a volunteer of the other event, with exactly the scope it had.
    expect((await accessOf(applicant)).profile).toEqual(before.profile);
    const token = await freshToken(applicant);
    // Head of the new event...
    expect((await patchFest(token, festId, { action: "edit", changes: { name: "Renamed By Head" } })).status).toBe(200);
    // ...and no more than a volunteer of the other one: the head role did not travel.
    expect((await patchFest(token, "other-fest", { action: "edit", changes: { name: "Not Theirs" } })).status).toBe(403);
    // The coarse gate lets them through as an admin (they head another event); at the other one they are a volunteer, and
    // creating staff there is not a volunteer's to do.
    expect((await callRoute(createStaff, { method: "POST", path: "/api/admin/staff", token, body: { name: "Helper", email: `h-${Date.now()}@plansphere.test`, role: "volunteer", festIds: ["other-fest"] } })).status).toBe(403);
  });

  it("refuses a disabled applicant", async () => {
    const applicant = await mintUser({ name: "Disabled Applicant" });
    const festId = (await apply(applicant, "Disabled Fest")).body.fest.id as string;
    await adminDb().collection(COLLECTIONS.users).doc(applicant.uid).set({ disabled: true }, { merge: true });

    expect((await approve(reviewer, festId)).status).toBe(422);
    expect((await festDoc(festId))?.verification.status).toBe("pending");
  });

  it("a repeated approval is refused and cannot change the Event Head", async () => {
    const applicant = await mintUser({ name: "Applicant Approved Twice" });
    const festId = (await apply(applicant, "Twice Fest")).body.fest.id as string;

    expect((await approve(reviewer, festId)).status).toBe(200);
    const again = await approve(secondReviewer, festId);
    expect(again.status).toBe(409);
    expect((await festDoc(festId))?.ownerId).toBe(applicant.uid);
  });

  it("concurrent approvals produce exactly one approval and one Event Head", async () => {
    const applicant = await mintUser({ name: "Applicant Approved In Parallel" });
    const festId = (await apply(applicant, "Parallel Fest")).body.fest.id as string;

    const results = await Promise.all([approve(reviewer, festId), approve(secondReviewer, festId), approve(reviewer, festId), approve(secondReviewer, festId), approve(reviewer, festId)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);

    expect((await festDoc(festId))?.ownerId).toBe(applicant.uid);
    // Exactly one Event Head membership exists for the fest, and it is the applicant's.
    const heads = (await adminDb().collection(COLLECTIONS.festMembers).where("festId", "==", festId).get()).docs.map((d) => d.data());
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({ userId: applicant.uid, role: "head", status: "active" });
    const approvals = (await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", "fest_verification_approved").get()).size;
    expect(approvals).toBe(1);
  });

  it("rolls the approval back if the applicant's claims cannot be set, so nobody is half-approved", async () => {
    const applicant = await mintUser({ name: "Applicant Whose Account Vanished" });
    const festId = (await apply(applicant, "Rollback Fest")).body.fest.id as string;
    const before = (await adminDb().collection(COLLECTIONS.users).doc(applicant.uid).get()).data();
    // Setting this account's claims fails once, the way a transient Auth outage would.
    const failing = vi.spyOn(adminAuth(), "setCustomUserClaims").mockRejectedValueOnce(new Error("auth unavailable"));

    const res = await approve(reviewer, festId);
    failing.mockRestore();
    expect(res.status).toBe(503);

    const stored = await festDoc(festId);
    expect(stored?.verification.status).toBe("pending");
    expect(stored).not.toHaveProperty("ownerId");
    expect(stored?.verification).not.toHaveProperty("decidedAt");
    const after = (await adminDb().collection(COLLECTIONS.users).doc(applicant.uid).get()).data();
    expect({ role: after?.role, festIds: after?.festIds }).toEqual({ role: before?.role, festIds: before?.festIds });
    expect((await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", "fest_verification_approved").get()).size).toBe(0);
    // No head membership is left behind, nor any mirror of one.
    const member = await membershipsOf(applicant);
    expect(member.docs).toHaveLength(0);
    expect(member.memberOf).toEqual([]);
  });

  it("records the decision without the document, its path, or the reviewer's notes in the audit trail", async () => {
    const applicant = await mintUser({ name: "Audited Applicant" });
    const uploaded = await uploadIdentity(applicant);
    const festId = (await apply(applicant, "Audited Fest", { idDocumentPath: uploaded.body.path })).body.fest.id as string;

    await approve(reviewer, festId);
    const entries = (await adminDb().collection(COLLECTIONS.auditLog).get()).docs.map((d) => d.data());
    const decision = entries.find((e) => e.action === "fest_verification_approved");
    expect(decision).toMatchObject({ actorId: reviewer.uid, festId, subjectId: festId });
    const trail = JSON.stringify(entries);
    expect(trail).not.toContain(uploaded.body.path);
    expect(trail).not.toContain("+919000000000");
    expect(trail).not.toContain("token=");
  });
});

/* ───────────── the applicant's email ───────────── */

describe("the applicant's email address", () => {
  it("must be verified before approval, and an unverified applicant stays pending with no access", async () => {
    const applicant = await mintUser({ name: "Unverified Applicant", emailVerified: false });
    const festId = (await apply(applicant, "Unverified Fest")).body.fest.id as string;
    const before = await accessOf(applicant);

    const res = await approve(reviewer, festId);
    expect(res.status).toBe(422);
    expect(String(res.body.error)).toMatch(/verif/i);
    expect(await accessOf(applicant)).toEqual(before);
    const stored = await festDoc(festId);
    expect(stored?.verification.status).toBe("pending");
    expect(stored).not.toHaveProperty("ownerId");
  });

  it("is judged by the sign-in account, not by the profile copy a user can write themselves", async () => {
    const applicant = await mintUser({ name: "Applicant Claiming Verified", emailVerified: false });
    const festId = (await apply(applicant, "Self Declared Fest")).body.fest.id as string;
    await adminDb().collection(COLLECTIONS.users).doc(applicant.uid).set({ emailVerified: true }, { merge: true });

    expect((await approve(reviewer, festId)).status).toBe(422);
    expect((await festDoc(festId))?.verification.status).toBe("pending");
  });

  it("is approvable once the address is verified", async () => {
    const applicant = await mintUser({ name: "Applicant Verifying Later", emailVerified: false });
    const festId = (await apply(applicant, "Verified Later Fest")).body.fest.id as string;
    expect((await approve(reviewer, festId)).status).toBe(422);

    await adminAuth().updateUser(applicant.uid, { emailVerified: true });
    expect((await approve(reviewer, festId)).status).toBe(200);
    expect((await festDoc(festId))?.ownerId).toBe(applicant.uid);
  });

  it("does not stop a rejection, so an unverified application can still be turned down", async () => {
    const applicant = await mintUser({ name: "Unverified Rejected", emailVerified: false });
    const festId = (await apply(applicant, "Rejected Unverified Fest")).body.fest.id as string;
    expect((await decideAs(reviewer, festId, { action: "reject", reason: "Please verify your college email and apply again." })).status).toBe(200);
  });

  it("is shown to the reviewer in the queue, and to the applicant on their status", async () => {
    const verified = await mintUser({ name: "Verified In Queue" });
    const unverified = await mintUser({ name: "Unverified In Queue", emailVerified: false });
    await apply(verified, "Verified Queue Fest");
    await apply(unverified, "Unverified Queue Fest");

    const queue = await callRoute(reviewQueue, { path: "/api/admin/verifications", token: reviewer.idToken });
    const byName = Object.fromEntries((queue.body.applications as Array<{ name: string; applicant: { emailVerified: boolean } }>).map((a) => [a.name, a.applicant.emailVerified]));
    expect(byName).toEqual({ "Verified Queue Fest": true, "Unverified Queue Fest": false });

    const mine = await callRoute(myApplications, { path: "/api/register-event", token: unverified.idToken });
    expect(mine.body.emailVerified).toBe(false);
  });
});

/* ───────────── the verified organization ───────────── */

describe("once an event has been verified, who it belongs to is the platform's to change", () => {
  const approvedFest = async (name: string) => {
    const applicant = await mintUser({ name: `${name} Head` });
    const festId = (await apply(applicant, name)).body.fest.id as string;
    expect((await approve(reviewer, festId)).status).toBe(200);
    return { applicant, festId, token: await freshToken(applicant) };
  };

  it("refuses its admin a new organization name, and changes nothing", async () => {
    const { festId, token } = await approvedFest("Identity Fest");

    expect((await patchFest(token, festId, { action: "edit", changes: { organizationName: "Another College Of Engineering" } })).status).toBe(403);
    // The edit API does not accept a type or website at all (the rules test covers a direct write of either), so
    // sending one is simply not applied.
    for (const changes of [{ organizationType: "company" }, { organizationWebsite: "https://another-college.edu" }]) {
      expect((await patchFest(token, festId, { action: "edit", changes })).status, JSON.stringify(changes)).toBe(400);
    }
    const stored = await festDoc(festId);
    expect(stored?.organizationName).toBe("Test Institute of Technology");
    expect(stored?.organizationType).toBe("college");
    expect(stored).not.toHaveProperty("organizationWebsite");
  });

  it("still lets the admin edit everything else, including sending the organization back unchanged", async () => {
    const { festId, token } = await approvedFest("Ordinary Edits Fest");

    const res = await patchFest(token, festId, { action: "edit", changes: { name: "Renamed Fest", description: "New copy", organizationName: "Test Institute of Technology", organizationType: "college" } });
    expect(res.status).toBe(200);
    expect((await festDoc(festId))?.name).toBe("Renamed Fest");
  });

  it("lets the platform change it, with the change recorded", async () => {
    const { festId } = await approvedFest("Platform Edit Fest");

    const res = await patchFest(reviewer.idToken, festId, { action: "edit", changes: { organizationName: "Corrected College Name" } });
    expect(res.status).toBe(200);
    expect((await festDoc(festId))?.organizationName).toBe("Corrected College Name");
    const entries = (await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", "fest_updated").get()).docs.map((d) => d.data());
    expect(JSON.stringify(entries)).toContain("organizationName");
  });

  it("does not change how events that predate the review are edited", async () => {
    await seedFest({ id: "old-fest", slug: "old", name: "Old Fest", organizationName: "Old Org" });
    const legacyAdmin = await mintUser({ role: "admin", festIds: ["old-fest"], name: "Old Fest Admin" });

    const res = await patchFest(legacyAdmin.idToken, "old-fest", { action: "edit", changes: { organizationName: "Old Org Renamed" } });
    expect(res.status).toBe(200);
    expect((await festDoc("old-fest"))?.organizationName).toBe("Old Org Renamed");
  });
});

/* ───────────── rejection ───────────── */

describe("rejection", () => {
  it("records a reason the applicant can read, grants nothing, and cannot be reversed by approving", async () => {
    const applicant = await mintUser({ name: "Rejected Applicant" });
    const festId = (await apply(applicant, "Rejected Fest")).body.fest.id as string;
    const before = await accessOf(applicant);

    const res = await decideAs(reviewer, festId, { action: "reject", reason: "We could not match the letter to your college." });
    expect(res.status).toBe(200);
    expect((await festDoc(festId))?.verification.status).toBe("rejected");
    expect(await festDoc(festId)).not.toHaveProperty("ownerId");
    expect(await accessOf(applicant)).toEqual(before);

    const mine = await callRoute(myApplications, { path: "/api/register-event", token: applicant.idToken });
    expect(mine.body.applications[0]).toMatchObject({ status: "rejected", reason: "We could not match the letter to your college." });

    // No authority afterwards either, and the decision is final.
    const token = await freshToken(applicant);
    expect((await patchFest(token, festId, { action: "edit", changes: { status: "published" } })).status).toBe(403);
    expect((await approve(reviewer, festId)).status).toBe(409);
    expect((await decideAs(reviewer, festId, { action: "reject", reason: "Again" })).status).toBe(409);
    expect((await patchFest(reviewer.idToken, festId, { action: "edit", changes: { status: "published" } })).status).toBe(409);
  });

  it("keeps the reason off the fest document that staff can read", async () => {
    const applicant = await mintUser({ name: "Rejected Applicant Two" });
    const festId = (await apply(applicant, "Reason Privacy Fest")).body.fest.id as string;
    await decideAs(reviewer, festId, { action: "reject", reason: "Documents were unreadable." });

    expect(JSON.stringify(await festDoc(festId))).not.toContain("unreadable");
    expect((await adminDb().collection(COLLECTIONS.festPrivate).doc(festId).get()).data()?.verification.reason).toBe("Documents were unreadable.");
  });

  it("refuses a reason that is missing or carries personal details, and leaves the application pending", async () => {
    const applicant = await mintUser({ name: "Applicant With Bad Reasons" });
    const festId = (await apply(applicant, "Bad Reason Fest")).body.fest.id as string;

    for (const reason of ["", "no", "Call him on +91 98765 43210", "Write to jane.doe@college.edu about it", "x".repeat(301)]) {
      expect((await decideAs(reviewer, festId, { action: "reject", reason })).status, reason.slice(0, 20)).toBe(422);
    }
    expect((await festDoc(festId))?.verification.status).toBe("pending");
  });
});

/* ───────────── private documents ───────────── */

describe("the identity document", () => {
  it("is opened only by a reviewer, through a short-lived link, and the opening is audited", async () => {
    const applicant = await mintUser({ name: "Applicant With A Document" });
    const uploaded = await uploadIdentity(applicant);
    const festId = (await apply(applicant, "Document Review Fest", { idDocumentPath: uploaded.body.path })).body.fest.id as string;

    const res = await callRoute(openDocument, { path: `/api/admin/fests/${festId}/verification/document`, params: { id: festId }, token: reviewer.idToken });
    expect(res.status).toBe(200);
    expect(res.body.expiresInSeconds).toBe(300);
    // A signed link into the private bucket, for the stored path, expiring in five minutes.
    expect(res.body.url).toContain(`/object/sign/uploads/${uploaded.body.path}`);
    expect(res.body.url).toContain("expiresIn=300");

    const viewed = (await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", "verification_document_viewed").get()).docs.map((d) => d.data());
    expect(viewed).toHaveLength(1);
    expect(JSON.stringify(viewed)).not.toContain(uploaded.body.path);
    expect(JSON.stringify(viewed)).not.toContain("token=");
  });

  it("is refused to everyone else: the applicant, other students, volunteers, admins, an admin of that very event, and anonymous callers", async () => {
    const applicant = await mintUser({ name: "Applicant Guarding A Document" });
    const uploaded = await uploadIdentity(applicant);
    const festId = (await apply(applicant, "Guarded Fest", { idDocumentPath: uploaded.body.path })).body.fest.id as string;
    const festAdmin = await mintUser({ role: "admin", festIds: [festId], name: "Guarded Fest Admin" });

    for (const who of [applicant, outsider, volunteer, scopedAdmin, festAdmin]) {
      const res = await callRoute(openDocument, { path: `/api/admin/fests/${festId}/verification/document`, params: { id: festId }, token: who.idToken });
      expect(res.status, who.name).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(uploaded.body.path);
    }
    expect((await callRoute(openDocument, { path: "/x", params: { id: festId } })).status).toBe(401);
    expect((await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", "verification_document_viewed").get()).size).toBe(0);
  });

  it("is always the stored one: a path in the request is ignored, and an application without a document answers 404", async () => {
    const applicant = await mintUser({ name: "Applicant With Two Things" });
    const uploaded = await uploadIdentity(applicant);
    const festId = (await apply(applicant, "Stored Path Fest", { idDocumentPath: uploaded.body.path })).body.fest.id as string;

    const res = await callRoute(openDocument, { path: `/api/admin/fests/${festId}/verification/document?path=users/someone-else/identity/x.png&bucket=certificates`, params: { id: festId }, token: reviewer.idToken });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain(`/uploads/${uploaded.body.path}`);
    expect(res.body.url).not.toContain("someone-else");

    const bare = await apply(await mintUser({ name: "Applicant Without A Document" }), "No Document Fest");
    const missing = await callRoute(openDocument, { path: "/x", params: { id: bare.body.fest.id }, token: reviewer.idToken });
    expect(missing.status).toBe(404);
  });
});

/* ───────────── existing events ───────────── */

describe("events that predate the review step", () => {
  it("keep working exactly as before and are not treated as verified or as pending", async () => {
    await seedFest({ id: "legacy-fest", slug: "legacy", name: "Legacy Fest" });
    const legacyAdmin = await mintUser({ role: "admin", festIds: ["legacy-fest"], name: "Legacy Admin" });

    // Not in the review queue, and the review step refuses them rather than silently approving.
    const queue = await callRoute(reviewQueue, { path: "/api/admin/verifications", token: reviewer.idToken });
    expect(queue.body.applications).toEqual([]);
    expect((await approve(reviewer, "legacy-fest")).status).toBe(409);
    expect(await festDoc("legacy-fest")).not.toHaveProperty("verification");

    // And their own admin still runs them, publishing included.
    expect((await patchFest(legacyAdmin.idToken, "legacy-fest", { action: "edit", changes: { status: "published" } })).status).toBe(200);
    expect(await festDoc("legacy-fest")).not.toHaveProperty("verification");
  });
});
