import type { Auth } from "firebase-admin/auth";
import type { BackupCheck, BackupManifest } from "./backup-common.mjs";

export type AuthUserJson = {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  photoURL?: string;
  phoneNumber?: string;
  disabled?: boolean;
  passwordHash?: string;
  passwordSalt?: string;
  customClaims?: Record<string, unknown>;
  providerData?: Array<{ uid: string; providerId: string; email?: string; displayName?: string; photoURL?: string; phoneNumber?: string }>;
  metadata?: { creationTime?: string; lastSignInTime?: string; lastRefreshTime?: string | null };
  multiFactor?: { enrolledFactors?: unknown[] };
  tokensValidAfterTime?: string;
  tenantId?: string;
  [extra: string]: unknown;
};

export function serializeAuthUser(user: { toJSON(): object } | object): AuthUserJson;
export function toStandardBase64(value: unknown): string | undefined;
export function toCliImportRecord(user: AuthUserJson): Record<string, unknown>;
export function summarizeAuthUsers(users: AuthUserJson[]): { users: number; withPasswordHash: number; withPasswordSalt: number; withCustomClaims: number; disabled: number; withMultiFactor: number; providers: Record<string, number> };
export function collectAuthUsers(auth: Auth): Promise<AuthUserJson[]>;
export function validateAuthRecord(record: unknown, file: { role?: string; users?: number }): string[];
export function writeAuthBackup(auth: Auth, abs: string, options: { projectId: string }): Promise<BackupManifest>;
export function verifyAuthBackup(dir: string): { ok: boolean; checks: BackupCheck[]; manifest: BackupManifest | null };
export function readAuthDump(dir: string): { manifest: BackupManifest; users: AuthUserJson[] };
export function compareLiveAuth(auth: Auth, dir: string): Promise<{ ok: boolean; backup: number; live: number; missingFromBackup: number; goneFromLive: number }>;
