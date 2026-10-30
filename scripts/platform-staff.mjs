/**
 * The platform registry: who may act as the platform team.
 *
 *   npm run platform-staff -- list
 *   npm run platform-staff -- bootstrap [--apply]               # register every enabled super admin
 *   npm run platform-staff -- add <email> [--apply]
 *   npm run platform-staff -- remove <email> [--apply]
 *   npm run platform-staff -- suspend <email> [--apply]
 *   npm run platform-staff -- reinstate <email> [--apply]
 *   npm run platform-staff -- enforce on [--require-mfa] [--apply]
 *   npm run platform-staff -- enforce off [--apply]             # always allowed: the way back from a lockout
 *
 * `super_admin` is the platform team. Until the boundary is enforced the role claim alone is enough; once enforced, a super
 * admin must also be on this registry (and, with --require-mfa, sign in with a second factor). See src/core/platform.ts and
 * docs/PLATFORM-BOUNDARY.md. This script is the ONLY writer of `platformStaff` and `platformConfig`: no route, page or
 * Firestore rule writes them, which is what keeps an organizer's account (or a compromised super admin session) from
 * adding itself.
 *
 * Nothing is written without --apply. It never creates an account and never grants a role: `add` accepts only an account
 * that is ALREADY a super admin (create one with `npm run grant-super-admin`, which registers it too).
 *
 * `enforce on` refuses to lock the platform out: it needs at least one registered, enabled super admin, and with
 * --require-mfa every one of them must already have enrolled a second factor.
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { loadServiceAccountOrExit } from "./lib/service-account.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const [command, subject] = positional;
const apply = flags.has("--apply");

const fail = (message) => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

if (!["list", "bootstrap", "add", "remove", "suspend", "reinstate", "enforce"].includes(command ?? "")) {
  fail(
    "Usage: npm run platform-staff -- list | bootstrap | add <email> | remove <email> | suspend <email> | reinstate <email> | enforce on|off [--require-mfa] [--apply]",
  );
}

const account = loadServiceAccountOrExit(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!getApps().length) {
  initializeApp({
    credential: cert({ projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key }),
    projectId: account.project_id,
  });
}
const db = getFirestore();
const auth = getAuth();

console.log(`\n  Project: ${account.project_id}${apply ? "" : "   (dry run - add --apply to make the change)"}\n`);

/* ───────────── reading ───────────── */

const staffRef = (uid) => db.collection("platformStaff").doc(uid);
const boundaryRef = db.collection("platformConfig").doc("boundary");

const readBoundary = async () => {
  const snap = await boundaryRef.get();
  return { enforce: snap.data()?.enforce === true, requireMfa: snap.data()?.requireMfa === true };
};

const accountByEmail = async (email) => {
  const normal = String(email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normal)) fail(`"${email ?? ""}" does not look like an email address.`);
  try {
    return await auth.getUserByEmail(normal);
  } catch (error) {
    if (error.code === "auth/user-not-found") fail(`No account for ${normal}. Create a super admin first with: npm run grant-super-admin -- ${normal}`);
    throw error;
  }
};

/** Is this account, right now, a usable platform member: an enabled super admin on the registry as active? */
const usable = async (uid, entry) => {
  if (entry.status !== "active") return false;
  const user = await auth.getUser(uid).catch(() => null);
  if (!user || user.disabled) return false;
  const profile = (await db.collection("users").doc(uid).get()).data();
  return profile?.role === "super_admin" && profile?.disabled !== true;
};

const activeMembers = async () => {
  const snap = await db.collection("platformStaff").get();
  const out = [];
  for (const doc of snap.docs) {
    if (await usable(doc.id, doc.data())) out.push({ uid: doc.id, ...doc.data() });
  }
  return out;
};

const record = async (action, summary) => {
  await db.collection("auditLog").add({
    action,
    summary: summary.slice(0, 200),
    actorId: "platform-staff-script",
    actorName: "platform-staff script",
    actorRole: "super_admin",
    createdAt: FieldValue.serverTimestamp(),
  });
};

const write = async (label, run, action, summary) => {
  if (!apply) {
    console.log(`  would ${label}`);
    return;
  }
  await run();
  await record(action, summary);
  console.log(`  done: ${label}`);
};

/* ───────────── commands ───────────── */

if (command === "list") {
  const boundary = await readBoundary();
  console.log(`  Boundary: ${boundary.enforce ? "ENFORCED" : "not enforced"}${boundary.enforce && boundary.requireMfa ? " (second factor required)" : ""}`);
  const snap = await db.collection("platformStaff").get();
  if (snap.empty) console.log("  Registry: empty");
  for (const doc of snap.docs) {
    const entry = doc.data();
    const user = await auth.getUser(doc.id).catch(() => null);
    const factors = user?.multiFactor?.enrolledFactors?.length ?? 0;
    console.log(`  ${String(entry.status).padEnd(10)} ${user?.email ?? "(account gone)"}  uid ${doc.id}  second factor: ${factors > 0 ? "enrolled" : "none"}${user?.disabled ? "  [account disabled]" : ""}`);
  }
  const supers = await db.collection("users").where("role", "==", "super_admin").get();
  const unregistered = supers.docs.filter((d) => !snap.docs.some((s) => s.id === d.id));
  if (unregistered.length) console.log(`\n  Super admins NOT on the registry: ${unregistered.length}  (they would lose platform access if the boundary were enforced)`);
  console.log("");
  process.exit(0);
}

if (command === "bootstrap") {
  const supers = await db.collection("users").where("role", "==", "super_admin").get();
  const todo = [];
  for (const doc of supers.docs) {
    if (doc.data().disabled === true) continue;
    const existing = await staffRef(doc.id).get();
    if (existing.exists && existing.data().status === "active") continue;
    todo.push(doc);
  }
  console.log(`  Super admin accounts: ${supers.size}   to register: ${todo.length}`);
  for (const doc of todo) {
    const email = String(doc.data().email ?? "").toLowerCase();
    await write(
      `register ${email}`,
      () => staffRef(doc.id).set({ uid: doc.id, email, status: "active", addedAt: FieldValue.serverTimestamp(), addedBy: "script" }, { merge: true }),
      "platform_staff_changed",
      `Registered platform account ${email}`,
    );
  }
  console.log("");
  process.exit(0);
}

if (command === "enforce") {
  const mode = subject;
  if (mode !== "on" && mode !== "off") fail("Usage: enforce on [--require-mfa] | enforce off");
  const requireMfa = mode === "on" && flags.has("--require-mfa");

  if (mode === "on") {
    const members = await activeMembers();
    if (members.length === 0) fail("Refusing to enforce: no registered, enabled super admin exists, so nobody would have platform access. Run `bootstrap --apply` or `add <email> --apply` first.");
    if (requireMfa) {
      const without = [];
      for (const member of members) {
        const user = await auth.getUser(member.uid);
        if ((user.multiFactor?.enrolledFactors?.length ?? 0) === 0) without.push(user.email ?? member.uid);
      }
      if (without.length > 0) {
        fail(`Refusing to require a second factor: ${without.length} registered super admin(s) have not enrolled one (${without.join(", ")}). They would be locked out. See docs/PLATFORM-BOUNDARY.md.`);
      }
    }
    console.log(`  ${members.length} registered super admin(s) will keep platform access.`);
  }

  await write(
    `set the platform boundary to ${mode === "on" ? `ENFORCED${requireMfa ? " with a second factor" : ""}` : "not enforced"}`,
    () => boundaryRef.set({ enforce: mode === "on", requireMfa, updatedAt: FieldValue.serverTimestamp(), updatedBy: "script" }),
    "platform_boundary_changed",
    `Platform boundary ${mode === "on" ? `enforced${requireMfa ? " (second factor required)" : ""}` : "switched off"}`,
  );
  console.log("");
  process.exit(0);
}

/* add / remove / suspend / reinstate act on one account */

const user = await accountByEmail(subject);
const current = await staffRef(user.uid).get();
const email = user.email.toLowerCase();

if (command === "add") {
  const profile = (await db.collection("users").doc(user.uid).get()).data();
  if (profile?.role !== "super_admin") fail(`${email} is not a super admin. This script only registers an account that already is one (npm run grant-super-admin -- ${email}). It never grants a role.`);
  if (user.disabled || profile.disabled === true) fail(`${email} is disabled.`);
  if (current.exists && current.data().status === "active") {
    console.log(`  ${email} is already registered.\n`);
    process.exit(0);
  }
  await write(
    `register ${email}`,
    () => staffRef(user.uid).set({ uid: user.uid, email, status: "active", addedAt: FieldValue.serverTimestamp(), addedBy: "script" }, { merge: true }),
    "platform_staff_changed",
    `Registered platform account ${email}`,
  );
  console.log("");
  process.exit(0);
}

if (!current.exists) fail(`${email} is not on the registry.`);

const status = { remove: "removed", suspend: "suspended", reinstate: "active" }[command];
if (current.data().status === status) {
  console.log(`  ${email} is already ${status}.\n`);
  process.exit(0);
}

if (status === "active") {
  const profile = (await db.collection("users").doc(user.uid).get()).data();
  if (profile?.role !== "super_admin" || user.disabled || profile.disabled === true) fail(`${email} is not an enabled super admin, so it cannot be reinstated.`);
} else {
  const boundary = await readBoundary();
  if (boundary.enforce) {
    const others = (await activeMembers()).filter((m) => m.uid !== user.uid);
    if (others.length === 0) fail(`Refusing: ${email} is the last usable platform account and the boundary is enforced. Add another first, or run \`enforce off --apply\`.`);
  }
}

await write(
  `${command} ${email}`,
  () => staffRef(user.uid).set({ status, [`${status}At`]: FieldValue.serverTimestamp(), [`${status}By`]: "script" }, { merge: true }),
  "platform_staff_changed",
  `Platform account ${email}: ${status}`,
);
console.log("");
process.exit(0);
