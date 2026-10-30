import { describe, expect, it } from "vitest";
import { decideAccess, festAccess, reachableFestIds, type AccessSubject } from "@/core/access";
import {
  ASSIGNABLE_ROLES,
  FEST_ROLES,
  FEST_ROLE_PERMISSIONS,
  MEMBER_NAV,
  PLATFORM_ROLE,
  assignMemberSchema,
  memberCan,
  memberCeiling,
  memberCoversEvent,
  membershipIdFor,
} from "@/core/models/membership";
import { PERMISSIONS, type Permission } from "@/core/permissions";

const head = { role: "head" as const, eventIds: [], duties: [] };
const admin = (eventIds: string[]) => ({ role: "admin" as const, eventIds, duties: [] });
const coordinator = (eventIds: string[]) => ({ role: "coordinator" as const, eventIds, duties: [] });
const volunteer = (eventIds: string[], duties: Array<"entry" | "meal" | "scoring">) => ({ role: "volunteer" as const, eventIds, duties });

const subject = (over: Partial<AccessSubject> = {}): AccessSubject => ({ role: "student", festIds: [], memberships: {}, ...over });

describe("the roles an event can give", () => {
  it("has exactly one head role, which can never be handed out through the members API", () => {
    expect(FEST_ROLES.filter((r) => r === "head")).toHaveLength(1);
    expect(ASSIGNABLE_ROLES).not.toContain("head");
    const parsed = assignMemberSchema.safeParse({ email: "a@b.co", role: "head", eventIds: ["e1"] });
    expect(parsed.success).toBe(false);
  });

  it("never produces the platform's role, however many memberships someone holds", () => {
    expect(memberCeiling([{ role: "head" }, { role: "admin" }, { role: "coordinator" }, { role: "volunteer" }])).toBe("admin");
    expect(memberCeiling([{ role: "volunteer" }])).toBe("volunteer");
    expect(memberCeiling([])).toBeUndefined();
    expect([memberCeiling([{ role: "head" }]), memberCeiling([{ role: "volunteer" }])]).not.toContain(PLATFORM_ROLE);
    expect(PLATFORM_ROLE).toBe("super_admin");
  });

  it("gives no member role a power that belongs to the platform", () => {
    const platformOnly: Permission[] = ["fest:create", "fest:delete", "fest:archive", "fest:transfer", "fest:configureRegistration", "certificate:publish", "staff:createAdmin", "platform:manage", "payment:approve", "fest:verify"];
    for (const role of ["head", "admin", "coordinator"] as const) {
      for (const permission of platformOnly) expect(FEST_ROLE_PERMISSIONS[role].has(permission), `${role} ${permission}`).toBe(false);
    }
    for (const duties of [["entry"], ["meal"], ["scoring"], ["entry", "meal", "scoring"]] as const) {
      for (const permission of platformOnly) expect(memberCan({ role: "volunteer", duties: [...duties] }, permission)).toBe(false);
    }
  });

  it("limits a volunteer to the duties assigned: each duty unlocks one permission and nothing else", () => {
    expect(memberCan({ role: "volunteer", duties: ["entry"] }, "attendance:scan")).toBe(true);
    expect(memberCan({ role: "volunteer", duties: ["entry"] }, "meal:scan")).toBe(false);
    expect(memberCan({ role: "volunteer", duties: ["meal"] }, "meal:scan")).toBe(true);
    expect(memberCan({ role: "volunteer", duties: ["meal"] }, "attendance:scan")).toBe(false);
    expect(memberCan({ role: "volunteer", duties: ["scoring"] }, "match:score")).toBe(true);
    expect(memberCan({ role: "volunteer", duties: [] }, "attendance:scan")).toBe(false);
    for (const permission of PERMISSIONS) {
      if (["attendance:scan", "meal:scan", "match:score"].includes(permission)) continue;
      expect(memberCan({ role: "volunteer", duties: ["entry", "meal", "scoring"] }, permission), permission).toBe(false);
    }
  });

  it("lets a volunteer read no registrations, however they are assigned", () => {
    expect(memberCan({ role: "volunteer", duties: ["entry", "meal", "scoring"] }, "registration:read")).toBe(false);
    expect(memberCan({ role: "volunteer", duties: ["entry", "meal", "scoring"] }, "registration:manage")).toBe(false);
  });

  it("makes a coordinator narrower than an admin, and an admin narrower than the head", () => {
    for (const permission of FEST_ROLE_PERMISSIONS.coordinator) expect(FEST_ROLE_PERMISSIONS.admin.has(permission), permission).toBe(true);
    for (const permission of FEST_ROLE_PERMISSIONS.admin) expect(FEST_ROLE_PERMISSIONS.head.has(permission), permission).toBe(true);
    expect(FEST_ROLE_PERMISSIONS.admin.has("member:manage")).toBe(false);
    expect(FEST_ROLE_PERMISSIONS.admin.has("member:assignVolunteer")).toBe(true);
    expect(FEST_ROLE_PERMISSIONS.coordinator.has("member:assignVolunteer")).toBe(false);
    expect(FEST_ROLE_PERMISSIONS.head.has("member:manage")).toBe(true);
  });

  it("covers every sub-event for the head and only the assigned ones for everyone else", () => {
    expect(memberCoversEvent(head, "anything")).toBe(true);
    expect(memberCoversEvent(admin(["e1"]), "e1")).toBe(true);
    expect(memberCoversEvent(admin(["e1"]), "e2")).toBe(false);
    expect(memberCoversEvent(admin([]), "e1")).toBe(false);
  });

  it("names a membership by fest and person, so there can only be one per pair", () => {
    expect(membershipIdFor("f1", "u1")).toBe("f1__u1");
    expect(membershipIdFor("f1", "u1")).not.toBe(membershipIdFor("f2", "u1"));
  });

  it("shows each role only the sections it can use", () => {
    expect(MEMBER_NAV.volunteer).toEqual(["overview"]);
    for (const role of ["admin", "coordinator", "volunteer"] as const) {
      for (const section of ["settings", "staff", "analytics", "arenas", "gate"]) expect(MEMBER_NAV[role], `${role} ${section}`).not.toContain(section);
    }
    expect(MEMBER_NAV.head).toContain("team");
    expect(MEMBER_NAV.admin).toContain("team");
    expect(MEMBER_NAV.coordinator).not.toContain("team");
  });
});

describe("assigning someone", () => {
  it("needs at least one competition, and a duty for a volunteer but not for anyone else", () => {
    expect(assignMemberSchema.safeParse({ email: "a@b.co", role: "admin", eventIds: [] }).success).toBe(false);
    expect(assignMemberSchema.safeParse({ email: "a@b.co", role: "volunteer", eventIds: ["e1"], duties: [] }).success).toBe(false);
    expect(assignMemberSchema.safeParse({ email: "a@b.co", role: "admin", eventIds: ["e1"], duties: ["entry"] }).success).toBe(false);
    expect(assignMemberSchema.safeParse({ email: "a@b.co", role: "volunteer", eventIds: ["e1"], duties: ["entry"] }).success).toBe(true);
    expect(assignMemberSchema.safeParse({ email: "A@B.CO", role: "coordinator", eventIds: ["e1"] }).success).toBe(true);
  });
});

describe("who can reach which fest, and which competition on it", () => {
  it("lets the platform through everywhere", () => {
    expect(decideAccess(subject({ role: "super_admin" }), "f1").ok).toBe(true);
    expect(festAccess(subject({ role: "super_admin" }), "f1").kind).toBe("platform");
  });

  it("refuses an account with no role on the fest, including a student and a staff member of another fest", () => {
    expect(decideAccess(subject(), "f1").ok).toBe(false);
    expect(decideAccess(subject({ role: "admin", festIds: ["f2"] }), "f1").ok).toBe(false);
    expect(decideAccess(subject({ role: "admin", memberships: { f2: head } }), "f1").ok).toBe(false);
  });

  it("keeps the older, fest-wide scope working for accounts not yet migrated", () => {
    expect(decideAccess(subject({ role: "admin", festIds: ["f1"] }), "f1", { permission: "event:update" }).ok).toBe(true);
    expect(festAccess(subject({ role: "volunteer", festIds: ["f1"] }), "f1").kind).toBe("legacy");
    // A student's festIds mean nothing.
    expect(decideAccess(subject({ role: "student", festIds: ["f1"] }), "f1").ok).toBe(false);
  });

  it("lets the head act across the whole fest, and on no other fest", () => {
    const s = subject({ role: "admin", memberships: { f1: head } });
    expect(decideAccess(s, "f1", { permission: "fest:update" }).ok).toBe(true);
    expect(decideAccess(s, "f1", { permission: "event:update", eventId: "any" }).ok).toBe(true);
    expect(decideAccess(s, "f2", { permission: "event:update", eventId: "any" }).ok).toBe(false);
  });

  it("confines an admin to the competitions assigned, for the permissions their role has", () => {
    const s = subject({ role: "admin", memberships: { f1: admin(["e1"]) } });
    expect(decideAccess(s, "f1", { permission: "event:update", eventId: "e1" }).ok).toBe(true);
    expect(decideAccess(s, "f1", { permission: "event:update", eventId: "e2" }).ok).toBe(false);
    // A fest-wide action, or one that names no competition, is the head's.
    expect(decideAccess(s, "f1", { permission: "fest:update" }).ok).toBe(false);
    expect(decideAccess(s, "f1", { permission: "event:update" }).ok).toBe(false);
    expect(decideAccess(s, "f1").ok).toBe(false);
    // A permission their role does not have, even on their own competition.
    expect(decideAccess(s, "f1", { permission: "event:delete", eventId: "e1" }).ok).toBe(false);
    expect(decideAccess(s, "f1", { permission: "announcement:send", eventId: "e1" }).ok).toBe(false);
    expect(decideAccess(s, "f1", { permission: "member:manage", eventId: "e1" }).ok).toBe(false);
  });

  it("lets a membership override an older, wider scope on the same fest", () => {
    const s = subject({ role: "admin", festIds: ["f1"], memberships: { f1: coordinator(["e1"]) } });
    expect(festAccess(s, "f1").kind).toBe("member");
    expect(decideAccess(s, "f1", { permission: "event:update", eventId: "e2" }).ok).toBe(false);
    expect(decideAccess(s, "f1", { permission: "fest:update" }).ok).toBe(false);
  });

  it("holds a volunteer to the duty and competition they were given", () => {
    const s = subject({ role: "volunteer", memberships: { f1: volunteer(["e1"], ["entry"]) } });
    expect(decideAccess(s, "f1", { permission: "attendance:scan", eventId: "e1" }).ok).toBe(true);
    expect(decideAccess(s, "f1", { permission: "attendance:scan", eventId: "e2" }).ok).toBe(false);
    expect(decideAccess(s, "f1", { permission: "meal:scan", eventId: "e1" }).ok).toBe(false);
    expect(decideAccess(s, "f1", { permission: "registration:read", eventId: "e1" }).ok).toBe(false);
  });

  it("holds different roles on different fests separately", () => {
    const s = subject({ role: "admin", memberships: { f1: head, f2: volunteer(["e9"], ["meal"]) } });
    expect(decideAccess(s, "f1", { permission: "fest:update" }).ok).toBe(true);
    expect(decideAccess(s, "f2", { permission: "fest:update" }).ok).toBe(false);
    expect(decideAccess(s, "f2", { permission: "meal:scan", eventId: "e9" }).ok).toBe(true);
    expect(decideAccess(s, "f2", { permission: "event:update", eventId: "e9" }).ok).toBe(false);
  });

  it("lists every fest reached, by either scheme, without duplicates", () => {
    expect(reachableFestIds(subject({ role: "admin", festIds: ["f1", "f2"], memberships: { f2: head, f3: admin(["e"]) } })).sort()).toEqual(["f1", "f2", "f3"]);
    expect(reachableFestIds(subject({ role: "student", festIds: ["f1"] }))).toEqual([]);
  });
});
