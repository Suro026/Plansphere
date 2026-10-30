import type { Firestore } from "firebase-admin/firestore";
import type { BackupCheck, BackupManifest } from "./backup-common.mjs";

export interface DiscoveredCollection {
  path: string;
  documents: number;
  depth: number;
}
export interface DumpRecord {
  collection: string;
  path: string;
  createTime: string | null;
  updateTime: string | null;
  data: Record<string, unknown>;
}
export interface Comparison {
  ok: boolean;
  compared: number;
  missing: string[];
  extra: string[];
  different: Array<{ path: string; fields: string[] }>;
}

export function openDatabase(projectId: string, credentials?: { client_email: string; private_key: string }): Firestore;
export function discoverCollections(db: Firestore, options: { maxDocuments: number }): Promise<DiscoveredCollection[]>;
export function collectDocuments(db: Firestore): Promise<DumpRecord[]>;
export function validateFirestoreRecord(record: unknown, file: { collection?: string }): string[];
export function writeFirestoreBackup(db: Firestore, abs: string, options: { projectId: string; maxDocuments: number }): Promise<BackupManifest>;
export function verifyFirestoreBackup(dir: string): { ok: boolean; checks: BackupCheck[]; manifest: BackupManifest | null };
export function readFirestoreDump(dir: string): { manifest: BackupManifest; records: DumpRecord[] };
export function compareLiveCounts(db: Firestore, dir: string): Promise<{ ok: boolean; differences: Array<{ collection: string; backup: number; live: number }> }>;
export function restoreIntoEmulator(db: Firestore, dir: string): Promise<number>;
export function compareDumpToDatabase(db: Firestore, dir: string): Promise<Comparison>;
