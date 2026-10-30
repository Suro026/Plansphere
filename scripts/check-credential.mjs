/**
 * Offline check of FIREBASE_SERVICE_ACCOUNT. Makes no network call and prints nothing from the value: only whether each
 * property holds, and the project id (a public identifier).
 *
 *   npm run check:credential
 *
 * It does not prove Google accepts the key - `npm run verify:admin` does that, with a read-only call to Auth and Firestore.
 */

import { checkServiceAccount } from "./lib/service-account.mjs";

const result = checkServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT, { webProjectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() || undefined });

console.log("");
for (const step of result.steps) console.log(`  ${step.ok ? "ok  " : "FAIL"}  ${step.label}${step.detail ? ` - ${step.detail}` : ""}`);
console.log(result.ok ? "\n  The credential is well formed. No network call was made; run `npm run verify:admin` next.\n" : "\n  The credential cannot be used. Nothing was changed.\n");
process.exit(result.ok ? 0 : 1);
