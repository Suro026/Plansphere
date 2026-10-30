/**
 * What would `npm run firebase:deploy` change? Pure comparisons, shared by the script (which does the reading) and its tests.
 *
 *   - rules:   the local `firestore.rules` against the ruleset currently released as `cloud.firestore`;
 *   - indexes: the local `firestore.indexes.json` against the composite indexes the project actually has, and their state.
 *
 * Nothing here talks to the network and nothing here prints a secret: rules and index definitions are configuration.
 */

import { createHash } from "node:crypto";

/** Line endings and trailing blanks are not a change. */
export const normalizeRules = (text) =>
  String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");

const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * @param {string} local     the local rules file
 * @param {string | null} deployed  the released ruleset's source, or null when none is released
 */
export const compareRules = (local, deployed) => {
  const a = normalizeRules(local);
  if (deployed === null || deployed === undefined) {
    return { identical: false, released: false, localHash: hash(a), deployedHash: null, added: a.split("\n").length, removed: 0, addedLines: [], removedLines: [] };
  }
  const b = normalizeRules(deployed);
  const localLines = a.split("\n");
  const deployedLines = b.split("\n");
  const inDeployed = new Set(deployedLines.map((l) => l.trim()).filter(Boolean));
  const inLocal = new Set(localLines.map((l) => l.trim()).filter(Boolean));
  // Lines are compared as sets: this says "what is new here / gone from there", not a positional diff. Good enough to
  // show the size of the change; the hash says whether there is one.
  const addedLines = localLines.filter((l) => l.trim() && !inDeployed.has(l.trim()));
  const removedLines = deployedLines.filter((l) => l.trim() && !inLocal.has(l.trim()));
  return {
    identical: a === b,
    released: true,
    localHash: hash(a),
    deployedHash: hash(b),
    added: addedLines.length,
    removed: removedLines.length,
    addedLines,
    removedLines,
  };
};

/** `attendance|festId:ASCENDING,scannedAt:ASCENDING` - the identity of a composite index, without its id or state. */
export const indexKey = (collectionGroup, fields) =>
  `${collectionGroup}|${fields.map((f) => `${f.fieldPath}:${f.order ?? (f.arrayConfig ? "CONTAINS" : "")}`).join(",")}`;

/** The collection group and the user-defined fields of an index as the Firestore Admin API returns it. */
const fromApi = (index) => ({
  collectionGroup: index.name.split("/collectionGroups/")[1].split("/")[0],
  fields: (index.fields ?? []).filter((f) => f.fieldPath !== "__name__"),
  state: index.state ?? "STATE_UNSPECIFIED",
  scope: index.queryScope,
});

/**
 * @param {Array<{collectionGroup: string, fields: Array<{fieldPath: string, order?: string, arrayConfig?: string}>}>} wanted
 * @param {Array<object>} deployedApi  `indexes` from the Admin API list response
 */
export const planIndexes = (wanted, deployedApi) => {
  const deployed = deployedApi.map(fromApi).filter((i) => i.scope === "COLLECTION");
  const byKey = new Map(deployed.map((i) => [indexKey(i.collectionGroup, i.fields), i]));
  const plan = { ready: [], building: [], needsRepair: [], missing: [], extra: [] };
  for (const index of wanted) {
    const found = byKey.get(indexKey(index.collectionGroup, index.fields));
    if (!found) plan.missing.push(index);
    else if (found.state === "READY") plan.ready.push(index);
    else if (found.state === "CREATING") plan.building.push(index);
    else plan.needsRepair.push({ index, state: found.state });
  }
  const wantedKeys = new Set(wanted.map((i) => indexKey(i.collectionGroup, i.fields)));
  plan.extra = deployed.filter((i) => !wantedKeys.has(indexKey(i.collectionGroup, i.fields)));
  return plan;
};
