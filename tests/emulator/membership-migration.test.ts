import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildClaims } from "@/core/claims";
import { membershipIdFor } from "@/core/models/membership";
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";
import { GET as roster } from "@/app/api/volunteer/roster/route";
import { PATCH as updateEvent } from "@/app/api/admin/events/[id]/route";
import { callRoute, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * scripts/migrate-memberships.mjs, run for real against the emulators in a child process.
 *
 * The script is the only thing that turns pre-membership staff (a role and a fest list on the profile) into event roles, so
 * what matters is what it will NOT do: write anything unless asked, give anyone more than they had, make a second Event Head,
 * or touch a platform account, a student or a disabled account.
 */

const dir = mkdtempSync(join(tmpdir(), "plansphere-mig-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const account = Buffer.from(JSON.stringify({ project_id: "plansphere-test", client_email: "m@plansphere-test.iam.gserviceaccount.com", private_key: privateKey })).toString("base64");

let n = 0;
const fresh = (name: string) => join(dir, `${name}-${(n += 1)}.json`);

const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["scripts/migrate-memberships.mjs", ...args], { env: { ...process.env, FIREBASE_SERVICE_ACCOUNT: account }, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

let ownerAdmin: TestUser;
let plainAdmin: TestUser;
let scoringVolunteer: TestUser;
let plainVolunteer: TestUser;
let organizer: TestUser;
let studentWithFests: TestUser;
let superAdmin: TestUser;
let disabledAdmin: TestUser;
let strayAdmin: TestUser;

const profile = (u: TestUser, role: string, festIds: string[], extra: Record<string, unknown> = {}) =>
  adminDb().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, name: u.name, role, festIds, disabled: false, profileCompleted: true, mustChangePassword: false, createdAt: new Date(), updatedAt: new Date(), ...extra });

beforeAll(async () => {
  await resetAuth();
  ownerAdmin = await mintUser({ role: "admin", festIds: ["fA"], name: "Owner Admin" });
  plainAdmin = await mintUser({ role: "admin", festIds: ["fA", "fB"], name: "Plain Admin" });
  scoringVolunteer = await mintUser({ role: "volunteer", festIds: ["fA"], name: "Scoring Volunteer" });
  plainVolunteer = await mintUser({ role: "volunteer", festIds: ["fA"], name: "Plain Volunteer" });
  organizer = await mintUser({ role: "volunteer", festIds: ["fB"], name: "Old Organizer" });
  studentWithFests = await mintUser({ name: "Student With Stale Fests" });
  superAdmin = await mintUser({ role: "super_admin", name: "Platform" });
  disabledAdmin = await mintUser({ role: "admin", festIds: ["fA"], name: "Disabled Admin" });
  strayAdmin = await mintUser({ role: "admin", festIds: ["gone"], name: "Admin Of A Deleted Fest" });
});

beforeEach(async () => {
  await resetFirestore();
  await seedFest({ id: "fA", slug: "a", name: "Fest A", ownerId: ownerAdmin.uid });
  await seedFest({ id: "fB", slug: "b", name: "Fest B" });
  await seedEvent({ id: "e1", festId: "fA", slug: "one" });
  await seedEvent({ id: "e2", festId: "fA", slug: "two" });
  await seedEvent({ id: "e3", festId: "fB", slug: "three" });
  await profile(ownerAdmin, "admin", ["fA"]);
  await profile(plainAdmin, "admin", ["fA", "fB"]);
  await profile(scoringVolunteer, "volunteer", ["fA"]);
  await profile(plainVolunteer, "volunteer", ["fA"]);
  await profile(organizer, "organizer", ["fB"]);
  await profile(studentWithFests, "student", ["fA"]);
  await profile(superAdmin, "super_admin", []);
  await profile(disabledAdmin, "admin", ["fA"], { disabled: true });
  await profile(strayAdmin, "admin", ["gone"]);
  await adminDb().collection(COLLECTIONS.shifts).doc("s1").set({ id: "s1", festId: "fA", userId: scoringVolunteer.uid, duty: "scoring", post: "arena1", cancelled: false, date: "2026-09-26", startTime: "09:00", endTime: "12:00", createdAt: new Date(), updatedAt: new Date() });
  await adminDb().collection(COLLECTIONS.shifts).doc("s2").set({ id: "s2", festId: "fA", userId: plainVolunteer.uid, duty: "scoring", post: "arena1", cancelled: true, date: "2026-09-26", startTime: "09:00", endTime: "12:00", createdAt: new Date(), updatedAt: new Date() });
});

const memberDoc = async (u: TestUser, festId: string) => (await adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor(festId, u.uid)).get()).data();
const memberCount = async () => (await adminDb().collection(COLLECTIONS.festMembers).get()).size;
const profileOf = async (u: TestUser) => (await adminDb().collection(COLLECTIONS.users).doc(u.uid).get()).data()!;

describe("a dry run (the default) only reports", () => {
  it("writes nothing, reports who would get what, and holds no names or emails", async () => {
    const before = await Promise.all([ownerAdmin, plainAdmin, scoringVolunteer].map(profileOf));
    const report = fresh("report");
    const res = run("--report", report);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toMatch(/Dry run: nothing was changed/);

    expect(await memberCount()).toBe(0);
    expect(await Promise.all([ownerAdmin, plainAdmin, scoringVolunteer].map(profileOf))).toEqual(before);

    const body = JSON.parse(readFileSync(report, "utf8"));
    expect(body.summary.proposed).toBe(6);
    expect(body.summary.byRole).toEqual({ head: 1, admin: 2, volunteer: 3 });
    const text = JSON.stringify(body);
    for (const u of [ownerAdmin, plainAdmin, scoringVolunteer]) {
      expect(text).not.toContain(u.email);
      expect(text).not.toContain(u.name);
    }
  });

  it("never proposes more than the person already had", async () => {
    const report = fresh("never-more");
    run("--report", report);
    const proposals = JSON.parse(readFileSync(report, "utf8")).proposals as Array<{ uid: string; festId: string; role: string; duties: string[] }>;
    const forUser = (u: TestUser) => proposals.filter((p) => p.uid === u.uid);

    // The owner is the head of the event they own; nobody else is a head.
    expect(proposals.filter((p) => p.role === "head")).toEqual([expect.objectContaining({ uid: ownerAdmin.uid, festId: "fA" })]);
    // An admin stays an admin, on each fest they had; a volunteer stays a volunteer.
    expect(forUser(plainAdmin).map((p) => `${p.festId}:${p.role}`).sort()).toEqual(["fA:admin", "fB:admin"]);
    for (const u of [scoringVolunteer, plainVolunteer, organizer]) for (const p of forUser(u)) expect(p.role).toBe("volunteer");
    // Scoring only for the volunteer with an active scoring shift - a cancelled shift earns nothing.
    expect(forUser(scoringVolunteer)[0]!.duties.sort()).toEqual(["entry", "meal", "scoring"]);
    expect(forUser(plainVolunteer)[0]!.duties.sort()).toEqual(["entry", "meal"]);
    // Platform accounts, students, disabled accounts and admins of fests that no longer exist are left alone.
    for (const u of [superAdmin, studentWithFests, disabledAdmin, strayAdmin]) expect(forUser(u), u.name).toEqual([]);
    expect(readJson(report).skipped.map((s: { reason: string }) => s.reason)).toEqual(expect.arrayContaining(["account disabled", "fest no longer exists"]));
  });
});

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("applying is explicit, backed up, and never overwrites", () => {
  it("refuses to apply without a backup file, or onto one that already exists", async () => {
    const noBackup = run("--apply");
    expect(noBackup.status).toBe(1);
    expect(noBackup.out).toMatch(/--backup/);

    const existing = fresh("existing");
    writeFileSync(existing, "keep me");
    const overwrite = run("--apply", "--backup", existing);
    expect(overwrite.status).toBe(1);
    expect(readFileSync(existing, "utf8")).toBe("keep me");
    expect(await memberCount()).toBe(0);
  });

  it("creates the memberships, narrows the old scope, rewrites the claims, and backs everyone up first", async () => {
    const backup = fresh("backup");
    const out = run("--apply", "--backup", backup);
    expect(out.status, out.out).toBe(0);
    // Phase 7: every membership written is read back before the run claims success.
    expect(out.out).toMatch(/read back: 6 of 6/);

    expect(await memberDoc(ownerAdmin, "fA")).toMatchObject({ role: "head", status: "active", eventIds: [], migratedFromLegacy: true });
    expect(await memberDoc(plainAdmin, "fA")).toMatchObject({ role: "admin", status: "active" });
    expect((await memberDoc(plainAdmin, "fA"))!.eventIds.sort()).toEqual(["e1", "e2"]);
    expect((await memberDoc(plainAdmin, "fB"))!.eventIds).toEqual(["e3"]);
    expect(await memberDoc(scoringVolunteer, "fA")).toMatchObject({ role: "volunteer", duties: ["entry", "meal", "scoring"] });
    expect(await memberDoc(plainVolunteer, "fA")).toMatchObject({ role: "volunteer", duties: ["entry", "meal"] });
    expect(await memberDoc(organizer, "fB")).toMatchObject({ role: "volunteer" });
    expect(await memberCount()).toBe(6);

    // The membership is now the whole of their authority on each fest: the old fest list loses it.
    expect((await profileOf(ownerAdmin)).festIds).toEqual([]);
    expect((await profileOf(plainAdmin)).festIds).toEqual([]);
    expect((await profileOf(plainAdmin)).memberOf.sort()).toEqual(["fA", "fB"]);
    // Their own role is exactly what it was.
    expect((await profileOf(plainAdmin)).role).toBe("admin");
    expect((await profileOf(scoringVolunteer)).role).toBe("volunteer");

    // Claims: the ceiling for the app, the base role for the rules, the fests they hold a role on - never the platform's.
    const claims = (await adminAuth().getUser(scoringVolunteer.uid)).customClaims!;
    expect(claims).toMatchObject({ role: "volunteer", br: "volunteer", fm: ["fA"], festIds: [] });
    const adminClaims = (await adminAuth().getUser(plainAdmin.uid)).customClaims!;
    expect(adminClaims.role).toBe("admin");
    expect((adminClaims.fm as string[]).sort()).toEqual(["fA", "fB"]);
    for (const u of [ownerAdmin, plainAdmin, scoringVolunteer, plainVolunteer, organizer]) expect((await adminAuth().getUser(u.uid)).customClaims!.role, u.name).not.toBe("super_admin");

    // Untouched: everyone the script is meant to leave alone.
    expect(await memberDoc(studentWithFests, "fA")).toBeUndefined();
    expect(await memberDoc(superAdmin, "fA")).toBeUndefined();
    expect(await memberDoc(disabledAdmin, "fA")).toBeUndefined();
    expect((await profileOf(studentWithFests)).festIds).toEqual(["fA"]);
    expect((await profileOf(disabledAdmin)).festIds).toEqual(["fA"]);

    // The backup holds each profile as it was - role and fest ids, no names or emails.
    const lines = readFileSync(backup, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(5);
    expect(lines.find((l) => l.uid === plainAdmin.uid)).toMatchObject({ role: "admin", festIds: ["fA", "fB"] });
    expect(readFileSync(backup, "utf8")).not.toContain(plainAdmin.email);
  });

  it("gives people the same reach they had, through the new roles - and no wider", async () => {
    run("--apply", "--backup", fresh("backup"));

    // The migrated admin of fest A works both of its competitions, through their membership...
    const edit = (user: TestUser, eventId: string) => callRoute(updateEvent, { method: "PATCH", path: "/x", params: { id: eventId }, token: user.idToken, body: { description: "Edited" } });
    expect((await edit(plainAdmin, "e1")).status).toBe(200);
    expect((await edit(plainAdmin, "e2")).status).toBe(200);
    expect((await edit(plainAdmin, "e3")).status).toBe(200); // fest B, where they were also an admin
    // ...and a migrated volunteer is still only a volunteer: gate yes, edits no, another fest no.
    expect((await edit(plainVolunteer, "e1")).status).toBe(403);
    expect((await callRoute(roster, { path: "/api/volunteer/roster?eventId=e1", token: plainVolunteer.idToken })).status).toBe(200);
    expect((await callRoute(roster, { path: "/api/volunteer/roster?eventId=e3", token: plainVolunteer.idToken })).status).toBe(403);
  });

  it("is idempotent: a second run finds nothing left to do", async () => {
    expect(run("--apply", "--backup", fresh("first")).status).toBe(0);
    const report = fresh("second-report");
    const again = run("--report", report);
    expect(again.status).toBe(0);
    expect(readJson(report).summary.proposed).toBe(0);
    expect(await memberCount()).toBe(6);
  });
});

describe("one Event Head per event, even in the migration", () => {
  it("reports a conflict, and writes no second head, when an owner's fest already has one", async () => {
    await adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor("fA", scoringVolunteer.uid)).set({ id: membershipIdFor("fA", scoringVolunteer.uid), festId: "fA", userId: scoringVolunteer.uid, role: "head", eventIds: [], duties: [], status: "active", createdBy: "seed", createdAt: new Date(), updatedAt: new Date() });
    const out = run("--apply", "--backup", fresh("conflict"));
    expect(out.status).toBe(2);
    expect(out.out).toMatch(/CONFLICT\s+fest fA: this fest already has an Event Head/);

    const heads = (await adminDb().collection(COLLECTIONS.festMembers).where("festId", "==", "fA").where("role", "==", "head").get()).docs;
    expect(heads).toHaveLength(1);
    expect(heads[0]!.data().userId).toBe(scoringVolunteer.uid);
  });
});

/* ───────────── claims: reconciliation, many roles, and recovery ───────────── */

const claimsOf = async (u: TestUser) => (await adminAuth().getUser(u.uid)).customClaims ?? {};
const sorted = (claims: Record<string, unknown>) => ({ ...claims, ...(Array.isArray(claims.fm) ? { fm: [...(claims.fm as string[])].sort() } : {}) });

describe("claims that fell behind the memberships are repaired by a re-run", () => {
  it("reports the drift on a dry run without writing, and repairs it with --apply - the pair itself is already done", async () => {
    expect(run("--apply", "--backup", fresh("first")).status).toBe(0);
    // What a failed step 4 leaves: the membership and the narrowed profile are committed, the claims are the old ones.
    await adminAuth().setCustomUserClaims(plainAdmin.uid, { role: "admin", festIds: ["fA", "fB"] });

    const dry = run();
    expect(dry.status, dry.out).toBe(0);
    expect(dry.out).toMatch(/Claims out of date:\s+1/);
    expect(await claimsOf(plainAdmin)).toEqual({ role: "admin", festIds: ["fA", "fB"] }); // a dry run changed nothing

    const repaired = run("--apply", "--backup", fresh("second"));
    expect(repaired.status, repaired.out).toBe(0);
    expect(repaired.out).toMatch(/claims repaired: 1/);
    const claims = await claimsOf(plainAdmin);
    expect(claims).toMatchObject({ role: "admin", br: "admin", festIds: [] });
    expect((claims.fm as string[]).sort()).toEqual(["fA", "fB"]);

    // And once repaired there is nothing left to do.
    expect(run().out).toMatch(/Claims out of date:\s+0/);
  });

  it("also clears a revoked role from a token that still lists it", async () => {
    expect(run("--apply", "--backup", fresh("first")).status).toBe(0);
    await adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor("fB", plainAdmin.uid)).set({ status: "revoked", updatedAt: new Date() }, { merge: true });
    expect(run().out).toMatch(/Claims out of date:\s+1/);
    expect(run("--apply", "--backup", fresh("second")).status).toBe(0);
    expect((await claimsOf(plainAdmin)).fm).toEqual(["fA"]);
  });
});

describe("the script writes the same claims as the app, including for an account with many event roles", () => {
  const manyFests = (count: number) => Array.from({ length: count }, (_, i) => `many-${String(i).padStart(3, "0")}-${"x".repeat(10)}`);

  const give = async (u: TestUser, role: string, ids: string[]) => {
    for (const id of ids) {
      await adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor(id, u.uid)).set({ id: membershipIdFor(id, u.uid), festId: id, userId: u.uid, role, eventIds: [], duties: [], status: "active", createdBy: "seed", createdAt: new Date(), updatedAt: new Date() });
    }
  };

  it.each([[3], [8], [9], [40]])("%i event roles", async (count) => {
    const person = await mintUser({ name: `Many ${count}` });
    await profile(person, "student", []);
    const ids = manyFests(count);
    await give(person, "admin", ids);
    expect(run("--apply", "--backup", fresh("many")).status).toBe(0);

    const expected = buildClaims({ role: "student", festIds: [], memberFestIds: ids, ceiling: "admin" });
    expect(sorted(await claimsOf(person))).toEqual(sorted(expected.claims));
    expect(expected.lookup).toBe(count > 8);
    expect(new TextEncoder().encode(JSON.stringify(await claimsOf(person))).length).toBeLessThan(1000);
  });

  it("refuses, rather than truncates, a legacy scope too large for any token, and reports it", async () => {
    const person = await mintUser({ role: "volunteer", festIds: ["fA"], name: "Huge Scope" });
    await profile(person, "volunteer", manyFests(60));
    await give(person, "volunteer", ["fA"]);
    const dry = run();
    expect(dry.status).toBe(2);
    expect(dry.out).toMatch(/CANNOT\s+/);
    expect(dry.out).toMatch(/too large for a sign-in token/);
  });
});

describe("fests the migration leaves without an Event Head", () => {
  it("lists them, so the platform assigns one, and keeps the list in the report as ids only", async () => {
    const report = fresh("heads");
    const res = run("--report", report);
    expect(res.out).toMatch(/Fests with no Event Head after this:\s+1/);
    expect(res.out).toMatch(/NO HEAD\s+fest fB/);
    expect(readJson(report).festsWithoutHead).toEqual(["fB"]);
  });
});

describe("recovery: --restore undoes what --apply did, and only that", () => {
  it("does nothing without --apply, and without a file that exists", async () => {
    const backup = fresh("backup");
    expect(run("--apply", "--backup", backup).status).toBe(0);
    const before = await memberCount();

    const dry = run("--restore", backup);
    expect(dry.status, dry.out).toBe(0);
    expect(dry.out).toMatch(/would remove/);
    expect(dry.out).toMatch(/restore dry run/);
    expect(await memberCount()).toBe(before);

    expect(run("--restore", join(dir, "nope.json")).status).toBe(1);
    expect(run("--restore").status).toBe(1);
    expect(run("--restore", backup, "--backup", fresh("x")).status).toBe(1);
  });

  it("removes the migration's memberships, puts the fests back on the old scope, and rebuilds the claims", async () => {
    const original = await Promise.all([ownerAdmin, plainAdmin, scoringVolunteer, plainVolunteer, organizer].map(async (u) => ({ uid: u.uid, festIds: (await profileOf(u)).festIds as string[] })));
    const backup = fresh("backup");
    expect(run("--apply", "--backup", backup).status).toBe(0);
    expect(await memberCount()).toBe(6);

    const restored = run("--restore", backup, "--apply");
    expect(restored.status, restored.out).toBe(0);
    expect(await memberCount()).toBe(0);
    for (const was of original) {
      const user = { uid: was.uid } as TestUser;
      const now = await profileOf(user);
      expect([...(now.festIds as string[])].sort(), was.uid).toEqual([...was.festIds].sort());
      expect(now.memberOf, was.uid).toEqual([]);
      // Back to a plain legacy token: the account's own role and its old fest list, no event role.
      const claims = await claimsOf(user);
      expect({ ...claims, festIds: [...(claims.festIds as string[])].sort() }, was.uid).toEqual({ role: now.role === "organizer" ? "volunteer" : now.role, festIds: [...was.festIds].sort() });
    }
    // Nobody the migration left alone was touched.
    expect((await profileOf(studentWithFests)).festIds).toEqual(["fA"]);
    expect(run().out).toMatch(/Memberships proposed:\s+6/); // and a later migration can start again from the same place
  });

  it("keeps a migrated membership somebody has edited since, and puts back only the rest", async () => {
    const backup = fresh("backup");
    expect(run("--apply", "--backup", backup).status).toBe(0);
    // The Event Head narrowed the admin's competition on fest A after the migration.
    await adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor("fA", plainAdmin.uid)).update({ eventIds: ["e1"], updatedAt: new Date(Date.now() + 5000) });

    const restored = run("--restore", backup, "--apply");
    expect(restored.status, restored.out).toBe(0);
    expect(restored.out).toMatch(/KEPT\s+\S+ @ fA: changed since the migration/);
    expect(await memberDoc(plainAdmin, "fA")).toMatchObject({ eventIds: ["e1"] });
    expect(await memberDoc(plainAdmin, "fB")).toBeUndefined();

    const profileNow = await profileOf(plainAdmin);
    expect(profileNow.festIds).toEqual(["fB"]); // only the fest whose membership was removed goes back
    expect(profileNow.memberOf).toEqual(["fA"]);
    const claims = await claimsOf(plainAdmin);
    expect(claims).toMatchObject({ role: "admin", br: "admin", fm: ["fA"], festIds: ["fB"] });
  });

  it("never touches a membership the migration did not create", async () => {
    const backup = fresh("backup");
    expect(run("--apply", "--backup", backup).status).toBe(0);
    const id = membershipIdFor("fB", organizer.uid);
    await adminDb().collection(COLLECTIONS.festMembers).doc(id).set({ createdBy: "someone-else" }, { merge: true });
    expect(run("--restore", backup, "--apply").status).toBe(0);
    expect(await memberDoc(organizer, "fB")).toMatchObject({ createdBy: "someone-else" });
  });
});
