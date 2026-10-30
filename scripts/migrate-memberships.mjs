/**
 * Moves pre-membership staff onto event-level memberships.
 *
 *   npm run migrate:memberships                                          # dry run (the default): reads, writes nothing
 *   npm run migrate:memberships -- --report <file.json>                  # ...and saves the plan for review
 *   npm run migrate:memberships -- --apply --backup <file.json>          # make the changes (after review)
 *   npm run migrate:memberships -- --restore <file.json> [--apply]       # recovery: undo what --apply did (dry run without --apply)
 *
 * Until now an admin or volunteer was scoped to a list of fests on their profile (`festIds`): fest-wide, whatever their
 * role. Event roles replace that with one membership per (fest, person) that names the role they hold there and the
 * sub-events and duties they are assigned (see src/core/models/membership.ts). This script proposes a membership for
 * every (person, fest) pair the old scheme gave access to - and never a broader one:
 *
 *   - the account recorded as a fest's owner (`ownerId`) → Event Head of that fest, if it has none yet;
 *   - any other admin → `admin` on every sub-event the fest has today. That is the access they already had. The Event Head
 *     can narrow it afterwards from the Team screen; the script never guesses a narrower scope for anyone;
 *   - a volunteer → `volunteer` on every sub-event, with the duties they had: gate entry and meals, and scoring only if
 *     they hold an active scoring shift in that fest;
 *   - platform accounts (`super_admin`), students and disabled accounts are left alone.
 *
 * Nothing is applied by default. `--apply` needs `--backup <file>`: each person's profile (role, fests, memberships) is
 * written to that file BEFORE anything changes, and an existing file is never overwritten. Per pair, in order:
 *   1. BACKUP   the person's profile as it is now
 *   2. CREATE   `festMembers/{fest}__{uid}` (never over an existing one - a pair that already has a membership is skipped)
 *   3. NARROW   the fest is removed from the person's legacy `festIds` (and the profile's `memberOf` gains it), so the
 *               membership is the whole of their authority there
 *   4. CLAIMS   the sign-in claims are recomputed from the profile and every active membership, never to `super_admin`
 *
 * Idempotent: a second run proposes nothing it already did. The report holds ids and counts, never names or emails.
 * Exit status 0; 2 if anything was a conflict or failed.
 *
 * CLAIMS RECONCILIATION. Step 4 can fail after steps 2-3 committed (an Auth outage, a legacy scope too large for a token).
 * A re-run would skip that pair ("already has a membership"), so the claims would never be repaired. Every run therefore
 * also compares the sign-in claims of everyone who holds a membership with what the profile and memberships imply, reports
 * the drift, and with --apply rewrites it. The claims are built exactly as the app builds them (src/core/claims.ts): up to 8
 * fests are listed in "fm"; more are replaced by "fx", which makes the rules look the membership up. A scope that cannot
 * fit a token at all is reported as failed, never truncated.
 *
 * TOKENS. Claims reach a person only when their token refreshes (within the hour, or at once on the app's self-heal). Until
 * then the OLD token still lists the old fest-wide scope, so a migrated person keeps exactly the reach they had - never more
 * and never less - and a later narrowing by the Event Head applies to the API at once and to direct Firestore access when
 * the token refreshes. The script does not revoke sessions.
 *
 * RECOVERY (--restore). Removes only the memberships this script created (createdBy "migration") that nobody has edited
 * since, puts those fests back on the person's legacy scope, recomputes memberOf and the claims, and leaves everything else
 * alone. A migrated membership that was edited afterwards is reported and kept.
 *
 * ORDER. Deploy the code and firestore.rules first (the rules must understand fm / fx), then run this, then review the
 * "fests with no Event Head" list: a fest whose owner was never recorded gets admins but no head, and the platform assigns
 * one with the fest "transfer" action. See docs/MIGRATIONS.md.
 */

import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { loadServiceAccountOrExit } from "./lib/service-account.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const backupPath = valueOf("--backup");
const reportPath = valueOf("--report");
const restorePath = valueOf("--restore");

if (args.includes("--restore") && (!restorePath || restorePath.startsWith("--"))) {
  console.error("\n  --restore needs the backup file written by an earlier --apply run.\n");
  process.exit(1);
}
if (restorePath && (args.includes("--backup") || args.includes("--report"))) {
  console.error("\n  --restore cannot be combined with --backup or --report.\n");
  process.exit(1);
}
if (restorePath && !existsSync(restorePath)) {
  console.error(`\n  ${restorePath} does not exist.\n`);
  process.exit(1);
}

if (apply && !restorePath && (!backupPath || backupPath.startsWith("--"))) {
  console.error("\n  --apply needs --backup <file.json>: each profile is written there before anything is changed.\n");
  process.exit(1);
}
if (apply && !restorePath && existsSync(backupPath)) {
  console.error(`\n  ${backupPath} already exists. Pick a new file so an earlier backup is never overwritten.\n`);
  process.exit(1);
}
if (reportPath && existsSync(reportPath)) {
  console.error(`\n  ${reportPath} already exists. Pick a new file so an earlier report is never overwritten.\n`);
  process.exit(1);
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

const ROLE_RANK = { student: 0, volunteer: 1, admin: 2, super_admin: 3 };
const normaliseRole = (role) => (role === "organizer" ? "volunteer" : role);
const stringList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
const memberId = (festId, uid) => `${festId}__${uid}`;

// What goes in a token. A copy of src/core/claims.ts (this script runs under plain node); an emulator test pins the two
// together. Firebase caps claims at 1,000 bytes, so many event roles are looked up by the rules instead of listed.
const CLAIMS_BUDGET_BYTES = 900;
const MAX_INLINE_MEMBERSHIPS = 8;
const sizeOf = (claims) => Buffer.byteLength(JSON.stringify(claims), "utf8");
const expectedClaims = (profile, memberships) => {
  const legacy = normaliseRole(profile.role) ?? "student";
  const members = Array.from(new Set(memberships.map((m) => m.festId)));
  const ceiling = memberships.some((m) => ["head", "admin", "coordinator"].includes(m.role)) ? "admin" : memberships.length > 0 ? "volunteer" : undefined;
  // "role" is what the app lets the account into; "br" is what the account itself is, which is what the rules read.
  const base = {
    role: ceiling && ROLE_RANK[legacy] < ROLE_RANK[ceiling] ? ceiling : legacy,
    ...(members.length > 0 ? { br: legacy } : {}),
    festIds: stringList(profile.festIds),
    ...(profile.mustChangePassword === true ? { mustChangePassword: true } : {}),
  };
  if (members.length === 0) {
    if (sizeOf(base) > CLAIMS_BUDGET_BYTES) throw new Error("the legacy fest scope alone is too large for a sign-in token");
    return base;
  }
  const inline = { ...base, fm: members };
  if (members.length <= MAX_INLINE_MEMBERSHIPS && sizeOf(inline) <= CLAIMS_BUDGET_BYTES) return inline;
  const lookup = { ...base, fx: true };
  if (sizeOf(lookup) > CLAIMS_BUDGET_BYTES) throw new Error("the legacy fest scope is too large for a sign-in token");
  return lookup;
};
const canonical = (claims) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(claims ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]),
    ),
  );

const activeMembershipsOf = async (uid) => (await db.collection("festMembers").where("userId", "==", uid).where("status", "==", "active").get()).docs.map((d) => d.data());

/** Compares one account's claims with what its profile and memberships imply. Null when in step; else the claims to write. */
const claimsDrift = async (uid) => {
  const profile = (await db.collection("users").doc(uid).get()).data();
  if (!profile || profile.disabled === true) return { skip: "no profile, or disabled" };
  const user = await auth.getUser(uid).catch(() => null);
  if (!user) return { skip: "no sign-in account" };
  const expected = expectedClaims(profile, await activeMembershipsOf(uid));
  return canonical(expected) === canonical(user.customClaims) ? null : { expected };
};

console.log(`\n  Project: ${account.project_id}${restorePath ? (apply ? "   (RESTORE)" : "   (restore dry run - add --apply to make the changes)") : apply ? "" : "   (dry run - pass --apply --backup <file> to make the changes)"}\n`);

/* ───────────── recovery: undo a previous --apply ───────────── */

if (restorePath) {
  const people = readFileSync(restorePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => typeof entry.uid === "string");
  const tally = { removed: 0, keptEdited: 0, claims: 0, failed: 0 };

  for (const entry of people) {
    const userRef = db.collection("users").doc(entry.uid);
    const created = (await db.collection("festMembers").where("userId", "==", entry.uid).get()).docs.filter((d) => d.data().createdBy === "migration" && d.data().migratedFromLegacy === true);
    const putBack = [];
    for (const doc of created) {
      const m = doc.data();
      // Edited since (the Event Head narrowed it, suspended it, ...): that is later work, not the migration's. Keep it.
      const unchanged = m.createdAt && m.updatedAt && m.createdAt.isEqual(m.updatedAt) && m.status === "active";
      if (!unchanged) {
        tally.keptEdited += 1;
        console.log(`    KEPT     ${entry.uid} @ ${m.festId}: changed since the migration`);
        continue;
      }
      console.log(`    ${apply ? "REMOVE  " : "would remove"} ${entry.uid} @ ${m.festId}`);
      putBack.push(m.festId);
      if (apply) {
        try {
          await doc.ref.delete();
          tally.removed += 1;
        } catch (error) {
          tally.failed += 1;
          console.error(`    FAILED  ${entry.uid} @ ${m.festId}: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
    }
    if (!apply || putBack.length === 0) continue;

    try {
      // Reverse exactly what the migration did to the profile: the fests go back on the legacy scope; the mirror is rebuilt.
      const remaining = await activeMembershipsOf(entry.uid);
      await userRef.set(
        { festIds: FieldValue.arrayUnion(...putBack), memberOf: remaining.map((m) => m.festId), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      const profile = (await userRef.get()).data() ?? {};
      await auth.setCustomUserClaims(entry.uid, expectedClaims(profile, remaining));
      tally.claims += 1;
    } catch (error) {
      tally.failed += 1;
      console.error(`    FAILED  ${entry.uid}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  console.log(`\n  ${apply ? "Removed" : "Would remove"}: ${apply ? tally.removed : "see above"}   kept (edited since): ${tally.keptEdited}   accounts restored: ${tally.claims}   failed: ${tally.failed}`);
  if (!apply) console.log("\n  Dry run: nothing was changed. Re-run with --apply to restore.\n");
  else console.log("\n  People need a fresh sign-in token to see the restored scope: it applies within the hour, or when they next open the app.\n");
  process.exit(tally.failed > 0 ? 2 : 0);
}

/* ───────────── read ───────────── */

const [festSnap, eventSnap, memberSnap, shiftSnap, userSnap] = await Promise.all([
  db.collection("fests").get(),
  db.collection("events").get(),
  db.collection("festMembers").get(),
  db.collection("shifts").where("duty", "==", "scoring").get(),
  db.collection("users").where("role", "in", ["admin", "volunteer", "organizer"]).get(),
]);

const fests = new Map(festSnap.docs.map((doc) => [doc.id, doc.data()]));
const eventsByFest = new Map();
for (const doc of eventSnap.docs) {
  const festId = doc.data().festId;
  if (typeof festId !== "string") continue;
  eventsByFest.set(festId, [...(eventsByFest.get(festId) ?? []), doc.id]);
}
const existing = new Set(memberSnap.docs.map((doc) => doc.id));
const activeHeads = new Set(memberSnap.docs.filter((doc) => doc.data().role === "head" && doc.data().status === "active").map((doc) => doc.data().festId));
const scoring = new Set(shiftSnap.docs.filter((doc) => doc.data().cancelled !== true).map((doc) => `${doc.data().festId}__${doc.data().userId}`));

/* ───────────── plan ───────────── */

const proposals = [];
const skipped = [];
const conflicts = [];
const headsProposed = new Set();

for (const doc of userSnap.docs) {
  const user = doc.data();
  const role = normaliseRole(user.role);
  if (user.disabled === true) {
    skipped.push({ uid: doc.id, reason: "account disabled" });
    continue;
  }
  const festIds = stringList(user.festIds).length > 0 ? stringList(user.festIds) : stringList(user.organizer?.festIds);
  for (const festId of festIds) {
    const fest = fests.get(festId);
    if (!fest) {
      skipped.push({ uid: doc.id, festId, reason: "fest no longer exists" });
      continue;
    }
    if (existing.has(memberId(festId, doc.id))) {
      skipped.push({ uid: doc.id, festId, reason: "already has a membership" });
      continue;
    }

    const events = eventsByFest.get(festId) ?? [];
    const notes = [];
    let festRole;
    let duties = [];
    if (role === "admin" && fest.ownerId === doc.id) {
      if (activeHeads.has(festId) || headsProposed.has(festId)) {
        conflicts.push({ uid: doc.id, festId, reason: "this fest already has an Event Head" });
        continue;
      }
      festRole = "head";
      headsProposed.add(festId);
    } else if (role === "admin") {
      festRole = "admin";
      notes.push("assigned every current sub-event, which is the access they had; the Event Head can narrow it");
    } else {
      festRole = "volunteer";
      duties = ["entry", "meal", ...(scoring.has(`${festId}__${doc.id}`) ? ["scoring"] : [])];
      notes.push("assigned every current sub-event, which is the access they had; the Event Head can narrow it");
    }
    if (festRole !== "head" && events.length === 0) notes.push("the fest has no sub-events yet: nothing is assigned, so assign some when they exist");

    proposals.push({ uid: doc.id, festId, role: festRole, eventCount: festRole === "head" ? 0 : events.length, eventIds: festRole === "head" ? [] : events, duties, notes });
  }
}

/* ───────────── report ───────────── */

const byRole = proposals.reduce((counts, p) => ({ ...counts, [p.role]: (counts[p.role] ?? 0) + 1 }), {});
console.log(`  Staff accounts read:     ${userSnap.size}`);
console.log(`  Memberships proposed:    ${proposals.length}   ${JSON.stringify(byRole)}`);
console.log(`  Already done / skipped:  ${skipped.length}`);
console.log(`  Conflicts:               ${conflicts.length}`);
for (const c of conflicts) console.log(`    CONFLICT  fest ${c.festId}: ${c.reason}`);

// A fest whose owner was never recorded gets admins from this script but no Event Head: the platform assigns one afterwards
// (the fest "transfer" action). Listed here so it is not found by accident.
const headless = [...fests.keys()].filter((id) => !activeHeads.has(id) && !headsProposed.has(id));
console.log(`  Fests with no Event Head after this: ${headless.length}${headless.length ? "   (the platform assigns one - fest 'transfer')" : ""}`);
for (const id of headless) console.log(`    NO HEAD   fest ${id}`);

// Sign-in claims that no longer match the memberships. Re-running cannot repair these (their pair is "already done"), so
// every run looks, and --apply rewrites them.
const staffUids = Array.from(new Set(memberSnap.docs.map((doc) => doc.data().userId).filter((uid) => typeof uid === "string")));
const drift = [];
const driftFailed = [];
for (const uid of staffUids) {
  try {
    const found = await claimsDrift(uid);
    if (found?.expected) drift.push({ uid, expected: found.expected });
  } catch (error) {
    driftFailed.push({ uid, reason: error instanceof Error ? error.message : "unknown error" });
  }
}
console.log(`  Claims out of date:      ${drift.length}${driftFailed.length ? `   (${driftFailed.length} cannot be built)` : ""}`);
for (const f of driftFailed) console.log(`    CANNOT    ${f.uid}: ${f.reason}`);

if (reportPath) {
  writeFileSync(
    reportPath,
    JSON.stringify(
      { project: account.project_id, generatedAt: new Date().toISOString(), summary: { staffAccounts: userSnap.size, proposed: proposals.length, byRole, skipped: skipped.length, conflicts: conflicts.length, claimsOutOfDate: drift.length, festsWithoutHead: headless.length }, proposals: proposals.map((p) => ({ uid: p.uid, festId: p.festId, role: p.role, eventCount: p.eventCount, duties: p.duties, notes: p.notes })), skipped, conflicts, festsWithoutHead: headless, claimsOutOfDate: drift.map((d) => d.uid) },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`\n  Report saved to ${reportPath} (ids and counts only).`);
}

if (!apply) {
  console.log("\n  Dry run: nothing was changed. Review the report, then re-run with --apply --backup <file>.\n");
  process.exit(conflicts.length > 0 || driftFailed.length > 0 ? 2 : 0);
}

/* ───────────── apply ───────────── */

const claimsFor = async (uid) => {
  const profile = (await db.collection("users").doc(uid).get()).data() ?? {};
  await auth.setCustomUserClaims(uid, expectedClaims(profile, await activeMembershipsOf(uid)));
};

const counts = { created: 0, failed: 0 };
const failedUids = new Set();
const backedUp = new Set();
for (const p of proposals) {
  try {
    const userRef = db.collection("users").doc(p.uid);
    const before = (await userRef.get()).data() ?? {};

    // 1. BACKUP, to disk, before any write for this person.
    if (!backedUp.has(p.uid)) {
      appendFileSync(backupPath, `${JSON.stringify({ uid: p.uid, role: before.role ?? null, festIds: stringList(before.festIds), memberOf: stringList(before.memberOf) })}\n`, { mode: 0o600 });
      backedUp.add(p.uid);
      try {
        chmodSync(backupPath, 0o600);
      } catch {
        // Not supported on every platform.
      }
    }

    // 2 + 3. CREATE the membership (never over an existing one) and NARROW the legacy scope, together.
    const ref = db.collection("festMembers").doc(memberId(p.festId, p.uid));
    await db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      if (current.exists) return;
      tx.create(ref, {
        id: ref.id,
        festId: p.festId,
        userId: p.uid,
        role: p.role,
        eventIds: p.eventIds,
        duties: p.duties,
        status: "active",
        createdBy: "migration",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        migratedFromLegacy: true,
      });
      tx.set(userRef, { festIds: FieldValue.arrayRemove(p.festId), memberOf: FieldValue.arrayUnion(p.festId), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });

    // 4. CLAIMS.
    await claimsFor(p.uid);
    counts.created += 1;
  } catch (error) {
    counts.failed += 1;
    failedUids.add(p.uid);
    console.error(`    FAILED  ${p.uid} @ ${p.festId}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

// Reconcile: anyone whose claims still do not match their memberships - a step 4 that failed in an earlier run, or one that
// failed just now (tried once more here). Nothing else about the account is touched.
let repaired = 0;
for (const uid of new Set([...staffUids, ...proposals.map((p) => p.uid)])) {
  try {
    const found = await claimsDrift(uid);
    if (found?.expected) {
      await auth.setCustomUserClaims(uid, found.expected);
      repaired += 1;
    }
  } catch (error) {
    if (!failedUids.has(uid)) counts.failed += 1;
    failedUids.add(uid);
    console.error(`    FAILED  claims for ${uid}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

// Read back what was written: every membership this run was meant to leave must now exist and be active. A write that
// "succeeded" but is not there is reported, and fails the run, instead of being believed.
let verified = 0;
for (const p of proposals) {
  if (failedUids.has(p.uid)) continue;
  const stored = await db.collection("festMembers").doc(memberId(p.festId, p.uid)).get();
  if (stored.exists && stored.data()?.status === "active") {
    verified += 1;
  } else {
    counts.failed += 1;
    console.error(`    NOT VERIFIED  ${p.uid} @ ${p.festId}: no active membership found after the write`);
  }
}

console.log(`\n  Created: ${counts.created}   claims repaired: ${repaired}   read back: ${verified} of ${proposals.length}   failed: ${counts.failed}`);
console.log(`  Profiles backed up to ${backupPath}. It holds role and fest ids: keep it private, delete it when you are done.\n`);
process.exit(conflicts.length > 0 || counts.failed > 0 ? 2 : 0);
