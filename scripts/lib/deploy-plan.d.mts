import type { DeclaredIndex } from "./index-probe.mjs";

export interface RulesComparison {
  identical: boolean;
  released: boolean;
  localHash: string;
  deployedHash: string | null;
  added: number;
  removed: number;
  addedLines: string[];
  removedLines: string[];
}

export interface IndexPlan {
  ready: DeclaredIndex[];
  building: DeclaredIndex[];
  needsRepair: Array<{ index: DeclaredIndex; state: string }>;
  missing: DeclaredIndex[];
  extra: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order?: string; arrayConfig?: string }>; state: string }>;
}

export function normalizeRules(text: string | null | undefined): string;
export function compareRules(local: string, deployed: string | null | undefined): RulesComparison;
export function indexKey(collectionGroup: string, fields: Array<{ fieldPath: string; order?: string; arrayConfig?: string }>): string;
export function planIndexes(wanted: DeclaredIndex[], deployedApi: object[]): IndexPlan;
