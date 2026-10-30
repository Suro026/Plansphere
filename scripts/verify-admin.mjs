/**
 * Checks that FIREBASE_SERVICE_ACCOUNT is present, parseable, and actually
 * accepted by Firebase.
 *
 * A bad service account fails deep inside the SDK with a message about PEM
 * parsing or a 401 from a token endpoint, usually at the moment a user is
 * waiting on a request. Running this first turns that into a clear answer.
 *
 *   npm run verify:admin
 *
 * Prints no secret material.
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { inspectServiceAccount } from "./lib/service-account.mjs";

const fail = (message) => {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
};

// The same reading the app, /api/health and every script use (scripts/lib/service-account.mjs): it names the actual mistake
// (the private key pasted alone, a truncated value, the wrong file) and never prints the value.
const reading = inspectServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!reading.ok) {
  fail(`FIREBASE_SERVICE_ACCOUNT cannot be used (${reading.code}): ${reading.message}\n        It is read from .env.local; see .env.example.`);
}

const account = reading.account;

console.log("  Service account parsed");
console.log(`    project_id   : ${account.project_id}`);
// The service account's address is an identifier, not a secret, but nothing about the credential needs to be echoed: the domain
// (which carries the project) is enough to tell it is the right one.
console.log(`    client_email : …@${account.client_email.split("@")[1] ?? ""}`);

const webProject = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

if (webProject && webProject !== account.project_id) {
  fail(
    `Project mismatch.\n` +
      `        Web config points at "${webProject}"\n` +
      `        but the service account belongs to "${account.project_id}".\n` +
      `        ID tokens from one project are rejected by the other, so every\n` +
      `        authenticated request would fail with "session expired".`,
  );
}

console.log("  Web config and service account agree on the project");

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: account.project_id,
      clientEmail: account.client_email,
      privateKey: account.private_key.replace(/\\n/g, "\n"),
    }),
    projectId: account.project_id,
  });
}

// Exercise both services the routes depend on. Either can fail independently:
// the key can be valid while the Firestore API is disabled on the project.
try {
  const users = await getAuth().listUsers(1);
  console.log(`  Auth reachable (${users.users.length ? "accounts exist" : "no accounts yet"})`);
} catch (error) {
  fail(`Auth rejected the credentials: ${error.message}`);
}

try {
  const snapshot = await getFirestore().collection("users").limit(1).get();
  console.log(`  Firestore reachable (users collection: ${snapshot.size} doc(s) sampled)`);
} catch (error) {
  fail(`Firestore rejected the credentials: ${error.message}`);
}

console.log("\n  Firebase Admin is configured correctly.\n");
process.exit(0);
