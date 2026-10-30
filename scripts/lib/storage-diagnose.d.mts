export type StorageProblemCode =
  | "half-configured"
  | "url-invalid"
  | "url-has-path"
  | "url-not-https"
  | "key-missing"
  | "key-malformed"
  | "key-publishable"
  | "key-unrecognized"
  | "project-mismatch"
  | "unauthorized"
  | "unreachable"
  | "wrong-url"
  | "upstream"
  | "unknown"
  | "bucket-missing"
  | "bucket-should-be-private"
  | "bucket-should-be-public";

export interface StorageProblem {
  code: StorageProblemCode;
  bucket?: string;
  message: string;
}

export interface StorageEnvShape {
  url: "missing" | "invalid" | "not-https" | "has-path" | "ok";
  key: "missing" | "malformed" | "publishable" | "service-role" | "unrecognized";
  projectMismatch: boolean;
  hostedProject: boolean;
}

export interface StorageReport {
  configured: boolean;
  ok: boolean;
  problems: StorageProblem[];
  buckets: Array<{ name: string; exists: boolean; public: boolean | null; expectedPublic: boolean }>;
  env: StorageEnvShape;
}

export interface BucketListing {
  name: string;
  public?: boolean;
  file_size_limit?: number | null;
}

export interface StorageProbeClient {
  storage: { listBuckets: () => Promise<{ data: BucketListing[] | null; error: unknown }> };
}

export const EXPECTED_BUCKETS: Readonly<Record<string, boolean>>;
export const cleanEnvValue: (value: string | undefined) => string;
export const misnamedStorageVariables: (env: Record<string, string | undefined>) => string[];
export const inspectStorageEnv:(env: Record<string, string | undefined>) => StorageEnvShape;
export const classifyStorageError: (error: unknown) => "bucket-missing" | "key-malformed" | "unauthorized" | "unreachable" | "wrong-url" | "upstream" | "unknown";
export const diagnoseStorage: (input: { env: Record<string, string | undefined>; client: () => StorageProbeClient; timeoutMs?: number }) => Promise<StorageReport>;
