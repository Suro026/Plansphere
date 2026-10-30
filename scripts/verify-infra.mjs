/**
 * Verifies the infrastructure the app depends on but cannot create for
 * itself: Firestore composite indexes, and the Supabase Storage buckets.
 *
 *   npm run verify:infra
 *
 * Checks, in order:
 *   1. every composite index in firestore.indexes.json is live (by running the
 *      query that needs it); prints a one-click console link for each one
 *      that is missing
 *   2. Supabase Storage: the key is the service-role key for the project in
 *      SUPABASE_URL, every bucket the app expects exists, and each is public or
 *      private as the app expects (a private bucket that is public leaks
 *      identity documents and certificates). Each failure names its cause;
 *      the URL and key are never printed. Same checks as /api/health.
 *   3. the service role can write and delete a certificate PDF (server path)
 *
 * There is no client-side Storage rules check any more: nothing in the
 * browser ever holds a Supabase key. Every upload goes through
 * POST /api/uploads with the Firebase ID token, which is what RBAC actually
 * gates — see src/app/api/uploads/route.ts.
 *
 * Needs FIREBASE_SERVICE_ACCOUNT, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */

import { readFileSync } from "node:fs";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createClient } from "@supabase/supabase-js";
import { classifyStorageError, cleanEnvValue, diagnoseStorage, misnamedStorageVariables } from "./lib/storage-diagnose.mjs";
import { buildIndexProbe, describeIndex, isMissingIndexError, missingIndexLink } from "./lib/index-probe.mjs";
import { loadServiceAccountOrExit } from "./lib/service-account.mjs";

// Names the actual problem when the value is unusable (private key pasted alone, truncated, wrong file) and never prints it.
const account = loadServiceAccountOrExit(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!getApps().length) {
  initializeApp({
    credential: cert({ projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key }),
    projectId: account.project_id,
  });
}

const db = getFirestore();
let passed = 0;
let failed = 0;
const ok = (label, detail = "") => { passed += 1; console.log(`  ok    ${label}${detail ? `  ${detail}` : ""}`); };
const bad = (label, detail = "") => { failed += 1; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); };

console.log(`\n  Project: ${account.project_id}\n`);

/* ── 1. composite indexes ─────────────────────────────────────────────── */

console.log("  Composite indexes");
const indexes = JSON.parse(readFileSync(new URL("../firestore.indexes.json", import.meta.url), "utf8")).indexes;
const links = [];
for (const index of indexes) {
  const label = describeIndex(index);
  try {
    await buildIndexProbe((name) => db.collection(name), index).get();
    ok(label);
  } catch (error) {
    const message = String(error.message ?? error);
    const link = missingIndexLink(message);
    if (link) links.push(link);
    bad(label, link || isMissingIndexError(error) ? "missing or still building — create it with the link below, or wait for it to finish" : message.slice(0, 160));
  }
}
if (links.length) {
  console.log("\n  Create the missing indexes (one click each, signed in as a project owner):");
  for (const link of links) console.log(`    ${link}`);
  console.log("\n  Or grant the service account the role \"Cloud Datastore Index Admin\" and run:  npm run firebase:deploy -- --indexes");
}

/* ── 2. Supabase buckets ──────────────────────────────────────────────── */

console.log("\n  Supabase Storage");
// The same diagnosis /api/health runs, so the two cannot disagree. It reports a cause per failure (wrong key, wrong
// project, unreachable, missing bucket, wrong visibility) and never prints the URL or the key.
const storage = await diagnoseStorage({
  env: process.env,
  client: () => createClient(cleanEnvValue(process.env.SUPABASE_URL), cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY), { auth: { persistSession: false, autoRefreshToken: false } }),
});
if (!storage.configured) {
  const misnamed = misnamedStorageVariables(process.env);
  bad(
    "Supabase Storage is not configured",
    `SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both empty — uploads are off. See docs/STORAGE-SETUP.md` +
      (misnamed.length ? `\n        ${misnamed.join(", ")} ${misnamed.length === 1 ? "is" : "are"} set, but this app does not read ${misnamed.length === 1 ? "that name" : "those names"}: set the two server variables above.` : ""),
  );
} else {
  ok("environment", `url:${storage.env.url} key:${storage.env.key}${storage.env.projectMismatch ? " (project mismatch)" : ""}`);
  for (const bucket of storage.buckets) {
    if (!bucket.exists) continue;
    const visibility = bucket.public ? "public" : "private";
    if (bucket.public === bucket.expectedPublic) ok(`bucket ${bucket.name}`, `(${visibility})`);
  }
  for (const p of storage.problems) bad(p.bucket ? `bucket ${p.bucket}` : p.code, `${p.code}: ${p.message}`);

  /* ── 3. server-side certificate write ───────────────────────────────── */

  // Only when the buckets could be listed: a write probe against a wrong key would only repeat the same failure.
  if (storage.ok) {
    const client = createClient(cleanEnvValue(process.env.SUPABASE_URL), cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY), { auth: { persistSession: false, autoRefreshToken: false } });
    const probePath = `_probe/${Date.now()}.pdf`;
    try {
      const { error } = await client.storage.from("certificates").upload(probePath, Buffer.from("%PDF-1.4\n%probe\n"), { contentType: "application/pdf" });
      if (error) throw error;
      await client.storage.from("certificates").remove([probePath]);
      ok("service role can write + delete certificates/…pdf");
    } catch (error) {
      bad("service-role write to certificates/", `${classifyStorageError(error)}: ${String(error.message ?? error).slice(0, 120)}`);
    }
  }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
