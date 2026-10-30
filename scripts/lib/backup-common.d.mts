export const REPO_ROOT: string;
export const FORMAT: string;
export const VERSION: number;
export const MANIFEST_FILE: string;
export const MANIFEST_HASH_FILE: string;
export const SENSITIVITY_WARNING: string;

export class BackupError extends Error {}

export interface BackupArgs {
  mode: "dry-run" | "write" | "verify";
  dir: string | null;
  live: boolean;
  restoreCheck: boolean;
  maxDocuments: number;
}
export interface BackupFileEntry {
  path: string;
  sha256: string;
  bytes: number;
  records: number;
  [extra: string]: unknown;
}
export interface BackupCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface BackupManifest {
  format: string;
  version: number;
  kind: "firestore" | "auth";
  projectId: string;
  createdAt: string;
  tool: string;
  files: BackupFileEntry[];
  totals: Record<string, unknown>;
  verification: { status: "verified" | "failed"; checkedAt: string; checks: BackupCheck[] };
  warnings: string[];
  [extra: string]: unknown;
}

export function sha256Hex(data: string | Uint8Array): string;
export function parseBackupArgs(argv: string[], options: { script: string; allowRestoreCheck?: boolean; defaultMaxDocuments?: number }): BackupArgs;
export function assertSafeBackupDir(dir: string, options?: { repoRoot?: string }): string;
export function createBackupDir(abs: string): string;
export function writeBackupFile(abs: string, rel: string, text: string): { sha256: string; bytes: number };
export function writeManifest(abs: string, manifest: object): string;
export function buildManifest(input: { kind: "firestore" | "auth"; projectId: string; files: BackupFileEntry[]; totals: Record<string, unknown>; verification: BackupManifest["verification"]; extra?: object }): BackupManifest;
export function checkFiles(abs: string, files: BackupFileEntry[], validateRecord: (record: unknown, file: BackupFileEntry) => string[]): BackupCheck[];
export function verifyBackupFiles(dir: string, validateRecord: (record: unknown, file: BackupFileEntry) => string[]): { ok: boolean; checks: BackupCheck[]; manifest: BackupManifest | null };
export function printChecks(checks: BackupCheck[]): void;
export function exitWith(error: unknown): never;
