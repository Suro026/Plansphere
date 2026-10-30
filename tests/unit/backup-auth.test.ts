// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectAuthUsers, compareLiveAuth, serializeAuthUser, summarizeAuthUsers, toCliImportRecord, toStandardBase64, validateAuthRecord, verifyAuthBackup, writeAuthBackup } from "../../scripts/lib/backup-auth-core.mjs";

/**
 * Auth serialization, with fake UserRecords - no Firebase project, production or emulator involved, so nothing here can create
 * or change an account. (The emulator test then runs the script against real emulator accounts.)
 */

const sandbox = mkdtempSync(join(tmpdir(), "plansphere-auth-unit-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
let n = 0;

/** What `UserRecord.toJSON()` gives, for an e-mail/password account with claims. */
const record = (over: Record<string, unknown> = {}) => ({
  uid: "uid-b",
  email: "ada@example.test",
  emailVerified: true,
  displayName: "Ada Lovelace",
  photoURL: "https://example.test/a.png",
  phoneNumber: "+919876543210",
  disabled: false,
  metadata: { lastSignInTime: "Wed, 28 Oct 2026 10:00:00 GMT", creationTime: "Mon, 01 Jun 2026 08:30:00 GMT", lastRefreshTime: "Wed, 28 Oct 2026 10:00:00 GMT" },
  providerData: [{ uid: "ada@example.test", displayName: "Ada Lovelace", email: "ada@example.test", providerId: "password" }],
  passwordHash: "Jlf7onfLbzqPNFP_1pqhx6fQF_w-9a",
  passwordSalt: "c2FsdC0x_ab-",
  customClaims: { role: "admin", festIds: ["f1"], br: "volunteer" },
  tokensValidAfterTime: "Mon, 01 Jun 2026 08:30:00 GMT",
  multiFactor: { enrolledFactors: [] },
  ...over,
});
const asUser = (json: Record<string, unknown>) => ({ toJSON: () => json, uid: json.uid });

describe("serializing an account", () => {
  it("keeps every field the SDK reports - hash, salt, claims, providers, flags - and nothing is invented", () => {
    const json = record();
    const out = serializeAuthUser(asUser(json));
    expect(out).toEqual(json);
    expect(out.passwordHash).toBe(json.passwordHash);
    expect(out.passwordSalt).toBe(json.passwordSalt);
    expect(out.customClaims).toEqual({ role: "admin", festIds: ["f1"], br: "volunteer" });
  });

  it("is plain JSON: a round trip changes nothing", () => {
    const out = serializeAuthUser(asUser(record()));
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("copes with an account that has no password, no claims and no e-mail (a phone-only or social account)", () => {
    const out = serializeAuthUser(asUser({ uid: "u", disabled: false, emailVerified: false, metadata: {}, providerData: [] }));
    expect(out.uid).toBe("u");
    expect(out.passwordHash).toBeUndefined();
  });

  it("refuses a record without a uid rather than writing a nameless account", () => {
    expect(() => serializeAuthUser(asUser({ email: "x@y.z" }))).toThrow(/uid/);
  });

  it("does not hold on to the live object", () => {
    const json = record();
    const out = serializeAuthUser(asUser(json));
    (json.customClaims as { role: string }).role = "student";
    expect(out.customClaims!.role).toBe("admin");
  });
});

describe("the Firebase CLI import file", () => {
  it("converts the SDK's web-safe base64 to the standard base64 the CLI reads", () => {
    expect(toStandardBase64("Jlf7onfLbzqPNFP_1pqhx6fQF_w-9a")).toBe("Jlf7onfLbzqPNFP/1pqhx6fQF/w+9a==");
    expect(toStandardBase64("c2FsdC0x_ab-")).toBe("c2FsdC0x/ab+");
    expect(toStandardBase64("")).toBeUndefined();
    expect(toStandardBase64(undefined)).toBeUndefined();
  });

  it("maps an account to localId, hash, salt, claims as customAttributes, and creation time in milliseconds", () => {
    const u = toCliImportRecord(serializeAuthUser(asUser(record())));
    expect(u).toMatchObject({ localId: "uid-b", email: "ada@example.test", emailVerified: true, displayName: "Ada Lovelace", phoneNumber: "+919876543210", disabled: false });
    expect(JSON.parse(u.customAttributes as string)).toEqual({ role: "admin", festIds: ["f1"], br: "volunteer" });
    expect(u.createdAt).toBe(Date.parse("Mon, 01 Jun 2026 08:30:00 GMT"));
    expect(u.lastSignedInAt).toBe(Date.parse("Wed, 28 Oct 2026 10:00:00 GMT"));
    expect(u.passwordHash).toBe(toStandardBase64("Jlf7onfLbzqPNFP_1pqhx6fQF_w-9a"));
    expect(u.providerUserInfo).toBeUndefined(); // the password provider is implied by the hash
  });

  it("carries social providers and leaves out fields an account does not have", () => {
    const u = toCliImportRecord(
      serializeAuthUser(asUser(record({ passwordHash: undefined, passwordSalt: undefined, customClaims: undefined, providerData: [{ uid: "g1", email: "ada@gmail.test", providerId: "google.com", displayName: "Ada" }] }))),
    );
    expect(u.passwordHash).toBeUndefined();
    expect(u.salt).toBeUndefined();
    expect(u.customAttributes).toBeUndefined();
    expect(u.providerUserInfo).toEqual([{ providerId: "google.com", rawId: "g1", email: "ada@gmail.test", displayName: "Ada" }]);
  });

  it("is deterministic", () => {
    const user = serializeAuthUser(asUser(record()));
    expect(JSON.stringify(toCliImportRecord(user))).toBe(JSON.stringify(toCliImportRecord(user)));
  });
});

describe("counts that describe the accounts without exposing them", () => {
  it("summarizes", () => {
    const users = [
      serializeAuthUser(asUser(record())),
      serializeAuthUser(asUser(record({ uid: "u2", passwordHash: undefined, passwordSalt: undefined, customClaims: {}, disabled: true }))),
      serializeAuthUser(asUser(record({ uid: "u3", providerData: [{ uid: "g", providerId: "google.com" }], multiFactor: { enrolledFactors: [{ uid: "f" }] } }))),
    ];
    expect(summarizeAuthUsers(users)).toEqual({ users: 3, withPasswordHash: 2, withPasswordSalt: 2, withCustomClaims: 2, disabled: 1, withMultiFactor: 1, providers: { password: 2, "google.com": 1 } });
  });
});

describe("writing and verifying with a stand-in Auth service", () => {
  /** The three calls the backup makes. Pages of 2 to prove pagination is followed. */
  const fakeAuth = (all: Array<Record<string, unknown>>) => ({
    listUsers: async (_max: number, token?: string) => {
      const start = token ? Number(token) : 0;
      const page = all.slice(start, start + 2).map(asUser);
      return { users: page, pageToken: start + 2 < all.length ? String(start + 2) : undefined };
    },
  });
  const accounts = () => [record({ uid: "uid-c" }), record({ uid: "uid-a", email: "a@example.test" }), record({ uid: "uid-b", email: "b@example.test", passwordHash: undefined })];

  it("collects every page, sorted by uid", async () => {
    const users = await collectAuthUsers(fakeAuth(accounts()) as never);
    expect(users.map((u) => u.uid)).toEqual(["uid-a", "uid-b", "uid-c"]);
  });

  it("writes two files and a manifest with counts and hashes, verified, and no credential", async () => {
    const dir = join(sandbox, `w${(n += 1)}`);
    const manifest = await writeAuthBackup(fakeAuth(accounts()) as never, dir, { projectId: "demo-project" });
    expect(manifest).toMatchObject({ kind: "auth", projectId: "demo-project", verification: { status: "verified" }, totals: { users: 3, withPasswordHash: 2, withCustomClaims: 3 } });
    expect(manifest.files.map((f) => f.path)).toEqual(["auth/users.ndjson", "auth/firebase-auth-import.json"]);
    const text = readFileSync(join(dir, "manifest.json"), "utf8");
    expect(text).not.toMatch(/ada@example|PRIVATE KEY|private_key|client_email/);
    expect(verifyAuthBackup(dir).ok).toBe(true);
    expect(readFileSync(join(dir, "auth/users.ndjson"), "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("notices a tampered users file, and a CLI import file that no longer matches it", async () => {
    const dir = join(sandbox, `w${(n += 1)}`);
    await writeAuthBackup(fakeAuth(accounts()) as never, dir, { projectId: "p" });
    const f = join(dir, "auth/users.ndjson");
    writeFileSync(f, readFileSync(f, "utf8").replace("uid-a", "uid-z"));
    const r = verifyAuthBackup(dir);
    expect(r.ok).toBe(false);
    expect(r.checks.filter((c) => !c.ok).length).toBeGreaterThan(0);
  });

  it("compares with the live accounts by uid only", async () => {
    const dir = join(sandbox, `w${(n += 1)}`);
    await writeAuthBackup(fakeAuth(accounts()) as never, dir, { projectId: "p" });
    expect(await compareLiveAuth(fakeAuth(accounts()) as never, dir)).toMatchObject({ ok: true, backup: 3, live: 3 });
    const changed = [...accounts(), record({ uid: "uid-new" })].filter((a) => a.uid !== "uid-c");
    expect(await compareLiveAuth(fakeAuth(changed) as never, dir)).toMatchObject({ ok: false, missingFromBackup: 1, goneFromLive: 1 });
  });

  it("an empty project still produces a valid, verified backup", async () => {
    const dir = join(sandbox, `w${(n += 1)}`);
    const manifest = await writeAuthBackup(fakeAuth([]) as never, dir, { projectId: "p" });
    expect(manifest.totals.users).toBe(0);
    expect(verifyAuthBackup(dir).ok).toBe(true);
  });

  it("validates records structurally", () => {
    expect(validateAuthRecord({ uid: "u" }, { role: "records" })).toEqual([]);
    expect(validateAuthRecord({}, { role: "records" })).toContain("no uid");
    expect(validateAuthRecord({ uid: "u", customClaims: [] }, { role: "records" })).toContain("customClaims is not an object");
    expect(validateAuthRecord({ users: [{ localId: "a" }] }, { role: "cli-import", users: 2 })).toEqual(["1 user(s) but the manifest says 2"]);
  });
});
