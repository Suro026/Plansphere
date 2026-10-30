// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareRules, indexKey, normalizeRules, planIndexes } from "../../scripts/lib/deploy-plan.mjs";
import type { DeclaredIndex } from "../../scripts/lib/index-probe.mjs";

/**
 * "Deployed" versus "defined locally". `npm run firebase:deploy` now compares first and writes only with --apply; these are
 * the comparisons it prints. Pure functions: the script supplies what the project returned.
 */

describe("rules: is the released ruleset the local file?", () => {
  const local = "rules_version = '2';\nservice cloud.firestore {\n  match /a/{id} { allow read: if true; }\n}\n";

  it("treats line endings and trailing blanks as no change", () => {
    const crlf = local.replace(/\n/g, "\r\n") + "\r\n\r\n";
    const padded = local.replace(/\{ /g, "{ ").split("\n").map((l) => `${l}   `).join("\n");
    expect(compareRules(local, crlf).identical).toBe(true);
    expect(compareRules(local, padded).identical).toBe(true);
    expect(normalizeRules(crlf)).toBe(normalizeRules(local));
  });

  it("counts what is only local and what is only in the release", () => {
    const released = "rules_version = '2';\nservice cloud.firestore {\n  match /old/{id} { allow read: if false; }\n}\n";
    const diff = compareRules(local, released);
    expect(diff.identical).toBe(false);
    expect(diff.released).toBe(true);
    expect(diff.addedLines).toEqual(["  match /a/{id} { allow read: if true; }"]);
    expect(diff.removedLines).toEqual(["  match /old/{id} { allow read: if false; }"]);
    expect(diff.localHash).not.toBe(diff.deployedHash);
    expect(diff.localHash).toHaveLength(12);
  });

  it("says so when nothing is released at all", () => {
    const diff = compareRules(local, null);
    expect(diff.released).toBe(false);
    expect(diff.identical).toBe(false);
    expect(diff.deployedHash).toBeNull();
  });

  it("is identical to itself", () => {
    const real = readFileSync("firestore.rules", "utf8");
    expect(compareRules(real, real).identical).toBe(true);
  });
});

describe("indexes: which declared indexes does the project actually have?", () => {
  const f = (fieldPath: string, order: "ASCENDING" | "DESCENDING" = "ASCENDING") => ({ fieldPath, order });
  const wanted: DeclaredIndex[] = [
    { collectionGroup: "attendance", queryScope: "COLLECTION", fields: [f("festId"), f("scannedAt")] },
    { collectionGroup: "registrations", queryScope: "COLLECTION", fields: [f("eventId"), f("createdAt", "DESCENDING")] },
    { collectionGroup: "users", queryScope: "COLLECTION", fields: [f("role"), f("createdAt", "DESCENDING")] },
    { collectionGroup: "auditLog", queryScope: "COLLECTION", fields: [f("actorId"), f("createdAt", "DESCENDING")] },
  ];

  /** An index as the Firestore Admin API returns it: with its resource name, state, and the implicit __name__ field. */
  const api = (collectionGroup: string, fields: Array<{ fieldPath: string; order?: string; arrayConfig?: string }>, state: string, queryScope = "COLLECTION") => ({
    name: `projects/p/databases/(default)/collectionGroups/${collectionGroup}/indexes/abc123`,
    queryScope,
    fields: [...fields, { fieldPath: "__name__", order: fields.at(-1)?.order ?? "ASCENDING" }],
    state,
  });

  it("sorts every declared index into ready / building / needs repair / missing", () => {
    const plan = planIndexes(wanted, [
      api("attendance", [f("festId"), f("scannedAt")], "READY"),
      api("registrations", [f("eventId"), f("createdAt", "DESCENDING")], "CREATING"),
      api("users", [f("role"), f("createdAt", "DESCENDING")], "NEEDS_REPAIR"),
    ]);
    expect(plan.ready.map((i) => i.collectionGroup)).toEqual(["attendance"]);
    expect(plan.building.map((i) => i.collectionGroup)).toEqual(["registrations"]);
    expect(plan.needsRepair.map((n) => `${n.index.collectionGroup}:${n.state}`)).toEqual(["users:NEEDS_REPAIR"]);
    expect(plan.missing.map((i) => i.collectionGroup)).toEqual(["auditLog"]);
  });

  it("reports indexes the project has that the file does not declare, and never plans to remove them", () => {
    const plan = planIndexes(wanted, [api("attendance", [f("festId"), f("scannedAt")], "READY"), api("legacy", [f("a"), f("b")], "READY")]);
    expect(plan.extra.map((i) => i.collectionGroup)).toEqual(["legacy"]);
    expect(Object.keys(plan)).not.toContain("remove");
  });

  it("matches on collection, fields and direction - the same fields in the other direction is a different index", () => {
    const plan = planIndexes(wanted, [api("registrations", [f("eventId"), f("createdAt", "ASCENDING")], "READY")]);
    expect(plan.ready).toHaveLength(0);
    expect(plan.missing).toHaveLength(wanted.length);
    expect(indexKey("a", [f("x"), f("y")])).not.toBe(indexKey("a", [f("x"), f("y", "DESCENDING")]));
  });

  it("ignores collection-group-scoped indexes, which the file never declares", () => {
    const plan = planIndexes(wanted, [api("attendance", [f("festId"), f("scannedAt")], "READY", "COLLECTION_GROUP")]);
    expect(plan.ready).toHaveLength(0);
  });

  it("an empty project: everything is missing", () => {
    expect(planIndexes(wanted, []).missing).toHaveLength(wanted.length);
  });
});

describe("the deploy script writes nothing without --apply", () => {
  const source = readFileSync("scripts/deploy-firebase.mjs", "utf8");

  it("its default path is read-only and exits before any deploy call", () => {
    const dryRunBranch = source.indexOf("if (!apply) {");
    const firstDeploy = source.indexOf("await deployRuleset(\"firestore\"");
    expect(dryRunBranch).toBeGreaterThan(-1);
    expect(source.slice(dryRunBranch, firstDeploy)).toContain("process.exit(0)");
    // Every write call sits in a function only the apply path reaches.
    // ruleset create, release PATCH, release POST, index create
    expect(source.match(/call\(\s*"(POST|PATCH)"/g)?.length).toBe(4);
    const writes = [...source.matchAll(/call\(\s*"(POST|PATCH)"/g)].map((m) => m.index!);
    for (const at of writes) expect(at).toBeLessThan(dryRunBranch);
  });

  it("selects rules/indexes independently of --apply", () => {
    expect(source).toMatch(/const apply = args\.has\("--apply"\)/);
    expect(source).toMatch(/const doRules = !args\.has\("--indexes"\) \|\| args\.has\("--rules"\)/);
    expect(source).toMatch(/const doIndexes = !args\.has\("--rules"\) \|\| args\.has\("--indexes"\)/);
  });

  it("refuses an unknown option", () => {
    expect(source).toMatch(/Unknown option/);
  });

  it("checks its options before it reads any credential, and keeps --save-rules read-only", () => {
    const run = (...args: string[]) => spawnSync(process.execPath, ["scripts/deploy-firebase.mjs", ...args], { encoding: "utf8", env: { ...process.env, FIREBASE_SERVICE_ACCOUNT: "" } });
    const typo = run("--aply");
    expect(typo.status).toBe(1);
    expect(typo.stderr).toMatch(/Unknown option --aply/);

    const noFile = run("--save-rules");
    expect(noFile.status).toBe(1);
    expect(noFile.stderr).toMatch(/--save-rules needs a file name/);

    const withApply = run("--save-rules", "rules-copy.txt", "--apply");
    expect(withApply.status).toBe(1);
    expect(withApply.stderr).toMatch(/--save-rules is read-only/);

    const existing = run("--save-rules", "firestore.rules");
    expect(existing.status).toBe(1);
    expect(existing.stderr).toMatch(/already exists/);
  });
});
