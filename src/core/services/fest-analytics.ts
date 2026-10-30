import type { Registration } from "../models/registration";
import type { Attendance, FoodCollection } from "../models/attendance";
import type { Shift } from "../models/shift";
import type { Certificate } from "../models/certificate";
import type { CertificateEvent } from "../models/certificate-event";
import { holdsSeat } from "../models/registration";
import { isReleased } from "../models/certificate";

/**
 * Pure, unit-testable bucketing for the analytics module.
 *
 * Firestore's `count()` aggregation answers "how many", never "how many, per
 * day" or "how many, by college" — there is no group-by. Every chart below
 * therefore starts from a tightly-scoped list of documents (one fest, one
 * date range) and buckets it in memory, exactly the way the existing
 * per-event analytics page already does. Nothing here re-reads Firestore;
 * callers own the query, these functions only own the arithmetic, which is
 * what makes them testable without an emulator.
 */

export interface LinePoint {
  label: string;
  value: number;
}

/** Registrations, cumulative from the first entry to `end` (inclusive). */
export const registrationsOverTime = (
  registrations: Pick<Registration, "createdAt" | "seats">[],
  end?: Date,
): LinePoint[] => {
  if (registrations.length === 0) return [];
  const days = new Map<string, number>();
  for (const r of registrations) {
    const d = r.createdAt.toISOString().slice(0, 10);
    days.set(d, (days.get(d) ?? 0) + r.seats);
  }
  const sorted = [...days.keys()].sort();
  // Built with a trailing "Z" so the walk stays in the same UTC calendar
  // used for the day-keys above — a local-time constructor here would drift
  // the loop a day out of step with `days` for any timezone east of UTC.
  const start = new Date(`${sorted[0]}T00:00:00Z`);
  const stop = end ? new Date(end) : new Date(`${sorted.at(-1)}T00:00:00Z`);
  const out: LinePoint[] = [];
  let running = 0;
  for (let d = new Date(start); d <= stop && out.length < 366; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    running += days.get(key) ?? 0;
    out.push({ label: key, value: running });
  }
  return out;
};

/** Registrations per day, not cumulative — the daily volume chart. */
export const dailyRegistrations = (registrations: Pick<Registration, "createdAt" | "seats">[]): LinePoint[] => {
  const days = new Map<string, number>();
  for (const r of registrations) {
    const d = r.createdAt.toISOString().slice(0, 10);
    days.set(d, (days.get(d) ?? 0) + r.seats);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => ({ label, value }));
};

/** Which hour of the day (00–23) registrations tend to land in. */
export const hourlyPeakRegistration = (registrations: Pick<Registration, "createdAt">[]): LinePoint[] => {
  const cells = Array.from({ length: 24 }, (_, h) => ({ label: String(h).padStart(2, "0"), value: 0 }));
  for (const r of registrations) {
    cells[r.createdAt.getHours()]!.value += 1;
  }
  return cells;
};

/** Solo vs. team entries, by count of entries (not seats). */
export const teamVsIndividual = (registrations: Pick<Registration, "type">[]): { team: number; individual: number } => {
  let team = 0;
  let individual = 0;
  for (const r of registrations) {
    if (r.type === "team") team++;
    else individual++;
  }
  return { team, individual };
};

/** Registration counts grouped by event. */
export const eventWiseRegistrations = (
  registrations: Pick<Registration, "eventId" | "eventTitle" | "seats">[],
): Array<{ eventId: string; eventTitle: string; count: number }> => {
  const counts = new Map<string, { eventTitle: string; count: number }>();
  for (const r of registrations) {
    const existing = counts.get(r.eventId);
    if (existing) existing.count += r.seats;
    else counts.set(r.eventId, { eventTitle: r.eventTitle, count: r.seats });
  }
  return [...counts.entries()]
    .map(([eventId, v]) => ({ eventId, ...v }))
    .sort((a, b) => b.count - a.count);
};

/** How full each event is against its capacity. Uncapped events are omitted. */
export const capacityUtilization = (
  events: Pick<import("../models/event").Event, "id" | "title" | "capacity" | "registeredCount">[],
): Array<{ eventId: string; title: string; capacity: number; registered: number; rate: number }> =>
  events
    .filter((e) => e.capacity > 0)
    .map((e) => ({ eventId: e.id, title: e.title, capacity: e.capacity, registered: e.registeredCount, rate: e.registeredCount / e.capacity }))
    .sort((a, b) => b.rate - a.rate);

export interface Distribution {
  top: Array<{ label: string; count: number }>;
  others: number;
  otherGroups: number;
  total: number;
}

/**
 * Top-10 + Others grouping, used for college/department/academic-year/
 * gender/city and any other free-text distribution. `accessor` returning an
 * empty/undefined value is bucketed as "Not stated" rather than dropped, so
 * the total always reconciles with the input length.
 */
export const topNDistribution = <T>(items: T[], accessor: (item: T) => string | undefined, n = 10): Distribution => {
  const counts = new Map<string, number>();
  for (const item of items) {
    const raw = accessor(item)?.trim();
    const key = raw && raw.length > 0 ? raw : "Not stated";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, n).map(([label, count]) => ({ label, count }));
  const rest = sorted.slice(n);
  return {
    top,
    others: rest.reduce((s, [, c]) => s + c, 0),
    otherGroups: rest.length,
    total: items.length,
  };
};

export interface AttendanceStats {
  registered: number;
  checkedIn: number;
  noShow: number;
  attendanceRate: number | null;
}

/** Checked-in / registered / no-show / attendance % for a set of confirmed entries. */
export const attendanceStats = (
  confirmedRegistrationIds: string[],
  attendance: Pick<Attendance, "registrationId">[],
): AttendanceStats => {
  const attended = new Set(attendance.map((a) => a.registrationId));
  const checkedIn = confirmedRegistrationIds.filter((id) => attended.has(id)).length;
  const registered = confirmedRegistrationIds.length;
  return {
    registered,
    checkedIn,
    noShow: Math.max(0, registered - checkedIn),
    attendanceRate: registered > 0 ? checkedIn / registered : null,
  };
};

/**
 * Of everyone who has ever been on a waitlist (promoted, plus still
 * waiting), how many made it in. Cancelled waitlist entries never resolved
 * and are excluded from both sides.
 */
export const waitlistConversion = (
  registrations: Pick<Registration, "status" | "promotedAt">[],
): { promoted: number; stillWaiting: number; total: number; rate: number | null } => {
  const promoted = registrations.filter((r) => r.promotedAt).length;
  const stillWaiting = registrations.filter((r) => r.status === "waitlisted").length;
  const total = promoted + stillWaiting;
  return { promoted, stillWaiting, total, rate: total > 0 ? promoted / total : null };
};

/** Check-ins bucketed by hour, 00–23, optionally restricted to one calendar day. */
export const hourlyEntryTimeline = (attendance: Pick<Attendance, "scannedAt">[], onDay?: string): LinePoint[] => {
  const cells = Array.from({ length: 24 }, (_, h) => ({ label: String(h).padStart(2, "0"), value: 0 }));
  for (const a of attendance) {
    if (onDay && a.scannedAt.toISOString().slice(0, 10) !== onDay) continue;
    cells[a.scannedAt.getHours()]!.value += 1;
  }
  return cells;
};

/** Check-ins grouped by the gate they came through. */
export const gateWiseScans = (attendance: Pick<Attendance, "gate">[]): Array<{ gate: string; count: number }> => {
  const counts = new Map<string, number>();
  for (const a of attendance) {
    const gate = a.gate?.trim() || "Unspecified";
    counts.set(gate, (counts.get(gate) ?? 0) + 1);
  }
  return [...counts.entries()].map(([gate, count]) => ({ gate, count })).sort((a, b) => b.count - a.count);
};

export interface VolunteerContribution {
  userId: string;
  name: string;
  gateScans: number;
  foodScans: number;
  totalScans: number;
  posts: string[];
}

/**
 * Per-volunteer scan counts for the leaderboard.
 *
 * Gate scans are counted per member marked (an entry's `members[].by`),
 * because that is who actually did the work at the gate — the attendance
 * document's own `scannedBy` is only whoever triggered the *first* scan of
 * that entry. Food scans are counted per serving, same reasoning.
 */
export const volunteerLeaderboard = (
  attendance: Array<Pick<Attendance, "members" | "scannedBy" | "scannedByName">>,
  meals: Array<Pick<FoodCollection, "collectedBy" | "collectedByName">>,
  shifts: Pick<Shift, "userId" | "userName" | "post">[] = [],
): VolunteerContribution[] => {
  const rows = new Map<string, VolunteerContribution>();
  const bump = (userId: string, name: string, field: "gateScans" | "foodScans") => {
    const row = rows.get(userId) ?? { userId, name, gateScans: 0, foodScans: 0, totalScans: 0, posts: [] };
    row[field] += 1;
    row.totalScans += 1;
    if (!row.name && name) row.name = name;
    rows.set(userId, row);
  };

  for (const a of attendance) {
    if (a.members.length > 0) {
      for (const m of a.members) if (m.by) bump(m.by, a.scannedByName ?? "", "gateScans");
    } else {
      bump(a.scannedBy, a.scannedByName ?? "", "gateScans");
    }
  }
  for (const m of meals) bump(m.collectedBy, m.collectedByName ?? "", "foodScans");

  for (const s of shifts) {
    const row = rows.get(s.userId);
    if (row && !row.posts.includes(s.post)) row.posts.push(s.post);
  }

  return [...rows.values()].sort((a, b) => b.totalScans - a.totalScans);
};

export interface CertificateStats {
  eligible: number;
  released: number;
  downloaded: number;
  emailDelivered: number;
  verificationCount: number;
}

/** Eligible/released/downloaded/email-delivered/verification-count for a fest or event. */
export const certificateStats = (
  certificates: Pick<Certificate, "revoked" | "published" | "delivery">[],
  events: Pick<CertificateEvent, "type">[],
): CertificateStats => {
  const live = certificates.filter((c) => c.revoked !== true);
  return {
    eligible: live.length,
    released: live.filter((c) => isReleased(c)).length,
    downloaded: events.filter((e) => e.type === "download").length,
    emailDelivered: live.filter((c) => c.delivery.status === "sent").length,
    verificationCount: events.filter((e) => e.type === "verify").length,
  };
};

/** Certificate verify/download events, bucketed per day, for a time-series chart. */
export const certificateEventsOverTime = (
  events: Pick<CertificateEvent, "type" | "at">[],
  type: "verify" | "download",
): LinePoint[] => {
  const days = new Map<string, number>();
  for (const e of events) {
    if (e.type !== type) continue;
    const d = e.at.toISOString().slice(0, 10);
    days.set(d, (days.get(d) ?? 0) + 1);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => ({ label, value }));
};

/** Registrations still holding a seat — confirmed or draft — for capacity/attendance math. */
export const seatHoldingRegistrations = <T extends { status: Registration["status"] }>(registrations: T[]): T[] =>
  registrations.filter((r) => holdsSeat(r.status));
