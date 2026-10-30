import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeoPoint, Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAuth, adminDb } from "@/server/firebase-admin";
import { compareDumpToDatabase, openDatabase } from "../../scripts/lib/backup-firestore-core.mjs";
import { PROJECT, mintUser, resetAuth, resetFirestore } from "./harness";

/**
 * The billing-free backup scripts, run for real against the EMULATORS in child processes. Nothing here touches production: the
 * scripts only talk to Firebase through the emulator hosts in the environment, and the restore check refuses to run without one.
 *
 * The proof that matters is the last one: a backup is restored into an empty emulator and every document is compared with the
 * original field by field. Until that passes a dump is only a file.
 */

const sandbox = mkdtempSync(join(tmpdir(), "plansphere-backup-emu-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const credential = Buffer.from(JSON.stringify({ type: "service_account", project_id: PROJECT, client_email: `svc@${PROJECT}.iam.gserviceaccount.com`, private_key: privateKey })).toString("base64");

let n = 0;
const fresh = (name: string) => join(sandbox, `${name}-${(n += 1)}`);

const run = (script: string, args: string[], env: Record<string, string | undefined> = {}) => {
  // An override of undefined REMOVES the variable (Node would otherwise pass the text "undefined").
  const merged: Record<string, string | undefined> = { ...process.env, FIREBASE_SERVICE_ACCOUNT: credential, GCLOUD_PROJECT: PROJECT, ...env };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  const r = spawnSync(process.execPath, [`scripts/${script}`, ...args], { env: merged as NodeJS.ProcessEnv, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

/** Document values of every kind, including a legacy collection the app never names and a document that exists only as a parent. */
const seed = async () => {
  const db = adminDb();
  await db.collection("users").doc("u1").set({ id: "u1", name: "Ada Lovelace — ✓ 😀", email: "ada@example.test", role: "admin", festIds: ["f1", "f2"], year: 3, ratio: 2.5, big: 9007199254740993n, createdAt: Timestamp.fromMillis(1_700_000_000_123), precise /* Firestore keeps microseconds */: new Timestamp(1_700_000_000, 123_456_000), before1970: new Timestamp(-86_400, 1_000), where: new GeoPoint(12.9716, 77.5946), owner: db.doc("fests/f1"), raw: Buffer.from([0, 1, 2, 253, 254, 255]), flag: true, nothing: null, empty: {}, none: [], nested: { a: { b: [1, 2.5, "x", null, { c: new Timestamp(5, 6_000) }] } }, tricky: { $: "int", v: "42" }, looksLikeATag: '{"$":"int"}' });
  await db.collection("users").doc("u2").set({ id: "u2", name: "Plain Student", role: "student", festIds: [] });
  await db.collection("fests").doc("f1").set({ id: "f1", name: "Fest One", status: "published", stats: { events: 2, registrations: 0 }, startDate: "2026-12-10" });
  await db.collection("fests").doc("f2").set({ id: "f2", name: "Fest Two", status: "draft" });
  await db.collection("fests").doc("f1").collection("private").doc("head").set({ phone: "+919876543210", ref: db.doc("users/u1") });
  await db.collection("events").doc("e1").set({ festId: "f1", title: "Hack", capacity: 100, entryFee: 0, date: "2026-12-11" });
  await db.collection("eventRegistrations").doc("legacy1").set({ student: "u1", event: "e1", note: "a legacy collection nothing in the app names" });
  await db.collection("eventRegistrations").doc("legacy2").set({ student: "u2", event: "e1" });
  // A document that does not exist itself but has a subcollection: only listDocuments() finds it.
  await db.collection("ghosts").doc("g1").collection("notes").doc("n1").set({ text: "child of a document that has no data" });
};

const COLLECTIONS = ["eventRegistrations", "events", "fests", "fests/f1/private", "ghosts/g1/notes", "users"].sort();
const DOCUMENTS = 9;

describe("backup:firestore", () => {
  let dir: string;

  beforeAll(async () => {
    await resetFirestore();
    await seed();
  });

  it("is a dry run by default: prints counts, writes nothing, shows no document content", () => {
    const before = readdirSync(sandbox).length;
    const r = run("backup-firestore.mjs", []);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/DRY RUN/);
    expect(r.out).toMatch(/Dry run: nothing was written/);
    for (const c of COLLECTIONS) expect(r.out).toContain(c);
    expect(r.out).toContain(`${DOCUMENTS} document(s)`);
    expect(r.out).toMatch(/PERSONAL DATA/);
    for (const personal of ["ada@example.test", "Ada Lovelace", "+919876543210", "legacy collection nothing"]) expect(r.out).not.toContain(personal);
    expect(readdirSync(sandbox).length).toBe(before);
  });

  it("writes every collection - root, nested and legacy - and a manifest that says it verified", () => {
    dir = fresh("firestore");
    const r = run("backup-firestore.mjs", ["--write", dir]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/Verification: VERIFIED/);
    expect(r.out).not.toContain("ada@example.test");

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ format: "plansphere-backup", kind: "firestore", projectId: PROJECT, totals: { documents: DOCUMENTS, collections: COLLECTIONS.length }, verification: { status: "verified" } });
    expect(manifest.files.map((f: { collection: string }) => f.collection).sort()).toEqual(COLLECTIONS);
    expect(Object.fromEntries(manifest.files.map((f: { collection: string; records: number }) => [f.collection, f.records]))).toEqual({ eventRegistrations: 2, events: 1, fests: 2, "fests/f1/private": 1, "ghosts/g1/notes": 1, users: 2 });
    expect(Date.parse(manifest.createdAt)).not.toBeNaN();
    for (const f of manifest.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.verification.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  it("never writes a credential, and the directory holds only the files the manifest lists", () => {
    const names: string[] = [];
    const walk = (d: string) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : names.push(join(d, e.name))));
    walk(dir);
    for (const file of names) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain("BEGIN PRIVATE KEY");
      expect(text, file).not.toContain("iam.gserviceaccount.com");
      expect(text, file).not.toContain(credential.slice(0, 40));
    }
    expect(names.length).toBe(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).files.length + 2);
    if (process.platform !== "win32") for (const file of names) expect(statSync(file).mode & 0o077, file).toBe(0);
  });

  it("refuses an existing directory, anywhere inside the repository, and a missing parent - and writes nothing", () => {
    const before = readFileSync(join(dir, "manifest.json"), "utf8");
    expect(run("backup-firestore.mjs", ["--write", dir]).out).toMatch(/already exists/);
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe(before);

    const inside = run("backup-firestore.mjs", ["--write", "backup-should-not-exist"]);
    expect(inside.status).toBe(1);
    expect(inside.out).toMatch(/inside this repository/);
    expect(existsSync("backup-should-not-exist")).toBe(false);

    expect(run("backup-firestore.mjs", ["--write", join(sandbox, "no", "such", "parent")]).out).toMatch(/does not exist/);
    expect(run("backup-firestore.mjs", ["--wrte", fresh("typo")]).out).toMatch(/Unknown option/);
  });

  it("refuses to read more documents than the cap, before reading any", () => {
    const target = fresh("capped");
    const r = run("backup-firestore.mjs", ["--write", target, "--max-documents", "5"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/more than 5 documents/);
    expect(existsSync(target)).toBe(false);
  });

  it("verifies offline, with no database and no credential", () => {
    const r = run("backup-firestore.mjs", ["--verify", dir], { FIRESTORE_EMULATOR_HOST: undefined, FIREBASE_AUTH_EMULATOR_HOST: undefined, FIREBASE_SERVICE_ACCOUNT: undefined });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/The backup is intact/);
  });

  it("notices a changed byte, a removed file and an edited manifest", () => {
    const flip = (mutate: (copy: string) => void) => {
      const copy = fresh("tampered");
      cpSync(dir, copy, { recursive: true });
      mutate(copy);
      return run("backup-firestore.mjs", ["--verify", copy]);
    };
    const users = (copy: string) => join(copy, readdirSync(join(copy, "firestore")).filter((f) => f.endsWith("-users.ndjson")).map((f) => `firestore/${f}`)[0]!);

    const changed = flip((c) => writeFileSync(users(c), readFileSync(users(c), "utf8").replace("Plain Student", "Plain Studenx")));
    expect(changed.status).toBe(1);
    expect(changed.out).toMatch(/FAIL.*users/);
    expect(changed.out).not.toContain("Plain Stud");

    const removed = flip((c) => rmSync(users(c)));
    expect(removed.status).toBe(1);
    expect(removed.out).toMatch(/missing/);

    const edited = flip((c) => writeFileSync(join(c, "manifest.json"), readFileSync(join(c, "manifest.json"), "utf8").replace(`"documents": ${DOCUMENTS}`, `"documents": ${DOCUMENTS - 1}`)));
    expect(edited.status).toBe(1);
    expect(edited.out).toMatch(/manifest hash/);

    expect(run("backup-firestore.mjs", ["--verify", dir]).status).toBe(0); // the original is untouched
  });

  it("--live compares with the database: equal now, drift once a document is added or removed", async () => {
    expect(run("backup-firestore.mjs", ["--verify", dir, "--live"]).status).toBe(0);

    await adminDb().collection("users").doc("u3").set({ id: "u3" });
    const added = run("backup-firestore.mjs", ["--verify", dir, "--live"]);
    expect(added.status).toBe(1);
    expect(added.out).toMatch(/users: backup 2, live 3/);
    await adminDb().collection("users").doc("u3").delete();

    await adminDb().collection("brandnew").doc("x").set({ a: 1 });
    expect(run("backup-firestore.mjs", ["--verify", dir, "--live"]).out).toMatch(/brandnew: backup 0, live 1/);
    await adminDb().collection("brandnew").doc("x").delete();

    expect(run("backup-firestore.mjs", ["--verify", dir, "--live"]).status).toBe(0);
  });

  it("--restore-check refuses without an emulator, so it can never write to production", () => {
    const r = run("backup-firestore.mjs", ["--verify", dir, "--restore-check"], { FIRESTORE_EMULATOR_HOST: undefined, FIREBASE_AUTH_EMULATOR_HOST: undefined });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/never writes to production/);
  });

  it("--restore-check refuses an emulator that already holds documents", () => {
    const r = run("backup-firestore.mjs", ["--verify", dir, "--restore-check"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/already holds documents/);
  });

  it("RESTORES into an empty emulator and every document matches field by field", async () => {
    await resetFirestore();
    const r = run("backup-firestore.mjs", ["--verify", dir, "--restore-check"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(new RegExp(`Restored ${DOCUMENTS} document`));
    expect(r.out).toMatch(/missing: 0\s+extra: 0\s+different: 0/);
    expect(r.out).toMatch(/restores exactly/);

    // The same check, independently, in this process - and on the values themselves rather than the tool's own report.
    const db = openDatabase(PROJECT);
    expect((await compareDumpToDatabase(db, dir)).ok).toBe(true);
    const ada = (await db.doc("users/u1").get()).data()!;
    expect(ada.big).toBe(9007199254740993n);
    expect(ada.year).toBe(3n);
    expect(ada.ratio).toBe(2.5);
    expect((ada.precise as Timestamp).isEqual(new Timestamp(1_700_000_000, 123_456_000))).toBe(true);
    expect((ada.before1970 as Timestamp).isEqual(new Timestamp(-86_400, 1_000))).toBe(true);
    expect((ada.where as GeoPoint).isEqual(new GeoPoint(12.9716, 77.5946))).toBe(true);
    expect((ada.owner as { path: string }).path).toBe("fests/f1");
    expect(Buffer.from(ada.raw as Buffer).equals(Buffer.from([0, 1, 2, 253, 254, 255]))).toBe(true);
    expect(ada.tricky).toEqual({ $: "int", v: "42" });
    expect(ada.looksLikeATag).toBe('{"$":"int"}');
    expect(ada.empty).toEqual({});
    expect(ada.none).toEqual([]);
    expect((await db.doc("ghosts/g1/notes/n1").get()).data()).toEqual({ text: "child of a document that has no data" });
    expect((await db.doc("eventRegistrations/legacy1").get()).exists).toBe(true);
    await db.terminate();
  });

  it("the field-by-field comparison catches a change, a missing document and an extra one - naming fields, never values", async () => {
    const db = openDatabase(PROJECT);
    await db.doc("users/u2").update({ name: "SECRET-NEW-NAME" });
    await db.doc("users/u1").update({ "nested.a.b": [1, 2.5] });
    await db.doc("events/e1").delete();
    await db.doc("events/extra").set({ x: 1 });
    const cmp = await compareDumpToDatabase(db, dir);
    expect(cmp.ok).toBe(false);
    expect(cmp.missing).toEqual(["events/e1"]);
    expect(cmp.extra).toEqual(["events/extra"]);
    expect(cmp.different).toEqual([
      { path: "users/u1", fields: ["nested.a.b"] },
      { path: "users/u2", fields: ["name"] },
    ]);
    expect(JSON.stringify(cmp)).not.toContain("SECRET-NEW-NAME");
    await db.terminate();
  });
});

describe("backup:auth", () => {
  let dir: string;
  const people: Array<{ uid: string; email: string; role: string }> = [];

  beforeAll(async () => {
    await resetAuth();
    for (const [role, festIds] of [["admin", ["f1"]], ["volunteer", ["f1"]], ["student", []]] as const) {
      const u = await mintUser({ role, festIds: [...festIds], name: `Backup ${role}` });
      people.push({ uid: u.uid, email: u.email, role });
    }
  });

  it("is a dry run by default: counts only, no account is named", () => {
    const before = readdirSync(sandbox).length;
    const r = run("backup-auth.mjs", []);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/DRY RUN/);
    expect(r.out).toMatch(/accounts\s+3/);
    expect(r.out).toMatch(/with custom claims\s+3/);
    for (const p of people) {
      expect(r.out).not.toContain(p.email);
      expect(r.out).not.toContain(p.uid);
    }
    expect(readdirSync(sandbox).length).toBe(before);
  });

  it("writes every account with its claims, a CLI import file, and a verified manifest", async () => {
    dir = fresh("auth");
    const r = run("backup-auth.mjs", ["--write", dir]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/Verification: VERIFIED/);
    for (const p of people) expect(r.out).not.toContain(p.email);

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ kind: "auth", projectId: PROJECT, totals: { users: 3, withCustomClaims: 3 }, verification: { status: "verified" } });
    for (const f of manifest.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);

    const users = readFileSync(join(dir, "auth/users.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(users.map((u: { uid: string }) => u.uid).sort()).toEqual(people.map((p) => p.uid).sort());
    for (const u of users) {
      const live = await adminAuth().getUser(u.uid);
      expect(u.email).toBe(live.email);
      expect(u.customClaims).toEqual(live.customClaims); // the claims the CLI export can omit
      expect(u.passwordHash).toBe(live.passwordHash); // whatever the SDK reports is what is kept
      expect(u.passwordSalt).toBe(live.passwordSalt);
      expect(u.providerData.map((p: { providerId: string }) => p.providerId)).toEqual(live.providerData.map((p) => p.providerId));
    }
    expect(manifest.totals.withPasswordHash).toBe(users.filter((u: { passwordHash?: string }) => u.passwordHash).length);

    const cli = JSON.parse(readFileSync(join(dir, "auth/firebase-auth-import.json"), "utf8"));
    expect(cli.users.map((u: { localId: string }) => u.localId)).toEqual(users.map((u: { uid: string }) => u.uid));
    for (const u of cli.users) expect(JSON.parse(u.customAttributes)).toEqual((await adminAuth().getUser(u.localId)).customClaims);
  });

  it("holds no service-account credential or API key anywhere", () => {
    for (const file of ["manifest.json", "MANIFEST.sha256", "auth/users.ndjson", "auth/firebase-auth-import.json"]) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toContain("BEGIN PRIVATE KEY");
      expect(text, file).not.toContain("iam.gserviceaccount.com");
      expect(text, file).not.toContain(credential.slice(0, 40));
    }
  });

  it("refuses an existing directory and one inside the repository", () => {
    expect(run("backup-auth.mjs", ["--write", dir]).out).toMatch(/already exists/);
    expect(run("backup-auth.mjs", ["--write", "auth-backup-should-not-exist"]).out).toMatch(/inside this repository/);
    expect(existsSync("auth-backup-should-not-exist")).toBe(false);
  });

  it("verifies offline and notices tampering", () => {
    expect(run("backup-auth.mjs", ["--verify", dir], { FIREBASE_AUTH_EMULATOR_HOST: undefined, FIREBASE_SERVICE_ACCOUNT: undefined }).status).toBe(0);
    const copy = fresh("auth-tampered");
    cpSync(dir, copy, { recursive: true });
    const f = join(copy, "auth/users.ndjson");
    writeFileSync(f, readFileSync(f, "utf8").replace(/"role":"admin"/, '"role":"super_admin"'));
    const r = run("backup-auth.mjs", ["--verify", copy]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL/);
  });

  it("--live compares the accounts: the same now, different after an account is added", async () => {
    expect(run("backup-auth.mjs", ["--verify", dir, "--live"]).status).toBe(0);
    const extra = await mintUser({ name: "Joined later" });
    const r = run("backup-auth.mjs", ["--verify", dir, "--live"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/in live but not in the backup: 1/);
    await adminAuth().deleteUser(extra.uid);
    expect(run("backup-auth.mjs", ["--verify", dir, "--live"]).status).toBe(0);
  });
});
