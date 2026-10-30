import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";
import { membershipIdFor } from "@/core/models/membership";
import { mintUser, resetAuth, resetFirestore, seedFest, type TestUser } from "./harness";

/**
 * The data-changing scripts, run for real against the emulators in child processes.
 *
 * Phase 7 audit finding: docs/MIGRATIONS.md said "each script is a dry run unless told otherwise, and writes a backup", but
 * `migrate:rbac` and `migrate:fests` APPLIED by default (the dry run was opt-in via --dry-run) and wrote no backup, and
 * `grant-super-admin` and `firebase:deploy` had no dry run at all. All four now follow the one contract in
 * scripts/lib/migration-cli.mjs. What matters here is what they will NOT do: write anything unless asked, apply without a
 * backup, overwrite a backup, or undo a change somebody has made since.
 */

const dir = mkdtempSync(join(tmpdir(), "plansphere-safety-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const account = Buffer.from(JSON.stringify({ type: "service_account", project_id: "plansphere-test", client_email: "m@plansphere-test.iam.gserviceaccount.com", private_key: privateKey })).toString("base64");

let n = 0;
const fresh = (name: string) => join(dir, `${name}-${(n += 1)}.json`);

const run = (script: string, args: string[], env: Record<string, string | undefined> = {}) => {
  const r = spawnSync(process.execPath, [`scripts/${script}`, ...args], { env: { ...process.env, FIREBASE_SERVICE_ACCOUNT: account, ...env }, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const users = () => adminDb().collection(COLLECTIONS.users);
const claimsOf = async (u: TestUser) => (await adminAuth().getUser(u.uid)).customClaims ?? {};

describe("migrate:rbac - dry run by default, backup before apply, restore", () => {
  let organizer: TestUser;
  let admin: TestUser;

  const legacyProfile = (u: TestUser, role: string, festIds: string[]) =>
    users().doc(u.uid).set({ email: u.email, fullName: u.name, role, organizer: { festIds, designation: "Convenor" }, createdAt: new Date(), updatedAt: new Date() });

  beforeAll(async () => {
    await resetAuth();
    organizer = await mintUser({ role: "organizer" as never, festIds: ["fA"], name: "Old Organizer", profile: false });
    admin = await mintUser({ role: "admin", festIds: ["fA"], name: "Fest Admin", profile: false });
  });

  beforeEach(async () => {
    await resetFirestore();
    await legacyProfile(organizer, "organizer", ["fA"]);
    await legacyProfile(admin, "admin", ["fA", "fB"]);
    await adminAuth().setCustomUserClaims(organizer.uid, { role: "organizer", festIds: ["fA"] });
    await adminAuth().setCustomUserClaims(admin.uid, { role: "admin", festIds: ["fA"] });
  });

  it("with no flag it only reports: no profile and no claim changes", async () => {
    const before = (await users().doc(organizer.uid).get()).data();
    const r = run("migrate-rbac.mjs", []);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/dry run/i);
    expect(r.out).toMatch(/would be signed out/);
    expect((await users().doc(organizer.uid).get()).data()).toEqual(before);
    expect(await claimsOf(organizer)).toEqual({ role: "organizer", festIds: ["fA"] });
  });

  it("--dry-run still works, and contradicting --apply is refused rather than guessed", async () => {
    expect(run("migrate-rbac.mjs", ["--dry-run"]).status).toBe(0);
    const r = run("migrate-rbac.mjs", ["--apply", "--dry-run", "--backup", fresh("b")]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/contradict/);
  });

  it("--apply without --backup is refused and changes nothing", async () => {
    const r = run("migrate-rbac.mjs", ["--apply"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/--apply needs --backup/);
    expect((await users().doc(organizer.uid).get()).data()!.role).toBe("organizer");
    expect(await claimsOf(organizer)).toEqual({ role: "organizer", festIds: ["fA"] });
  });

  it("an unknown option is refused (a typo must not fall through to an apply)", () => {
    const r = run("migrate-rbac.mjs", ["--aply", "--backup", fresh("b")]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/Unknown option --aply/);
  });

  it("refuses to overwrite an existing backup", async () => {
    const file = fresh("existing");
    writeFileSync(file, "keep me\n");
    const r = run("migrate-rbac.mjs", ["--apply", "--backup", file]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/already exists/);
    expect(readFileSync(file, "utf8")).toBe("keep me\n");
    expect((await users().doc(organizer.uid).get()).data()!.role).toBe("organizer");
  });

  it("--apply --backup migrates, writes the backup first, reads back, and a second run changes nothing", async () => {
    const file = fresh("rbac");
    const r = run("migrate-rbac.mjs", ["--apply", "--backup", file]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Backup:/);

    expect((await users().doc(organizer.uid).get()).data()).toMatchObject({ role: "volunteer", festIds: ["fA"], name: "Old Organizer", designation: "Convenor" });
    expect(await claimsOf(organizer)).toEqual({ role: "volunteer", festIds: ["fA"] });
    // The claim change signed the account out: its refresh tokens were revoked.
    expect((await adminAuth().getUser(organizer.uid)).tokensValidAfterTime).toBeTruthy();

    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.uid).sort()).toEqual([admin.uid, organizer.uid].sort());
    const entry = lines.find((l) => l.uid === organizer.uid);
    expect(entry.claimsBefore).toEqual({ role: "organizer", festIds: ["fA"] });
    expect(entry.before.role).toBe("organizer");
    expect(entry.absent).toContain("name"); // the legacy profile had `fullName`, not `name`
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);

    // Idempotent: nothing left to change, so no second backup is needed and nothing is rewritten.
    const again = run("migrate-rbac.mjs", ["--apply", "--backup", fresh("rbac2")]);
    expect(again.status).toBe(0);
    expect(again.out).toMatch(/documents migrated : 0/);
    expect(again.out).toMatch(/no backup file was written/);
  });

  it("--restore is a dry run without --apply, then puts the profile and claims back, keeping anything edited since", async () => {
    const file = fresh("rbac-restore");
    expect(run("migrate-rbac.mjs", ["--apply", "--backup", file]).status).toBe(0);

    // Somebody edited the admin's migrated profile after the migration: that must survive a restore.
    await users().doc(admin.uid).update({ festIds: ["fA", "fB", "fC"] });

    const dry = run("migrate-rbac.mjs", ["--restore", file]);
    expect(dry.status).toBe(0);
    expect(dry.out).toMatch(/restore dry run/);
    expect((await users().doc(organizer.uid).get()).data()!.role).toBe("volunteer"); // untouched

    const real = run("migrate-rbac.mjs", ["--restore", file, "--apply"]);
    expect(real.status).toBe(0);
    expect((await users().doc(organizer.uid).get()).data()!.role).toBe("organizer");
    expect((await users().doc(organizer.uid).get()).data()!.name).toBeUndefined(); // the field the migration added is removed
    expect(await claimsOf(organizer)).toEqual({ role: "organizer", festIds: ["fA"] });
    expect((await users().doc(admin.uid).get()).data()!.festIds).toEqual(["fA", "fB", "fC"]);
    expect(real.out).toMatch(/kept \(changed since the migration\)/);
  });

  it("--restore refuses a damaged backup instead of guessing", () => {
    const file = fresh("damaged");
    writeFileSync(file, '{"uid":"a"}\nnot json\n');
    const r = run("migrate-rbac.mjs", ["--restore", file]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/line 2 is not valid JSON/);
  });
});

describe("migrate:fests - dry run by default, backup before apply, restore", () => {
  beforeEach(async () => {
    await resetFirestore();
    // The default seed carries none of festType / visibility / registrationState / ownerId / academicYear: a pre-container fest.
    await seedFest({ id: "fOld", slug: "old", name: "Old Fest", createdBy: "someone", startDate: "2026-09-01", endDate: "2026-09-03" });
  });

  const fest = async () => (await adminDb().collection(COLLECTIONS.fests).doc("fOld").get()).data()!;

  it("with no flag it only reports", async () => {
    const before = await fest();
    const r = run("migrate-fest-containers.mjs", []);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/dry run/i);
    expect(r.out).toMatch(/fests to migrate/);
    expect(await fest()).toEqual(before);
  });

  it("--apply needs --backup; an unknown option is refused", async () => {
    expect(run("migrate-fest-containers.mjs", ["--apply"]).out).toMatch(/--apply needs --backup/);
    expect(run("migrate-fest-containers.mjs", ["--aply"]).status).toBe(1);
    expect((await fest()).festType).toBeUndefined();
  });

  it("--apply --backup adds only the missing fields, records exactly what it added, and is idempotent", async () => {
    const file = fresh("fests");
    const r = run("migrate-fest-containers.mjs", ["--apply", "--backup", file]);
    expect(r.status).toBe(0);
    expect(await fest()).toMatchObject({ festType: "other", visibility: "public", ownerId: "someone", academicYear: "2026-27" });
    const [line] = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(line.festId).toBe("fOld");
    expect(Object.keys(line.added).sort()).toEqual(["academicYear", "festType", "ownerId", "registrationState", "visibility"]);

    const again = run("migrate-fest-containers.mjs", ["--apply", "--backup", fresh("fests2")]);
    expect(again.status).toBe(0);
    expect(again.out).toMatch(/already current : 1/);
    expect(again.out).toMatch(/no backup file was written/);
  });

  it("--restore removes what the migration added, and keeps a field the owner has changed since", async () => {
    const file = fresh("fests-restore");
    expect(run("migrate-fest-containers.mjs", ["--apply", "--backup", file]).status).toBe(0);
    await adminDb().collection(COLLECTIONS.fests).doc("fOld").update({ visibility: "private" }); // the owner changed it

    expect(run("migrate-fest-containers.mjs", ["--restore", file]).out).toMatch(/restore dry run/);
    expect((await fest()).festType).toBe("other"); // a dry run removes nothing

    const real = run("migrate-fest-containers.mjs", ["--restore", file, "--apply"]);
    expect(real.status).toBe(0);
    const after = await fest();
    expect(after.festType).toBeUndefined();
    expect(after.ownerId).toBeUndefined();
    expect(after.academicYear).toBeUndefined();
    expect(after.visibility).toBe("private");
    expect(real.out).toMatch(/kept \(changed since the migration\)/);
    expect(after.name).toBe("Old Fest"); // nothing else was touched
  });
});

describe("migrate:accounts - the one-time import cannot reset staff or hand out the platform", () => {
  let staff: TestUser;
  let bootstrap: TestUser;
  let verifiedBootstrap: TestUser;

  beforeAll(async () => {
    await resetAuth();
    staff = await mintUser({ role: "admin", festIds: ["fA"], name: "Current Admin", profile: false });
    bootstrap = await mintUser({ name: "Unverified Owner", email: "owner-unverified@plansphere.test", emailVerified: false, profile: false });
    verifiedBootstrap = await mintUser({ name: "Verified Owner", email: "owner-verified@plansphere.test", emailVerified: true, profile: false });
  });

  beforeEach(async () => {
    await resetFirestore();
    await users().doc(staff.uid).set({ id: staff.uid, email: staff.email, name: staff.name, role: "admin", festIds: ["fA"], createdAt: new Date(), updatedAt: new Date() });
  });

  const env = (email: string) => ({ SUPER_ADMIN_EMAIL: email });

  it("is a dry run by default and skips accounts that already have a profile", async () => {
    const r = run("migrate-accounts.mjs", [], env("nobody@plansphere.test"));
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/DRY RUN/);
    expect(r.out).toMatch(/Nothing written/);
    expect(r.out).toMatch(/skip .*→ admin|skip/);
    expect(await claimsOf(staff)).toEqual({ role: "admin", festIds: ["fA"] });
  });

  it("--apply --force is refused without a backup, and an existing backup is never overwritten", async () => {
    const none = run("migrate-accounts.mjs", ["--apply", "--force"], env("nobody@plansphere.test"));
    expect(none.status).toBe(1);
    expect(none.out).toMatch(/needs --backup/);
    const file = fresh("accounts-existing");
    writeFileSync(file, "keep\n");
    expect(run("migrate-accounts.mjs", ["--apply", "--force", "--backup", file], env("nobody@plansphere.test")).out).toMatch(/already exists/);
    expect(await claimsOf(staff)).toEqual({ role: "admin", festIds: ["fA"] });
  });

  it("--force with a backup records the claims and scope it replaces", async () => {
    const file = fresh("accounts-force");
    const r = run("migrate-accounts.mjs", ["--apply", "--force", "--backup", file], env("nobody@plansphere.test"));
    expect(r.status).toBe(0);
    const entries = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const mine = entries.find((e) => e.uid === staff.uid);
    expect(mine).toMatchObject({ profile: { role: "admin", festIds: ["fA"] }, claims: { role: "admin", festIds: ["fA"] } });
  });

  it("does not grant the platform role to an unverified bootstrap address", async () => {
    const r = run("migrate-accounts.mjs", [], env(bootstrap.email));
    expect(r.out).not.toMatch(/super_admin\s+\(bootstrap/);
    expect(r.out).toMatch(/Unverified Owner/);
    expect(r.out).not.toMatch(/bootstrap super admin/);
  });

  it("grants it to a verified bootstrap address, or one the operator vouches for with --trust-emails", async () => {
    expect(run("migrate-accounts.mjs", [], env(verifiedBootstrap.email)).out).toMatch(/bootstrap super admin/);
    expect(run("migrate-accounts.mjs", ["--trust-emails"], env(bootstrap.email)).out).toMatch(/bootstrap super admin/);
  });

  it("refuses an unknown option", () => {
    expect(run("migrate-accounts.mjs", ["--aply"], env("x@plansphere.test")).status).toBe(1);
  });
});

describe("grant-super-admin - dry run by default", () => {
  let candidate: TestUser;
  let eventHead: TestUser;

  beforeAll(async () => {
    await resetAuth();
    candidate = await mintUser({ name: "Platform Candidate", email: "candidate@plansphere.test" });
    eventHead = await mintUser({ name: "Event Head", email: "head@plansphere.test" });
  });

  beforeEach(async () => {
    await resetFirestore();
    await users().doc(candidate.uid).set({ id: candidate.uid, email: candidate.email, name: candidate.name, role: "student", festIds: [], createdAt: new Date(), updatedAt: new Date() });
    await adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor("fA", eventHead.uid)).set({ festId: "fA", userId: eventHead.uid, role: "head", status: "active", eventIds: [], createdAt: new Date(), updatedAt: new Date() });
  });

  it("without --apply it reports and changes nothing", async () => {
    const r = run("grant-super-admin.mjs", [candidate.email]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/dry run/i);
    expect(r.out).toMatch(/current role student/);
    expect((await claimsOf(candidate)).role).toBe("student");
    expect((await adminDb().collection(COLLECTIONS.platformStaff).doc(candidate.uid).get()).exists).toBe(false);
  });

  it("does not create an account on a dry run", async () => {
    const r = run("grant-super-admin.mjs", ["nobody-yet@plansphere.test"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/does not exist/);
    await expect(adminAuth().getUserByEmail("nobody-yet@plansphere.test")).rejects.toMatchObject({ code: "auth/user-not-found" });
  });

  it("with --apply it grants the role and registers the account", async () => {
    const r = run("grant-super-admin.mjs", [candidate.email, "--apply"]);
    expect(r.status).toBe(0);
    expect(await claimsOf(candidate)).toEqual({ role: "super_admin", festIds: [] });
    expect((await adminDb().collection(COLLECTIONS.platformStaff).doc(candidate.uid).get()).data()?.status).toBe("active");
  });

  it("refuses an account that holds event roles, even with --apply, unless explicitly allowed", async () => {
    const dry = run("grant-super-admin.mjs", [eventHead.email]);
    expect(dry.status).toBe(1);
    expect(dry.out).toMatch(/REFUSED.*1 event role/s);

    const applied = run("grant-super-admin.mjs", [eventHead.email, "--apply"]);
    expect(applied.status).toBe(1);
    expect((await claimsOf(eventHead)).role).toBe("student");
    expect((await adminDb().collection(COLLECTIONS.platformStaff).doc(eventHead.uid).get()).exists).toBe(false);
  });

  it("refuses an unknown option", () => {
    expect(run("grant-super-admin.mjs", [candidate.email, "--aply"]).status).toBe(1);
  });
});

describe("a credential that cannot be read stops every script before it touches anything", () => {
  const scripts: Array<[string, string[]]> = [
    ["migrate-rbac.mjs", ["--apply", "--backup"]],
    ["migrate-fest-containers.mjs", []],
    ["migrate-memberships.mjs", []],
    ["migrate-event-head.mjs", []],
    ["migrate-accounts.mjs", []],
    ["platform-staff.mjs", ["list"]],
    ["grant-super-admin.mjs", ["x@plansphere.test"]],
    ["inspect-accounts.mjs", []],
    ["deploy-firebase.mjs", []],
    ["verify-infra.mjs", []],
    ["verify-admin.mjs", []],
  ];

  for (const [script, extra] of scripts) {
    it(`${script}: names the cause, exits 1 and writes no backup`, () => {
      const backup = fresh("never");
      const args = extra.includes("--backup") ? [...extra, backup] : extra;
      // The private key alone - the real mistake found in .env.local.
      const r = run(script, args, { FIREBASE_SERVICE_ACCOUNT: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\nabcDEF+/123\\nxyz=\\n" });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/private key alone|private-key-only/);
      expect(r.out).not.toContain("MIIEvQ");
      expect(existsSync(backup)).toBe(false);
    });
  }
});
