/**
 * The Firebase Auth half of the billing-free backup. Reads every account through the Admin SDK, which (unlike the CLI export)
 * returns the password hash, the salt AND the custom claims. Writes two files:
 *
 *   auth/users.ndjson              one account per line, exactly as the Admin SDK reports it (`UserRecord.toJSON()`)
 *   auth/firebase-auth-import.json the same accounts in the format `firebase auth:import` reads, so a restore needs no new code
 *
 * Both contain PASSWORD HASHES and SALTS. They are credentials-equivalent: whoever holds them can attack the passwords offline.
 * No service-account credential or API key is ever written.
 *
 * Not recoverable from the Admin SDK, so not in the backup: the project's password-hash PARAMETERS (rounds, memory cost,
 * signer key, salt separator). A restore needs them from the Firebase console (Authentication -> Users -> menu ->
 * "Password hash parameters"); see docs/BACKUP-WITHOUT-BILLING.md.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BackupError, buildManifest, checkFiles, createBackupDir, verifyBackupFiles, writeBackupFile, writeManifest } from "./backup-common.mjs";

/* ───────────── serialization ───────────── */

/**
 * One account as plain JSON. Takes `toJSON()` verbatim, so nothing the SDK reports is dropped, then proves it is JSON-safe.
 * @param {{ toJSON: () => object }} user  a UserRecord
 */
export const serializeAuthUser = (user) => {
  const json = typeof user.toJSON === "function" ? user.toJSON() : user;
  if (!json || typeof json.uid !== "string" || !json.uid) throw new Error("an Auth record without a uid cannot be backed up");
  // A round trip through JSON both strips undefined and proves nothing exotic (a Buffer, a class) slipped in.
  return JSON.parse(JSON.stringify(json));
};

/** Web-safe base64 (what the Admin SDK reports for hashes and salts) to the standard base64 the CLI import file uses. */
export const toStandardBase64 = (value) => {
  if (typeof value !== "string" || value === "") return undefined;
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  return standard + "=".repeat((4 - (standard.length % 4)) % 4);
};

const millis = (text) => {
  const t = Date.parse(text ?? "");
  return Number.isNaN(t) ? undefined : t;
};

/**
 * One account in the format `firebase auth:import` reads (JSON). Fields that are absent are left out.
 * @param {ReturnType<typeof serializeAuthUser>} u
 */
export const toCliImportRecord = (u) => {
  const claims = u.customClaims && Object.keys(u.customClaims).length ? JSON.stringify(u.customClaims) : undefined;
  const providers = (u.providerData ?? [])
    .filter((p) => p.providerId !== "password" && p.providerId !== "phone")
    .map((p) => ({ providerId: p.providerId, rawId: p.uid, email: p.email, displayName: p.displayName, photoUrl: p.photoURL }));
  const record = {
    localId: u.uid,
    email: u.email,
    emailVerified: u.emailVerified,
    passwordHash: toStandardBase64(u.passwordHash),
    salt: toStandardBase64(u.passwordSalt),
    displayName: u.displayName,
    photoUrl: u.photoURL,
    phoneNumber: u.phoneNumber,
    disabled: u.disabled,
    createdAt: millis(u.metadata?.creationTime),
    lastSignedInAt: millis(u.metadata?.lastSignInTime),
    customAttributes: claims,
    providerUserInfo: providers.length ? providers : undefined,
  };
  return JSON.parse(JSON.stringify(record));
};

/** Counts that describe the accounts without exposing any of them. */
export const summarizeAuthUsers = (users) => {
  const providers = {};
  for (const u of users) for (const p of u.providerData ?? []) providers[p.providerId] = (providers[p.providerId] ?? 0) + 1;
  return {
    users: users.length,
    withPasswordHash: users.filter((u) => u.passwordHash).length,
    withPasswordSalt: users.filter((u) => u.passwordSalt).length,
    withCustomClaims: users.filter((u) => u.customClaims && Object.keys(u.customClaims).length).length,
    disabled: users.filter((u) => u.disabled).length,
    withMultiFactor: users.filter((u) => (u.multiFactor?.enrolledFactors ?? []).length).length,
    providers,
  };
};

/* ───────────── reading ───────────── */

/** Every account, sorted by uid. */
export const collectAuthUsers = async (auth) => {
  const users = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) users.push(serializeAuthUser(user));
    pageToken = page.pageToken;
  } while (pageToken);
  return users.sort((a, b) => a.uid.localeCompare(b.uid));
};

/* ───────────── validation ───────────── */

export const validateAuthRecord = (record, file) => {
  if (!record || typeof record !== "object") return ["not an object"];
  if (file.role === "cli-import") {
    if (!Array.isArray(record.users)) return ["no users array"];
    const problems = [];
    if (record.users.length !== file.users) problems.push(`${record.users.length} user(s) but the manifest says ${file.users}`);
    if (record.users.some((u) => typeof u?.localId !== "string")) problems.push("a user has no localId");
    return problems;
  }
  const problems = [];
  if (typeof record.uid !== "string" || !record.uid) problems.push("no uid");
  if (record.customClaims !== undefined && (record.customClaims === null || typeof record.customClaims !== "object" || Array.isArray(record.customClaims))) problems.push("customClaims is not an object");
  if (record.providerData !== undefined && !Array.isArray(record.providerData)) problems.push("providerData is not an array");
  if (record.passwordHash !== undefined && typeof record.passwordHash !== "string") problems.push("passwordHash is not a string");
  return problems;
};

/* ───────────── writing ───────────── */

export const writeAuthBackup = async (auth, abs, { projectId }) => {
  const users = await collectAuthUsers(auth);
  createBackupDir(abs);

  const ndjson = users.length ? `${users.map((u) => JSON.stringify(u)).join("\n")}\n` : "";
  const importFile = `${JSON.stringify({ users: users.map(toCliImportRecord) })}\n`;
  const a = writeBackupFile(abs, "auth/users.ndjson", ndjson);
  const b = writeBackupFile(abs, "auth/firebase-auth-import.json", importFile);
  const files = [
    { path: "auth/users.ndjson", role: "records", ...a, records: users.length },
    { path: "auth/firebase-auth-import.json", role: "cli-import", ...b, records: 1, users: users.length },
  ];

  const checks = checkFiles(abs, files, validateAuthRecord);
  const after = await collectAuthUsers(auth);
  const sameSet = after.length === users.length && after.every((u, i) => u.uid === users[i].uid);
  checks.push({ name: "live accounts equal the accounts written", ok: sameSet, ...(sameSet ? {} : { detail: `${users.length} written, ${after.length} now` }) });

  const ok = checks.every((c) => c.ok);
  const manifest = buildManifest({
    kind: "auth",
    projectId,
    files,
    totals: summarizeAuthUsers(users),
    verification: { status: ok ? "verified" : "failed", checkedAt: new Date().toISOString(), checks },
    extra: {
      restore: [
        "firebase auth:import auth/firebase-auth-import.json --hash-algo=SCRYPT --hash-key=<signer key> --salt-separator=<separator> --rounds=<rounds> --mem-cost=<memory cost> --project <project>",
        "The hash parameters are NOT in this backup; read them from the Firebase console (Authentication -> Users -> menu -> Password hash parameters).",
        "Accounts with the same UID are overwritten. Active sessions are not restored; custom claims are (customAttributes).",
      ],
    },
  });
  writeManifest(abs, manifest);
  return manifest;
};

/* ───────────── verification ───────────── */

export const verifyAuthBackup = (dir) => {
  const result = verifyBackupFiles(dir, validateAuthRecord);
  // The two files must describe the same accounts.
  try {
    const records = readFileSync(join(dir, "auth/users.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).uid);
    const imported = JSON.parse(readFileSync(join(dir, "auth/firebase-auth-import.json"), "utf8")).users.map((u) => u.localId);
    const same = records.length === imported.length && records.every((uid, i) => uid === imported[i]);
    result.checks.push({ name: "users.ndjson and the CLI import file list the same accounts", ok: same });
    result.ok = result.ok && same;
  } catch {
    result.checks.push({ name: "users.ndjson and the CLI import file list the same accounts", ok: false, detail: "could not read both files" });
    result.ok = false;
  }
  return result;
};

export const readAuthDump = (dir) => ({
  manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
  users: readFileSync(join(dir, "auth/users.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
});

/** Compares the backup with the live accounts (read-only). Counts and uid membership only. */
export const compareLiveAuth = async (auth, dir) => {
  const { users } = readAuthDump(dir);
  const live = await collectAuthUsers(auth);
  const have = new Set(users.map((u) => u.uid));
  const now = new Set(live.map((u) => u.uid));
  const missingFromBackup = [...now].filter((uid) => !have.has(uid)).length;
  const goneFromLive = [...have].filter((uid) => !now.has(uid)).length;
  return { ok: missingFromBackup === 0 && goneFromLive === 0, backup: users.length, live: live.length, missingFromBackup, goneFromLive };
};

export { BackupError };
