import { describe, expect, it } from "vitest";
import { OPEN_BOUNDARY, PLATFORM_DENIAL_MESSAGES, decidePlatform, readBoundary, type PlatformBoundary } from "@/core/platform";

/**
 * The platform boundary's decision, as a table. `firestore.rules` (`platformOk()`) implements the same table and
 * tests/emulator/platform-boundary.test.ts runs the same rows against it, so the API and the rules cannot drift apart.
 */

const enforced: PlatformBoundary = { enforce: true, requireMfa: false };
const withMfa: PlatformBoundary = { enforce: true, requireMfa: true };

describe("decidePlatform", () => {
  it("lets every super admin through while the boundary is not enforced - the behaviour before it existed", () => {
    expect(decidePlatform({ boundary: OPEN_BOUNDARY, staff: null })).toEqual({ ok: true });
    expect(decidePlatform({ boundary: { enforce: false, requireMfa: true }, staff: null })).toEqual({ ok: true });
    expect(decidePlatform({ boundary: OPEN_BOUNDARY, staff: { status: "removed" } })).toEqual({ ok: true });
  });

  it.each([
    ["no registry entry", null, undefined, { ok: false, reason: "not-registered" }],
    ["an active entry", { status: "active" }, undefined, { ok: true }],
    ["a suspended entry", { status: "suspended" }, undefined, { ok: false, reason: "suspended" }],
    ["a removed entry", { status: "removed" }, undefined, { ok: false, reason: "not-registered" }],
    ["an entry with no status", {}, undefined, { ok: false, reason: "not-registered" }],
    ["an entry with a status nobody defined", { status: "admin" }, undefined, { ok: false, reason: "not-registered" }],
  ] as const)("enforced, %s", (_name, staff, secondFactor, expected) => {
    expect(decidePlatform({ boundary: enforced, staff, secondFactor })).toEqual(expected);
  });

  it("does not need a second factor unless it is required", () => {
    expect(decidePlatform({ boundary: enforced, staff: { status: "active" }, secondFactor: undefined })).toEqual({ ok: true });
    expect(decidePlatform({ boundary: enforced, staff: { status: "active" }, secondFactor: "totp" })).toEqual({ ok: true });
  });

  it("requires one when the boundary says so: registered is not enough on its own", () => {
    expect(decidePlatform({ boundary: withMfa, staff: { status: "active" } })).toEqual({ ok: false, reason: "second-factor-required" });
    expect(decidePlatform({ boundary: withMfa, staff: { status: "active" }, secondFactor: null })).toEqual({ ok: false, reason: "second-factor-required" });
    expect(decidePlatform({ boundary: withMfa, staff: { status: "active" }, secondFactor: "" })).toEqual({ ok: false, reason: "second-factor-required" });
    expect(decidePlatform({ boundary: withMfa, staff: { status: "active" }, secondFactor: "totp" })).toEqual({ ok: true });
  });

  it("and a second factor does not stand in for being registered", () => {
    expect(decidePlatform({ boundary: withMfa, staff: null, secondFactor: "totp" })).toEqual({ ok: false, reason: "not-registered" });
    expect(decidePlatform({ boundary: withMfa, staff: { status: "suspended" }, secondFactor: "totp" })).toEqual({ ok: false, reason: "suspended" });
  });

  it("has a message for every refusal", () => {
    for (const reason of ["not-registered", "suspended", "second-factor-required"] as const) expect(PLATFORM_DENIAL_MESSAGES[reason].length).toBeGreaterThan(10);
  });
});

describe("readBoundary", () => {
  it("reads only an explicit true, so a missing or malformed document is not enforcement", () => {
    expect(readBoundary(undefined)).toEqual(OPEN_BOUNDARY);
    expect(readBoundary(null)).toEqual(OPEN_BOUNDARY);
    expect(readBoundary({})).toEqual(OPEN_BOUNDARY);
    expect(readBoundary({ enforce: "true", requireMfa: 1 })).toEqual(OPEN_BOUNDARY);
    expect(readBoundary({ enforce: true })).toEqual({ enforce: true, requireMfa: false });
    expect(readBoundary({ enforce: true, requireMfa: true })).toEqual({ enforce: true, requireMfa: true });
  });
});
