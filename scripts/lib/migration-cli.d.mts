export interface MigrationArgs {
  apply: boolean;
  dryRun: boolean;
  backupPath: string | null;
  restorePath: string | null;
}

export function parseMigrationArgs(argv: string[], options: { script: string; extraFlags?: string[] }): MigrationArgs;
export function appendBackupLine(path: string, entry: unknown): void;
export function readBackupLines(path: string): Array<Record<string, unknown>>;
export function sameValue(a: unknown, b: unknown): boolean;
