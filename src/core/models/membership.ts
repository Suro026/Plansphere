import { z } from "zod";
import { idSchema } from "./common";
import { ROLE_PERMISSIONS, type Permission, type UserRole } from "../permissions";

/**
 * Event-level roles.
 *
 * A person's account has one global `role` (student, volunteer, admin, super_admin) and a list of fests. That cannot say
 * "Event Head of the Tech Fest, volunteer at the Sports Meet", and it cannot say "admin of the coding contest only". A
 * membership can: one document per (fest, person), carrying the role they hold on that one main event and the
 * sub-events and duties they are assigned.
 *
 *   head         The one Event Head (Event Super Admin) of a main event. Fest-wide. Assigned only by approving the
 *                application, or by the platform transferring the event. Never created through the members API.
 *   admin        Runs the sub-events they are assigned. No fest-wide settings, no other admins.
 *   coordinator  Manages the competitions they are assigned: details, results, attendance. Narrower than an admin.
 *   volunteer    Task-specific: scans entry, hands out meals, or scores matches, at the sub-events they are assigned.
 *
 * None of these is, or can become, the platform's `super_admin`. That role is a separate, global authority held by the
 * Plansphere team (see `PLATFORM_ROLE`); memberships neither grant it nor are consulted for it.
 */

export const FEST_ROLES = ["head", "admin", "coordinator", "volunteer"] as const;
export const festRoleSchema = z.enum(FEST_ROLES);
export type FestRole = z.infer<typeof festRoleSchema>;

export const FEST_ROLE_LABELS: Record<FestRole, string> = {
  head: "Event Head",
  admin: "Admin",
  coordinator: "Coordinator",
  volunteer: "Volunteer",
};

/** What a volunteer may do at the gate. Each unlocks exactly one permission. */
export const DUTIES = ["entry", "meal", "scoring"] as const;
export const dutySchema = z.enum(DUTIES);
export type Duty = z.infer<typeof dutySchema>;

export const DUTY_LABELS: Record<Duty, string> = {
  entry: "Gate entry",
  meal: "Meal handout",
  scoring: "Match scoring",
};

const DUTY_PERMISSION: Record<Duty, Permission> = {
  entry: "attendance:scan",
  meal: "meal:scan",
  scoring: "match:score",
};

export const MEMBERSHIP_STATUSES = ["active", "suspended", "revoked"] as const;
export const membershipStatusSchema = z.enum(MEMBERSHIP_STATUSES);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const membershipSchema = z.object({
  /** `membershipIdFor(festId, userId)`. */
  id: z.string().min(1),
  festId: idSchema,
  userId: idSchema,
  role: festRoleSchema,
  /**
   * The sub-events this member works on. Ignored for the head, who has the whole fest. For everyone else an empty list
   * means no sub-event at all, never "all of them".
   */
  eventIds: z.array(idSchema).max(200).default([]),
  /** A volunteer's duties. Admins and coordinators do not need any: their role says what they may do. */
  duties: z.array(dutySchema).max(3).default([]),
  /** Only `active` memberships carry any authority. Suspension is reversible; revocation is the end of it. */
  status: membershipStatusSchema.default("active"),
  createdBy: idSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  revokedAt: z.coerce.date().optional(),
  revokedBy: idSchema.optional(),
});
export type Membership = z.infer<typeof membershipSchema>;

export const membershipIdFor = (festId: string, userId: string): string => `${festId}__${userId}`;

/* ───────────── what each role may do ───────────── */

/** The head can do everything an admin can, across the whole fest, and manage the people who work on it. */
const HEAD: ReadonlySet<Permission> = new Set<Permission>([...ROLE_PERMISSIONS.admin]);

/** Event-scoped: every one of these applies to an assigned sub-event only. */
const ADMIN: ReadonlySet<Permission> = new Set<Permission>([
  "event:update",
  "registration:read",
  "registration:manage",
  "attendance:manual",
  "results:publish",
  "certificate:issue",
  "certificate:revoke",
  "match:manage",
  "upload:eventPoster",
  "member:assignVolunteer",
  "attendance:scan",
  "meal:scan",
  "match:score",
]);

const COORDINATOR: ReadonlySet<Permission> = new Set<Permission>([
  "event:update",
  "registration:read",
  "attendance:manual",
  "results:publish",
  "match:manage",
  "upload:eventPoster",
  "attendance:scan",
  "meal:scan",
  "match:score",
]);

/** The permission sets of the roles that have a fixed one. A volunteer's comes from their duties. */
export const FEST_ROLE_PERMISSIONS: Record<Exclude<FestRole, "volunteer">, ReadonlySet<Permission>> = {
  head: HEAD,
  admin: ADMIN,
  coordinator: COORDINATOR,
};

type RoleAndDuties = Pick<Membership, "role" | "duties">;

/** May this membership do this, ignoring *where* (sub-event) — that is a separate question. */
export const memberCan = (member: RoleAndDuties, permission: Permission): boolean => {
  if (member.role === "volunteer") return member.duties.some((duty) => DUTY_PERMISSION[duty] === permission);
  return FEST_ROLE_PERMISSIONS[member.role].has(permission);
};

/** The head works across the whole fest; everyone else only on the sub-events they were given. */
export const memberCoversEvent = (member: Pick<Membership, "role" | "eventIds">, eventId: string): boolean =>
  member.role === "head" || member.eventIds.includes(eventId);

/**
 * The global role an account needs for the API's coarse gate to let a member through at all. The fine check (this fest,
 * this sub-event, this permission) is made afterwards, per request. Never `super_admin`: membership cannot confer it.
 */
export const memberCeiling = (members: ReadonlyArray<Pick<Membership, "role">>): UserRole | undefined => {
  if (members.some((m) => m.role === "head" || m.role === "admin" || m.role === "coordinator")) return "admin";
  if (members.some((m) => m.role === "volunteer")) return "volunteer";
  return undefined;
};

/**
 * The admin sections each event role is shown. A menu, not a gate: the API and the rules refuse what a role may not do
 * whether or not a link is shown.
 */
export const MEMBER_NAV: Record<FestRole, readonly string[]> = {
  head: ["overview", "events", "registrations", "gate", "arenas", "analytics", "certificates", "volunteers", "staff", "team", "settings"],
  admin: ["overview", "events", "registrations", "certificates", "team"],
  coordinator: ["overview", "events", "registrations"],
  volunteer: ["overview"],
};

/** The one global role that is the Plansphere platform team's. Event roles are a different namespace entirely. */
export const PLATFORM_ROLE = "super_admin" as const satisfies UserRole;

/* ───────────── who may assign whom ───────────── */

/** Roles a person can be given through the members API. `head` is deliberately absent: it comes from approval only. */
export const ASSIGNABLE_ROLES = ["admin", "coordinator", "volunteer"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const assignMemberSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    name: z.string().trim().min(1).max(120).optional(),
    role: z.enum(ASSIGNABLE_ROLES),
    eventIds: z.array(idSchema).min(1, "Assign at least one competition or activity.").max(200),
    duties: z.array(dutySchema).max(3).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.role === "volunteer" && value.duties.length === 0) {
      ctx.addIssue({ code: "custom", path: ["duties"], message: "Give a volunteer at least one duty." });
    }
    if (value.role !== "volunteer" && value.duties.length > 0) {
      ctx.addIssue({ code: "custom", path: ["duties"], message: "Duties are for volunteers; an admin or coordinator's role already says what they may do." });
    }
  });
export type AssignMember = z.output<typeof assignMemberSchema>;

export const updateMemberSchema = z
  .object({
    role: z.enum(ASSIGNABLE_ROLES).optional(),
    eventIds: z.array(idSchema).min(1).max(200).optional(),
    duties: z.array(dutySchema).max(3).optional(),
    status: z.enum(["active", "suspended"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });
export type UpdateMember = z.output<typeof updateMemberSchema>;
