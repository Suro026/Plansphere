/**
 * The Firestore half of the billing-free backup: discover EVERY collection (root and sub, through the live database - not the
 * app's list, which would miss legacy collections), read every document with its types intact, write one file per collection,
 * and prove the result by restoring it into the emulator and comparing field by field.
 *
 * Read the database through a Firestore instance created with `useBigInt: true` (integers come back as BigInt, doubles as
 * numbers); `openDatabase` below does that.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Firestore } from "firebase-admin/firestore";
import { canonicalize, decodeData, diffFields, encodeData, validateEncoded } from "./backup-codec.mjs";
import { BackupError, buildManifest, checkFiles, createBackupDir, verifyBackupFiles, writeBackupFile, writeManifest } from "./backup-common.mjs";

/** A Firestore instance that returns integers as BigInt. Honors FIRESTORE_EMULATOR_HOST. */
export const openDatabase = (projectId, credentials) =>
  new Firestore({ projectId, useBigInt: true, ...(credentials ? { credentials: { client_email: credentials.client_email, private_key: credentials.private_key } } : {}) });

/* ───────────── discovery ───────────── */

/**
 * Every collection path with its document count, root and nested, without reading any document's fields. Refuses before reading
 * anything if the total exceeds `maxDocuments` - on the free plan a large read would use up the day's quota and take the live
 * app down with it.
 * @returns {Promise<Array<{ path: string, documents: number, depth: number }>>}
 */
export const discoverCollections = async (db, { maxDocuments }) => {
  const found = [];
  let total = 0;
  const walk = async (collections, depth) => {
    for (const col of collections) {
      // With useBigInt the aggregate comes back as a BigInt; a count is a small number.
      const documents = Number((await col.count().get()).data().count);
      total += documents;
      if (total > maxDocuments) {
        throw new BackupError(`The database holds more than ${maxDocuments} documents. Reading them all would use a large part of the free plan's daily read quota (50,000) and could take the live app down. Raise --max-documents only if you accept that.`);
      }
      found.push({ path: col.path, documents, depth });
      for (const ref of await col.listDocuments()) await walk(await ref.listCollections(), depth + 1);
    }
  };
  await walk(await db.listCollections(), 0);
  return found.sort((a, b) => a.path.localeCompare(b.path));
};

/* ───────────── reading ───────────── */

/**
 * Every document, typed and encoded, sorted by path.
 * @returns {Promise<Array<{ collection: string, path: string, createTime: string | null, updateTime: string | null, data: object }>>}
 */
export const collectDocuments = async (db) => {
  const records = [];
  const walk = async (collections) => {
    for (const col of collections) {
      const snapshot = await col.get();
      for (const doc of snapshot.docs) {
        records.push({
          collection: col.path,
          path: doc.ref.path,
          createTime: doc.createTime ? doc.createTime.toDate().toISOString() : null,
          updateTime: doc.updateTime ? doc.updateTime.toDate().toISOString() : null,
          data: encodeData(doc.data()),
        });
      }
      // Documents that do not exist themselves but have subcollections are found only through listDocuments().
      for (const ref of await col.listDocuments()) await walk(await ref.listCollections());
    }
  };
  await walk(await db.listCollections());
  return records.sort((a, b) => a.path.localeCompare(b.path));
};

const sanitize = (path) => path.replace(/[^A-Za-z0-9._-]/g, "_");

/** The problems with one parsed line of a Firestore backup file. */
export const validateFirestoreRecord = (record, file) => {
  const problems = [];
  if (!record || typeof record !== "object") return ["not an object"];
  if (typeof record.path !== "string") problems.push("no document path");
  else {
    const collection = file.collection;
    const parts = record.path.split("/");
    if (collection && !record.path.startsWith(`${collection}/`)) problems.push("document is not in this file's collection");
    if (parts.length % 2 !== 0) problems.push("path is not a document path");
  }
  if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) problems.push("no data object");
  else for (const p of validateEncoded(record.data)) problems.push(`field ${p}`);
  return problems;
};

/* ───────────── writing ───────────── */

/**
 * Writes the backup into `abs` (a directory that does not exist yet), checks it, and writes the manifest last, carrying the
 * result of those checks. Returns the manifest.
 */
export const writeFirestoreBackup = async (db, abs, { projectId, maxDocuments }) => {
  const plan = await discoverCollections(db, { maxDocuments });
  const records = await collectDocuments(db);

  createBackupDir(abs);
  const byCollection = new Map();
  for (const r of records) byCollection.set(r.collection, [...(byCollection.get(r.collection) ?? []), r]);

  const files = [];
  let index = 0;
  for (const collection of [...byCollection.keys()].sort()) {
    index += 1;
    const docs = byCollection.get(collection);
    const text = `${docs.map((d) => JSON.stringify({ path: d.path, createTime: d.createTime, updateTime: d.updateTime, data: d.data })).join("\n")}\n`;
    const rel = `firestore/${String(index).padStart(4, "0")}-${sanitize(collection)}.ndjson`;
    const { sha256, bytes } = writeBackupFile(abs, rel, text);
    files.push({ path: rel, collection, depth: collection.split("/").length === 1 ? 0 : (collection.split("/").length - 1) / 2, sha256, bytes, records: docs.length });
  }

  // Checks made BEFORE the manifest exists, so the manifest can carry their result.
  const checks = checkFiles(abs, files, validateFirestoreRecord);
  // Did anything change while we were reading? Compare the live counts with what was written.
  const after = await discoverCollections(db, { maxDocuments: Number.MAX_SAFE_INTEGER });
  const live = new Map(after.map((c) => [c.path, c.documents]));
  const written = new Map(files.map((f) => [f.collection, f.records]));
  const drift = [...new Set([...live.keys(), ...written.keys()])].filter((p) => (live.get(p) ?? 0) !== (written.get(p) ?? 0));
  checks.push({ name: "live counts equal the counts written", ok: drift.length === 0, ...(drift.length ? { detail: `${drift.length} collection(s) changed while the backup ran: ${drift.slice(0, 5).join(", ")}` } : {}) });
  checks.push({ name: "every discovered collection with documents has a file", ok: after.every((c) => c.documents === 0 || written.has(c.path)) });

  const ok = checks.every((c) => c.ok);
  const manifest = buildManifest({
    kind: "firestore",
    projectId,
    files,
    totals: {
      collections: files.length,
      documents: records.length,
      emptyCollectionsSkipped: plan.filter((c) => c.documents === 0).length,
      subcollectionFiles: files.filter((f) => f.depth > 0).length,
    },
    verification: { status: ok ? "verified" : "failed", checkedAt: new Date().toISOString(), checks },
    extra: {
      database: "(default)",
      encoding: "typed JSON; integers read with useBigInt, see scripts/lib/backup-codec.mjs",
      notRestoredByThisTool: ["createTime and updateTime (informational only)", "security rules and indexes (kept in the repository)"],
    },
  });
  writeManifest(abs, manifest);
  return manifest;
};

/* ───────────── verification ───────────── */

/** Offline integrity check of an existing backup directory. No network. */
export const verifyFirestoreBackup = (dir) => verifyBackupFiles(dir, validateFirestoreRecord);

/** Reads the records of a backup directory (after it has passed verification). */
export const readFirestoreDump = (dir) => {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const records = [];
  for (const file of manifest.files) {
    for (const line of readFileSync(join(dir, file.path), "utf8").split("\n").filter(Boolean)) records.push({ ...JSON.parse(line), collection: file.collection });
  }
  return { manifest, records };
};

/** Compares the manifest's counts with the live database (read-only). */
export const compareLiveCounts = async (db, dir) => {
  const { manifest } = readFirestoreDump(dir);
  const live = new Map((await discoverCollections(db, { maxDocuments: Number.MAX_SAFE_INTEGER })).map((c) => [c.path, c.documents]));
  const written = new Map(manifest.files.map((f) => [f.collection, f.records]));
  const differences = [...new Set([...live.keys(), ...written.keys()])]
    .filter((p) => (live.get(p) ?? 0) !== (written.get(p) ?? 0))
    .map((p) => ({ collection: p, backup: written.get(p) ?? 0, live: live.get(p) ?? 0 }));
  return { ok: differences.length === 0, differences };
};

/* ───────────── restore (emulator only) and field-by-field comparison ───────────── */

/**
 * Writes a backup into the Firestore EMULATOR. It refuses to run at all unless FIRESTORE_EMULATOR_HOST is set (so it can never
 * write to production), and refuses a database that already holds documents.
 */
export const restoreIntoEmulator = async (db, dir) => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new BackupError("Restore checks run only against the Firestore emulator (FIRESTORE_EMULATOR_HOST is not set). This tool never writes to production.");
  }
  if ((await db.listCollections()).length > 0) throw new BackupError("The emulator already holds documents. Start from an empty emulator so the comparison is exact.");
  const { records } = readFirestoreDump(dir);
  const writer = db.bulkWriter();
  for (const r of records) writer.set(db.doc(r.path), decodeData(r.data, db));
  await writer.close();
  return records.length;
};

/**
 * Compares a backup with the database it is meant to match, field by field. Reports document paths and field NAMES only.
 * @returns {Promise<{ ok: boolean, compared: number, missing: string[], extra: string[], different: Array<{ path: string, fields: string[] }> }>}
 */
export const compareDumpToDatabase = async (db, dir) => {
  const { records } = readFirestoreDump(dir);
  const live = new Map((await collectDocuments(db)).map((r) => [r.path, r]));
  const dump = new Map(records.map((r) => [r.path, r]));
  const missing = [...dump.keys()].filter((p) => !live.has(p));
  const extra = [...live.keys()].filter((p) => !dump.has(p));
  const different = [];
  for (const [path, r] of dump) {
    const other = live.get(path);
    if (!other) continue;
    const fields = diffFields(r.data, other.data);
    if (fields.length) different.push({ path, fields });
  }
  return { ok: missing.length + extra.length + different.length === 0, compared: dump.size, missing, extra, different };
};

export { canonicalize };
