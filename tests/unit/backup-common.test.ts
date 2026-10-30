// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BackupError,
  REPO_ROOT,
  assertSafeBackupDir,
  buildManifest,
  createBackupDir,
  parseBackupArgs,
  sha256Hex,
  verifyBackupFiles,
  writeBackupFile,
  writeManifest,
} from "../../scripts/lib/backup-common.mjs";

/**
 * The rules every backup follows: a dry run unless told to write, a NEW directory outside the repository, owner-only files, a
 * manifest that carries hashes and counts and no credential, and an offline check that notices any change.
 */

const sandbox = mkdtempSync(join(tmpdir(), "plansphere-backup-unit-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(sandbox, `b${(n += 1)}`);
const parse = (...args: string[]) => parseBackupArgs(args, { script: "x.mjs", allowRestoreCheck: true });

describe("the command line", () => {
  it("is a dry run with no flags", () => {
    expect(parse()).toMatchObject({ mode: "dry-run", dir: null, live: false, restoreCheck: false, maxDocuments: 10_000 });
  });

  it("writes only with --write and a directory", () => {
    expect(parse("--write", "C:\\backups\\one")).toMatchObject({ mode: "write", dir: "C:\\backups\\one" });
    expect(() => parse("--write")).toThrow(/NEW directory/);
    expect(() => parse("--write", "--live")).toThrow(/NEW directory/);
  });

  it("verifies with --verify, optionally --live or --restore-check", () => {
    expect(parse("--verify", "d")).toMatchObject({ mode: "verify", dir: "d", live: false });
    expect(parse("--verify", "d", "--live")).toMatchObject({ mode: "verify", live: true });
    expect(parse("--verify", "d", "--restore-check")).toMatchObject({ mode: "verify", restoreCheck: true });
    expect(() => parse("--verify")).toThrow(/directory to check/);
  });

  it("refuses contradictory or misplaced flags rather than guessing", () => {
    expect(() => parse("--write", "a", "--verify", "b")).toThrow(/cannot be combined/);
    expect(() => parse("--live")).toThrow(/only apply to --verify/);
    expect(() => parse("--restore-check")).toThrow(/only apply to --verify/);
    expect(() => parse("--verify", "d", "--live", "--restore-check")).toThrow(/Pick one/);
  });

  it("refuses an unknown option, so a typo cannot turn a dry run into something else", () => {
    expect(() => parse("--wrte", "d")).toThrow(/Unknown option --wrte/);
    expect(() => parseBackupArgs(["--restore-check"], { script: "backup-auth.mjs" })).toThrow(/Unknown option/);
  });

  it("takes a positive whole number for the document cap", () => {
    expect(parse("--max-documents", "500").maxDocuments).toBe(500);
    for (const bad of ["0", "-1", "abc", "1.5"]) expect(() => parse("--max-documents", bad)).toThrow(/positive whole number/);
    expect(() => parse("--max-documents")).toThrow(/positive whole number/);
  });
});

describe("where a backup may go", () => {
  it("accepts a new folder inside an existing one, outside the repository", () => {
    const dir = fresh();
    expect(assertSafeBackupDir(dir)).toBe(dir);
  });

  it("refuses a directory that already exists - never overwritten, never reused", () => {
    const dir = fresh();
    mkdirSync(dir);
    expect(() => assertSafeBackupDir(dir)).toThrow(/already exists/);
    writeFileSync(join(sandbox, "afile"), "x");
    expect(() => assertSafeBackupDir(join(sandbox, "afile"))).toThrow(/already exists/);
  });

  it("refuses a parent that does not exist rather than creating a tree", () => {
    expect(() => assertSafeBackupDir(join(sandbox, "nope", "deeper"))).toThrow(/does not exist/);
  });

  it("refuses anywhere inside the repository, so a backup can never be committed", () => {
    for (const inside of [join(REPO_ROOT, "backup-x"), join(REPO_ROOT, "docs", "backup-x"), REPO_ROOT]) {
      expect(() => assertSafeBackupDir(inside), inside).toThrow(BackupError);
    }
    expect(() => assertSafeBackupDir(join(REPO_ROOT, "backup-x"))).toThrow(/inside this repository/);
  });

  it("does not mistake a sibling folder that shares the repository's name prefix for the repository", () => {
    const repo = join(sandbox, "repo");
    mkdirSync(repo);
    const sibling = join(sandbox, "repo-backups");
    expect(assertSafeBackupDir(sibling, { repoRoot: repo })).toBe(sibling);
    expect(() => assertSafeBackupDir(join(repo, "b"), { repoRoot: repo })).toThrow(/inside this repository/);
  });

  it("creates the folder itself without recursion, so a second creation fails", () => {
    const dir = fresh();
    createBackupDir(dir);
    expect(() => createBackupDir(dir)).toThrow();
  });

  it("never overwrites a file inside a backup", () => {
    const dir = fresh();
    createBackupDir(dir);
    writeBackupFile(dir, "a/one.ndjson", "x\n");
    expect(() => writeBackupFile(dir, "a/one.ndjson", "y\n")).toThrow();
    expect(readFileSync(join(dir, "a/one.ndjson"), "utf8")).toBe("x\n");
  });

  it.skipIf(process.platform === "win32")("creates folders and files readable by the owner only", () => {
    const dir = fresh();
    createBackupDir(dir);
    writeBackupFile(dir, "a/one.ndjson", "x\n");
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(statSync(join(dir, "a")).mode & 0o077).toBe(0);
    expect(statSync(join(dir, "a/one.ndjson")).mode & 0o077).toBe(0);
  });
});

/** Builds a small valid backup by hand: two data files and a manifest. */
const makeBackup = () => {
  const dir = fresh();
  createBackupDir(dir);
  const a = `${JSON.stringify({ path: "users/a", data: {} })}\n${JSON.stringify({ path: "users/b", data: {} })}\n`;
  const b = `${JSON.stringify({ path: "fests/f", data: {} })}\n`;
  const fa = { path: "firestore/0001-fests.ndjson", collection: "fests", ...writeBackupFile(dir, "firestore/0001-fests.ndjson", b), records: 1 };
  const fb = { path: "firestore/0002-users.ndjson", collection: "users", ...writeBackupFile(dir, "firestore/0002-users.ndjson", a), records: 2 };
  const manifest = buildManifest({
    kind: "firestore",
    projectId: "demo-project",
    files: [fa, fb],
    totals: { collections: 2, documents: 3 },
    verification: { status: "verified", checkedAt: new Date().toISOString(), checks: [] },
  });
  writeManifest(dir, manifest);
  return { dir, manifest };
};
const validate = (record: unknown) => (typeof (record as { path?: unknown }).path === "string" ? [] : ["no path"]);

describe("the manifest", () => {
  it("carries the project, a timestamp, counts, SHA-256 of every file and the verification status", () => {
    const { dir, manifest } = makeBackup();
    const onDisk = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(onDisk).toMatchObject({ format: "plansphere-backup", version: 1, kind: "firestore", projectId: "demo-project", totals: { documents: 3 }, verification: { status: "verified" } });
    expect(Date.parse(onDisk.createdAt)).not.toBeNaN();
    for (const file of onDisk.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256Hex(readFileSync(join(dir, file.path), "utf8"))).toBe(file.sha256);
    }
    expect(onDisk.warnings.join(" ")).toMatch(/PERSONAL DATA/);
    expect(manifest.files).toHaveLength(2);
  });

  it("is hashed in a separate file, so editing it is noticed", () => {
    const { dir } = makeBackup();
    expect(readFileSync(join(dir, "MANIFEST.sha256"), "utf8").split(/\s+/)[0]).toBe(sha256Hex(readFileSync(join(dir, "manifest.json"), "utf8")));
  });

  it("refuses to be written if it would mention credential material", () => {
    const dir = fresh();
    createBackupDir(dir);
    for (const leak of ['"private_key": "x"', "-----BEGIN PRIVATE KEY-----", "client_email", "FIREBASE_SERVICE_ACCOUNT"]) {
      const bad = buildManifest({ kind: "auth", projectId: "p", files: [], totals: { note: leak }, verification: { status: "verified", checkedAt: "now", checks: [] } });
      expect(() => writeManifest(dir, bad), leak).toThrow(/credential material/);
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("offline verification notices every kind of change", () => {
  it("passes an untouched backup", () => {
    const { dir } = makeBackup();
    const r = verifyBackupFiles(dir, validate);
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  const fails = (dir: string, name: RegExp) => {
    const r = verifyBackupFiles(dir, validate);
    expect(r.ok).toBe(false);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name).join(" | ")).toMatch(name);
  };

  it("a changed byte in a data file", () => {
    const { dir } = makeBackup();
    const f = join(dir, "firestore/0002-users.ndjson");
    writeFileSync(f, readFileSync(f, "utf8").replace("users/a", "users/z"));
    fails(dir, /0002-users/);
  });

  it("a removed record", () => {
    const { dir } = makeBackup();
    const f = join(dir, "firestore/0002-users.ndjson");
    writeFileSync(f, readFileSync(f, "utf8").split("\n")[0] + "\n");
    fails(dir, /0002-users/);
  });

  it("a missing file", () => {
    const { dir } = makeBackup();
    rmSync(join(dir, "firestore/0001-fests.ndjson"));
    fails(dir, /0001-fests/);
  });

  it("an edited manifest (counts changed to match a tampered file)", () => {
    const { dir } = makeBackup();
    const m = join(dir, "manifest.json");
    writeFileSync(m, readFileSync(m, "utf8").replace('"documents": 3', '"documents": 2'));
    fails(dir, /manifest hash/);
  });

  it("a file that is not in the manifest", () => {
    const { dir } = makeBackup();
    writeFileSync(join(dir, "firestore", "stray.ndjson"), "{}\n");
    fails(dir, /unlisted/);
  });

  it("a record the validator rejects", () => {
    const { dir } = makeBackup();
    const r = verifyBackupFiles(dir, () => ["broken"]);
    expect(r.ok).toBe(false);
  });

  it("garbage instead of a manifest, and no manifest at all", () => {
    const { dir } = makeBackup();
    writeFileSync(join(dir, "manifest.json"), "not json");
    fails(dir, /manifest readable/);
    const empty = fresh();
    mkdirSync(empty);
    fails(empty, /manifest present/);
  });

  it("reports names and counts only, never the contents of a record", () => {
    const { dir } = makeBackup();
    const f = join(dir, "firestore/0002-users.ndjson");
    writeFileSync(f, `{"path":"users/a","data":{"secret":"PERSONAL-VALUE"}}\nnot json PERSONAL-VALUE\n`);
    const r = verifyBackupFiles(dir, validate);
    expect(JSON.stringify(r.checks)).not.toContain("PERSONAL-VALUE");
  });
});
