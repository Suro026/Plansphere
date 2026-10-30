export type ServiceAccountProblemCode =
  | "missing"
  | "private-key-only"
  | "not-json-or-base64"
  | "not-json"
  | "not-an-object"
  | "wrong-type"
  | "missing-fields"
  | "private-key-malformed";

export interface ServiceAccountKey {
  project_id: string;
  client_email: string;
  private_key: string;
}

export type ServiceAccountReading =
  | { ok: true; shape: "json" | "base64"; projectId: string; clientEmailDomain: string; account: ServiceAccountKey }
  | { ok: false; code: ServiceAccountProblemCode; message: string; fields?: string[] };

export function cleanServiceAccountValue(raw: unknown): string;
export function inspectServiceAccount(raw: unknown): ServiceAccountReading;
export function loadServiceAccountOrExit(raw: string | undefined): ServiceAccountKey;

export interface CredentialCheckStep {
  ok: boolean;
  label: string;
  detail?: string;
}
export function checkServiceAccount(raw: unknown, options?: { webProjectId?: string }): { ok: boolean; steps: CredentialCheckStep[] };
