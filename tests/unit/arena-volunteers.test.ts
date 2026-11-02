import { describe, expect, it } from "vitest";
import { scorerSource } from "@/core/arena-volunteers";

const member = (over: Partial<{ role: "head" | "admin" | "coordinator" | "volunteer"; duties: Array<"entry" | "meal" | "scoring">; status: "active" | "suspended" | "revoked" }> = {}) => ({ role: "volunteer" as const, duties: ["scoring" as const], status: "active" as const, ...over });

describe("who may be rostered at an arena (scorerSource)", () => {
  it("accepts an event-role volunteer with the scoring duty, whatever the profile's own role and fest list", () => {
    expect(scorerSource("f1", { role: "student", festIds: [] }, member())).toBe("event");
    expect(scorerSource("f1", { role: "volunteer", festIds: ["f2"] }, member())).toBe("event");
  });

  it("accepts a fest-scoped volunteer with no membership on the fest, including the old 'organizer' role name", () => {
    expect(scorerSource("f1", { role: "volunteer", festIds: ["f1"] }, null)).toBe("fest");
    expect(scorerSource("f1", { role: "organizer", festIds: ["f1", "f2"] }, undefined)).toBe("fest");
  });

  it("lets an active membership govern: a fest-scoped volunteer whose membership lacks the scoring duty is not offered", () => {
    expect(scorerSource("f1", { role: "volunteer", festIds: ["f1"] }, member({ duties: ["entry", "meal"] }))).toBeNull();
    expect(scorerSource("f1", { role: "volunteer", festIds: ["f1"] }, member({ duties: [] }))).toBeNull();
  });

  it("reads a suspended or revoked membership as absent, which leaves the legacy scope as it was", () => {
    expect(scorerSource("f1", { role: "student", festIds: [] }, member({ status: "suspended" }))).toBeNull();
    expect(scorerSource("f1", { role: "student", festIds: [] }, member({ status: "revoked" }))).toBeNull();
    expect(scorerSource("f1", { role: "volunteer", festIds: ["f1"] }, member({ status: "revoked" }))).toBe("fest");
  });

  it("refuses roles that score without a shift or are not volunteers at all: head, admin, coordinator, platform, student", () => {
    for (const role of ["head", "admin", "coordinator"] as const) expect(scorerSource("f1", { role: "student", festIds: [] }, member({ role }))).toBeNull();
    expect(scorerSource("f1", { role: "admin", festIds: ["f1"] }, null)).toBeNull();
    expect(scorerSource("f1", { role: "super_admin", festIds: [] }, null)).toBeNull();
    expect(scorerSource("f1", { role: "super_admin", festIds: ["f1"] }, member())).toBeNull();
    expect(scorerSource("f1", { role: "student", festIds: ["f1"] }, null)).toBeNull();
  });

  it("refuses a volunteer scoped to another fest, a disabled account and a missing profile", () => {
    expect(scorerSource("f1", { role: "volunteer", festIds: ["f2"] }, null)).toBeNull();
    expect(scorerSource("f1", { role: "volunteer", festIds: ["f1"], disabled: true }, null)).toBeNull();
    expect(scorerSource("f1", { role: "student", festIds: [], disabled: true }, member())).toBeNull();
    expect(scorerSource("f1", undefined, member())).toBeNull();
    expect(scorerSource("f1", null, null)).toBeNull();
  });

  it("tolerates a malformed festIds field", () => {
    expect(scorerSource("f1", { role: "volunteer", festIds: "f1" }, null)).toBeNull();
    expect(scorerSource("f1", { role: "volunteer" }, null)).toBeNull();
  });
});
