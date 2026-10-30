/**
 * Seeds the first super admin.
 *
 * Staff accounts are invite-only and only a super admin can issue an invite,
 * which leaves a chicken-and-egg problem the first time the project is set up.
 * This script is the way out of it, and it is deliberately a local script
 * rather than an HTTP route: an endpoint that can mint a super admin is a
 * permanent back door, however well guarded.
 *
 *   npm run grant-super-admin -- someone@college.edu             # DRY RUN: says what would happen, changes nothing
 *   npm run grant-super-admin -- someone@college.edu --apply     # grants the role
 *
 * Works whether or not the address already has an account. If it does not, one
 * is created and a password-set link is printed.
 *
 * SAFETY (Phase 7). This is a production role change, so it is a dry run unless --apply. The dry run names the account's
 * current role and event roles. An account that already holds event roles (an Event Head, an event admin ...) is refused even
 * with --apply: the platform team and event organizers are separate identities (docs/PLATFORM-BOUNDARY.md), and promoting one
 * account into the other would give a whole fest's organizer the platform. Use a separate address for the platform account;
 * --allow-event-roles overrides, for the rare case where that is truly intended. Revoking sessions and rewriting claims
 * signs the account out everywhere.
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { loadServiceAccountOrExit } from "./lib/service-account.mjs";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const allowEventRoles = argv.includes("--allow-event-roles");
for (const arg of argv) {
  if (arg.startsWith("--") && !["--apply", "--allow-event-roles"].includes(arg)) {
    console.error(`\n  Unknown option ${arg}.\n`);
    process.exit(1);
  }
}
const email = (argv.find((a) => !a.startsWith("--")) ?? process.env.SUPER_ADMIN_EMAIL ?? "").trim().toLowerCase();

if (!email) {
  console.error(
    "\n  Usage: npm run grant-super-admin -- someone@college.edu [--apply]" +
      "\n  (or set SUPER_ADMIN_EMAIL in .env.local)\n",
  );
  process.exit(1);
}

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`\n  "${email}" does not look like an email address.\n`);
  process.exit(1);
}

const account = loadServiceAccountOrExit(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: account.project_id,
      clientEmail: account.client_email,
      privateKey: account.private_key,
    }),
    projectId: account.project_id,
  });
}

const auth = getAuth();
const db = getFirestore();

const randomPassword = () => {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return `Aa1!${Buffer.from(bytes).toString("base64url")}`;
};

let user;
let createdNow = false;

// Read-only first: who is this, and what do they hold today?
let existingUser = null;
try {
  existingUser = await auth.getUserByEmail(email);
} catch (error) {
  if (error.code !== "auth/user-not-found") throw error;
}

const eventRoles = existingUser
  ? (await db.collection("festMembers").where("userId", "==", existingUser.uid).where("status", "==", "active").limit(50).get()).size
  : 0;
const currentRole = existingUser ? (existingUser.customClaims?.br ?? existingUser.customClaims?.role ?? "student") : null;

console.log(`\n  Project: ${account.project_id}${apply ? "" : "   (dry run - add --apply to make the change)"}\n`);
console.log(
  existingUser
    ? `  Account: exists (${existingUser.uid}); current role ${currentRole}; ${eventRoles} active event role(s); email ${existingUser.emailVerified ? "verified" : "not verified"}`
    : "  Account: does not exist; one would be created with a random password and a password-set link printed",
);
console.log("  Would do: set the super_admin role and claims (this signs the account out), write its profile, and register it on the platform registry.");

if (eventRoles > 0 && !allowEventRoles) {
  console.error(
    `\n  REFUSED: this account holds ${eventRoles} event role(s). Platform staff and event organizers are separate identities;` +
      "\n  use a separate address for the platform account. (--allow-event-roles overrides this, if it is truly intended.)\n",
  );
  process.exit(1);
}

if (!apply) {
  console.log("\n  Dry run: nothing was changed. Re-run with --apply to grant the role.\n");
  process.exit(0);
}

if (existingUser) {
  user = existingUser;
  console.log(`  Found existing account: ${user.uid}`);
} else {
  user = await auth.createUser({
    email,
    password: randomPassword(),
    emailVerified: false,
    disabled: false,
  });

  createdNow = true;
  console.log(`  Created account: ${user.uid}`);
}

await auth.setCustomUserClaims(user.uid, { role: "super_admin", festIds: [] });

// Any token already issued still carries the old role, and would keep doing so
// for up to an hour. Revoking forces the next request to mint a fresh one.
await auth.revokeRefreshTokens(user.uid);

const ref = db.collection("users").doc(user.uid);
const existing = await ref.get();

await ref.set(
  {
    id: user.uid,
    email,
    fullName: user.displayName || existing.data()?.fullName || "Super Admin",
    role: "super_admin",
    emailVerified: user.emailVerified,
    disabled: false,
    organizer: { festIds: [] },
    updatedAt: FieldValue.serverTimestamp(),
    ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
  },
  { merge: true },
);

console.log(`  Role set to super_admin and profile written.`);

// The platform registry (see docs/PLATFORM-BOUNDARY.md). Registering here keeps a freshly granted platform account working
// once the boundary is enforced; before that the registry is not consulted, so this changes nothing today.
await db.collection("platformStaff").doc(user.uid).set(
  { uid: user.uid, email, status: "active", addedAt: FieldValue.serverTimestamp(), addedBy: "script" },
  { merge: true },
);
console.log(`  Registered on the platform registry.`);

if (createdNow || !user.emailVerified) {
  const link = await auth.generatePasswordResetLink(email);
  console.log("\n  Set the password using this link (it expires):\n");
  console.log(`    ${link}\n`);
}

console.log("  Done. Sign out and back in for the new role to take effect.\n");
process.exit(0);
