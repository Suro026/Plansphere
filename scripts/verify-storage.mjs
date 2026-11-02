/**
 * Read-only check of Supabase Storage: which of "wrong key", "wrong project", "unreachable", "bucket missing" and
 * "bucket has the wrong visibility" is it. It runs the very same diagnosis as GET /api/health and `npm run verify:infra`
 * (scripts/lib/storage-diagnose.mjs), but needs only the two Supabase values: no Firebase credential, nothing is written,
 * no probe object is created.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service_role key> npm run verify:storage
 *
 * (or put both in .env.local; `npm run verify:storage` reads it.) Prints fixed problem codes, bucket names and whether each
 * bucket is public. It never prints the URL or the key. Exit status 0 when storage is healthy, 1 when it is not.
 */

import { createClient } from "@supabase/supabase-js";
import { EXPECTED_BUCKETS, cleanEnvValue, diagnoseStorage, misnamedStorageVariables } from "./lib/storage-diagnose.mjs";

const url = cleanEnvValue(process.env.SUPABASE_URL);
const key = cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY);

const report = await diagnoseStorage({
  env: process.env,
  client: () => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }),
});

if (!report.configured) {
  const misnamed = misnamedStorageVariables(process.env);
  console.log("\n  Storage is not configured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both unset.");
  if (misnamed.length > 0) console.log(`  These names are set but this app never reads them: ${misnamed.join(", ")}.`);
  console.log("");
  process.exit(1);
}

console.log("");
for (const bucket of report.buckets) {
  const expected = EXPECTED_BUCKETS[bucket.name] ? "public" : "private";
  const actual = !bucket.exists ? "MISSING" : bucket.public ? "public" : "private";
  console.log(`  ${bucket.name.padEnd(14)} expected ${expected.padEnd(8)} found ${actual}`);
}
if (report.ok) {
  console.log("\n  Storage is healthy: the key works for this project and every bucket is there as expected.\n");
  process.exit(0);
}
console.log("");
for (const problem of report.problems) console.log(`  ${problem.code}${problem.bucket ? ` (${problem.bucket})` : ""}: ${problem.message}`);
console.log("");
process.exit(1);
