/**
 * Deploys firestore.rules and firestore.indexes.json using the service
 * account in FIREBASE_SERVICE_ACCOUNT — no `firebase login` needed. File
 * storage is Supabase now, provisioned separately in the Supabase dashboard.
 *
 *   npm run firebase:deploy                       # DRY RUN (the default): compares local with what is deployed, changes nothing
 *   npm run firebase:deploy -- --apply            # deploys rules + indexes
 *   npm run firebase:deploy -- --apply --rules    # rules only
 *   npm run firebase:deploy -- --apply --indexes  # indexes only
 *   npm run firebase:deploy -- --rules --save-rules <file>   # read-only: also saves the released ruleset, the file a rollback redeploys
 *
 * SAFETY (Phase 7). Until now this deployed on a bare `npm run firebase:deploy`. Rules are the access-control boundary of
 * the whole database, so it now reads first and writes only with --apply. The dry run needs read access only and prints:
 *   - rules:   identical to the released ruleset, or how many lines differ (and the hash of each side);
 *   - indexes: for every index in firestore.indexes.json, READY / still building / needs repair / MISSING, plus indexes the
 *              project has that the file does not declare (a deploy never deletes any).
 * It is how you learn what is "deployed" versus merely "defined locally".
 *
 * The index create only ADDS: an existing index is never changed or deleted. A new index builds for a few minutes, during
 * which a query that needs it fails, so deploy indexes BEFORE the code that depends on them.
 * A rules deploy is a new release of the whole ruleset; the previous one stays in Firebase's release history, and
 * rolling back is deploying the previous file.
 *
 * Why not the Firebase CLI: it needs an interactive OAuth sign-in, which does
 * not fit CI or a machine where the developer is not the project owner. The
 * Rules and Firestore Admin REST APIs accept the service account directly.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { compareRules, indexKey, planIndexes } from "./lib/deploy-plan.mjs";
import { describeIndex } from "./lib/index-probe.mjs";
import { loadServiceAccountOrExit } from "./lib/service-account.mjs";

const argv = process.argv.slice(2);
const saveAt = argv.indexOf("--save-rules");
const saveRulesTo = saveAt === -1 ? null : argv[saveAt + 1];
if (saveAt !== -1 && (!saveRulesTo || saveRulesTo.startsWith("--"))) {
  console.error("\n  --save-rules needs a file name.\n");
  process.exit(1);
}
if (saveRulesTo && existsSync(saveRulesTo)) {
  console.error(`\n  ${saveRulesTo} already exists. Pick a new file so an earlier copy is never overwritten.\n`);
  process.exit(1);
}
const args = new Set(argv.filter((a, i) => i !== saveAt + 1 || saveAt === -1));
for (const arg of args) {
  if (!["--apply", "--rules", "--indexes", "--save-rules"].includes(arg)) {
    console.error(`\n  Unknown option ${arg}. Options: --apply, --rules, --indexes, --save-rules <file>.\n`);
    process.exit(1);
  }
}
if (saveRulesTo && args.has("--apply")) {
  console.error("\n  --save-rules is read-only; run it on its own, BEFORE --apply, so there is a copy to roll back to.\n");
  process.exit(1);
}
const apply = args.has("--apply");
const doRules = !args.has("--indexes") || args.has("--rules");
const doIndexes = !args.has("--rules") || args.has("--indexes");

const credentials = { ...loadServiceAccountOrExit(process.env.FIREBASE_SERVICE_ACCOUNT) };

const project = credentials.project_id;

const auth = new GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase"],
});
const client = await auth.getClient();
const { token } = await client.getAccessToken();

const call = async (method, url, body) => {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { ok: response.ok, status: response.status, json };
};

const fail = (message) => {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
};

/* ───────────── rules ───────────── */

/** The source of the ruleset currently released as `releaseName`, null if nothing is released, or {error} if unreadable. */
const readReleasedRules = async (releaseName) => {
  const release = await call("GET", `https://firebaserules.googleapis.com/v1/projects/${project}/releases/${releaseName}`);
  if (release.status === 404) return null;
  if (!release.ok) return { error: `could not read the release (HTTP ${release.status}) ${release.json?.error?.message ?? ""}`.trim() };
  const ruleset = await call("GET", `https://firebaserules.googleapis.com/v1/${release.json.rulesetName}`);
  if (!ruleset.ok) return { error: `could not read the ruleset (HTTP ${ruleset.status}) ${ruleset.json?.error?.message ?? ""}`.trim() };
  return { name: release.json.rulesetName, source: (ruleset.json.source?.files ?? []).map((f) => f.content).join("\n") };
};

const planRules = async (label, fileName, releaseName) => {
  const local = readFileSync(fileName, "utf8");
  const released = await readReleasedRules(releaseName);
  if (released && "error" in released) {
    console.log(`  ${label.padEnd(10)} UNKNOWN   ${released.error}`);
    return;
  }
  // The copy a rollback redeploys. Written only on request, only from a read, and never over an existing file.
  if (saveRulesTo && released) {
    writeFileSync(saveRulesTo, released.source, { flag: "wx" });
    console.log(`  ${label.padEnd(10)} saved     the released ruleset (${released.name.split("/").pop()}) is now in ${saveRulesTo}`);
  }
  const diff = compareRules(local, released ? released.source : null);
  if (!diff.released) console.log(`  ${label.padEnd(10)} NOT RELEASED  nothing is released under ${releaseName}; --apply would create it (local ${diff.localHash})`);
  else if (diff.identical) console.log(`  ${label.padEnd(10)} identical  the released ruleset matches ${fileName} (${diff.localHash})`);
  else {
    console.log(`  ${label.padEnd(10)} DIFFERS    local ${diff.localHash} vs released ${diff.deployedHash}: ${diff.added} line(s) only in the local file, ${diff.removed} only in the released one`);
    console.log("             --apply would release the local file as the new ruleset (the released one stays in Firebase's release history).");
  }
};

const deployRuleset = async (label, fileName, releaseName) => {
  const content = readFileSync(fileName, "utf8");

  const created = await call("POST", `https://firebaserules.googleapis.com/v1/projects/${project}/rulesets`, {
    source: { files: [{ name: fileName, content }] },
  });

  if (!created.ok) {
    const issues = created.json?.error?.details?.flatMap((d) => d.issues ?? []) ?? [];
    for (const issue of issues) {
      console.error(`    ${fileName}:${issue.sourcePosition?.line ?? "?"}  ${issue.description}`);
    }
    fail(`${label}: ruleset rejected (${created.status}) ${created.json?.error?.message ?? ""}`);
  }

  const rulesetName = created.json.name;
  const fullRelease = `projects/${project}/releases/${releaseName}`;

  // PATCH updates an existing release; POST creates it the first time.
  let released = await call(
    "PATCH",
    `https://firebaserules.googleapis.com/v1/${fullRelease}`,
    { release: { name: fullRelease, rulesetName } },
  );

  if (released.status === 404) {
    released = await call("POST", `https://firebaserules.googleapis.com/v1/projects/${project}/releases`, {
      name: fullRelease,
      rulesetName,
    });
  }

  if (!released.ok) {
    fail(`${label}: release failed (${released.status}) ${released.json?.error?.message ?? ""}`);
  }

  console.log(`  ${label.padEnd(10)} deployed  ${rulesetName.split("/").pop()}`);
};

/* ───────────── indexes ───────────── */

const indexBase = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/collectionGroups`;

const listIndexes = async () => {
  const listed = await call("GET", `${indexBase}/-/indexes`);
  if (!listed.ok) return { error: `listing indexes failed (HTTP ${listed.status}) ${listed.json?.error?.message ?? ""}`.trim() };
  return { indexes: listed.json?.indexes ?? [] };
};

const planIndexReport = async () => {
  const wanted = JSON.parse(readFileSync("firestore.indexes.json", "utf8")).indexes ?? [];
  const listed = await listIndexes();
  if (listed.error) {
    console.log(`  indexes    UNKNOWN   ${listed.error}`);
    console.log('             (reading indexes needs the role "Cloud Datastore Viewer" or "Cloud Datastore Index Admin" on the service account)');
    return;
  }
  const plan = planIndexes(wanted, listed.indexes);
  console.log(`  indexes    ${plan.ready.length} READY, ${plan.building.length} building, ${plan.needsRepair.length} needing repair, ${plan.missing.length} MISSING of ${wanted.length} declared; ${plan.extra.length} deployed but not declared`);
  for (const index of plan.missing) console.log(`             MISSING  ${describeIndex(index)}`);
  for (const index of plan.building) console.log(`             building ${describeIndex(index)}`);
  for (const { index, state } of plan.needsRepair) console.log(`             ${state} ${describeIndex(index)}`);
  for (const index of plan.extra) console.log(`             extra    ${describeIndex({ collectionGroup: index.collectionGroup, fields: index.fields })} (${index.state}) - not in firestore.indexes.json; a deploy leaves it alone`);
};

const deployIndexes = async () => {
  const wanted = JSON.parse(readFileSync("firestore.indexes.json", "utf8")).indexes ?? [];

  // What already exists, so we only create what is missing.
  const listed = await listIndexes();
  if (listed.error) fail(listed.error);
  const plan = planIndexes(wanted, listed.indexes);
  const have = new Set([...plan.ready, ...plan.building, ...plan.needsRepair.map((n) => n.index)].map((i) => indexKey(i.collectionGroup, i.fields)));

  let created = 0;
  let present = 0;

  for (const index of wanted) {
    const k = indexKey(index.collectionGroup, index.fields);
    if (have.has(k)) {
      present += 1;
      continue;
    }

    const response = await call("POST", `${indexBase}/${index.collectionGroup}/indexes`, {
      queryScope: index.queryScope ?? "COLLECTION",
      fields: index.fields.map((f) =>
        f.arrayConfig ? { fieldPath: f.fieldPath, arrayConfig: f.arrayConfig } : { fieldPath: f.fieldPath, order: f.order },
      ),
    });

    if (response.status === 409) {
      present += 1;
      continue;
    }
    if (!response.ok) {
      console.error(`    ${index.collectionGroup} ${k}: ${response.json?.error?.message ?? response.status}`);
      continue;
    }
    created += 1;
    console.log(`  index      building  ${index.collectionGroup}: ${index.fields.map((f) => f.fieldPath).join(", ")}`);
  }

  console.log(`  indexes    ${created} created, ${present} already present`);
  if (created) console.log("             new indexes take a few minutes to build; queries using them fail until then");
};

/* ───────────── run ───────────── */

console.log(`\n  Project: ${project}${apply ? "" : "   (dry run - nothing will be changed; add --apply to deploy)"}\n`);

if (!apply) {
  if (doRules) await planRules("firestore", "firestore.rules", "cloud.firestore");
  if (doIndexes) await planIndexReport();
  console.log("\n  Dry run: nothing was changed.\n");
  process.exit(0);
}

if (doRules) {
  await deployRuleset("firestore", "firestore.rules", "cloud.firestore");
}

if (doIndexes) await deployIndexes();

console.log("\n  Done.\n");
process.exit(0);
