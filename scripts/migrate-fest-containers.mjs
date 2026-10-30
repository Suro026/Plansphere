/**
 * Backfills the fest container fields added with the super admin module.
 *
 *   npm run migrate:fests                                     # DRY RUN (the default): reports, writes nothing
 *   npm run migrate:fests -- --apply --backup <file.json>     # make the change
 *   npm run migrate:fests -- --restore <file.json> [--apply]  # recovery: remove what --apply added (dry run without --apply)
 *   (add --with-fields to also write the default registration fields; see below)
 *
 * What it sets, per fest, only where the field is missing:
 *   festType            "other" — the kind of fest is a decision, not a guess
 *   visibility          "public" — how every existing fest already behaved
 *   registrationState   "open" for a fest that has not ended, "closed" after
 *   ownerId             from `createdBy`, which is who has been running it
 *   registrationFields  only with --with-fields: writing the default set onto
 *                       a live fest makes phone and college required from
 *                       that moment, which is the owner's call, not a
 *                       migration's
 *   academicYear        derived from the start date (an Indian session runs
 *                       June–May, so January–May belongs to the year before)
 *
 * Nothing is overwritten and nothing is deleted: a fest that already carries
 * a field keeps whatever it says. Idempotent — the second run reports zero.
 *
 * SAFETY. A dry run unless --apply, and --apply needs --backup (until Phase 7 this script applied by default). The backup
 * lists, per fest, the fields and values it added. After writing, every changed fest is read back and compared; a mismatch
 * is reported and the exit code is 1. --restore removes exactly those fields, and only where the fest still holds the value
 * the migration wrote (a field the owner has since changed is kept and reported).
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { appendBackupLine, parseMigrationArgs, readBackupLines, sameValue } from "./lib/migration-cli.mjs";
import { loadServiceAccountOrExit } from "./lib/service-account.mjs";

const { apply, dryRun, backupPath, restorePath } = parseMigrationArgs(process.argv.slice(2), { script: "migrate-fest-containers.mjs", extraFlags: ["--with-fields"] });
const withFields = process.argv.includes("--with-fields");

const account = loadServiceAccountOrExit(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!getApps().length) {
  initializeApp({
    credential: cert({ projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key }),
    projectId: account.project_id,
  });
}

const db = getFirestore();

/** The same default set the app ships, kept in step by hand — scripts cannot import TS. */
const DEFAULT_REGISTRATION_FIELDS = {
  builtIn: {
    fullName: "required",
    email: "required",
    phone: "required",
    college: "required",
    department: "optional",
    year: "optional",
    gender: "hidden",
    rollNumber: "hidden",
    city: "hidden",
    github: "hidden",
    linkedin: "hidden",
    resume: "hidden",
  },
  custom: [],
};

/** "2025-26" from a start date, on a June–May academic session. */
const academicYearFor = (startDate) => {
  const match = /^(\d{4})-(\d{2})/.exec(String(startDate ?? ""));
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const start = month >= 6 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
};

console.log(`\n  Project: ${account.project_id}${restorePath ? (apply ? "   (RESTORE)" : "   (restore dry run - add --apply to make the changes)") : dryRun ? "   (dry run — nothing will be written; pass --apply --backup <file> to make the change)" : ""}\n`);

/* ───────────── recovery: undo a previous --apply ───────────── */

if (restorePath) {
  const entries = readBackupLines(restorePath);
  const counts = { removed: 0, kept: 0, gone: 0 };
  for (const entry of entries) {
    const ref = db.collection("fests").doc(String(entry.festId));
    const snap = await ref.get();
    if (!snap.exists) {
      counts.gone += 1;
      continue;
    }
    const current = snap.data();
    const removable = Object.keys(entry.added ?? {}).filter((key) => sameValue(current[key], entry.added[key]));
    const edited = Object.keys(entry.added ?? {}).filter((key) => !removable.includes(key) && current[key] !== undefined);
    if (edited.length) console.log(`  kept (changed since the migration): ${entry.festId}  ${edited.join(", ")}`);
    counts.kept += edited.length;
    if (removable.length === 0) continue;
    console.log(`  ${String(current.name ?? entry.festId).padEnd(28)} - ${removable.join(", ")}`);
    if (apply) await ref.update(Object.fromEntries(removable.map((key) => [key, FieldValue.delete()])));
    counts.removed += removable.length;
  }
  console.log(`\n  fields ${apply ? "removed" : "to remove"} : ${counts.removed}\n  kept (edited)   : ${counts.kept}\n  fests gone      : ${counts.gone}\n`);
  if (!apply) console.log("  Dry run: nothing was changed. Re-run with --apply to restore.\n");
  process.exit(0);
}

const snapshot = await db.collection("fests").get();
console.log(`  ${snapshot.size} fest(s)\n`);

const today = new Date().toISOString().slice(0, 10);
const summary = { migrated: 0, unchanged: 0, failed: 0 };

for (const doc of snapshot.docs) {
  const data = doc.data();
  const next = {};

  if (data.festType === undefined) next.festType = "other";
  if (data.visibility === undefined) next.visibility = "public";
  if (data.registrationState === undefined) {
    next.registrationState = String(data.endDate ?? "") >= today ? "open" : "closed";
  }
  if (data.ownerId === undefined && data.createdBy) next.ownerId = data.createdBy;
  // Deliberately NOT backfilled unless asked for with --with-fields.
  //
  // Writing the default set onto a fest that is already taking registrations
  // makes phone and college required from that moment, and a student halfway
  // through the form gets an error about a question they were never asked.
  // An unconfigured fest asks nothing, exactly as it did before the feature;
  // the owner turns the questions on from Settings when they want them.
  if (withFields && data.registrationFields === undefined) next.registrationFields = DEFAULT_REGISTRATION_FIELDS;
  if (data.academicYear === undefined) {
    const year = academicYearFor(data.startDate);
    if (year) next.academicYear = year;
  }

  if (Object.keys(next).length === 0) {
    summary.unchanged += 1;
    continue;
  }

  console.log(`  ${String(data.name ?? doc.id).padEnd(28)} + ${Object.keys(next).join(", ")}`);

  if (!dryRun) {
    try {
      // The backup line goes to disk first, so a stop part-way can always be undone for the fests already changed.
      appendBackupLine(backupPath, { festId: doc.id, added: next });
      await doc.ref.set({ ...next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      // Read it back: what is now stored must be what was meant to be written.
      const after = (await doc.ref.get()).data() ?? {};
      const wrong = Object.keys(next).filter((key) => !sameValue(after[key], next[key]));
      if (wrong.length) {
        summary.failed += 1;
        console.error(`    FAILED read-back: ${doc.id} ${wrong.join(", ")}`);
      } else {
        summary.migrated += 1;
      }
    } catch (error) {
      summary.failed += 1;
      console.error(`    failed: ${error.message}`);
    }
  } else {
    summary.migrated += 1;
  }
}

console.log(`
  fests ${dryRun ? "to migrate" : "migrated"}${dryRun ? "  " : "   "}: ${summary.migrated}
  already current : ${summary.unchanged}
  failures        : ${summary.failed}
`);

console.log(
  dryRun
    ? "  Dry run complete. Nothing was changed. To apply: --apply --backup <new file>.\n"
    : summary.migrated + summary.failed === 0
      ? "  Done. Nothing needed changing, so no backup file was written.\n"
      : `  Done. Backup: ${backupPath}  (fest ids and the fields added; keep it until the rollout is verified, then delete it)\n`,
);
process.exit(summary.failed > 0 ? 1 : 0);
