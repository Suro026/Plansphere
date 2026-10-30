import { memberCan, type Membership } from "./models/membership";
import { can, type Permission, type UserRole } from "./permissions";

/**
 * Who may act on which main event, and on which of its sub-events. One function, so the API routes, the tests and any
 * future caller agree.
 *
 * An account reaches a fest in one of three ways, checked in this order:
 *
 *  - platform: the global `super_admin`, the Plansphere team. Unscoped. Event roles never produce this.
 *  - member:   it holds an active membership on this fest. The membership alone decides what it may do here, however
 *              much (or little) its global role says. A head works across the fest; every other member only on the
 *              sub-events and duties they were assigned.
 *  - legacy:   the account predates memberships and is scoped by `festIds` on its profile. Fest-wide, as before, until it
 *              is migrated to a membership.
 *
 * The default is to refuse. A member who is not the head is let through only when the permission is one their role has,
 * the sub-event is named, and they are assigned to it - so a route that has not been taught about sub-events is
 * head-only for members, never open.
 */

export interface AccessSubject {
  /** The account's OWN role. Memberships never raise it: each fest an account holds a membership on is governed by that alone. */
  role: UserRole;
  /** The fests a legacy (pre-membership) account is scoped to. */
  festIds: string[];
  /** Active memberships, by fest id. */
  memberships: Readonly<Record<string, Pick<Membership, "role" | "eventIds" | "duties">>>;
}

export type FestAccess =
  | { kind: "platform" }
  | { kind: "member"; member: Pick<Membership, "role" | "eventIds" | "duties"> }
  | { kind: "legacy" }
  | { kind: "none" };

export const festAccess = (subject: AccessSubject, festId: string | undefined | null): FestAccess => {
  if (subject.role === "super_admin") return { kind: "platform" };
  if (!festId) return { kind: "none" };
  const member = subject.memberships[festId];
  if (member) return { kind: "member", member };
  if (subject.role !== "student" && subject.festIds.includes(festId)) return { kind: "legacy" };
  return { kind: "none" };
};

export type AccessDecision = { ok: true } | { ok: false; reason: string };

export const decideAccess = (
  subject: AccessSubject,
  festId: string | undefined | null,
  options: { permission?: Permission | undefined; eventId?: string | undefined } = {},
): AccessDecision => {
  const access = festAccess(subject, festId);

  if (access.kind === "none") return { ok: false, reason: "You do not manage this fest." };
  if (access.kind === "legacy") {
    // The route's coarse gate may have let the account in on a raised ceiling (it is head of some other fest). On this
    // fest it is what its own role says.
    return options.permission && !can(subject.role, options.permission) ? { ok: false, reason: "Your role on this event cannot do that." } : { ok: true };
  }
  if (access.kind !== "member") return { ok: true };

  const { member } = access;
  if (member.role === "head") {
    return options.permission && !memberCan(member, options.permission) ? { ok: false, reason: "Your role on this event cannot do that." } : { ok: true };
  }

  if (!options.permission || !memberCan(member, options.permission)) return { ok: false, reason: "Your role on this event cannot do that." };
  if (!options.eventId) return { ok: false, reason: "That is an action for the Event Head, not for someone assigned to particular competitions." };
  if (!member.eventIds.includes(options.eventId)) return { ok: false, reason: "You are not assigned to that competition." };
  return { ok: true };
};

/** Every fest this account can reach in any way, for lists and menus. Never an authorization on its own. */
export const reachableFestIds = (subject: AccessSubject): string[] =>
  Array.from(new Set([...(subject.role === "student" ? [] : subject.festIds), ...Object.keys(subject.memberships)]));
