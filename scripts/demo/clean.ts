/**
 * Removes the video-demo dataset — and only that.
 *
 * A document is deleted only if it carries `demoBatch === "video-demo-2026"`.
 * An Auth account is deleted only if its `users` document carries that marker
 * AND its address is on the reserved `plansphere.demo` domain, so a real
 * account can never be caught by a marker typo.
 *
 * Emulator only: like the seeder, it refuses any other target.
 */
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";
import { BATCH, DEMO_DOMAIN, assertEmulatorTarget, log, retryingBulkWriter } from "./lib";

export const clean = async (): Promise<void> => {
  const target = assertEmulatorTarget();
  log(`\n  TARGET  Firebase emulator · project ${target.project}\n`);

  const db = adminDb();
  const names = [...Object.values(COLLECTIONS), "certificateEvents"];
  const uids: string[] = [];
  const deleted: Record<string, number> = {};
  const bw = retryingBulkWriter(db);

  for (const name of names) {
    const snap = await db.collection(name).where("demoBatch", "==", BATCH).get();
    deleted[name] = snap.size;
    for (const doc of snap.docs) {
      if (name === COLLECTIONS.users) {
        const address = String(doc.data().email ?? "").toLowerCase();
        if (address.endsWith(`@${DEMO_DOMAIN}`)) uids.push(doc.id);
        else {
          deleted[name] = (deleted[name] ?? 1) - 1;
          continue;
        }
      }
      bw.delete(doc.ref);
    }
  }
  await bw.close();

  let accounts = 0;
  for (let i = 0; i < uids.length; i += 1000) {
    const result = await adminAuth().deleteUsers(uids.slice(i, i + 1000));
    accounts += result.successCount;
  }

  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  log(`  removed ${total} documents and ${accounts} sign-in accounts carrying demoBatch="${BATCH}"`);
  for (const [name, n] of Object.entries(deleted)) if (n > 0) log(`    ${name.padEnd(18)} ${n}`);
  log("");
};
