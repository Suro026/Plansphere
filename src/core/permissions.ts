/**
 * The permission matrix — the single source of truth for who may do what.
 *
 * Every role check in the app resolves to `can(role, permission)` or
 * `canInScope(...)`. Nothing else re-derives privileges from a role name:
 * rules, API helpers, UI guards and tests all read this table, so adding a
 * capability is one line here rather than a hunt through the codebase.
 *
 * Four roles, least to most privileged:
 *
 *   student     registers for events, holds a pass, collects certificates
 *   volunteer   scans at the gate — entry and meals — and nothing else
 *   admin       runs the fests assigned to them, end to end
 *   super_admin runs the platform, and is the only role that creates admins
 *
 * A public visitor is not a user. Browsing needs no account, and "public"
 * is therefore not a role — it is the absence of one.
 */

export const USER_ROLES = ["student", "volunteer", "admin", "super_admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Ordering for "at least this privileged" questions. Never for capability checks. */
const ROLE_RANK: Record<UserRole, number> = {
  student: 0,
  volunteer: 1,
  admin: 2,
  super_admin: 3,
};

export const roleRank = (role: UserRole): number => ROLE_RANK[role];

export const hasAtLeast = (role: UserRole | undefined, required: UserRole): boolean =>
  role !== undefined && ROLE_RANK[role] >= ROLE_RANK[required];

export const ROLE_LABELS: Record<UserRole, string> = {
  student: "Student",
  volunteer: "Volunteer",
  admin: "Admin",
  super_admin: "Super admin",
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  student: "Registers for events, holds a pass, collects certificates.",
  volunteer: "Scans entry and meals at the gate. No access to registrations, results or settings.",
  admin: "Runs the fests assigned to them: events, registrations, results, certificates, staff.",
  super_admin: "Runs the platform: creates fests and admins, and can act on every fest.",
};

/* ───────────── capabilities ───────────── */

export const PERMISSIONS = [
  // Student
  "registration:create",
  "registration:cancelOwn",
  "team:manageOwn",
  "certificate:viewOwn",

  // Volunteer — the gate, and only the gate
  "attendance:scan",
  "meal:scan",
  "shift:viewOwn",
  /** Score a match at the arena a volunteer's shift assigns them to. */
  "match:score",

  // Admin, within the fests assigned to them
  "fest:update",
  "event:create",
  "event:update",
  "event:delete",
  "registration:read",
  "registration:manage",
  "attendance:manual",
  "results:publish",
  "certificate:issue",
  "certificate:revoke",
  "announcement:send",
  "staff:createVolunteer",
  "staff:manage",
  /** Assign, change, suspend and revoke the admins, coordinators and volunteers of an event (the Event Head's power). */
  "member:manage",
  /** Assign volunteers to sub-events one is already assigned to. */
  "member:assignVolunteer",
  "audit:read",
  "upload:festArtwork",
  "upload:eventPoster",
  /** Arenas, tournament configuration, brackets, and any match — unscoped by arena. */
  "match:manage",
  /** Save the fest's own merchant credentials and see payment status (never the secrets). */
  "payment:configure",
  /** Approve or reverse a refund that waits for staff, and resolve payments flagged for review. */
  "payment:refund",

  // Super admin only
  "fest:create",
  "fest:delete",
  "fest:archive",
  "fest:transfer",
  "fest:configureRegistration",
  "certificate:publish",
  "staff:createAdmin",
  "platform:manage",
  /** Approve or reject a self-service event application, and open the identity documents behind it. */
  "fest:verify",
  /** Approve or suspend a fest's payment account — the gate before any paid event can be published. */
  "payment:approve",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const STUDENT: Permission[] = ["registration:create", "registration:cancelOwn", "team:manageOwn", "certificate:viewOwn"];

/**
 * A volunteer is a scanner. They deliberately do *not* inherit student
 * permissions on the staff side of the app; if a volunteer also registers for
 * an event they do so as themselves, and the owner checks on their own
 * documents are what let them through — not their staff role.
 */
const VOLUNTEER: Permission[] = [...STUDENT, "attendance:scan", "meal:scan", "shift:viewOwn", "match:score"];

const ADMIN: Permission[] = [
  ...VOLUNTEER,
  "fest:update",
  "event:create",
  "event:update",
  "event:delete",
  "registration:read",
  "registration:manage",
  "attendance:manual",
  "results:publish",
  "certificate:issue",
  "certificate:revoke",
  "announcement:send",
  "staff:createVolunteer",
  "staff:manage",
  "member:manage",
  "member:assignVolunteer",
  "audit:read",
  "match:manage",
  "payment:configure",
  "payment:refund",
  "upload:festArtwork",
  "upload:eventPoster",
];

const SUPER_ADMIN: Permission[] = [
  ...ADMIN,
  "fest:create",
  "fest:delete",
  // Archiving, ownership and what a fest asks its students are the owner's
  // decisions, not the running admin's.
  "fest:archive",
  "fest:transfer",
  "fest:configureRegistration",
  // An admin prepares certificates; only the platform owner releases them.
  "certificate:publish",
  "staff:createAdmin",
  "platform:manage",
  // Deciding who may run an event is the platform's call, never the applicant's or an event admin's.
  "fest:verify",
  "payment:approve",
];

export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  student: new Set(STUDENT),
  volunteer: new Set(VOLUNTEER),
  admin: new Set(ADMIN),
  super_admin: new Set(SUPER_ADMIN),
};

/** Does this role hold this capability at all? Scope is a separate question. */
export const can = (role: UserRole | undefined, permission: Permission): boolean =>
  role !== undefined && ROLE_PERMISSIONS[role].has(permission);

/* ───────────── scope ───────────── */

/**
 * Staff are scoped to the fests assigned to them. A super admin is not: the
 * platform is their scope, and that is the one privilege the role adds over
 * an admin besides creating admins and fests.
 */
export interface Scoped {
  role: UserRole;
  festIds: string[];
}

export const inScope = (actor: Scoped, festId: string | undefined | null): boolean => {
  if (actor.role === "super_admin") return true;
  if (!festId) return false;
  if (actor.role === "student") return false;
  return actor.festIds.includes(festId);
};

/** The usual question: may this actor do X to something belonging to this fest? */
export const canInScope = (actor: Scoped, permission: Permission, festId: string | undefined | null): boolean =>
  can(actor.role, permission) && inScope(actor, festId);

/**
 * Roles a given role may create. Enforced by the staff route and the rules.
 *
 * `isFestOwnerOfTarget` is the one exception to "only a super admin creates
 * admins": the account that registered a fest through self-service (its
 * `Fest.ownerId`) may build an admin team for that one fest, without holding
 * the platform-wide `staff:createAdmin` permission. It has no effect for any
 * other role — an owner is still an ordinary `admin` everywhere else.
 */
export const creatableRoles = (role: UserRole, isFestOwnerOfTarget = false): UserRole[] => {
  if (role === "super_admin") return ["volunteer", "admin", "super_admin"];
  if (role === "admin") return isFestOwnerOfTarget ? ["volunteer", "admin"] : ["volunteer"];
  return [];
};

/** Does `uid` own this fest? The one capability an owner has beyond a scoped admin's. */
export const isFestOwner = (uid: string, fest: { ownerId?: string }): boolean => Boolean(fest.ownerId) && fest.ownerId === uid;

/** Where a signed-in account lands after authenticating. */
export const homeForRole = (role: UserRole): string => {
  switch (role) {
    case "super_admin":
    case "admin":
      return "/admin";
    case "volunteer":
      return "/volunteer";
    default:
      return "/explore";
  }
};
