import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encryption for merchant credentials at rest.
 *
 * Credentials are stored only in the server-only `paymentSecrets` collection,
 * which Firestore rules deny to every client, and even there only as
 * AES-256-GCM ciphertext. Keys never appear in the repository, in Firestore, or
 * in any response, and nothing here logs plaintext, ciphertext or a key.
 *
 * **Versioned, rotatable.** A stored blob says which key sealed it:
 *
 *   v2  { v, kid, iv, tag, data }   kid = first 8 hex of SHA-256(key)
 *   v1  { v, iv, tag, data }        the original format, no key id
 *
 * The key ring is read from the environment on every call:
 *
 *   PAYMENT_SECRET_KEY            the current key (base64 of 32 bytes). New
 *                                 blobs are always sealed with this one.
 *   PAYMENT_SECRET_KEYS_PREVIOUS  comma-separated older keys, decrypt-only.
 *
 * Rotating = put the new key in PAYMENT_SECRET_KEY, move the old one to
 * PAYMENT_SECRET_KEYS_PREVIOUS, deploy, run the re-encrypt job
 * (`rewrapAllSecrets`), then — once it reports nothing left on an old key —
 * drop the old key. A blob that no key can open fails closed with a generic
 * error; the ring is never guessed at beyond the keys it was given.
 *
 * The fest id is bound in as additional authenticated data (v2 also binds the
 * key id), so a ciphertext copied to another fest's document, or relabelled
 * with another key id, fails to decrypt.
 */

export class PaymentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentConfigError";
  }
}

export interface EncryptedBlobV1 {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export interface EncryptedBlobV2 {
  v: 2;
  kid: string;
  iv: string;
  tag: string;
  data: string;
}

export type EncryptedBlob = EncryptedBlobV1 | EncryptedBlobV2;

export const CURRENT_BLOB_VERSION = 2;

/* ───────────── the key ring ───────────── */

const keyId = (key: Buffer): string => createHash("sha256").update(key).digest("hex").slice(0, 8);

const parseKey = (raw: string, name: string): Buffer => {
  const bytes = Buffer.from(raw.trim(), "base64");
  if (bytes.length !== 32) throw new PaymentConfigError(`${name} must be base64 of exactly 32 bytes.`);
  return bytes;
};

interface KeyRing {
  current: { kid: string; key: Buffer };
  /** Current first, then the previous keys in the order given. */
  all: Array<{ kid: string; key: Buffer }>;
}

const keyRing = (): KeyRing => {
  const raw = process.env.PAYMENT_SECRET_KEY;
  if (!raw) throw new PaymentConfigError("PAYMENT_SECRET_KEY is not set, so merchant credentials cannot be stored.");
  const currentKey = parseKey(raw, "PAYMENT_SECRET_KEY");
  const current = { kid: keyId(currentKey), key: currentKey };
  const previous = (process.env.PAYMENT_SECRET_KEYS_PREVIOUS ?? "")
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((value) => {
      const key = parseKey(value, "PAYMENT_SECRET_KEYS_PREVIOUS");
      return { kid: keyId(key), key };
    })
    .filter((entry) => entry.kid !== current.kid);
  return { current, all: [current, ...previous] };
};

/** The id of the key new blobs are sealed with (for health checks and the re-encrypt report). */
export const currentKeyId = (): string => keyRing().current.kid;

/* ───────────── seal / open ───────────── */

const aadFor = (blob: { v: 1 } | { v: 2; kid: string }, festId: string): Buffer =>
  Buffer.from(blob.v === 1 ? festId : `plansphere.payments.v2|${blob.kid}|${festId}`, "utf8");

export const encryptCredentials = (credentials: Record<string, string>, festId: string): EncryptedBlobV2 => {
  const { current } = keyRing();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", current.key, iv);
  cipher.setAAD(aadFor({ v: 2, kid: current.kid }, festId));
  const data = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return { v: 2, kid: current.kid, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
};

const open = (blob: EncryptedBlob, key: Buffer, festId: string): Record<string, string> => {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAAD(aadFor(blob, festId));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(plain) as Record<string, string>;
};

export const decryptCredentials = (blob: EncryptedBlob, festId: string): Record<string, string> => {
  if (!blob || (blob.v !== 1 && blob.v !== 2)) throw new PaymentConfigError("Unsupported credential format.");
  const ring = keyRing();
  // v2 names its key; v1 predates key ids, so every key on the ring is tried.
  const candidates = blob.v === 2 ? ring.all.filter((entry) => entry.kid === blob.kid) : ring.all;
  if (candidates.length === 0) throw new PaymentConfigError("Stored credentials were sealed with a key this deployment no longer has.");
  for (const candidate of candidates) {
    try {
      return open(blob, candidate.key, festId);
    } catch {
      // Wrong key, tampering, or another fest's blob — try the next, say nothing about which.
    }
  }
  throw new PaymentConfigError("Stored credentials could not be decrypted.");
};

/** Is this blob in the current format under the current key? */
export const isCurrentBlob = (blob: EncryptedBlob): boolean => blob.v === 2 && blob.kid === currentKeyId();

/** Opens a blob with any key on the ring and seals it again under the current one. */
export const rewrapBlob = (blob: EncryptedBlob, festId: string): EncryptedBlobV2 => encryptCredentials(decryptCredentials(blob, festId), festId);
