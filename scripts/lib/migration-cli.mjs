/**
 * The command-line contract every data-changing script follows, so that "what does this do if I just run it?" has one answer:
 *
 *   (no flag)                    DRY RUN. Reads, prints the plan, writes nothing, exits 0.
 *   --apply --backup <file>      Makes the change. The prior state of everything it will touch is appended to <file> BEFORE
 *                                each change; an existing <file> is refused, so an earlier backup is never overwritten.
 *   --restore <file> [--apply]   Recovery from a backup: a dry run unless --apply, and it touches only what the migration
 *                                wrote and nobody has changed since.
 *   --dry-run                    Accepted for the old muscle memory; it is what happens anyway. Combining it with --apply is
 *                                refused rather than guessed at.
 *
 * Until Phase 7 `migrate:rbac` and `migrate:fests` did the opposite - they applied unless given `--dry-run`, and wrote no backup.
 */

import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";

const fail = (message) => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @param {{ script: string, extraFlags?: string[] }} options
 */
export const parseMigrationArgs = (argv, { script, extraFlags = [] }) => {
  const known = new Set(["--apply", "--dry-run", "--backup", "--restore", ...extraFlags]);
  const valueOf = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? null : argv[at + 1] ?? "";
  };
  for (const arg of argv) {
    if (arg.startsWith("--") && !known.has(arg)) fail(`Unknown option ${arg}. See the header of scripts/${script}.`);
  }

  const apply = argv.includes("--apply");
  if (apply && argv.includes("--dry-run")) fail("--apply and --dry-run contradict each other. Pass one.");

  const backupPath = valueOf("--backup");
  const restorePath = valueOf("--restore");
  const present = (v) => v !== null && v !== "" && !v.startsWith("--");

  if (argv.includes("--restore") && !present(restorePath)) fail("--restore needs the backup file written by an earlier --apply run.");
  if (argv.includes("--backup") && !present(backupPath)) fail("--backup needs a file name.");
  if (restorePath && backupPath) fail("--restore cannot be combined with --backup.");
  if (restorePath && !existsSync(restorePath)) fail(`${restorePath} does not exist.`);

  if (apply && !restorePath) {
    if (!present(backupPath)) fail("--apply needs --backup <file.json>: the prior state of everything it changes is written there first.");
    if (existsSync(backupPath)) fail(`${backupPath} already exists. Pick a new file so an earlier backup is never overwritten.`);
  }
  if (!apply && backupPath && !restorePath) {
    // A backup name on a dry run is harmless, but it usually means the person thinks they are applying. Say so.
    console.log("\n  Note: --backup is only used with --apply. This is a dry run; nothing will be written.\n");
  }

  return { apply, dryRun: !apply, backupPath: present(backupPath) ? backupPath : null, restorePath: present(restorePath) ? restorePath : null };
};

/** Appends one JSON line to the backup, readable by the owner only. */
export const appendBackupLine = (path, entry) => {
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not supported on every platform.
  }
};

/** Every line of a backup file as an object; a damaged line is reported, never skipped silently. */
export const readBackupLines = (path) => {
  const lines = [];
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .forEach((text, index) => {
      try {
        lines.push(JSON.parse(text));
      } catch {
        fail(`${path} line ${index + 1} is not valid JSON; refusing to restore from a damaged backup.`);
      }
    });
  return lines;
};

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value ?? null;

/** Two JSON-able values are the same value (object key order does not matter; array order does). */
export const sameValue = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
