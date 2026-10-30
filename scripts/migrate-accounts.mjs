/**
 * Brings the previous project's accounts into the new schema.
 *
 * For every Firebase Auth user:
 *   - `students/{uid}`   → users/{uid} with role "student", claim role=student
 *   - `organizers/{uid}` → users/{uid} with role "admin" (the old app's
 *                          "admin" ran a fest end to end), claim role=admin
 *   - superadmin@plansphere.com (the old hardcoded bootstrap) → super_admin
 *   - no document at all → student with a profile to complete
 *
 * Existing users/{uid} documents are left alone unless --force is passed.
 * Passwords are untouched. Old collections are read, never modified.
 *
 * This is a ONE-TIME IMPORT from the previous project. Against a project that already runs the current schema the dry run
 * should print only `skip` lines; if it prints `write`, stop and read them. Never --force there: it resets the profile and
 * claims of people who are staff today to what the old collections said, and so it is refused without --backup <new file>
 * (their current profile scope and claims are written there first). The bootstrap super admin (SUPER_ADMIN_EMAIL) is granted
 * the platform role only if that address is verified or --trust-emails vouches for it.
 *
 *   npm run migrate:accounts                  # dry run: prints the plan
 *   npm run migrate:accounts -- --apply       # write it
 *   npm run migrate:accounts -- --apply --trust-emails
 *        also marks the migrated accounts' emails verified — appropriate for
 *        known test accounts, since the old app never verified anything and
 *        registration now requires it.
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { existsSync } from "node:fs";
import { appendBackupLine } from "./lib/migration-cli.mjs";
import { loadServiceAccountOrExit } from "./lib/service-account.mjs";

const argv = process.argv.slice(2);
const backupAt = argv.indexOf("--backup");
const backupPath = backupAt === -1 ? null : argv[backupAt + 1];
const args = new Set(argv.filter((a, i) => backupAt === -1 || i !== backupAt + 1));
for (const arg of args) {
  if (!["--apply", "--force", "--trust-emails", "--backup"].includes(arg)) {
    console.error(`\n  Unknown option ${arg}. See the header of scripts/migrate-accounts.mjs.\n`);
    process.exit(1);
  }
}
const apply = args.has("--apply");
const force = args.has("--force");
const trustEmails = args.has("--trust-emails");

// --force overwrites the profile and claims of accounts that already have one - the people who are staff TODAY would be reset
// to what the previous project said they were. It is the one destructive path of this script, so it is refused without a
// backup of exactly what it is about to replace (a new file; never overwritten).
if (apply && force) {
  if (!backupPath || backupPath.startsWith("--")) {
    console.error("\n  --apply --force needs --backup <file.json>: the current profile and claims of every account it overwrites are written there first.\n");
    process.exit(1);
  }
  if (existsSync(backupPath)) {
    console.error(`\n  ${backupPath} already exists. Pick a new file so an earlier backup is never overwritten.\n`);
    process.exit(1);
  }
}

const BOOTSTRAP_SUPER_ADMIN = (process.env.SUPER_ADMIN_EMAIL || "superadmin@plansphere.com").toLowerCase();

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

const authUsers = [];
let token;
do {
  const page = await auth.listUsers(1000, token);
  authUsers.push(...page.users);
  token = page.pageToken;
} while (token);

const [students, organizers, existing] = await Promise.all([
  db.collection("students").get(),
  db.collection("organizers").get(),
  db.collection("users").get(),
]);
const studentById = new Map(students.docs.map((d) => [d.id, d.data()]));
const organizerById = new Map(organizers.docs.map((d) => [d.id, d.data()]));
const existingIds = new Set(existing.docs.map((d) => d.id));

const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const nameFromEmail = (email = "") =>
  email
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "Plansphere user";

const plan = [];

for (const u of authUsers) {
  const email = (u.email ?? "").toLowerCase();
  const student = studentById.get(u.uid);
  const organizer = organizerById.get(u.uid);

  let role = "student";
  let source = "no profile";
  const doc = {
    id: u.uid,
    email,
    fullName: clean(u.displayName) ?? nameFromEmail(email),
    emailVerified: u.emailVerified,
    disabled: Boolean(u.disabled),
  };

  // The platform role goes only to an address that has been proven to be the owner's: verified, or vouched for by the operator
  // with --trust-emails. Otherwise anyone who registered that address first would be handed the platform.
  if (email === BOOTSTRAP_SUPER_ADMIN && (u.emailVerified || trustEmails)) {
    role = "super_admin";
    source = "bootstrap super admin";
    doc.fullName = clean(organizer?.fullName) ?? "Super Admin";
    doc.organizer = { designation: clean(organizer?.designation), festIds: [] };
  } else if (organizer) {
    role = organizer.role === "super_admin" ? "super_admin" : "admin";
    source = `organizers (${organizer.role ?? "-"})`;
    doc.fullName = clean(organizer.fullName) ?? doc.fullName;
    doc.phone = clean(organizer.phone);
    doc.organizer = { designation: clean(organizer.designation), festIds: [] };
  } else if (student) {
    role = "student";
    source = "students";
    doc.fullName = clean(student.fullName) ?? doc.fullName;
    doc.phone = clean(student.phone);
    doc.student = {
      studentId: clean(student.studentId) ?? "Not set",
      college: clean(student.college) ?? "Not set",
      department: clean(student.department),
      year: Number.isFinite(Number(student.year)) && Number(student.year) >= 1 ? Number(student.year) : undefined,
    };
  } else {
    doc.student = { studentId: "Not set", college: "Not set" };
  }

  doc.role = role;
  if (trustEmails) doc.emailVerified = true;

  plan.push({ uid: u.uid, email, role, source, doc, skip: existingIds.has(u.uid) && !force });
}

console.log(`\n  ${apply ? "APPLYING" : "DRY RUN"} — ${plan.length} Auth accounts${trustEmails ? " · marking emails verified" : ""}\n`);
for (const p of plan) {
  console.log(
    `  ${p.skip ? "skip " : "write"}  ${p.uid.slice(0, 8)}…  ${mask(p.email).padEnd(26)} → ${p.role.padEnd(11)} (${p.source})  ${p.doc.fullName}`,
  );
}

if (!apply) {
  console.log("\n  Nothing written. Re-run with --apply to migrate.\n");
  process.exit(0);
}

const strip = (o) => JSON.parse(JSON.stringify(o)); // drops undefined

let written = 0;
for (const p of plan) {
  if (p.skip) continue;

  // Only reachable for an existing profile with --force: keep what is about to be replaced.
  if (existingIds.has(p.uid)) {
    const current = await db.collection("users").doc(p.uid).get();
    const user = await auth.getUser(p.uid);
    appendBackupLine(backupPath, { uid: p.uid, profile: { role: current.data()?.role ?? null, festIds: current.data()?.festIds ?? [], memberOf: current.data()?.memberOf ?? [] }, claims: user.customClaims ?? {} });
  }

  await auth.setCustomUserClaims(p.uid, { role: p.role, festIds: [] });
  if (trustEmails && !p.doc.emailVerifiedBefore) await auth.updateUser(p.uid, { emailVerified: true });
  await auth.revokeRefreshTokens(p.uid);

  await db
    .collection("users")
    .doc(p.uid)
    .set(
      {
        ...strip(p.doc),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        migratedFrom: p.source,
      },
      { merge: true },
    );
  written += 1;
}

console.log(`\n  Migrated ${written} account(s). Old students/organizers collections were left untouched.`);
console.log("  Everyone needs to sign out and back in once for the new role to take effect.\n");
process.exit(0);
