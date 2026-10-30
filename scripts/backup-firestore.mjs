/**
 * Billing-free logical backup of Firestore: every collection (root and sub, discovered live - including legacy ones the app no
 * longer names), every document, with Firestore types preserved. Read-only against Firebase. Free: a full read costs one read
 * per document against the free plan's 50,000 a day.
 *
 *   npm run backup:firestore                              # DRY RUN (the default): counts only, writes nothing
 *   npm run backup:firestore -- --write <new directory>   # writes the backup
 *   npm run backup:firestore -- --verify <directory>      # offline integrity check (hashes, counts, structure); no network
 *   npm run backup:firestore -- --verify <directory> --live            # ...and compare the counts with production (read-only)
 *   npm run backup:firestore -- --verify <directory> --restore-check   # restore into the EMULATOR and compare field by field
 *   (--max-documents <n> raises the safety cap, default 10,000)
 *
 * THE DIRECTORY must not exist (it is created, never reused or overwritten) and must be OUTSIDE this repository. It holds
 * PERSONAL DATA. Encrypt it before it leaves this machine; delete it when the rollout is verified (docs/BACKUP-WITHOUT-BILLING.md).
 *
 * --restore-check refuses to run unless FIRESTORE_EMULATOR_HOST is set: this tool has no way to write to production.
 *
 * What it does not do: it is not an atomic snapshot (a changing database is detected by comparing counts afterwards), it does
 * not back up rules, indexes, Auth (see backup-auth) or Supabase files, and it cannot write a whole-number double back as a
 * double (a restore makes it an integer; --restore-check reports exactly that).
 */

import { resolve } from "node:path";
import { BackupError, SENSITIVITY_WARNING, assertSafeBackupDir, exitWith, parseBackupArgs, printChecks } from "./lib/backup-common.mjs";
import {
  compareDumpToDatabase,
  compareLiveCounts,
  discoverCollections,
  openDatabase,
  readFirestoreDump,
  restoreIntoEmulator,
  verifyFirestoreBackup,
  writeFirestoreBackup,
} from "./lib/backup-firestore-core.mjs";
import { inspectServiceAccount } from "./lib/service-account.mjs";

const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

let openDb = null;
/** Close the connection before exiting, so the process ends cleanly instead of aborting inside the gRPC layer. */
const done = async (code) => {
  if (openDb) await openDb.terminate().catch(() => {});
  process.exit(code);
};

/** The Firestore handle, or exit with the cause. Production needs the service account; the emulator needs nothing. */
const connect = (fallbackProject) => {
  if (emulator) {
    const projectId = process.env.GCLOUD_PROJECT ?? fallbackProject ?? "plansphere-emulator";
    openDb = openDatabase(projectId);
    return { db: openDb, projectId, target: "the Firestore EMULATOR" };
  }
  const reading = inspectServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!reading.ok) throw new BackupError(`FIREBASE_SERVICE_ACCOUNT cannot be used (${reading.code}): ${reading.message}`);
  openDb = openDatabase(reading.projectId, reading.account);
  return { db: openDb, projectId: reading.projectId, target: `production project ${reading.projectId}` };
};

try {
  const args = parseBackupArgs(process.argv.slice(2), { script: "backup-firestore.mjs", allowRestoreCheck: true });

  /* ───── offline verification: nothing from Firebase ───── */
  if (args.mode === "verify" && !args.live && !args.restoreCheck) {
    const result = verifyFirestoreBackup(args.dir);
    console.log(`\n  Verifying ${resolve(args.dir)} (offline)\n`);
    printChecks(result.checks);
    if (result.manifest) console.log(`\n  ${result.manifest.totals.documents} document(s) in ${result.manifest.totals.collections} collection file(s), project ${result.manifest.projectId}, written ${result.manifest.createdAt}, recorded status: ${result.manifest.verification?.status}`);
    console.log(result.ok ? "\n  The backup is intact.\n" : "\n  The backup FAILED verification. Do not rely on it.\n");
    await done(result.ok ? 0 : 1);
  }

  /* ───── verification that talks to a database ───── */
  if (args.mode === "verify") {
    const offline = verifyFirestoreBackup(args.dir);
    console.log(`\n  Verifying ${resolve(args.dir)}\n`);
    printChecks(offline.checks);
    if (!offline.ok) {
      console.log("\n  The backup FAILED offline verification; not comparing further.\n");
      await done(1);
    }
    const { manifest } = readFirestoreDump(args.dir);

    if (args.restoreCheck) {
      if (!emulator) throw new BackupError("--restore-check runs only against the Firestore emulator (FIRESTORE_EMULATOR_HOST is not set). This tool never writes to production.");
      const { db } = connect(manifest.projectId);
      const restored = await restoreIntoEmulator(db, args.dir);
      const cmp = await compareDumpToDatabase(db, args.dir);
      console.log(`\n  Restored ${restored} document(s) into the emulator and compared ${cmp.compared} field by field.`);
      console.log(`  missing: ${cmp.missing.length}   extra: ${cmp.extra.length}   different: ${cmp.different.length}`);
      for (const d of cmp.different.slice(0, 10)) console.log(`    ${d.path.split("/")[0]}/${d.path.split("/")[1]?.slice(0, 6)}…  fields: ${d.fields.join(", ")}`);
      console.log(cmp.ok ? "\n  The backup restores exactly.\n" : "\n  The restore DIFFERS from the backup. See above.\n");
      await done(cmp.ok ? 0 : 1);
    }

    const { db, target } = connect(manifest.projectId);
    const live = await compareLiveCounts(db, args.dir);
    console.log(`\n  Compared the backup's counts with ${target} (read-only):`);
    for (const d of live.differences) console.log(`    ${d.collection}: backup ${d.backup}, live ${d.live}`);
    console.log(live.ok ? "  Every collection has the same number of documents.\n" : "\n  The live database has CHANGED since the backup (expected if the app has been used). Take a fresh backup before relying on it.\n");
    await done(live.ok ? 0 : 1);
  }

  /* ───── dry run and write ───── */
  const abs = args.mode === "write" ? assertSafeBackupDir(args.dir) : null;
  const { db, projectId, target } = connect();
  console.log(`\n  Source: ${target}   (read-only)${args.mode === "write" ? "" : "   DRY RUN - nothing will be written"}\n`);

  const plan = await discoverCollections(db, { maxDocuments: args.maxDocuments });
  const documents = plan.reduce((sum, c) => sum + c.documents, 0);
  for (const c of plan) console.log(`  ${c.path.padEnd(34)} ${String(c.documents).padStart(6)} document(s)${c.depth ? "   (subcollection)" : ""}`);
  console.log(`\n  ${plan.length} collection(s), ${documents} document(s). A full read costs about ${documents} read(s) against the free plan's 50,000 a day.`);

  if (args.mode !== "write") {
    console.log(`\n  ${SENSITIVITY_WARNING}\n`);
    console.log("  Dry run: nothing was written. To write the backup, choose a NEW folder OUTSIDE this repository:");
    console.log("    npm run backup:firestore -- --write C:\\plansphere-backups\\firestore-<date>\n");
    await done(0);
  }

  const manifest = await writeFirestoreBackup(db, abs, { projectId, maxDocuments: args.maxDocuments });
  console.log("");
  printChecks(manifest.verification.checks);
  console.log(`\n  Wrote ${manifest.totals.documents} document(s) in ${manifest.totals.collections} file(s) to ${abs}`);
  console.log(`  Verification: ${manifest.verification.status.toUpperCase()}`);
  console.log(`\n  ${SENSITIVITY_WARNING}\n`);
  console.log(`  Next: npm run backup:firestore -- --verify "${abs}"   (offline integrity check)`);
  console.log("  Then prove it restores, on the emulator:  see docs/BACKUP-WITHOUT-BILLING.md\n");
  await done(manifest.verification.status === "verified" ? 0 : 1);
} catch (error) {
  if (openDb) await openDb.terminate().catch(() => {});
  exitWith(error);
}
