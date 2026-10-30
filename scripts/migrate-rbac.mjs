/**
 * Migrates the `users` collection and every Auth custom claim to the unified
 * RBAC model.
 *
 *   npm run migrate:rbac                                      # DRY RUN (the default): reports, writes nothing
 *   npm run migrate:rbac -- --apply --backup <file.json>      # make the change
 *   npm run migrate:rbac -- --restore <file.json> [--apply]   # recovery (dry run without --apply)
 *
 * What it does, per account:
 *   role      "organizer" becomes "volunteer"; everything else is kept
 *   name      from `fullName`
 *   avatar    from `photoUrl`
 *   college / department / year / studentId   out of the nested `student` block
 *   designation                               out of the nested `organizer` block
 *   festIds   out of `organizer.festIds`, top level now
 *   uid       set equal to the document id
 *   profileCompleted   computed: staff are complete, a student needs a name,
 *                      a phone and a college
 *   mustChangePassword false unless already set — existing accounts chose
 *                      their own passwords, so nothing is forced on them
 *   createdBy          from the old `invitedBy`, when present
 *   claims    role + festIds re-set from the migrated document
 *
 * Nothing is deleted. The legacy fields stay in place so a rollback is a
 * matter of redeploying the previous build, and `normalizeUserDoc` in the app
 * reads either shape regardless.
 *
 * Idempotent: running it twice changes nothing the second time.
 *
 * SAFETY. A dry run unless --apply, and --apply needs --backup (until Phase 7 this script applied by default). The backup
 * holds, per account it changes, the profile fields it writes (before and after) and the claims it replaces. The fields can
 * include a name, college and student id, so the file is PERSONAL DATA: it is created readable by its owner only; keep it
 * private and delete it once the rollout is verified. Each change is read back and compared; a mismatch is reported and the
 * exit code is 1.
 *
 * Every account whose claims change is SIGNED OUT (its refresh tokens are revoked so the new claim applies at once). The dry
 * run prints how many that is. Run it when that is acceptable.
 *
 * It rewrites claims as {role, festIds}, which drops event-role claims (br / fm / fx): do not re-run it after
 * migrate:memberships without running that again (docs/MIGRATIONS.md).
 *
 * --restore puts the profile fields and the claims back to what the backup holds, for each account whose profile / claims
 * still hold exactly what this script wrote (anything changed since is kept and reported), and signs those accounts out.
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { appendBackupLine, parseMigrationArgs, readBackupLines, sameValue } from "./lib/migration-cli.mjs";
import { loadServiceAccountOrExit } from "./lib/service-account.mjs";

const { apply, dryRun, backupPath, restorePath } = parseMigrationArgs(process.argv.slice(2), { script: "migrate-rbac.mjs" });

const account = loadServiceAccountOrExit(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!getApps().length) {
  initializeApp({
    credential: cert({ projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key }),
    projectId: account.project_id,
  });
}

const db = getFirestore();
const auth = getAuth();

const ROLES = new Set(["student", "volunteer", "admin", "super_admin"]);

const migrateRole = (role) => (role === "organizer" ? "volunteer" : ROLES.has(role) ? role : "student");

const asStrings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);

console.log(`\n  Project: ${account.project_id}${restorePath ? (apply ? "   (RESTORE)" : "   (restore dry run - add --apply to make the changes)") : dryRun ? "   (dry run — nothing will be written; pass --apply --backup <file> to make the change)" : ""}\n`);

/* ───────────── recovery: undo a previous --apply ───────────── */

if (restorePath) {
  const entries = readBackupLines(restorePath);
  const counts = { profiles: 0, claims: 0, kept: 0, gone: 0, failed: 0 };
  for (const entry of entries) {
    const uid = String(entry.uid);
    try {
      const ref = db.collection("users").doc(uid);
      const snap = await ref.get();
      if (!snap.exists) {
        counts.gone += 1;
      } else {
        const current = snap.data();
        const written = entry.written ?? {};
        const restorable = Object.keys(written).filter((key) => sameValue(current[key], written[key]));
        const edited = Object.keys(written).filter((key) => !restorable.includes(key));
        if (edited.length) {
          counts.kept += edited.length;
          console.log(`  kept (changed since the migration): ${uid}  ${edited.join(", ")}`);
        }
        if (restorable.length) {
          counts.profiles += 1;
          if (apply) {
            await ref.update(Object.fromEntries(restorable.map((key) => [key, (entry.absent ?? []).includes(key) ? FieldValue.delete() : entry.before[key]])));
          }
        }
      }
      if (entry.claimsAfter) {
        const user = await auth.getUser(uid);
        if (sameValue(user.customClaims ?? {}, entry.claimsAfter)) {
          counts.claims += 1;
          if (apply) {
            const previous = entry.claimsBefore ?? {};
            await auth.setCustomUserClaims(uid, Object.keys(previous).length ? previous : null);
            await auth.revokeRefreshTokens(uid);
          }
        } else {
          counts.kept += 1;
          console.log(`  kept (claims changed since the migration): ${uid}`);
        }
      }
    } catch (error) {
      counts.failed += 1;
      console.error(`  failed: ${uid}: ${error?.message ?? error}`);
    }
  }
  console.log(`\n  profiles ${apply ? "restored" : "to restore"} : ${counts.profiles}\n  claims ${apply ? "restored" : "to restore"}   : ${counts.claims}\n  kept (edited)       : ${counts.kept}\n  accounts gone       : ${counts.gone}\n  failures            : ${counts.failed}\n`);
  if (!apply) console.log("  Dry run: nothing was changed. Re-run with --apply to restore.\n");
  process.exit(counts.failed ? 1 : 0);
}

const snapshot = await db.collection("users").get();
console.log(`  ${snapshot.size} user document(s)\n`);

const summary = { unchanged: 0, migrated: 0, claims: 0, failed: 0, byRole: {} };
const problems = [];

for (const doc of snapshot.docs) {
  const data = doc.data();
  const student = data.student ?? {};
  const organizer = data.organizer ?? {};

  const role = migrateRole(data.role);
  const name = (data.name ?? data.fullName ?? "").trim();
  const phone = (data.phone ?? "").trim();
  const college = (data.college ?? student.college ?? "").trim();
  const festIds = data.festIds !== undefined ? asStrings(data.festIds) : asStrings(organizer.festIds);

  const next = {
    uid: doc.id,
    id: doc.id,
    role,
    festIds,
    profileCompleted: role === "student" ? Boolean(name && phone && college) : Boolean(name),
    mustChangePassword: data.mustChangePassword === true,
  };
  if (name) next.name = name;
  if (data.avatar ?? data.photoUrl) next.avatar = data.avatar ?? data.photoUrl;
  if (college) next.college = college;
  const department = (data.department ?? student.department ?? "").trim();
  if (department) next.department = department;
  const year = data.year ?? student.year;
  if (typeof year === "number") next.year = year;
  const studentId = (data.studentId ?? student.studentId ?? "").trim();
  if (studentId) next.studentId = studentId;
  const designation = (data.designation ?? organizer.designation ?? "").trim();
  if (designation) next.designation = designation;
  const createdBy = data.createdBy ?? data.invitedBy;
  if (createdBy) next.createdBy = createdBy;

  // Is anything actually different?
  const differs = Object.entries(next).some(([key, value]) => {
    const current = data[key];
    if (Array.isArray(value)) return JSON.stringify(asStrings(current)) !== JSON.stringify(value);
    return current !== value;
  });

  summary.byRole[role] = (summary.byRole[role] ?? 0) + 1;

  if (!name) problems.push(`${doc.id} (${data.email ?? "no email"}) has no name — profile marked incomplete`);

  // Claims: role + scope, mirrored from the migrated document. A student
  // carries an empty scope so a stale festIds claim cannot linger.
  // Read first, write nothing yet: the backup must hold the profile AND the claims exactly as they are now.
  let claimsBefore = null;
  let claimsAfter = null;
  try {
    const user = await auth.getUser(doc.id);
    const claims = user.customClaims ?? {};
    const wantMustChange = next.mustChangePassword === true;
    const claimsDiffer =
      claims.role !== role ||
      JSON.stringify(asStrings(claims.festIds)) !== JSON.stringify(festIds) ||
      Boolean(claims.mustChangePassword) !== wantMustChange;
    if (claimsDiffer) {
      summary.claims += 1;
      claimsBefore = claims;
      claimsAfter = { role, festIds, ...(wantMustChange ? { mustChangePassword: true } : {}) };
    }
  } catch (error) {
    const code = error?.errorInfo?.code ?? error?.code ?? "";
    if (code === "auth/user-not-found") {
      problems.push(`${doc.id} (${data.email ?? "no email"}) has a profile but no Auth account`);
    } else {
      summary.failed += 1;
      problems.push(`${doc.id}: ${error?.message ?? error}`);
    }
  }

  if (differs) summary.migrated += 1;
  else summary.unchanged += 1;

  if (!dryRun && (differs || claimsAfter)) {
    // What each field held, for the fields this run changes: `null` in `before` means the field was absent.
    const written = differs ? Object.fromEntries(Object.entries(next).filter(([key, value]) => !sameValue(data[key], value))) : {};
    const before = Object.fromEntries(Object.keys(written).map((key) => [key, data[key] === undefined ? null : data[key]]));
    const absent = Object.keys(written).filter((key) => data[key] === undefined);
    try {
      appendBackupLine(backupPath, { uid: doc.id, written, before, absent, claimsBefore, claimsAfter });
      if (differs) {
        await db.collection("users").doc(doc.id).set({ ...next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      if (claimsAfter) {
        await auth.setCustomUserClaims(doc.id, claimsAfter);
        // Force a token refresh so the new claim is picked up on the next
        // request rather than within the hour. This signs the person out.
        await auth.revokeRefreshTokens(doc.id);
      }
      // Read both back: what is stored must be what was meant to be written.
      const profileAfter = (await db.collection("users").doc(doc.id).get()).data() ?? {};
      const wrong = Object.keys(written).filter((key) => !sameValue(profileAfter[key], written[key]));
      const claimsNow = claimsAfter ? ((await auth.getUser(doc.id)).customClaims ?? {}) : null;
      if (wrong.length || (claimsAfter && !sameValue(claimsNow, claimsAfter))) {
        summary.failed += 1;
        problems.push(`${doc.id}: read-back differs${wrong.length ? ` (fields: ${wrong.join(", ")})` : ""}${claimsAfter && !sameValue(claimsNow, claimsAfter) ? " (claims)" : ""}`);
      }
    } catch (error) {
      summary.failed += 1;
      problems.push(`${doc.id}: ${error?.message ?? error}`);
    }
  }
}

// Auth accounts with no profile document cannot sign in past `authenticate()`;
// report them so a super admin can decide.
const orphans = [];
let pageToken;
do {
  const page = await auth.listUsers(1000, pageToken);
  for (const user of page.users) {
    if (!snapshot.docs.some((d) => d.id === user.uid)) orphans.push(`${user.uid} (${user.email ?? "no email"})`);
  }
  pageToken = page.pageToken;
} while (pageToken);

console.log(`  documents migrated : ${summary.migrated}`);
console.log(`  already current    : ${summary.unchanged}`);
console.log(`  claims refreshed   : ${summary.claims}${summary.claims ? `   (${dryRun ? "these accounts would be signed out" : "these accounts were signed out"} so the new claim applies at once)` : ""}`);
console.log(`  failures           : ${summary.failed}`);
console.log(`  roles              : ${Object.entries(summary.byRole).map(([r, n]) => `${r}=${n}`).join("  ")}`);

if (orphans.length) {
  console.log(`\n  Auth accounts with no profile (${orphans.length}) — they cannot use the app until one exists:`);
  for (const o of orphans.slice(0, 20)) console.log(`    ${o}`);
}

if (problems.length) {
  console.log(`\n  Notes (${problems.length}):`);
  for (const p of problems.slice(0, 20)) console.log(`    ${p}`);
}

console.log(
  dryRun
    ? "\n  Dry run complete. Nothing was changed. To apply: --apply --backup <new file>.\n"
    : summary.migrated + summary.claims === 0
      ? "\n  Done. Nothing needed changing, so no backup file was written.\n"
      : `\n  Done. Backup: ${backupPath}  (profile fields and claims before and after - personal data: keep it private until the rollout is verified, then delete it)\n`,
);
process.exit(summary.failed ? 1 : 0);
