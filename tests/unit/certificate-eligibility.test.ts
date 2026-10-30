import { describe, expect, it } from "vitest";
import { computeCertificateEligibility } from "@/core/services/certificate-eligibility";
import { member, publishedResult, registration } from "./fixtures";

const base = { event: { id: "ev1", title: "Capture the Flag", festId: "fest1" }, fest: { id: "fest1", name: "Bits2Bytes" } };

describe("computeCertificateEligibility", () => {
  it("issues nothing to someone who registered but was never scanned", () => {
    const out = computeCertificateEligibility({
      ...base,
      registrations: [registration({ id: "r1" })],
      attendedRegistrationIds: new Set(),
      result: null,
      userIdByEmail: new Map(),
    });
    expect(out.drafts).toHaveLength(0);
    expect(out.summary).toMatchObject({ registrations: 1, attended: 0, absent: 1 });
  });

  it("ignores cancelled entries even when an attendance record exists", () => {
    const out = computeCertificateEligibility({
      ...base,
      registrations: [registration({ id: "r1", status: "cancelled" })],
      attendedRegistrationIds: new Set(["r1"]),
      result: null,
      userIdByEmail: new Map(),
    });
    expect(out.drafts).toHaveLength(0);
  });

  it("grants participation to every attendee when there is no published result", () => {
    const out = computeCertificateEligibility({
      ...base,
      registrations: [registration({ id: "r1" })],
      attendedRegistrationIds: new Set(["r1"]),
      result: { ...publishedResult([{ registrationId: "r1", position: 1 }]), status: "draft" },
      userIdByEmail: new Map(),
    });
    expect(out.drafts.map((d) => d.type)).toEqual(["participation"]);
    expect(out.drafts[0]?.position).toBeUndefined();
  });

  it("upgrades an attendee to the award on a published sheet", () => {
    const out = computeCertificateEligibility({
      ...base,
      registrations: [registration({ id: "r1" }), registration({ id: "r2", userId: "u2", members: [member({ name: "Dev", email: "dev@x.test", userId: "u2", isLeader: true })] })],
      attendedRegistrationIds: new Set(["r1", "r2"]),
      result: publishedResult([{ registrationId: "r2", position: 1 }]),
      userIdByEmail: new Map(),
    });
    const byUser = Object.fromEntries(out.drafts.map((d) => [d.userId, d]));
    expect(byUser.u1).toMatchObject({ type: "participation" });
    expect(byUser.u2).toMatchObject({ type: "winner", position: 1 });
    expect(out.summary.byType.winner).toBe(1);
    expect(out.summary.byType.participation).toBe(1);
  });

  it("gives every team member their own certificate carrying the team name", () => {
    const team = registration({
      id: "r1",
      teamName: "Null Pointers",
      members: [
        member({ name: "Ishita", email: "ishita@x.test", userId: "u1", isLeader: true }),
        member({ name: "Arjun", email: "arjun@x.test", userId: "u2" }),
        member({ name: "Ghost", email: "ghost@x.test" }),
      ],
    });
    const out = computeCertificateEligibility({
      ...base,
      registrations: [team],
      attendedRegistrationIds: new Set(["r1"]),
      result: publishedResult([{ registrationId: "r1", position: 2 }]),
      userIdByEmail: new Map(),
    });
    expect(out.drafts).toHaveLength(2);
    expect(out.drafts.every((d) => d.teamName === "Null Pointers" && d.type === "runner_up")).toBe(true);
    expect(out.unmatched).toEqual([{ name: "Ghost", email: "ghost@x.test", registrationId: "r1", type: "runner_up" }]);
  });

  it("matches a teammate entered by email once they have an account", () => {
    const team = registration({
      id: "r1",
      teamName: "Late Joiners",
      members: [member({ name: "Ishita", email: "ishita@x.test", userId: "u1", isLeader: true }), member({ name: "Priya", email: "Priya@X.test" })],
    });
    const out = computeCertificateEligibility({
      ...base,
      registrations: [team],
      attendedRegistrationIds: new Set(["r1"]),
      result: null,
      userIdByEmail: new Map([["priya@x.test", "u9"]]),
    });
    expect(out.drafts.map((d) => d.userId).sort()).toEqual(["u1", "u9"]);
    expect(out.unmatched).toHaveLength(0);
  });

  it("keeps the strongest award when one person is on two entries", () => {
    const solo = registration({ id: "r1" });
    const team = registration({ id: "r2", userId: "u2", teamName: "Duo", members: [member({ name: "Dev", email: "dev@x.test", userId: "u2", isLeader: true }), member({ name: "Ishita", email: "ishita@x.test", userId: "u1" })] });
    const out = computeCertificateEligibility({
      ...base,
      registrations: [solo, team],
      attendedRegistrationIds: new Set(["r1", "r2"]),
      result: publishedResult([{ registrationId: "r2", position: 1 }]),
      userIdByEmail: new Map(),
    });
    const ishita = out.drafts.filter((d) => d.userId === "u1");
    expect(ishita).toHaveLength(1);
    expect(ishita[0]).toMatchObject({ type: "winner", registrationId: "r2" });
  });
});
