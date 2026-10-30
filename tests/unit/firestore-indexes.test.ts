// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildIndexProbe, describeIndex, isMissingIndexError, missingIndexLink, type DeclaredIndex } from "../../scripts/lib/index-probe.mjs";
import { misnamedStorageVariables } from "@/server/storage/diagnose";
import { validateEnv } from "@/server/env";

/**
 * Composite indexes. A query that filters on one field and orders or ranges on another fails outright in production
 * (FAILED_PRECONDITION) unless that index is deployed, and the Firestore emulator never enforces them - so nothing in the
 * emulator suites would notice a missing one. Found in the Phase 7 audit: the analytics routes filter attendance by
 * `festId`/`eventId` + a `scannedAt` range and certificate events by `type` + an `at` range, and no index was declared for
 * either; the platform analytics route always applies a 30-day range, so it always ran the second one.
 *
 * Phase 8 correction: the range-query shapes also need the index in the ASCENDING direction, which the (createdAt DESC) paging
 * indexes do not provide; seven indexes were missing in production, not three.
 *
 * `QUERY_SHAPES` is the audited list of every server query that needs a composite index, with the code that issues it.
 * Adding such a query means adding a row here AND the index to firestore.indexes.json.
 */

const declared = JSON.parse(readFileSync("firestore.indexes.json", "utf8")).indexes as DeclaredIndex[];

interface Shape {
  /** Where the query lives. */
  site: string;
  collection: string;
  /** Equality (or array-contains) filters. */
  equal: string[];
  /** The field the query orders or ranges on. */
  ordered: string;
  /**
   * The direction that field is read in. A range filter with no orderBy reads ASCENDING; the paged lists say `orderBy(.., "desc")`.
   * Firestore does NOT serve one from an index declared the other way round - found in the Phase 8 production probes: the
   * registrations indexes declared createdAt DESCENDING did not serve the analytics range query.
   */
  direction: "ASCENDING" | "DESCENDING";
}

const ASC = "ASCENDING" as const;
const DESC = "DESCENDING" as const;

const QUERY_SHAPES: Shape[] = [
  // Paged lists and recent-first views: orderBy(createdAt, "desc").
  { site: "registration-repository paged list", collection: "registrations", equal: ["festId"], ordered: "createdAt", direction: DESC },
  { site: "registration-repository paged list", collection: "registrations", equal: ["eventId"], ordered: "createdAt", direction: DESC },
  { site: "registration-repository paged list with a status filter", collection: "registrations", equal: ["festId", "status"], ordered: "createdAt", direction: DESC },
  { site: "registration-repository paged list with a status filter", collection: "registrations", equal: ["eventId", "status"], ordered: "createdAt", direction: DESC },
  { site: "api/admin/platform (admins and super admins, newest first)", collection: "users", equal: ["role"], ordered: "createdAt", direction: DESC },
  { site: "api/admin/platform/audit (one filter at a time)", collection: "auditLog", equal: ["festId"], ordered: "createdAt", direction: DESC },
  { site: "api/admin/platform/audit; api/admin/platform/activity", collection: "auditLog", equal: ["actorId"], ordered: "createdAt", direction: DESC },
  { site: "api/admin/platform/audit", collection: "auditLog", equal: ["action"], ordered: "createdAt", direction: DESC },
  // Date-range reads with no orderBy (src/server/fest-analytics.ts applyRange): ascending.
  { site: "fest-analytics.ts:126 registrations of a fest in a date range", collection: "registrations", equal: ["festId"], ordered: "createdAt", direction: ASC },
  { site: "fest-analytics.ts:126 registrations of one event in a date range", collection: "registrations", equal: ["eventId"], ordered: "createdAt", direction: ASC },
  { site: "fest-analytics.ts:126 registrations of one event of a fest in a date range", collection: "registrations", equal: ["festId", "eventId"], ordered: "createdAt", direction: ASC },
  { site: "fest-analytics.ts:130 attendance of a fest in a date range", collection: "attendance", equal: ["festId"], ordered: "scannedAt", direction: ASC },
  { site: "fest-analytics.ts:130 attendance of one event in a date range", collection: "attendance", equal: ["eventId"], ordered: "scannedAt", direction: ASC },
  { site: "fest-analytics.ts:130 attendance of one event of a fest in a date range", collection: "attendance", equal: ["festId", "eventId"], ordered: "scannedAt", direction: ASC },
  { site: "fest-analytics.ts:319 certificate downloads/verifications in a date range (always, on platform analytics)", collection: "certificateEvents", equal: ["type"], ordered: "at", direction: ASC },
];

const indexFor = (collection: string, fields: string[], direction: Shape["direction"]) =>
  declared.some(
    (i) => i.collectionGroup === collection && i.fields.map((f) => f.fieldPath).join(",") === fields.join(",") && i.fields.at(-1)!.order === direction,
  );

describe("every audited composite-index query has its index declared, in the direction the query reads", () => {
  for (const shape of QUERY_SHAPES) {
    it(`${shape.collection}(${shape.equal.join(", ")} + ${shape.ordered} ${shape.direction}) - ${shape.site}`, () => {
      // One index over all the equality fields (the one the production probe confirms), not left to index merging.
      expect(indexFor(shape.collection, [...shape.equal, shape.ordered], shape.direction)).toBe(true);
    });
  }

  it("an index declared one way does not satisfy a query that reads the other way", () => {
    // The registrations (festId, createdAt DESC) index is declared, and the ascending range query is not covered by it.
    expect(indexFor("registrations", ["festId", "createdAt"], DESC)).toBe(true);
    expect(indexFor("registrations", ["festId", "createdAt"], ASC)).toBe(true); // ...so the ascending one is declared separately
    expect(declared.filter((i) => i.collectionGroup === "registrations" && i.fields.map((f) => f.fieldPath).join(",") === "festId,createdAt")).toHaveLength(2);
  });
});

describe("firestore.indexes.json is well formed", () => {
  it("has no duplicate index and every index ends in an ordered field the probe can sort by", () => {
    const keys = declared.map(describeIndex);
    expect(new Set(keys).size).toBe(keys.length);
    for (const index of declared) {
      expect(index.fields.length, describeIndex(index)).toBeGreaterThanOrEqual(2);
      expect(index.fields.at(-1)!.order, describeIndex(index)).toBeDefined();
    }
  });
});

/** A recording stand-in for a Firestore query. */
interface RecordedQuery {
  where(field: string, op: string, value: unknown): RecordedQuery;
  orderBy(field: string, direction?: string): RecordedQuery;
  limit(n: number): RecordedQuery;
}

const recorder = () => {
  const calls: string[] = [];
  const query: RecordedQuery = {
    where: (f, op, v) => (calls.push(`where ${f} ${op} ${String(v)}`), query),
    orderBy: (f, d) => (calls.push(`orderBy ${f} ${d ?? "asc"}`), query),
    limit: (n) => (calls.push(`limit ${n}`), query),
  };
  return { query, calls };
};

describe("the probe built from a declared index (used by /api/health and verify:infra)", () => {
  it("probes equality fields, then orders by the last ordered field", () => {
    const { query, calls } = recorder();
    buildIndexProbe(() => query, { collectionGroup: "attendance", fields: [{ fieldPath: "festId", order: "ASCENDING" }, { fieldPath: "scannedAt", order: "ASCENDING" }] });
    expect(calls).toEqual(["where festId == _probe_", "orderBy scannedAt asc", "limit 1"]);
  });

  it("handles three fields, a descending order and an array field", () => {
    const three = recorder();
    buildIndexProbe(() => three.query, { collectionGroup: "registrations", fields: [{ fieldPath: "eventId", order: "ASCENDING" }, { fieldPath: "status", order: "ASCENDING" }, { fieldPath: "createdAt", order: "DESCENDING" }] });
    expect(three.calls).toEqual(["where eventId == _probe_", "where status == _probe_", "orderBy createdAt desc", "limit 1"]);

    const arr = recorder();
    buildIndexProbe(() => arr.query, { collectionGroup: "users", fields: [{ fieldPath: "festIds", arrayConfig: "CONTAINS" }, { fieldPath: "createdAt", order: "DESCENDING" }] });
    expect(arr.calls).toEqual(["where festIds array-contains _probe_", "orderBy createdAt desc", "limit 1"]);
  });

  it("builds a probe for every declared index, so none is left unchecked", () => {
    for (const index of declared) {
      const { query, calls } = recorder();
      buildIndexProbe(() => query, index);
      expect(calls.filter((c) => c.startsWith("orderBy")), describeIndex(index)).toHaveLength(1);
      expect(calls.at(-1)).toBe("limit 1");
    }
  });

  it("/api/health probes the declared list from the file, not a hand-written subset", () => {
    const route = readFileSync("src/app/api/health/route.ts", "utf8");
    expect(route).toContain('from "../../../../firestore.indexes.json"');
    expect(route).toMatch(/for \(const index of declared\)/);
    // The five hard-coded probes it used to carry are gone.
    expect(route).not.toContain("registrations festId+createdAt");
  });

  it("recognises a missing-index error and extracts the console link without needing the exact wording", () => {
    expect(isMissingIndexError({ code: 9, message: "9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/p/firestore/indexes?create_composite=abc" })).toBe(true);
    expect(isMissingIndexError(new Error("PERMISSION_DENIED: missing permission"))).toBe(false);
    expect(missingIndexLink("blah https://console.firebase.google.com/v1/r/x?create_composite=abc more")).toBe("https://console.firebase.google.com/v1/r/x?create_composite=abc");
    expect(missingIndexLink("no link")).toBeNull();
  });
});

describe("Supabase variables set under names the app never reads", () => {
  it("names them (never the values) only when the real pair is absent", () => {
    expect(misnamedStorageVariables({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" })).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    ]);
    expect(misnamedStorageVariables({})).toEqual([]);
    // The real pair (or either of it) set: not this problem - half-configured has its own diagnosis.
    expect(misnamedStorageVariables({ SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" })).toEqual([]);
  });

  it("is reported by the environment check as a warning that does not echo the value", () => {
    const report = validateEnv({
      NODE_ENV: "development",
      NEXT_PUBLIC_SUPABASE_URL: "https://secret-looking-ref.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_VALUE",
    } as unknown as NodeJS.ProcessEnv);
    const issue = report.issues.find((i) => i.message.includes("uploads are off"));
    expect(issue?.level).toBe("warning");
    expect(issue?.message).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(JSON.stringify(report)).not.toContain("secret-looking-ref");
    expect(JSON.stringify(report)).not.toContain("sb_publishable_VALUE");
  });
});
