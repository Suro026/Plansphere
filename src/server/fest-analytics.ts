import { registrationSchema, type Registration } from "@/core/models/registration";
import { attendanceSchema, foodCollectionSchema, type Attendance, type FoodCollection } from "@/core/models/attendance";
import { eventSchema, type Event } from "@/core/models/event";
import { certificateSchema, type Certificate } from "@/core/models/certificate";
import { certificateEventSchema, type CertificateEvent } from "@/core/models/certificate-event";
import { shiftSchema, type Shift } from "@/core/models/shift";
import { matchSchema, type Match } from "@/core/models/match";
import { matchLogEntrySchema, type MatchLogEntry } from "@/core/models/match-log";
import {
  attendanceStats,
  capacityUtilization,
  certificateEventsOverTime,
  certificateStats,
  dailyRegistrations,
  eventWiseRegistrations,
  gateWiseScans,
  hourlyEntryTimeline,
  hourlyPeakRegistration,
  registrationsOverTime,
  seatHoldingRegistrations,
  teamVsIndividual,
  topNDistribution,
  volunteerLeaderboard,
  waitlistConversion,
  type Distribution,
  type LinePoint,
  type VolunteerContribution,
} from "@/core/services/fest-analytics";
import {
  arenaUtilization,
  matchStats,
  mostActiveVolunteers,
  teamWinRate,
  type ArenaUtilization,
  type MatchStats,
  type TeamWinRate,
  type VolunteerActivity,
} from "@/core/services/live-analytics";
import { COLLECTIONS, adminDb } from "./firebase-admin";
import { toDates } from "./serialize";

/**
 * Server-side analytics aggregation — the Admin-SDK half of the analytics
 * module. Everything client-readable (registrations, attendance, events,
 * shifts) could in principle be bucketed in the browser the way the
 * per-event analytics page already does, but a fest's owner is one thing and
 * "every fest on the platform" is another: a super admin's dashboard must
 * not pull every registration on the platform into a browser tab. Reads here
 * are always scoped — by fest, and where possible by date range — and
 * counts prefer Firestore's `count()` aggregation, which bills one read
 * regardless of collection size.
 */

const parseAll = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, docs: FirebaseFirestore.QueryDocumentSnapshot[]): T[] =>
  docs
    .map((doc) => schema.safeParse(toDates({ ...doc.data(), id: doc.id })))
    .filter((r): r is { success: true; data: T } => r.success)
    .map((r) => r.data);

export interface DateRange {
  from?: Date;
  to?: Date;
}

const applyRange = (query: FirebaseFirestore.Query, field: string, range: DateRange): FirebaseFirestore.Query => {
  let q = query;
  if (range.from) q = q.where(field, ">=", range.from);
  if (range.to) q = q.where(field, "<=", range.to);
  return q;
};

export interface AnalyticsOverview {
  events: number;
  registrations: number;
  students: number;
  volunteers: number;
  certificatesIssued: number;
  attendanceRate: number | null;
  waitlistConversionRate: number | null;
}

export interface FestAnalyticsBundle {
  overview: AnalyticsOverview;
  registrationsOverTime: LinePoint[];
  dailyRegistrations: LinePoint[];
  hourlyPeakRegistration: LinePoint[];
  teamVsIndividual: { team: number; individual: number };
  eventWiseRegistrations: Array<{ eventId: string; eventTitle: string; count: number }>;
  capacityUtilization: Array<{ eventId: string; title: string; capacity: number; registered: number; rate: number }>;
  distributions: { college: Distribution; department: Distribution; academicYear: Distribution; gender: Distribution; city: Distribution };
  attendance: ReturnType<typeof attendanceStats>;
  waitlistConversion: ReturnType<typeof waitlistConversion>;
  hourlyEntryTimeline: LinePoint[];
  gateWiseScans: Array<{ gate: string; count: number }>;
  volunteerLeaderboard: VolunteerContribution[];
  certificates: ReturnType<typeof certificateStats>;
  certificateDownloadsOverTime: LinePoint[];
  certificateVerificationsOverTime: LinePoint[];
  /** The Live Event Engine's contribution — empty arrays/zeros for a fest with no live matches. */
  live: {
    matches: MatchStats;
    arenaUtilization: ArenaUtilization[];
    mostActiveVolunteers: VolunteerActivity[];
    teamWinRate: TeamWinRate[];
  };
}

/**
 * Everything one fest's analytics page needs, in one bundle.
 *
 * Reads are scoped to `festId` (and, if given, `eventId` or a date range on
 * `createdAt`/`scannedAt`) — never the whole collection. A single fest's
 * documents are the unit this app already reads in bulk elsewhere (the
 * registration dashboard and its export do the same full-fest scan), so this
 * mirrors an established, accepted cost rather than introducing a new one.
 */
export const loadFestAnalytics = async (
  festId: string,
  options: { eventId?: string; range?: DateRange } = {},
): Promise<FestAnalyticsBundle> => {
  const db = adminDb();
  const range = options.range ?? {};

  let regQuery = db.collection(COLLECTIONS.registrations).where("festId", "==", festId) as FirebaseFirestore.Query;
  if (options.eventId) regQuery = regQuery.where("eventId", "==", options.eventId);
  regQuery = applyRange(regQuery, "createdAt", range);

  let attQuery = db.collection(COLLECTIONS.attendance).where("festId", "==", festId) as FirebaseFirestore.Query;
  if (options.eventId) attQuery = attQuery.where("eventId", "==", options.eventId);
  attQuery = applyRange(attQuery, "scannedAt", range);

  const [regSnap, attSnap, eventsSnap, mealsSnap, shiftsSnap, certsSnap] = await Promise.all([
    regQuery.get(),
    attQuery.get(),
    db.collection(COLLECTIONS.events).where("festId", "==", festId).get(),
    db.collection(COLLECTIONS.foodCollections).where("festId", "==", festId).get(),
    db.collection(COLLECTIONS.shifts).where("festId", "==", festId).get(),
    db.collection(COLLECTIONS.certificates).where("festId", "==", festId).get(),
  ]);

  const registrations = parseAll<Registration>(registrationSchema, regSnap.docs);
  const attendance = parseAll<Attendance>(attendanceSchema, attSnap.docs);
  const events = parseAll<Event>(eventSchema, eventsSnap.docs);
  const meals = parseAll<FoodCollection>(foodCollectionSchema, mealsSnap.docs);
  const shifts = parseAll<Shift>(shiftSchema, shiftsSnap.docs);
  const certificates = parseAll<Certificate>(certificateSchema, certsSnap.docs);

  const certEventsSnap = await (() => {
    let q = db.collection(COLLECTIONS.certificateEvents).where("festId", "==", festId) as FirebaseFirestore.Query;
    if (options.eventId) q = q.where("eventId", "==", options.eventId);
    return q.get();
  })();
  const certificateEvents = parseAll<CertificateEvent>(certificateEventSchema, certEventsSnap.docs);

  const matchesSnap = await (() => {
    let q = db.collection(COLLECTIONS.matches).where("festId", "==", festId) as FirebaseFirestore.Query;
    if (options.eventId) q = q.where("eventId", "==", options.eventId);
    return q.get();
  })();
  const liveMatches = parseAll<Match>(matchSchema, matchesSnap.docs);

  const matchLogSnap = await (() => {
    let q = db.collection(COLLECTIONS.matchLog).where("festId", "==", festId) as FirebaseFirestore.Query;
    if (options.eventId) q = q.where("eventId", "==", options.eventId);
    return q.get();
  })();
  const matchLog = parseAll<MatchLogEntry>(matchLogEntrySchema, matchLogSnap.docs);

  const seated = seatHoldingRegistrations(registrations);
  const confirmed = registrations.filter((r) => r.status === "confirmed");
  const uniqueStudents = new Set(registrations.map((r) => r.userId)).size;

  const volunteersCount = await db
    .collection(COLLECTIONS.users)
    .where("role", "in", ["volunteer", "organizer"])
    .where("festIds", "array-contains", festId)
    .count()
    .get()
    .then((s) => s.data().count);

  const att = attendanceStats(
    confirmed.map((r) => r.id),
    attendance,
  );
  const wl = waitlistConversion(registrations);

  return {
    overview: {
      events: events.length,
      registrations: registrations.length,
      students: uniqueStudents,
      volunteers: volunteersCount,
      certificatesIssued: certificates.filter((c) => !c.revoked).length,
      attendanceRate: att.attendanceRate,
      waitlistConversionRate: wl.rate,
    },
    registrationsOverTime: registrationsOverTime(registrations, range.to),
    dailyRegistrations: dailyRegistrations(registrations),
    hourlyPeakRegistration: hourlyPeakRegistration(registrations),
    teamVsIndividual: teamVsIndividual(registrations),
    eventWiseRegistrations: eventWiseRegistrations(registrations),
    capacityUtilization: capacityUtilization(events),
    distributions: {
      college: topNDistribution(seated, (r) => r.answers?.college ?? r.members.find((m) => m.isLeader)?.college ?? r.members[0]?.college),
      department: topNDistribution(seated, (r) => r.answers?.department),
      academicYear: topNDistribution(seated, (r) => r.answers?.academicYear ?? r.answers?.year),
      gender: topNDistribution(seated, (r) => r.answers?.gender),
      city: topNDistribution(seated, (r) => r.answers?.city),
    },
    attendance: att,
    waitlistConversion: wl,
    hourlyEntryTimeline: hourlyEntryTimeline(attendance),
    gateWiseScans: gateWiseScans(attendance),
    volunteerLeaderboard: volunteerLeaderboard(attendance, meals, shifts),
    certificates: certificateStats(certificates, certificateEvents),
    certificateDownloadsOverTime: certificateEventsOverTime(certificateEvents, "download"),
    certificateVerificationsOverTime: certificateEventsOverTime(certificateEvents, "verify"),
    live: {
      matches: matchStats(liveMatches),
      arenaUtilization: arenaUtilization(liveMatches),
      mostActiveVolunteers: mostActiveVolunteers(matchLog),
      teamWinRate: teamWinRate(liveMatches),
    },
  };
};

export interface PlatformAnalyticsBundle {
  overview: {
    fests: number;
    events: number;
    registrations: number;
    students: number;
    volunteers: number;
    certificatesIssued: number;
    certificatesReleased: number;
    certificatesDownloaded: number;
    certificateVerifications: number;
    attendanceRate: number | null;
    waitlistConversionRate: number | null;
    activeUsers30d: number;
  };
  registrationsOverTime: LinePoint[];
  dailyRegistrations: LinePoint[];
  hourlyPeakRegistration: LinePoint[];
  teamVsIndividual: { team: number; individual: number };
  festWiseRegistrations: Array<{ festId: string; festName: string; count: number }>;
  distributions: { college: Distribution; department: Distribution; academicYear: Distribution; gender: Distribution; city: Distribution };
  certificateDownloadsOverTime: LinePoint[];
  certificateVerificationsOverTime: LinePoint[];
}

/**
 * Platform-wide analytics for the super admin. KPIs come from `count()`
 * wherever a plain count answers the question — including certificate
 * eligibility/release/download/verification, which never need a document
 * body read. `range` bounds every query that reads actual documents (a
 * histogram has no `count()` equivalent), and the route defaults it to the
 * last 30 days: without a bound, "every registration on the platform" is
 * exactly the full-collection scan this module exists to avoid.
 *
 * `certificatesReleased` undercounts certificates written before the
 * `published` field existed (they default to released in the *model*,
 * `isReleased()`, but a bare `count()` query has no way to see a missing
 * field as "true") — a one-time, documented gap for pre-Part-2 data, not an
 * ongoing one.
 */
export const loadPlatformAnalytics = async (range: DateRange = {}): Promise<PlatformAnalyticsBundle> => {
  const db = adminDb();
  const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const count = async (collection: string, build?: (q: FirebaseFirestore.Query) => FirebaseFirestore.Query) => {
    const base = db.collection(collection);
    const query = build ? build(base) : base;
    const snapshot = await query.count().get();
    return snapshot.data().count;
  };

  let regQuery = db.collection(COLLECTIONS.registrations) as FirebaseFirestore.Query;
  regQuery = applyRange(regQuery, "createdAt", range);

  const [
    fests,
    events,
    registrationsCount,
    students,
    volunteers,
    certificatesIssued,
    certificatesReleased,
    certificatesDownloaded,
    certificateVerifications,
    activeUsers30d,
    regSnap,
  ] = await Promise.all([
    count(COLLECTIONS.fests),
    count(COLLECTIONS.events),
    count(COLLECTIONS.registrations),
    count(COLLECTIONS.users, (q) => q.where("role", "==", "student")),
    count(COLLECTIONS.users, (q) => q.where("role", "in", ["volunteer", "organizer"])),
    count(COLLECTIONS.certificates, (q) => q.where("revoked", "==", false)),
    count(COLLECTIONS.certificates, (q) => q.where("revoked", "==", false).where("published", "==", true)),
    count(COLLECTIONS.certificateEvents, (q) => q.where("type", "==", "download")),
    count(COLLECTIONS.certificateEvents, (q) => q.where("type", "==", "verify")),
    count(COLLECTIONS.users, (q) => q.where("updatedAt", ">=", cutoff30d)),
    regQuery.get(),
  ]);

  const registrations = parseAll<Registration>(registrationSchema, regSnap.docs);
  const seated = seatHoldingRegistrations(registrations);

  const attSnap = await (() => {
    let q = db.collection(COLLECTIONS.attendance) as FirebaseFirestore.Query;
    q = applyRange(q, "scannedAt", range);
    return q.get();
  })();
  const attendance = parseAll<Attendance>(attendanceSchema, attSnap.docs);

  const rangedCertEvents = async (type: "download" | "verify") => {
    let q = db.collection(COLLECTIONS.certificateEvents).where("type", "==", type) as FirebaseFirestore.Query;
    q = applyRange(q, "at", range);
    const snap = await q.get();
    return parseAll<CertificateEvent>(certificateEventSchema, snap.docs);
  };
  const [downloadEvents, verifyEvents] = await Promise.all([rangedCertEvents("download"), rangedCertEvents("verify")]);

  const confirmed = registrations.filter((r) => r.status === "confirmed");
  const att = attendanceStats(
    confirmed.map((r) => r.id),
    attendance,
  );
  const wl = waitlistConversion(registrations);

  const festCounts = new Map<string, { festName: string; count: number }>();
  for (const r of registrations) {
    const existing = festCounts.get(r.festId);
    if (existing) existing.count += r.seats;
    else festCounts.set(r.festId, { festName: r.festId, count: r.seats });
  }
  const festIds = [...festCounts.keys()];
  if (festIds.length > 0) {
    const festDocs = await db.getAll(...festIds.map((id) => db.collection(COLLECTIONS.fests).doc(id)));
    for (const doc of festDocs) {
      const entry = festCounts.get(doc.id);
      if (entry && doc.exists) entry.festName = String(doc.data()?.name ?? doc.id);
    }
  }

  return {
    overview: {
      fests,
      events,
      registrations: registrationsCount,
      students,
      volunteers,
      certificatesIssued,
      certificatesReleased,
      certificatesDownloaded,
      certificateVerifications,
      attendanceRate: att.attendanceRate,
      waitlistConversionRate: wl.rate,
      activeUsers30d,
    },
    registrationsOverTime: registrationsOverTime(registrations, range.to),
    dailyRegistrations: dailyRegistrations(registrations),
    hourlyPeakRegistration: hourlyPeakRegistration(registrations),
    teamVsIndividual: teamVsIndividual(registrations),
    festWiseRegistrations: [...festCounts.entries()].map(([festId, v]) => ({ festId, ...v })).sort((a, b) => b.count - a.count),
    distributions: {
      college: topNDistribution(seated, (r) => r.answers?.college ?? r.members.find((m) => m.isLeader)?.college ?? r.members[0]?.college),
      department: topNDistribution(seated, (r) => r.answers?.department),
      academicYear: topNDistribution(seated, (r) => r.answers?.academicYear ?? r.answers?.year),
      gender: topNDistribution(seated, (r) => r.answers?.gender),
      city: topNDistribution(seated, (r) => r.answers?.city),
    },
    certificateDownloadsOverTime: certificateEventsOverTime(downloadEvents, "download"),
    certificateVerificationsOverTime: certificateEventsOverTime(verifyEvents, "verify"),
  };
};
