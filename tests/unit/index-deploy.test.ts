// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyIndexes, summariseIndexApply } from "../../scripts/lib/index-deploy.mjs";

/**
 * The index apply must tell the truth. It used to print "Done." and exit 0 while every create was refused (a missing IAM
 * role answers 403 for each index). These drive the same decision the script makes, with the network calls replaced.
 */

const idx = (collectionGroup: string, ...fields: string[]) => ({
  collectionGroup,
  queryScope: "COLLECTION",
  fields: fields.map((fieldPath) => ({ fieldPath, order: "ASCENDING" })),
});

const live = (collectionGroup: string, state: string, ...fields: string[]) => ({
  name: `projects/p/databases/(default)/collectionGroups/${collectionGroup}/indexes/${fields.join("_")}`,
  queryScope: "COLLECTION",
  state,
  fields: [...fields.map((fieldPath) => ({ fieldPath, order: "ASCENDING" })), { fieldPath: "__name__", order: "ASCENDING" }],
});

const wanted = [idx("registrations", "festId", "createdAt"), idx("attendance", "festId", "scannedAt"), idx("certificateEvents", "type", "at")];

describe("applyIndexes", () => {
  it("creates only what is missing and leaves existing indexes alone (even while they build)", async () => {
    const calls: string[] = [];
    const result = await applyIndexes({
      wanted,
      deployed: [live("registrations", "READY", "festId", "createdAt"), live("attendance", "CREATING", "festId", "scannedAt")],
      create: async (index: { collectionGroup: string }) => {
        calls.push(index.collectionGroup);
        return { ok: true, status: 200 };
      },
    });
    expect(calls).toEqual(["certificateEvents"]);
    expect(result).toMatchObject({ created: 1, present: 2, failed: [], needsRepair: [] });
    expect(summariseIndexApply(result).ok).toBe(true);
  });

  it("records every refused create as a failure instead of counting it as done", async () => {
    const result = await applyIndexes({
      wanted,
      deployed: [],
      create: async () => ({ ok: false, status: 403, json: { error: { message: "The caller does not have permission" } } }),
    });
    expect(result.created).toBe(0);
    expect(result.failed).toHaveLength(3);
    expect(result.failed[0]).toMatchObject({ reason: "The caller does not have permission" });

    const summary = summariseIndexApply(result);
    expect(summary.ok).toBe(false);
    expect(summary.lines[0]).toBe("indexes    0 created, 0 already present, 3 FAILED");
    expect(summary.lines.join("\n")).toMatch(/NOT everything was deployed/);
  });

  it("keeps going after one failure and reports a mixed run as unsuccessful", async () => {
    let n = 0;
    const result = await applyIndexes({
      wanted,
      deployed: [],
      create: async () => (++n === 2 ? { ok: false, status: 500, json: null } : { ok: true, status: 200 }),
    });
    expect(result).toMatchObject({ created: 2 });
    expect(result.failed).toEqual([{ key: "attendance|festId:ASCENDING,scannedAt:ASCENDING", reason: "HTTP 500" }]);
    expect(summariseIndexApply(result).ok).toBe(false);
  });

  it("treats a thrown network error as a failure, and 409 (created meanwhile) as present", async () => {
    const result = await applyIndexes({
      wanted: [wanted[0]!, wanted[1]!],
      deployed: [],
      create: async (index: { collectionGroup: string }) => {
        if (index.collectionGroup === "registrations") throw new Error("socket hang up");
        return { ok: false, status: 409 };
      },
    });
    expect(result.failed).toEqual([{ key: "registrations|festId:ASCENDING,createdAt:ASCENDING", reason: "socket hang up" }]);
    expect(result.present).toBe(1);
    expect(summariseIndexApply(result).ok).toBe(false);
  });

  it("reports an index that exists but is broken, and is not a success", async () => {
    const result = await applyIndexes({
      wanted: [wanted[0]!],
      deployed: [live("registrations", "NEEDS_REPAIR", "festId", "createdAt")],
      create: async () => {
        throw new Error("must not be called for an index that already exists");
      },
    });
    expect(result.needsRepair).toEqual([{ key: "registrations|festId:ASCENDING,createdAt:ASCENDING", state: "NEEDS_REPAIR" }]);
    expect(result.created).toBe(0);
    expect(summariseIndexApply(result).ok).toBe(false);
  });

  it("when everything is already deployed it does nothing and succeeds (the 16-index production state)", async () => {
    const result = await applyIndexes({
      wanted,
      deployed: [live("registrations", "READY", "festId", "createdAt"), live("attendance", "READY", "festId", "scannedAt"), live("certificateEvents", "READY", "type", "at")],
      create: async () => {
        throw new Error("nothing should be created");
      },
    });
    expect(result).toMatchObject({ created: 0, present: 3, failed: [], needsRepair: [] });
    expect(summariseIndexApply(result).ok).toBe(true);
  });
});

describe("the deploy script itself", () => {
  it("exits non-zero and never prints Done after a failed index apply", async () => {
    const { readFileSync } = await import("node:fs");
    const script = readFileSync("scripts/deploy-firebase.mjs", "utf8");
    // The apply result decides the exit code; "Done." comes only after the failure branch has exited.
    expect(script).toMatch(/const indexesOk = doIndexes \? await deployIndexes\(\) : true;/);
    expect(script.indexOf("if (!indexesOk)")).toBeGreaterThan(script.indexOf("const indexesOk"));
    expect(script.indexOf("process.exit(1)", script.indexOf("if (!indexesOk)"))).toBeLessThan(script.lastIndexOf("  Done."));
    // Rules failures already end the run through fail(), which exits 1.
    expect(script).toMatch(/const fail = \(message\) => \{[\s\S]*?process\.exit\(1\)/);
  });
});
