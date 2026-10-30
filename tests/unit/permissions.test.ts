import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  USER_ROLES,
  can,
  canInScope,
  creatableRoles,
  hasAtLeast,
  homeForRole,
  inScope,
  isFestOwner,
  type Permission,
  type UserRole,
} from "@/core/permissions";
import { isProfileComplete, normalizeUserDoc, userSchema } from "@/core/models/user";

/** Every capability the spec grants each role, written out rather than derived. */
const EXPECTED: Record<UserRole, Permission[]> = {
  student: ["registration:create", "registration:cancelOwn", "team:manageOwn", "certificate:viewOwn"],
  volunteer: ["registration:create", "registration:cancelOwn", "team:manageOwn", "certificate:viewOwn", "attendance:scan", "meal:scan", "shift:viewOwn", "match:score"],
  admin: [
    "registration:create", "registration:cancelOwn", "team:manageOwn", "certificate:viewOwn",
    "attendance:scan", "meal:scan", "shift:viewOwn", "match:score",
    "fest:update", "event:create", "event:update", "event:delete",
    "registration:read", "registration:manage", "attendance:manual",
    "results:publish", "certificate:issue", "certificate:revoke",
    "announcement:send", "staff:createVolunteer", "staff:manage", "member:manage", "member:assignVolunteer", "audit:read",
    "upload:festArtwork", "upload:eventPoster", "match:manage",
    "payment:configure", "payment:refund",
  ],
  super_admin: [...PERMISSIONS],
};

/** The verbs the spec reserves for the platform owner, written out. */
const OWNER_ONLY: Permission[] = [
  "fest:create",
  "fest:delete",
  "fest:archive",
  "fest:transfer",
  "fest:configureRegistration",
  "certificate:publish",
  "staff:createAdmin",
  "platform:manage",
  "fest:verify",
  "payment:approve",
];

describe("roles", () => {
  it("is exactly the four roles, ordered", () => {
    expect([...USER_ROLES]).toEqual(["student", "volunteer", "admin", "super_admin"]);
    expect(hasAtLeast("student", "volunteer")).toBe(false);
    expect(hasAtLeast("volunteer", "volunteer")).toBe(true);
    expect(hasAtLeast("admin", "volunteer")).toBe(true);
    expect(hasAtLeast("super_admin", "admin")).toBe(true);
    expect(hasAtLeast("admin", "super_admin")).toBe(false);
    expect(hasAtLeast(undefined, "student")).toBe(false);
  });

  it("sends each role to its own home", () => {
    expect(homeForRole("student")).toBe("/explore");
    expect(homeForRole("volunteer")).toBe("/volunteer");
    expect(homeForRole("admin")).toBe("/admin");
    expect(homeForRole("super_admin")).toBe("/admin");
  });
});

describe("the permission matrix", () => {
  it.each(USER_ROLES)("grants %s exactly what the spec says", (role) => {
    expect([...ROLE_PERMISSIONS[role]].sort()).toEqual([...EXPECTED[role]].sort());
  });

  it("student: registrations and certificates only", () => {
    expect(can("student", "registration:create")).toBe(true);
    expect(can("student", "certificate:viewOwn")).toBe(true);
    for (const p of ["attendance:scan", "event:create", "results:publish", "staff:createVolunteer", "platform:manage"] as Permission[]) {
      expect(can("student", p), p).toBe(false);
    }
  });

  it("volunteer: scanning and nothing else on the staff side", () => {
    expect(can("volunteer", "attendance:scan")).toBe(true);
    expect(can("volunteer", "meal:scan")).toBe(true);
    for (const p of [
      "event:create", "event:update", "event:delete", "registration:read", "registration:manage",
      "attendance:manual", "results:publish", "certificate:issue", "certificate:revoke",
      "announcement:send", "staff:createVolunteer", "staff:manage", "audit:read",
      "upload:festArtwork", "upload:eventPoster", "fest:update", "fest:create", "platform:manage",
    ] as Permission[]) {
      expect(can("volunteer", p), p).toBe(false);
    }
  });

  it("admin: everything for a fest, nothing of the super admin's", () => {
    for (const p of ["event:create", "results:publish", "certificate:issue", "staff:createVolunteer", "audit:read"] as Permission[]) {
      expect(can("admin", p), p).toBe(true);
    }
    for (const p of OWNER_ONLY) {
      expect(can("admin", p), p).toBe(false);
    }
  });

  it("super admin: everything", () => {
    for (const p of PERMISSIONS) expect(can("super_admin", p), p).toBe(true);
  });

  it("the owner-only set is exactly what admin lacks", () => {
    const missing = PERMISSIONS.filter((p) => !can("admin", p));
    expect([...missing].sort()).toEqual([...OWNER_ONLY].sort());
  });

  it("an admin prepares certificates; only the owner releases them", () => {
    expect(can("admin", "certificate:issue")).toBe(true);
    expect(can("admin", "certificate:publish")).toBe(false);
    expect(can("super_admin", "certificate:publish")).toBe(true);
    expect(can("volunteer", "certificate:issue")).toBe(false);
  });

  it("what a fest asks its students is the owner's, not the running admin's", () => {
    expect(can("admin", "fest:update")).toBe(true);
    expect(can("admin", "fest:configureRegistration")).toBe(false);
    expect(can("super_admin", "fest:configureRegistration")).toBe(true);
  });
});

describe("scope", () => {
  const admin = { role: "admin" as const, festIds: ["fest1"] };
  const volunteer = { role: "volunteer" as const, festIds: ["fest1"] };
  const superAdmin = { role: "super_admin" as const, festIds: [] };
  const student = { role: "student" as const, festIds: [] };

  it("limits admins and volunteers to their assigned fests", () => {
    expect(inScope(admin, "fest1")).toBe(true);
    expect(inScope(admin, "fest2")).toBe(false);
    expect(inScope(volunteer, "fest1")).toBe(true);
    expect(inScope(volunteer, "fest2")).toBe(false);
    expect(inScope(admin, undefined)).toBe(false);
  });

  it("leaves a super admin unscoped and a student out of scope entirely", () => {
    expect(inScope(superAdmin, "anything")).toBe(true);
    expect(inScope(superAdmin, undefined)).toBe(true);
    expect(inScope(student, "fest1")).toBe(false);
  });

  it("canInScope needs the capability and the fest", () => {
    expect(canInScope(admin, "results:publish", "fest1")).toBe(true);
    expect(canInScope(admin, "results:publish", "fest2")).toBe(false);
    expect(canInScope(volunteer, "results:publish", "fest1")).toBe(false);
    expect(canInScope(volunteer, "attendance:scan", "fest1")).toBe(true);
  });
});

describe("who may create whom", () => {
  it("only a super admin creates admins; an admin creates volunteers", () => {
    expect(creatableRoles("super_admin")).toEqual(["volunteer", "admin", "super_admin"]);
    expect(creatableRoles("admin")).toEqual(["volunteer"]);
    expect(creatableRoles("volunteer")).toEqual([]);
    expect(creatableRoles("student")).toEqual([]);
  });

  it("an admin who owns the target fest may also create admins for it", () => {
    expect(creatableRoles("admin", true)).toEqual(["volunteer", "admin"]);
    // Ownership has no effect on any other role — it is not a back door to a
    // bigger grant than the platform owner's.
    expect(creatableRoles("volunteer", true)).toEqual([]);
    expect(creatableRoles("student", true)).toEqual([]);
    expect(creatableRoles("super_admin", true)).toEqual(["volunteer", "admin", "super_admin"]);
  });
});

describe("fest ownership", () => {
  it("is true only when ownerId matches, and false when unset", () => {
    expect(isFestOwner("u1", { ownerId: "u1" })).toBe(true);
    expect(isFestOwner("u1", { ownerId: "u2" })).toBe(false);
    expect(isFestOwner("u1", {})).toBe(false);
  });
});

describe("the unified user document", () => {
  const base = {
    id: "u1",
    email: "a@x.test",
    name: "Ishita Rao",
    role: "student",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("defaults the new flags and mirrors uid, with compatibility aliases", () => {
    const user = userSchema.parse(base);
    expect(user).toMatchObject({ uid: "u1", festIds: [], profileCompleted: false, mustChangePassword: false, disabled: false });
    expect(user.fullName).toBe("Ishita Rao");
  });

  it("reads a pre-refactor document: organizer role, fullName, nested student/organizer blocks", () => {
    const legacy = normalizeUserDoc({
      id: "u2",
      email: "o@x.test",
      fullName: "Old Organizer",
      photoUrl: "https://x.test/a.png",
      role: "organizer",
      student: { college: "SRM", studentId: "RA1", department: "CSE", year: 3 },
      organizer: { designation: "Cultural secretary", festIds: ["fest1"] },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const user = userSchema.parse(legacy);
    expect(user.role).toBe("volunteer");
    expect(user.name).toBe("Old Organizer");
    expect(user.avatar).toBe("https://x.test/a.png");
    expect(user).toMatchObject({ college: "SRM", studentId: "RA1", department: "CSE", year: 3, designation: "Cultural secretary", festIds: ["fest1"] });
    expect(user.profileCompleted).toBe(true);
  });

  it("knows when a profile is complete, by role", () => {
    expect(isProfileComplete({ role: "student", name: "A", phone: "+91999", college: "SRM" })).toBe(true);
    expect(isProfileComplete({ role: "student", name: "A", phone: "", college: "SRM" })).toBe(false);
    expect(isProfileComplete({ role: "student", name: "A", phone: "+91999", college: "" })).toBe(false);
    // Staff are complete the moment they accept their invitation.
    expect(isProfileComplete({ role: "volunteer", name: "V", phone: undefined, college: undefined })).toBe(true);
    expect(isProfileComplete({ role: "admin", name: "", phone: undefined, college: undefined })).toBe(false);
  });
});
