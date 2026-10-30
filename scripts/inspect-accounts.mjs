/**
 * Read-only look at what exists before migrating: Auth accounts, the old
 * `students` / `organizers` collections, and the new `users` collection.
 * Prints counts and shapes, and masks emails.
 */
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { loadServiceAccountOrExit } from "./lib/service-account.mjs";

const account = loadServiceAccountOrExit(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!getApps().length) {
  initializeApp({
    credential: cert({ projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key }),
    projectId: account.project_id,
  });
}
const auth = getAuth();
const db = getFirestore();

const mask = (e = "") => e.replace(/^(.).*(@.*)$/, "$1***$2");

const users = [];
let token;
do {
  const page = await auth.listUsers(1000, token);
  users.push(...page.users);
  token = page.pageToken;
} while (token);

console.log(`\nAuth accounts: ${users.length}`);
for (const u of users) {
  console.log(
    `  ${u.uid.slice(0, 8)}…  ${mask(u.email).padEnd(28)} verified=${u.emailVerified ? "y" : "n"} disabled=${u.disabled ? "y" : "n"} claims=${JSON.stringify(u.customClaims ?? {})} name=${u.displayName ?? "-"}`,
  );
}

for (const name of ["students", "organizers", "users"]) {
  const snap = await db.collection(name).get();
  console.log(`\n${name}: ${snap.size} docs`);
  const keys = new Set();
  snap.docs.forEach((d) => Object.keys(d.data()).forEach((k) => keys.add(k)));
  if (snap.size) console.log(`  fields: ${[...keys].sort().join(", ")}`);
  snap.docs.slice(0, 20).forEach((d) => {
    const x = d.data();
    console.log(`  ${d.id.slice(0, 8)}…  ${mask(x.email ?? "")}  role=${x.role ?? "-"}  name=${x.fullName ?? x.name ?? "-"}`);
  });
}
process.exit(0);
