/**
 * Billing-free backup of Firebase Auth: every account with its password hash, salt, custom claims, providers and flags,
 * through the Admin SDK (the CLI export can omit claims and cannot be scripted into a manifest). Read-only against Firebase.
 *
 *   npm run backup:auth                              # DRY RUN (the default): counts only, writes nothing
 *   npm run backup:auth -- --write <new directory>   # writes the backup
 *   npm run backup:auth -- --verify <directory>      # offline integrity check; no network
 *   npm run backup:auth -- --verify <directory> --live   # ...and compare the accounts with production (read-only)
 *
 * THE DIRECTORY must not exist and must be OUTSIDE this repository. It holds PASSWORD HASHES AND SALTS and personal data:
 * encrypt it before it leaves this machine and delete it when the rollout is verified (docs/BACKUP-WITHOUT-BILLING.md).
 * The project's password-hash parameters are not readable through the Admin SDK and are NOT in the backup; a restore needs them
 * from the Firebase console.
 */

import { resolve } from "node:path";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { BackupError, SENSITIVITY_WARNING, assertSafeBackupDir, exitWith, parseBackupArgs, printChecks } from "./lib/backup-common.mjs";
import { collectAuthUsers, compareLiveAuth, readAuthDump, summarizeAuthUsers, verifyAuthBackup, writeAuthBackup } from "./lib/backup-auth-core.mjs";
import { inspectServiceAccount } from "./lib/service-account.mjs";

const emulator = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);

/** Delete the app before exiting, so the process ends cleanly. */
const done = async (code) => {
  for (const app of getApps()) await app.delete().catch(() => {});
  process.exit(code);
};

const connect = () => {
  if (emulator) {
    const projectId = process.env.GCLOUD_PROJECT ?? "plansphere-emulator";
    if (!getApps().length) initializeApp({ projectId });
    return { auth: getAuth(), projectId, target: "the Auth EMULATOR" };
  }
  const reading = inspectServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!reading.ok) throw new BackupError(`FIREBASE_SERVICE_ACCOUNT cannot be used (${reading.code}): ${reading.message}`);
  if (!getApps().length) {
    initializeApp({ credential: cert({ projectId: reading.projectId, clientEmail: reading.account.client_email, privateKey: reading.account.private_key }), projectId: reading.projectId });
  }
  return { auth: getAuth(), projectId: reading.projectId, target: `production project ${reading.projectId}` };
};

try {
  const args = parseBackupArgs(process.argv.slice(2), { script: "backup-auth.mjs" });

  if (args.mode === "verify" && !args.live) {
    const result = verifyAuthBackup(args.dir);
    console.log(`\n  Verifying ${resolve(args.dir)} (offline)\n`);
    printChecks(result.checks);
    if (result.manifest) console.log(`\n  ${result.manifest.totals.users} account(s), project ${result.manifest.projectId}, written ${result.manifest.createdAt}, recorded status: ${result.manifest.verification?.status}`);
    console.log(result.ok ? "\n  The backup is intact.\n" : "\n  The backup FAILED verification. Do not rely on it.\n");
    await done(result.ok ? 0 : 1);
  }

  if (args.mode === "verify") {
    const offline = verifyAuthBackup(args.dir);
    console.log(`\n  Verifying ${resolve(args.dir)}\n`);
    printChecks(offline.checks);
    if (!offline.ok) {
      console.log("\n  The backup FAILED offline verification; not comparing further.\n");
      await done(1);
    }
    const { auth, target } = connect();
    const live = await compareLiveAuth(auth, args.dir);
    console.log(`\n  Compared with ${target} (read-only): backup ${live.backup} account(s), live ${live.live}; in live but not in the backup: ${live.missingFromBackup}; in the backup but gone from live: ${live.goneFromLive}`);
    console.log(live.ok ? "  The same accounts.\n" : "\n  The accounts have CHANGED since the backup. Take a fresh backup before relying on it.\n");
    await done(live.ok ? 0 : 1);
  }

  const abs = args.mode === "write" ? assertSafeBackupDir(args.dir) : null;
  const { auth, projectId, target } = connect();
  console.log(`\n  Source: ${target}   (read-only)${args.mode === "write" ? "" : "   DRY RUN - nothing will be written"}\n`);

  const summary = summarizeAuthUsers(await collectAuthUsers(auth));
  console.log(`  accounts                ${summary.users}`);
  console.log(`  with password hash      ${summary.withPasswordHash}`);
  console.log(`  with password salt      ${summary.withPasswordSalt}`);
  console.log(`  with custom claims      ${summary.withCustomClaims}`);
  console.log(`  disabled                ${summary.disabled}`);
  console.log(`  with a second factor    ${summary.withMultiFactor}`);
  console.log(`  providers               ${Object.entries(summary.providers).map(([p, n]) => `${p}=${n}`).join("  ") || "-"}`);

  if (args.mode !== "write") {
    console.log(`\n  ${SENSITIVITY_WARNING}\n`);
    console.log("  Dry run: nothing was written. To write the backup, choose a NEW folder OUTSIDE this repository:");
    console.log("    npm run backup:auth -- --write C:\\plansphere-backups\\auth-<date>\n");
    await done(0);
  }

  const manifest = await writeAuthBackup(auth, abs, { projectId });
  console.log("");
  printChecks(manifest.verification.checks);
  console.log(`\n  Wrote ${manifest.totals.users} account(s) to ${abs}`);
  console.log(`  Verification: ${manifest.verification.status.toUpperCase()}`);
  console.log(`\n  ${SENSITIVITY_WARNING}\n`);
  console.log(`  Next: npm run backup:auth -- --verify "${abs}"\n`);
  const { users } = readAuthDump(abs);
  if (users.length !== manifest.totals.users) throw new BackupError("The written file does not hold the number of accounts the manifest records.");
  await done(manifest.verification.status === "verified" ? 0 : 1);
} catch (error) {
  exitWith(error);
}
