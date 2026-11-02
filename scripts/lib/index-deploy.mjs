import { indexKey, planIndexes } from "./deploy-plan.mjs";

/**
 * Applying `firestore.indexes.json` to a project, with an honest outcome.
 *
 * The script used to print "Done." and exit 0 even when every create was refused (a missing IAM role answers 403 for each
 * index), so a pipeline reading the exit code believed the indexes existed. This keeps the decision in one pure place, with
 * the network calls injected, so a test can drive it with failures:
 *
 *   - an index that already exists (any state) is never created again, deleted or changed;
 *   - a refused or failed create is recorded in `failed` with the reason, and the run continues with the rest;
 *   - an index that exists but is in an error state (not READY, not CREATING) is reported as `needsRepair`;
 *   - the run is only a success when nothing failed and nothing needs repair.
 *
 * @param {object} input
 * @param {Array<{collectionGroup: string, queryScope?: string, fields: Array<{fieldPath: string, order?: string, arrayConfig?: string}>}>} input.wanted
 * @param {Array<object>} input.deployed  `indexes` from the Admin API list response
 * @param {(index: any) => Promise<{ok: boolean, status: number, json?: any}>} input.create  POSTs one index
 * @param {(line: string) => void} [input.log]
 */
export const applyIndexes = async ({ wanted, deployed, create, log = () => {} }) => {
  const plan = planIndexes(wanted, deployed);
  const have = new Set([...plan.ready, ...plan.building, ...plan.needsRepair.map((n) => n.index)].map((i) => indexKey(i.collectionGroup, i.fields)));

  const result = { created: 0, present: 0, failed: [], needsRepair: plan.needsRepair.map((n) => ({ key: indexKey(n.index.collectionGroup, n.index.fields), state: n.state })) };

  for (const index of wanted) {
    const key = indexKey(index.collectionGroup, index.fields);
    if (have.has(key)) {
      result.present += 1;
      continue;
    }

    let response;
    try {
      response = await create(index);
    } catch (error) {
      result.failed.push({ key, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    // 409: someone created it between the listing and now. Present, not an error.
    if (response.status === 409) {
      result.present += 1;
      continue;
    }
    if (!response.ok) {
      result.failed.push({ key, reason: response.json?.error?.message ?? `HTTP ${response.status}` });
      continue;
    }
    result.created += 1;
    log(`index      building  ${index.collectionGroup}: ${index.fields.map((f) => f.fieldPath).join(", ")}`);
  }

  return result;
};

/** The lines the script prints after an apply, and whether it succeeded. Never says "Done" for a run with failures. */
export const summariseIndexApply = (result) => {
  const ok = result.failed.length === 0 && result.needsRepair.length === 0;
  const lines = [`indexes    ${result.created} created, ${result.present} already present, ${result.failed.length} FAILED`];
  for (const f of result.failed) lines.push(`           FAILED   ${f.key}: ${f.reason}`);
  for (const r of result.needsRepair) lines.push(`           ${r.state}  ${r.key} exists but is not usable; delete and recreate it from the console`);
  if (result.created) lines.push("           new indexes take a few minutes to build; queries using them fail until then");
  if (!ok) lines.push("           NOT everything was deployed. The exit code is non-zero; fix the cause above and run it again (existing indexes are left alone).");
  return { ok, lines };
};
