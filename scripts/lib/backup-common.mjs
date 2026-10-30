/**
 * What the two backup scripts share: the command line, the rules for where a backup may go, how files and the manifest are
 * written, and the offline integrity check.
 *
 *   (no flag)                 DRY RUN. Connects read-only, prints counts, writes nothing.
 *   --write <new directory>   Writes the backup. The directory must NOT exist (it is created, never reused), must be OUTSIDE
 *                             this repository, and its files are created readable by the owner only.
 *   --verify <directory>      Offline integrity check of a backup that already exists: hashes, counts, structure. Reads nothing
 *                             from Firebase. Add --live to also compare the counts with production (read-only).
 *
 * A backup holds PERSONAL DATA (and, for Auth, password hashes). See docs/BACKUP-WITHOUT-BILLING.md for encryption and retention.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const FORMAT = "plansphere-backup";
export const VERSION = 1;
export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_HASH_FILE = "MANIFEST.sha256";

export const SENSITIVITY_WARNING =
  "THIS BACKUP CONTAINS PERSONAL DATA (names, e-mail addresses, phone numbers, registrations) and, for Auth, password hashes and salts. " +
  "Keep it off Git and off shared drives, encrypt it before it leaves this machine, and delete it when the rollout is verified.";

export class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupError";
  }
}

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/* ───────────── command line ───────────── */

/**
 * @param {string[]} argv
 * @param {{ script: string, allowRestoreCheck?: boolean, defaultMaxDocuments?: number }} options
 */
export const parseBackupArgs = (argv, { script, allowRestoreCheck = false, defaultMaxDocuments = 10_000 }) => {
  const known = new Set(["--write", "--verify", "--live", "--max-documents", ...(allowRestoreCheck ? ["--restore-check"] : [])]);
  const valueOf = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? null : argv[at + 1] ?? "";
  };
  const isValue = (v) => v !== null && v !== "" && !v.startsWith("--");
  for (const arg of argv) {
    if (arg.startsWith("--") && !known.has(arg)) throw new BackupError(`Unknown option ${arg}. See the header of scripts/${script}.`);
  }
  const writeDir = valueOf("--write");
  const verifyDir = valueOf("--verify");
  if (argv.includes("--write") && !isValue(writeDir)) throw new BackupError("--write needs a NEW directory name (it must not exist).");
  if (argv.includes("--verify") && !isValue(verifyDir)) throw new BackupError("--verify needs the backup directory to check.");
  if (argv.includes("--write") && argv.includes("--verify")) throw new BackupError("--write and --verify cannot be combined.");
  if ((argv.includes("--live") || argv.includes("--restore-check")) && !argv.includes("--verify")) throw new BackupError("--live and --restore-check only apply to --verify <directory>.");
  if (argv.includes("--live") && argv.includes("--restore-check")) throw new BackupError("Pick one of --live (compare with production) and --restore-check (restore into the emulator).");
  const rawMax = valueOf("--max-documents");
  let maxDocuments = defaultMaxDocuments;
  if (argv.includes("--max-documents")) {
    if (!isValue(rawMax) || !/^\d+$/.test(rawMax) || Number(rawMax) < 1) throw new BackupError("--max-documents needs a positive whole number.");
    maxDocuments = Number(rawMax);
  }
  return {
    mode: isValue(writeDir) ? "write" : isValue(verifyDir) ? "verify" : "dry-run",
    dir: isValue(writeDir) ? writeDir : isValue(verifyDir) ? verifyDir : null,
    live: argv.includes("--live"),
    restoreCheck: argv.includes("--restore-check"),
    maxDocuments,
  };
};

/* ───────────── where a backup may go ───────────── */

/**
 * The absolute path a new backup will be created at. It must not exist, must be created inside an existing directory, and must
 * be outside this repository so it can never be committed.
 */
export const assertSafeBackupDir = (dir, { repoRoot = REPO_ROOT } = {}) => {
  const abs = resolve(String(dir));
  if (existsSync(abs)) throw new BackupError(`${abs} already exists. A backup is created in a NEW directory and never overwrites or reuses one.`);
  const parent = dirname(abs);
  if (!existsSync(parent)) throw new BackupError(`${parent} does not exist. Create the parent folder first; only the backup folder itself is created.`);
  const inside = relative(repoRoot, abs);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    throw new BackupError(`${abs} is inside this repository. Backups hold personal data and must live OUTSIDE it (for example C:\\plansphere-backups\\<date>).`);
  }
  return abs;
};

export const createBackupDir = (abs) => {
  mkdirSync(abs, { mode: 0o700 }); // not recursive: fails if it exists, so two runs can never share a directory
  return abs;
};

/** Creates `rel` (and its folder) under `abs` readable by the owner only; refuses to overwrite. Returns hash and size. */
export const writeBackupFile = (abs, rel, text) => {
  const target = join(abs, rel);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, text, { flag: "wx", mode: 0o600 });
  try {
    chmodSync(target, 0o600);
  } catch {
    // Not supported on every platform (Windows relies on the folder's permissions).
  }
  const bytes = Buffer.byteLength(text, "utf8");
  return { sha256: sha256Hex(text), bytes };
};

/* ───────────── manifest ───────────── */

// Nothing that could be a credential is ever allowed into a manifest.
const FORBIDDEN_IN_MANIFEST = /private_key|BEGIN [A-Z ]*PRIVATE KEY|client_email|service_account|FIREBASE_SERVICE_ACCOUNT|SERVICE_ROLE/i;

export const writeManifest = (abs, manifest) => {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (FORBIDDEN_IN_MANIFEST.test(text)) throw new BackupError("Refusing to write a manifest that mentions credential material.");
  writeBackupFile(abs, MANIFEST_FILE, text);
  writeBackupFile(abs, MANIFEST_HASH_FILE, `${sha256Hex(text)}  ${MANIFEST_FILE}\n`);
  return sha256Hex(text);
};

export const buildManifest = ({ kind, projectId, files, totals, verification, extra = {} }) => ({
  format: FORMAT,
  version: VERSION,
  kind,
  projectId,
  createdAt: new Date().toISOString(),
  tool: kind === "firestore" ? "scripts/backup-firestore.mjs" : "scripts/backup-auth.mjs",
  files,
  totals,
  verification,
  warnings: [SENSITIVITY_WARNING, "The manifest lists counts and SHA-256 hashes only. No credential of any kind is stored here."],
  ...extra,
});

/* ───────────── offline verification ───────────── */

/**
 * The per-file half of the integrity check: each listed file exists, hashes to what was recorded, holds exactly the recorded
 * number of records, and every record is well formed. Used after writing (before the manifest exists) and by --verify.
 */
export const checkFiles = (abs, files, validateRecord) => {
  const checks = [];
  for (const file of files) {
    const target = join(abs, file.path);
    if (!existsSync(target)) {
      checks.push({ name: `file ${file.path}`, ok: false, detail: "missing" });
      continue;
    }
    const text = readFileSync(target, "utf8");
    const hashOk = sha256Hex(text) === file.sha256;
    const lines = text.split("\n").filter(Boolean);
    const problems = [];
    let parsed = 0;
    lines.forEach((line, index) => {
      try {
        const record = JSON.parse(line);
        parsed += 1;
        for (const p of validateRecord(record, file)) problems.push(`line ${index + 1}: ${p}`);
      } catch {
        problems.push(`line ${index + 1}: not valid JSON`);
      }
    });
    const countOk = lines.length === file.records && parsed === file.records;
    checks.push({
      name: `file ${file.path}`,
      ok: hashOk && countOk && problems.length === 0,
      ...(hashOk && countOk && problems.length === 0
        ? {}
        : { detail: [!hashOk && "SHA-256 differs from the manifest", !countOk && `${lines.length} record(s) but the manifest says ${file.records}`, ...problems.slice(0, 5)].filter(Boolean).join("; ") }),
    });
  }
  return checks;
};

/**
 * Integrity of an existing backup directory, with no network and no SDK.
 * @param {string} dir
 * @param {(record: any, file: any) => string[]} validateRecord  problems for one parsed line (never values)
 */
export const verifyBackupFiles = (dir, validateRecord) => {
  const abs = resolve(String(dir));
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  const manifestPath = join(abs, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    add("manifest present", false, `${MANIFEST_FILE} not found in ${abs}`);
    return { ok: false, checks, manifest: null };
  }
  const manifestText = readFileSync(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    add("manifest readable", false, "manifest.json is not valid JSON");
    return { ok: false, checks, manifest: null };
  }
  add("manifest readable", manifest?.format === FORMAT && manifest?.version === VERSION && Array.isArray(manifest?.files), manifest?.format === FORMAT ? undefined : "not a Plansphere backup manifest");

  const hashPath = join(abs, MANIFEST_HASH_FILE);
  const recorded = existsSync(hashPath) ? readFileSync(hashPath, "utf8").split(/\s+/)[0] : null;
  add("manifest hash matches MANIFEST.sha256", recorded === sha256Hex(manifestText), recorded ? undefined : `${MANIFEST_HASH_FILE} missing`);
  add("manifest holds no credential material", !FORBIDDEN_IN_MANIFEST.test(manifestText));

  const listed = new Set([MANIFEST_FILE, MANIFEST_HASH_FILE]);
  for (const file of manifest.files ?? []) listed.add(file.path.split("\\").join("/"));
  checks.push(...checkFiles(abs, manifest.files ?? [], validateRecord));

  const present = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else present.push(relative(abs, full).split(sep).join("/"));
    }
  };
  walk(abs);
  const unlisted = present.filter((p) => !listed.has(p));
  add("no unlisted files", unlisted.length === 0, unlisted.length ? `${unlisted.length} file(s) not in the manifest` : undefined);

  return { ok: checks.every((c) => c.ok), checks, manifest };
};

export const printChecks = (checks) => {
  for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? ` - ${c.detail}` : ""}`);
};

export const exitWith = (error) => {
  console.error(`\n  ${error instanceof BackupError ? error.message : `Failed: ${error instanceof Error ? error.message : "unknown error"}`}\n`);
  process.exit(1);
};
