/**
 * Storage diagnosis for the app side: which of "no key", "wrong key", "wrong project", "unreachable", "bucket missing" and
 * "bucket has the wrong visibility" is it. The logic lives in `scripts/lib/storage-diagnose.mjs` so that
 * `npm run verify:infra` (plain node) and `/api/health` run the very same checks; this file is the typed way in.
 */
export {
  EXPECTED_BUCKETS,
  classifyStorageError,
  cleanEnvValue,
  diagnoseStorage,
  inspectStorageEnv,
  misnamedStorageVariables,
  type StorageEnvShape,
  type StorageProblem,
  type StorageProblemCode,
  type StorageProbeClient,
  type StorageReport,
} from "../../../scripts/lib/storage-diagnose.mjs";
