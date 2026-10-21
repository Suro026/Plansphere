import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { currentKeyId, decryptCredentials, isCurrentBlob, rewrapBlob, type EncryptedBlob } from "./secrets";

export interface RewrapReport {
  dryRun: boolean;
  /** The key id new blobs are sealed with. */
  currentKeyId: string;
  total: number;
  /** Already v2 under the current key. */
  alreadyCurrent: number;
  /** Re-sealed under the current key (or, in a dry run, would be). */
  rewrapped: number;
  /** Fest ids whose blob no key on the ring can open. Nothing is changed for them. */
  undecryptable: string[];
}

/**
 * Moves every stored credential blob onto the current key and format.
 *
 * Safe to run any number of times and while the app is serving traffic:
 *  - a dry run reads and decrypts but writes nothing;
 *  - each write is a transaction that re-reads the blob first and only replaces
 *    it if it is still the one that was opened, so a credential an organizer
 *    saved a moment ago is never overwritten by a re-seal of the old one;
 *  - a blob that cannot be opened is reported and left exactly as it is — never
 *    deleted, never guessed at;
 *  - the plaintext is held only in memory for the duration of one blob.
 *
 * Run it after adding a new key to `PAYMENT_SECRET_KEY` (and moving the old one
 * to `PAYMENT_SECRET_KEYS_PREVIOUS`); drop the old key only once a real run
 * reports `undecryptable: []` and nothing left to rewrap.
 */
export const rewrapAllSecrets = async (options: { dryRun?: boolean } = {}): Promise<RewrapReport> => {
  const dryRun = options.dryRun === true;
  const db = adminDb();
  const report: RewrapReport = { dryRun, currentKeyId: currentKeyId(), total: 0, alreadyCurrent: 0, rewrapped: 0, undecryptable: [] };

  const snapshot = await db.collection(COLLECTIONS.paymentSecrets).get();
  for (const doc of snapshot.docs) {
    report.total += 1;
    const blob = (doc.data() as { blob?: EncryptedBlob }).blob;
    if (!blob) {
      report.undecryptable.push(doc.id);
      continue;
    }
    if (isCurrentBlob(blob)) {
      // Still prove it opens: a blob under the current key id that fails is corrupt, not current.
      try {
        decryptCredentials(blob, doc.id);
        report.alreadyCurrent += 1;
      } catch {
        report.undecryptable.push(doc.id);
      }
      continue;
    }

    let next;
    try {
      next = rewrapBlob(blob, doc.id);
    } catch {
      report.undecryptable.push(doc.id);
      continue;
    }
    if (dryRun) {
      report.rewrapped += 1;
      continue;
    }

    const replaced = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const current = (fresh.data() as { blob?: EncryptedBlob } | undefined)?.blob;
      if (!current || current.iv !== blob.iv) return false; // changed since we read it
      tx.update(doc.ref, { blob: next, rewrappedAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (replaced) report.rewrapped += 1;
  }
  return report;
};
