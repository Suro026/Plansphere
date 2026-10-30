import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { doc, getDoc, getDocs, collection } from "firebase/firestore";
import { adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { firestore } from "@/data/firebase/client";
import { repositories } from "@/data/repositories";
import { POST as registerEvent } from "@/app/api/register-event/route";
import { POST as register } from "@/app/api/registrations/route";
import { POST as joinTeam } from "@/app/api/registrations/join/route";
import { POST as teamAction } from "@/app/api/registrations/[id]/team/route";
import { GET as myTeamEntries } from "@/app/api/registrations/mine/route";
import { GET as listStaff } from "@/app/api/admin/staff/route";
import { POST as staffAction } from "@/app/api/admin/registrations/[id]/route";
import { GET as exportRegistrations } from "@/app/api/admin/registrations/export/route";
import { DELETE as deleteFest } from "@/app/api/admin/fests/[id]/route";
import { callRoute, clientSignIn, clientSignOut, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are asserted field by field */

/**
 * Regression tests for the privacy exposures found in docs/legal/privacy-policy.md (Part B3, A1–A3):
 *
 *   1. the Event Head's phone / LinkedIn / ID-document reference sat on the world-readable fest document;
 *   2. staff of one fest could list profiles and registrations of every fest;
 *   3. a teammate could read every other member's email, phone, college and ID.
 *
 * (The sign-out cache cleanup is covered in tests/components/signout-cleanup.test.tsx and
 * tests/unit/scanner-cache-signout.test.ts; the rules themselves in firestore-rules.test.ts.)
 */

const HEAD_PHONE = "+919000000042";
const HEAD_LINKEDIN = "https://linkedin.com/in/event-head-person";
const HEAD_ID_DOC = "https://files.example.test/identity/head-id-card.png";
const realFetch = globalThis.fetch;

let head: TestUser;
let leader: TestUser;
let mate: TestUser;
let third: TestUser;
let outsider: TestUser;
let volunteerA: TestUser;
let volunteerB: TestUser;
let adminA: TestUser;
let adminB: TestUser;
let superAdmin: TestUser;
const all = () => [head, leader, mate, third, outsider, volunteerA, volunteerB, adminA, adminB, superAdmin];

const repos = repositories();
const db = () => adminDb();
/** A repository call the rules refused: the Firestore error rides along as the cause. */
const DENIED = { cause: { code: "permission-denied" } };

beforeAll(async () => {
  await resetAuth();
  head = await mintUser({ name: "Event Head Person" });
  leader = await mintUser({ name: "Team Leader" });
  mate = await mintUser({ name: "Team Mate" });
  third = await mintUser({ name: "Third Member" });
  outsider = await mintUser({ name: "Outsider" });
  volunteerA = await mintUser({ role: "volunteer", festIds: ["fest1"], name: "Vol A" });
  volunteerB = await mintUser({ role: "volunteer", festIds: ["fest2"], name: "Vol B" });
  adminA = await mintUser({ role: "admin", festIds: ["fest1"], name: "Admin A" });
  adminB = await mintUser({ role: "admin", festIds: ["fest2"], name: "Admin B" });
  superAdmin = await mintUser({ role: "super_admin", name: "Super" });
  // The repositories reach the app's own API for a teammate's view; there is no Next server here.
  vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "/api/registrations/mine"
      ? myTeamEntries(new Request("http://localhost:3000/api/registrations/mine", { method: "GET", headers: init?.headers }), { params: Promise.resolve({}) })
      : realFetch(input, init)) as typeof fetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await clientSignOut();
});

beforeEach(async () => {
  await clientSignOut();
  await resetFirestore();
  for (const u of all()) {
    await db()
      .collection(COLLECTIONS.users)
      .doc(u.uid)
      .set({
        id: u.uid,
        uid: u.uid,
        email: u.email,
        name: u.name,
        role: u.role,
        festIds: u.role === "volunteer" || u.role === "admin" ? (u === volunteerB || u === adminB ? ["fest2"] : ["fest1"]) : [],
        phone: "+919811110000",
        college: "Private College",
        studentId: `ROLL-${u.name.replace(/\s/g, "")}`,
        profileCompleted: true,
        mustChangePassword: false,
        emailVerified: true,
        disabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
  }
  await seedFest();
  await seedFest({ id: "fest2", slug: "other-fest", name: "Other Fest" });
  await seedEvent();
  await seedEvent({ id: "ev2", festId: "fest2", slug: "other", title: "Other Event" });
});

/* ───────────── 1. the Event Head's details are not on the public fest document ───────────── */

const eventBody = (name: string) => ({
  organizationName: "Test Institute of Technology",
  organizationType: "college" as const,
  organizationWebsite: "https://test-institute.edu",
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
  eventHead: { name: "Event Head Person", designation: "Cultural Secretary", phone: HEAD_PHONE, linkedin: HEAD_LINKEDIN, idCardUrl: HEAD_ID_DOC },
});

describe("Event Head personal details", () => {
  const registered = async () => {
    const res = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: head.idToken, body: eventBody("Aurora 26") });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const festId = res.body.fest.id as string;
    await db().collection(COLLECTIONS.fests).doc(festId).update({ status: "published" });
    return { festId, response: res.body };
  };

  it("are kept on a server-only document, not on the fest", async () => {
    const { festId, response } = await registered();

    const fest = (await db().collection(COLLECTIONS.fests).doc(festId).get()).data()!;
    expect(fest).not.toHaveProperty("eventHead");
    expect(JSON.stringify(fest)).not.toContain(HEAD_PHONE);
    expect(JSON.stringify(fest)).not.toContain("event-head-person");
    expect(JSON.stringify(fest)).not.toContain("head-id-card");
    expect(JSON.stringify(response)).not.toContain(HEAD_PHONE);

    const priv = (await db().collection(COLLECTIONS.festPrivate).doc(festId).get()).data()!;
    expect(priv).toMatchObject({ festId, registeredBy: head.uid, eventHead: { name: "Event Head Person", designation: "Cultural Secretary", phone: HEAD_PHONE, linkedin: HEAD_LINKEDIN, idCardUrl: HEAD_ID_DOC } });
  });

  it("cannot be read by an anonymous visitor, from the fest document or from the private one", async () => {
    const { festId } = await registered();
    await clientSignOut();

    const publicFest = await getDoc(doc(firestore(), "fests", festId));
    expect(publicFest.exists()).toBe(true); // the public page still has its fest
    expect(JSON.stringify(publicFest.data())).not.toContain(HEAD_PHONE);
    expect(publicFest.data()).not.toHaveProperty("eventHead");

    await expect(getDoc(doc(firestore(), "festPrivate", festId))).rejects.toMatchObject({ code: "permission-denied" });
    await expect(getDocs(collection(firestore(), "festPrivate"))).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("cannot be read by the event head themselves, other fests' admins, or a super admin, through a client", async () => {
    const { festId } = await registered();
    // The event head is an admin of the fest now; still nothing for a client to read.
    for (const who of [head, adminB, superAdmin, outsider]) {
      await clientSignIn(who);
      await expect(getDoc(doc(firestore(), "festPrivate", festId)), who.name).rejects.toMatchObject({ code: "permission-denied" });
      await clientSignOut();
    }
  });

  it("leaves the public fest page working: the published fest is found by its address, anonymously", async () => {
    const { festId } = await registered();
    await clientSignOut();
    const fest = await repos.fests.getBySlug("aurora-26");
    expect(fest?.id).toBe(festId);
    expect(fest?.name).toBe("Aurora 26");
    expect(fest).not.toHaveProperty("eventHead");
  });

  it("go when the fest is deleted", async () => {
    const { festId } = await registered();
    const removed = await callRoute(deleteFest, { method: "DELETE", path: `/api/admin/fests/${festId}`, params: { id: festId }, token: superAdmin.idToken });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await db().collection(COLLECTIONS.festPrivate).doc(festId).get()).exists).toBe(false);
  });
});

describe("migrating fests registered before the fix", () => {
  const backups: string[] = [];
  const backupFile = () => {
    const file = join(tmpdir(), `event-head-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    backups.push(file);
    return file;
  };
  afterEach(() => {
    for (const file of backups.splice(0)) rmSync(file, { force: true });
  });

  const run = (...args: string[]) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const account = JSON.stringify({ project_id: process.env.GCLOUD_PROJECT ?? "plansphere-test", client_email: "migrate@plansphere-test.iam.gserviceaccount.com", private_key: privateKey });
    const result = spawnSync(process.execPath, ["scripts/migrate-event-head.mjs", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, FIREBASE_SERVICE_ACCOUNT: Buffer.from(account).toString("base64") },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  };

  const headOf = (name: string, phone = HEAD_PHONE) => ({ name, designation: "Secretary", phone, linkedin: HEAD_LINKEDIN });
  const fest = (id: string) => db().collection(COLLECTIONS.fests).doc(id);
  const priv = (id: string) => db().collection(COLLECTIONS.festPrivate).doc(id);

  /** A published fest and a draft one with the details on them, a clean fest, and one with extra fields to keep. */
  const legacy = async () => {
    await seedFest({ id: "legacy", slug: "legacy", name: "Legacy Fest", status: "published", eventHead: headOf("Old Head"), createdBy: head.uid, tagline: "keep me", stats: { events: 3, registrations: 9, checkIns: 1 } });
    await seedFest({ id: "legacy-draft", slug: "legacy-draft", name: "Draft Fest", status: "draft", eventHead: headOf("Draft Head", "+919000000077"), createdBy: head.uid });
    await seedFest({ id: "clean", slug: "clean", name: "Clean Fest" });
  };

  it("a fest registered before the fix does expose the phone number to an anonymous visitor until it is migrated", async () => {
    await legacy();
    await clientSignOut();
    const publicFest = await getDoc(doc(firestore(), "fests", "legacy"));
    // This is the exposure itself, kept as a test so the need for the migration stays documented: nothing in the rules
    // can hide one field of a published document.
    expect(publicFest.data()?.eventHead?.phone).toBe(HEAD_PHONE);
  });

  it("reports published and unpublished fests, prints no personal details, and changes nothing by default", async () => {
    await legacy();
    const before = [(await fest("legacy").get()).data(), (await fest("legacy-draft").get()).data()];
    const dry = run();
    expect(dry.status, dry.out).toBe(0);
    expect(dry.out).toContain("would move  fest legacy (published)");
    expect(dry.out).toContain("would move  fest legacy-draft (draft)");
    expect(dry.out).not.toContain("fest clean");
    expect(dry.out).toContain("with eventHead: 2 (published 1, not published 1)");
    expect(dry.out).not.toContain(HEAD_PHONE);
    expect(dry.out).not.toContain("Old Head");
    expect([(await fest("legacy").get()).data(), (await fest("legacy-draft").get()).data()]).toEqual(before);
    expect((await priv("legacy").get()).exists).toBe(false);
    expect((await priv("legacy-draft").get()).exists).toBe(false);
  });

  it("refuses --apply without a backup file, and refuses to reuse an existing one", async () => {
    await legacy();
    const none = run("--apply");
    expect(none.status).toBe(1);
    expect(none.out).toContain("--backup");
    expect((await fest("legacy").get()).data()).toHaveProperty("eventHead");

    const file = backupFile();
    writeFileSync(file, "earlier backup\n");
    const reuse = run("--apply", "--backup", file);
    expect(reuse.status).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("earlier backup\n");
    expect((await fest("legacy").get()).data()).toHaveProperty("eventHead");
  });

  it("with --apply backs up, copies, verifies, then removes only the eventHead field - from published and draft fests alike", async () => {
    await legacy();
    const beforeLegacy = (await fest("legacy").get()).data()!;
    const file = backupFile();
    const applied = run("--apply", "--backup", file);
    expect(applied.status, applied.out).toBe(0);
    expect(applied.out).toContain("moved: 2");
    expect(applied.out).not.toContain(HEAD_PHONE);

    // Destination holds the details; the source field is gone and nothing else about the fest changed.
    expect((await priv("legacy").get()).data()).toMatchObject({ festId: "legacy", registeredBy: head.uid, eventHead: headOf("Old Head") });
    expect((await priv("legacy-draft").get()).data()).toMatchObject({ eventHead: headOf("Draft Head", "+919000000077") });
    const afterLegacy = (await fest("legacy").get()).data()!;
    expect(afterLegacy).not.toHaveProperty("eventHead");
    const { eventHead: _removed, ...beforeRest } = beforeLegacy;
    void _removed;
    expect(afterLegacy).toEqual(beforeRest);
    expect((await fest("clean").get()).exists).toBe(true);
    expect((await priv("clean").get()).exists).toBe(false);

    // The backup was written and holds both.
    const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((r) => r.festId).sort()).toEqual(["legacy", "legacy-draft"]);
    expect(rows.find((r) => r.festId === "legacy").eventHead).toEqual(headOf("Old Head"));

    // Anonymous visitors no longer get the phone number from the fest.
    await clientSignOut();
    expect(JSON.stringify((await getDoc(doc(firestore(), "fests", "legacy"))).data())).not.toContain(HEAD_PHONE);
  });

  it("is idempotent: a second run finds nothing and writes nothing", async () => {
    await legacy();
    expect(run("--apply", "--backup", backupFile()).status).toBe(0);
    const privBefore = (await priv("legacy").get()).data();
    const second = backupFile();
    const again = run("--apply", "--backup", second);
    expect(again.status, again.out).toBe(0);
    expect(again.out).toContain("with eventHead: 0");
    expect((await priv("legacy").get()).data()).toEqual(privBefore);
  });

  it("never overwrites a private copy that already exists: an identical one lets the source go, a different one is a conflict and nothing is deleted", async () => {
    await legacy();
    await priv("legacy").set({ festId: "legacy", eventHead: headOf("Old Head"), note: "existing" });
    await priv("legacy-draft").set({ festId: "legacy-draft", eventHead: headOf("Someone Else", "+919000000099") });

    const dry = run();
    expect(dry.status).toBe(2);
    expect(dry.out).toContain("would remove field (private copy already matches)  fest legacy (published)");
    expect(dry.out).toContain("CONFLICT (different private copy)  fest legacy-draft (draft)");

    const applied = run("--apply", "--backup", backupFile());
    expect(applied.status, applied.out).toBe(2);
    expect(applied.out).toContain("moved: 1");
    expect(applied.out).toContain("conflicts: 1");
    // Identical copy: left exactly as it was, source removed.
    expect((await priv("legacy").get()).data()).toMatchObject({ note: "existing" });
    expect((await fest("legacy").get()).data()).not.toHaveProperty("eventHead");
    // Different copy: neither side touched.
    expect((await priv("legacy-draft").get()).data()?.eventHead).toMatchObject({ name: "Someone Else" });
    expect((await fest("legacy-draft").get()).data()?.eventHead).toMatchObject({ name: "Draft Head" });
  });

  it("recovery: --restore rebuilds festPrivate from the backup without overwriting anything that is there", async () => {
    await legacy();
    const file = backupFile();
    expect(run("--apply", "--backup", file).status).toBe(0);

    // Disaster: one private document is lost, the other has since been legitimately updated.
    await priv("legacy").delete();
    await priv("legacy-draft").update({ eventHead: headOf("Updated Since", "+919000000055") });

    const restored = run("--restore", file);
    expect(restored.status, restored.out).toBe(0);
    expect(restored.out).toContain("restored: 1");
    expect((await priv("legacy").get()).data()).toMatchObject({ eventHead: headOf("Old Head"), restoredFromBackup: true });
    expect((await priv("legacy-draft").get()).data()?.eventHead).toMatchObject({ name: "Updated Since" });
  });
});

/* ───────────── 2. staff are limited to their own fests ───────────── */

const seedEntry = async (id: string, festId: string, eventId: string, user: TestUser, over: Record<string, unknown> = {}) => {
  const now = new Date();
  await db()
    .collection(COLLECTIONS.registrations)
    .doc(id)
    .set({
      id,
      eventId,
      festId,
      userId: user.uid,
      type: "solo",
      members: [{ name: user.name, email: user.email, userId: user.uid, isLeader: true, inviteStatus: "accepted" }],
      memberEmails: [user.email],
      seats: 1,
      ticketCode: `PS-${id.toUpperCase().padEnd(10, "X").slice(0, 10)}`,
      status: "confirmed",
      eventTitle: "E",
      userName: user.name,
      userEmail: user.email,
      createdAt: now,
      updatedAt: now,
      ...over,
    });
};

describe("staff of one fest and another fest's participants (real client SDK, real rules)", () => {
  beforeEach(async () => {
    await seedEntry("regA", "fest1", "ev1", leader);
    await seedEntry("regB", "fest2", "ev2", outsider);
  });

  it("an admin's roster and ticket lookups work for their fest and return nothing for another's; a volunteer's are refused outright", async () => {
    // A volunteer reads no registration. The gate is served by the server with a minimal roster instead.
    await clientSignIn(volunteerA);
    await expect(repos.registrations.listForEvent("ev1", "fest1")).rejects.toMatchObject(DENIED);
    await expect(repos.registrations.getByTicketCode("PS-REGAXXXXXX", "fest1")).rejects.toMatchObject(DENIED);

    await clientSignIn(adminA);
    expect((await repos.registrations.listForEvent("ev1", "fest1")).map((r) => r.id)).toEqual(["regA"]);
    expect((await repos.registrations.getByTicketCode("PS-REGAXXXXXX", "fest1"))?.id).toBe("regA");
    // The other fest's ticket is not there for them, and asking for the other fest is refused.
    expect(await repos.registrations.getByTicketCode("PS-REGBXXXXXX", "fest1")).toBeNull();
    await expect(repos.registrations.getByTicketCode("PS-REGBXXXXXX", "fest2")).rejects.toMatchObject(DENIED);
    await expect(repos.registrations.listForEvent("ev2", "fest2")).rejects.toMatchObject(DENIED);
    await expect(repos.registrations.list({})).rejects.toMatchObject(DENIED);
  });

  it("an admin sees their own fest's entries live, and is refused any query that reaches into another fest", async () => {
    await clientSignIn(adminA);
    const own = await repos.registrations.list({ festId: "fest1" });
    expect(own.items.map((r) => r.id)).toEqual(["regA"]);
    await expect(repos.registrations.list({ festId: "fest2" })).rejects.toMatchObject(DENIED);
    await expect(repos.registrations.list({ eventId: "ev2", festId: "fest2" })).rejects.toMatchObject(DENIED);
    await expect(repos.registrations.list({ eventId: "ev1" })).rejects.toMatchObject(DENIED);
    await expect(repos.registrations.list({ userId: outsider.uid })).rejects.toMatchObject(DENIED);
  });

  it("no staff account can read a participant's profile from a client; a super admin can read any", async () => {
    for (const who of [volunteerA, volunteerB, adminA, adminB]) {
      await clientSignIn(who);
      await expect(getDoc(doc(firestore(), "users", leader.uid)), who.name).rejects.toMatchObject({ code: "permission-denied" });
      await expect(getDoc(doc(firestore(), "users", outsider.uid)), who.name).rejects.toMatchObject({ code: "permission-denied" });
      await expect(getDocs(collection(firestore(), "users")), who.name).rejects.toMatchObject({ code: "permission-denied" });
      await clientSignOut();
    }
    await clientSignIn(superAdmin);
    expect((await getDoc(doc(firestore(), "users", leader.uid))).exists()).toBe(true);
  });

  it("an admin can still read the profile of a volunteer of their own fest (shift rostering), not another fest's", async () => {
    await clientSignIn(adminA);
    expect((await getDoc(doc(firestore(), "users", volunteerA.uid))).exists()).toBe(true);
    await expect(getDoc(doc(firestore(), "users", volunteerB.uid))).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("a person still reads their own profile and entries", async () => {
    await clientSignIn(leader);
    expect((await getDoc(doc(firestore(), "users", leader.uid))).exists()).toBe(true);
    expect((await repos.registrations.listForUserWithEvents(leader.uid, leader.email)).map((e) => e.registration.id)).toEqual(["regA"]);
  });
});

describe("server-side authorisation paths (the Admin SDK does not use the rules, so these are checked in code)", () => {
  beforeEach(async () => {
    await seedEntry("regA", "fest1", "ev1", leader);
    await seedEntry("regB", "fest2", "ev2", outsider);
  });

  it("an admin's staff list holds their own fests' staff only", async () => {
    const res = await callRoute(listStaff, { path: "/api/admin/staff", token: adminA.idToken });
    expect(res.status).toBe(200);
    const ids = (res.body.staff as any[]).map((s) => s.id);
    expect(ids).toContain(volunteerA.uid);
    expect(ids).not.toContain(volunteerB.uid);
    expect(ids).not.toContain(adminB.uid);
  });

  it("an admin cannot act on, or export, another fest's registrations", async () => {
    const act = await callRoute(staffAction, { path: "/api/admin/registrations/regB", params: { id: "regB" }, token: adminA.idToken, body: { action: "cancel" } });
    expect(act.status).toBe(403);
    const exp = await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest2&format=csv", method: "GET", token: adminA.idToken });
    expect(exp.status).toBe(403);
    expect((await db().collection(COLLECTIONS.registrations).doc("regB").get()).data()?.status).toBe("confirmed");
  });

  it("a client-supplied role or fest list means nothing: the claims on the verified token decide", async () => {
    const forged = await callRoute(exportRegistrations, {
      path: "/api/admin/registrations/export?festId=fest2&format=csv",
      method: "GET",
      token: adminA.idToken,
      headers: { "x-role": "super_admin", "x-fest-ids": "fest2" },
    });
    expect(forged.status).toBe(403);
    expect((await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest2&format=csv", method: "GET", token: adminB.idToken, raw: true })).status).toBe(200);
  });
});

/* ───────────── 3. teammates do not get each other's contact details ───────────── */

const PHONES = ["+919800000001", "+919800000002", "+919800000003"];

describe("a teammate's view of a team entry", () => {
  let id: string;

  beforeEach(async () => {
    await seedEvent({ id: "team-ev", slug: "team", teamSize: { min: 2, max: 4 }, capacity: 10 });
    const now = new Date();
    id = "teamreg";
    await db()
      .collection(COLLECTIONS.registrations)
      .doc(id)
      .set({
        id,
        eventId: "team-ev",
        festId: "fest1",
        userId: leader.uid,
        type: "team",
        teamName: "Null Pointers",
        members: [
          { name: leader.name, email: leader.email, phone: PHONES[0], studentId: "ROLL-LEADER", college: "Leader College", userId: leader.uid, isLeader: true, inviteStatus: "accepted" },
          { name: mate.name, email: mate.email, phone: PHONES[1], userId: mate.uid, isLeader: false, inviteStatus: "pending" },
          { name: third.name, email: third.email, phone: PHONES[2], studentId: "ROLL-THIRD", college: "Third College", isLeader: false, inviteStatus: "accepted" },
        ],
        memberEmails: [leader.email, mate.email, third.email],
        seats: 3,
        ticketCode: "PS-TEAMPASS01",
        joinCode: "ABC234",
        status: "draft",
        eventTitle: "Capture the Flag",
        userName: leader.name,
        userEmail: leader.email,
        answers: { phone: PHONES[0], note: "LEADER-PRIVATE-ANSWER" },
        createdAt: now,
        updatedAt: now,
      });
  });

  const leaks = (value: unknown, viewer: TestUser) => {
    const text = JSON.stringify(value);
    const hidden = [leader.email, third.email, ...PHONES.filter((p) => p !== PHONES[1]), "ROLL-LEADER", "ROLL-THIRD", "Leader College", "Third College", "LEADER-PRIVATE-ANSWER", "ABC234"];
    return hidden.filter((secret) => text.includes(secret) && !(secret === viewer.email));
  };

  it("lists the team entry with the other members' contact details removed", async () => {
    const res = await callRoute(myTeamEntries, { path: "/api/registrations/mine", token: mate.idToken });
    expect(res.status).toBe(200);
    const regs = res.body.registrations as any[];
    expect(regs.map((r) => r.id)).toEqual([id]);
    expect(leaks(regs, mate)).toEqual([]);

    const reg = regs[0];
    expect(reg).toMatchObject({ ticketCode: "PS-TEAMPASS01", teamName: "Null Pointers", status: "draft", userName: leader.name });
    expect(reg.members.map((m: any) => m.name)).toEqual([leader.name, mate.name, third.name]);
    expect(reg.members.find((m: any) => m.name === mate.name)).toMatchObject({ email: mate.email, phone: PHONES[1], inviteStatus: "pending" });
    expect(reg.members[0].email).toMatch(/^.___@/);
    expect(reg.memberEmails).toEqual([mate.email]);
    expect(reg).not.toHaveProperty("joinCode");
  });

  it("returns nothing to a stranger, nothing to the leader for their own entry, and needs a signed-in caller", async () => {
    expect((await callRoute(myTeamEntries, { path: "/api/registrations/mine", token: outsider.idToken })).body.registrations).toEqual([]);
    expect((await callRoute(myTeamEntries, { path: "/api/registrations/mine", token: leader.idToken })).body.registrations).toEqual([]);
    expect((await callRoute(myTeamEntries, { path: "/api/registrations/mine" })).status).toBe(401);
  });

  it("the teammate cannot read the entry from Firestore directly, and the leader still can", async () => {
    await clientSignIn(mate);
    await expect(getDoc(doc(firestore(), "registrations", id))).rejects.toMatchObject({ code: "permission-denied" });
    await clientSignOut();
    await clientSignIn(leader);
    const own = await getDoc(doc(firestore(), "registrations", id));
    expect(own.data()?.members).toHaveLength(3);
    expect(own.data()?.members[1].email).toBe(mate.email);
  });

  it("the teammate's \"My events\" still shows the shared ticket, through the repository", async () => {
    await clientSignIn(mate);
    const entries = await repos.registrations.listForUserWithEvents(mate.uid, mate.email);
    expect(entries.map((e) => e.registration.id)).toEqual([id]);
    expect(entries[0]?.registration.ticketCode).toBe("PS-TEAMPASS01");
    expect(leaks(entries[0]?.registration, mate)).toEqual([]);
  });

  it("answering an invitation returns the teammate view, not the full entry", async () => {
    const accepted = await callRoute(teamAction, { path: `/api/registrations/${id}/team`, params: { id }, token: mate.idToken, body: { action: "accept" } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(leaks(accepted.body.registration, mate)).toEqual([]);
    expect(accepted.body.registration.ticketCode).toBe("PS-TEAMPASS01");
    // The change itself happened.
    expect((await db().collection(COLLECTIONS.registrations).doc(id).get()).data()?.members[1].inviteStatus).toBe("accepted");
  });

  it("the leader's own team actions still return everything the leader entered", async () => {
    const renamed = await callRoute(teamAction, { path: `/api/registrations/${id}/team`, params: { id }, token: leader.idToken, body: { action: "rename", teamName: "Segfaults" } });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.registration.teamName).toBe("Segfaults");
    expect(renamed.body.registration.joinCode).toBe("ABC234");
    expect(renamed.body.registration.members.map((m: any) => m.email)).toEqual([leader.email, mate.email, third.email]);
    expect(renamed.body.registration.members[2].phone).toBe(PHONES[2]);
  });

  it("joining with the code returns the teammate view, with no join code and no one else's details", async () => {
    // A fresh solo-leader team with room for one more.
    const created = await callRoute(register, { path: "/api/registrations", token: leader.idToken, body: { eventId: "ev1", teamName: "Joiners", members: [{ name: leader.name, email: leader.email }], answers: { phone: PHONES[0], college: "Leader College" } } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const code = created.body.registration.joinCode as string;
    expect(code).toBeTruthy();

    const joined = await callRoute(joinTeam, { path: "/api/registrations/join", token: outsider.idToken, body: { code } });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body.registration).not.toHaveProperty("joinCode");
    expect(JSON.stringify(joined.body.registration)).not.toContain(leader.email);
    expect(JSON.stringify(joined.body.registration)).not.toContain(PHONES[0]);
    expect(joined.body.registration.members.find((m: any) => m.name === outsider.name)?.email).toBe(outsider.email);
  });
});
