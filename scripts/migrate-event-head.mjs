/**
 * Moves the Event Head's personal details off the world-readable fest document.
 *
 *   npm run migrate:event-head                                   # report only (the default) - writes nothing
 *   npm run migrate:event-head -- --apply --backup <file.json>   # move the data
 *   npm run migrate:event-head -- --restore <file.json>          # recovery: rebuild festPrivate from a backup file
 *
 * Until this version, registering an event stored `eventHead` (name, designation, phone, LinkedIn, ID-document link)
 * on the fest document itself. A published fest is readable by anyone, signed in or not, and Firestore rules cannot
 * hide a single field, so that data was public. New registrations now write it to the server-only `festPrivate/{id}`
 * document; this script does the same for fests registered before.
 *
 * Per fest (published or not) that still has an `eventHead` field, in this order:
 *   1. BACKUP   the details are appended to the --backup file (written to disk before anything in Firestore changes;
 *               --apply is refused without it). The file holds personal data: keep it private, delete it when done.
 *   2. COPY     `festPrivate/{festId}` is created from the fest's field. An existing private copy is never overwritten.
 *   3. VERIFY   the private document is read back and must equal the fest's field.
 *   4. REMOVE   only then is `eventHead` deleted from the fest document - and only that field, and only if the fest
 *               document has not been modified since it was read (a concurrent edit makes this fest "skipped").
 * A fest whose existing private copy differs from the fest's field is reported as a CONFLICT and left untouched for a
 * person to decide: the script never chooses which of two different versions to throw away.
 *
 * Idempotent: a second run finds nothing. Prints fest ids and counts only, never the details. Exit status is 0 only if
 * every fest found was moved (or, in report mode, none could not be); 2 if any fest conflicted, was skipped or failed.
 */

import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { loadServiceAccountOrExit } from "./lib/service-account.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const backupPath = valueOf("--backup");
const restorePath = valueOf("--restore");

if (apply && (!backupPath || backupPath.startsWith("--"))) {
  console.error("\n  --apply needs --backup <file.json>: the details are written there before anything is changed.\n");
  process.exit(1);
}
if (apply && existsSync(backupPath)) {
  console.error(`\n  ${backupPath} already exists. Pick a new file so an earlier backup is never overwritten.\n`);
  process.exit(1);
}
if (args.includes("--restore") && (!restorePath || restorePath.startsWith("--"))) {
  console.error("\n  --restore needs the backup file written by an earlier --apply run.\n");
  process.exit(1);
}

const account = loadServiceAccountOrExit(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: account.project_id,
      clientEmail: account.client_email,
      privateKey: account.private_key,
    }),
    projectId: account.project_id,
  });
}

const db = getFirestore();

/* ───────────── recovery ───────────── */

if (restorePath) {
  console.log(`\n  Project: ${account.project_id}   restoring festPrivate from backup\n`);
  const lines = readFileSync(restorePath, "utf8").split("\n").filter(Boolean);
  let restored = 0;
  let kept = 0;
  for (const line of lines) {
    const row = JSON.parse(line);
    const ref = db.collection("festPrivate").doc(row.festId);
    if ((await ref.get()).exists) {
      kept += 1; // never overwrite
      continue;
    }
    await ref.set({ festId: row.festId, registeredBy: row.registeredBy ?? null, eventHead: row.eventHead, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), restoredFromBackup: true });
    restored += 1;
  }
  console.log(`  Backup rows: ${lines.length}   restored: ${restored}   already present (left alone): ${kept}\n`);
  process.exit(0);
}

/* ───────────── migration ───────────── */

console.log(`\n  Project: ${account.project_id}${apply ? "" : "   (report only - pass --apply --backup <file> to move the data)"}\n`);

const fests = await db.collection("fests").get();
const counts = { checked: fests.size, found: 0, published: 0, unpublished: 0, moved: 0, conflict: 0, skipped: 0, failed: 0 };

for (const doc of fests.docs) {
  const data = doc.data();
  if (data.eventHead === undefined) continue;
  counts.found += 1;
  if (data.status === "published") counts.published += 1;
  else counts.unpublished += 1;

  const privateRef = db.collection("festPrivate").doc(doc.id);
  const existing = await privateRef.get();
  const conflict = existing.exists && !isDeepStrictEqual(existing.data()?.eventHead, data.eventHead);
  const label = `fest ${doc.id} (${data.status ?? "no status"})`;

  if (!apply) {
    console.log(`  ${conflict ? "CONFLICT (different private copy)" : existing.exists ? "would remove field (private copy already matches)" : "would move"}  ${label}`);
    if (conflict) counts.conflict += 1;
    continue;
  }

  try {
    if (conflict) {
      console.log(`  CONFLICT - left untouched, decide by hand  ${label}`);
      counts.conflict += 1;
      continue;
    }

    // 1. BACKUP, to disk, before any write.
    appendFileSync(backupPath, `${JSON.stringify({ festId: doc.id, registeredBy: data.createdBy ?? data.ownerId ?? null, eventHead: data.eventHead })}\n`, { mode: 0o600 });
    try {
      chmodSync(backupPath, 0o600);
    } catch {
      // Not supported on every platform.
    }

    // 2. COPY (never over an existing copy).
    if (!existing.exists) {
      await privateRef.create({
        festId: doc.id,
        registeredBy: data.createdBy ?? data.ownerId ?? null,
        eventHead: data.eventHead,
        createdAt: data.createdAt ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        movedFromFest: true,
      });
    }

    // 3. VERIFY by reading the destination back.
    const copy = await privateRef.get();
    if (!copy.exists || !isDeepStrictEqual(copy.data()?.eventHead, data.eventHead)) {
      console.log(`  FAILED verification - source kept  ${label}`);
      counts.failed += 1;
      continue;
    }

    // 4. REMOVE the one field, only if the fest has not changed since it was read.
    try {
      await doc.ref.update({ eventHead: FieldValue.delete() }, { lastUpdateTime: doc.updateTime });
    } catch (error) {
      if (error?.code === 9 || /precondition/i.test(String(error?.message))) {
        console.log(`  SKIPPED, fest changed while running - run again  ${label}`);
        counts.skipped += 1;
        continue;
      }
      throw error;
    }
    console.log(`  moved  ${label}`);
    counts.moved += 1;
  } catch (error) {
    console.log(`  FAILED (${error?.code ?? "error"}) - source kept  ${label}`);
    counts.failed += 1;
  }
}

console.log(
  `\n  Fests checked: ${counts.checked}   with eventHead: ${counts.found} (published ${counts.published}, not published ${counts.unpublished})` +
    `   ${apply ? `moved: ${counts.moved}` : "moved: 0 (report only)"}   conflicts: ${counts.conflict}   skipped: ${counts.skipped}   failed: ${counts.failed}\n`,
);
if (apply) console.log(`  Backup: ${backupPath}  (personal data - keep it private; delete it once the rollout is verified)\n`);
process.exit(counts.conflict + counts.skipped + counts.failed > 0 ? 2 : 0);
