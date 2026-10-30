/* eslint-disable @typescript-eslint/no-explicit-any -- route bodies and Firestore documents are read field by field */
/**
 * Video-demo seeder.
 *
 * Builds one internally consistent world — six fests, 29 events, ~150
 * students, staff in every role — by *running the product's own flows*:
 *
 *   • Event Heads register their fests through POST /api/register-event and
 *     become the admin/owner of each (the app's "event-scoped super admin").
 *   • Staff are invited through POST /api/admin/staff, students sign up
 *     through the client SDK and create their profile through the real
 *     repository.
 *   • Registrations, teams, cancellations and the waitlist go through
 *     POST /api/registrations and its siblings — real tickets, real counters.
 *   • Check-in and meals are recorded by the real scanner repository, signed
 *     in as the volunteer, under the real Firestore rules.
 *   • Results, certificates, announcements, brackets and live scoring all use
 *     the real routes.
 *
 * Only two things are written directly, and both are disclosed in the
 * report: timestamps are spread over the past weeks (so charts show a trend
 * instead of one minute of activity) and every document is stamped
 * `demo:true, demoBatch:"video-demo-2026"` so it can be removed later.
 *
 * Emulator only — see assertEmulatorTarget() in lib.ts.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { memberKeyFor } from "@/core/models/attendance";
import { generateStaffCode } from "@/core/models/user";
import { applyClaims, setMustChangePassword } from "@/server/credentials";
import { COLLECTIONS, FieldValue, Timestamp, adminAuth, adminDb } from "@/server/firebase-admin";
import { randomBytes } from "@/server/serialize";
import { FirestoreAttendanceRepository } from "@/data/firebase/repositories/attendance-repository";
import { FirestoreShiftRepository } from "@/data/firebase/repositories/shift-repository";
import { FirestoreUserRepository } from "@/data/firebase/repositories/user-repository";
import { POST as registerEventRoute } from "@/app/api/register-event/route";
import { PATCH as patchFestRoute } from "@/app/api/admin/fests/[id]/route";
import { POST as createStaffRoute } from "@/app/api/admin/staff/route";
import { POST as createEventRoute } from "@/app/api/admin/events/route";
import { PATCH as patchEventRoute } from "@/app/api/admin/events/[id]/route";
import { POST as registerRoute } from "@/app/api/registrations/route";
import { POST as teamRoute } from "@/app/api/registrations/[id]/team/route";
import { POST as cancelRoute } from "@/app/api/registrations/[id]/cancel/route";
import { POST as announceRoute } from "@/app/api/admin/fests/[id]/announcements/route";
import { PUT as putResultsRoute } from "@/app/api/admin/events/[id]/results/route";
import { POST as publishResultsRoute } from "@/app/api/admin/events/[id]/results/publish/route";
import { POST as prepareCertsRoute } from "@/app/api/admin/events/[id]/certificates/route";
import { POST as publishCertsRoute } from "@/app/api/admin/certificates/publish/route";
import { POST as revokeCertRoute } from "@/app/api/admin/certificates/[id]/revoke/route";
import { POST as createArenaRoute } from "@/app/api/admin/arenas/route";
import { POST as createMatchRoute } from "@/app/api/admin/matches/route";
import { POST as manualAttendanceRoute } from "@/app/api/admin/attendance/manual/route";
import { POST as joinRoute } from "@/app/api/registrations/join/route";
import { POST as bracketRoute } from "@/app/api/admin/events/[id]/bracket/route";
import { PATCH as patchMatchRoute } from "@/app/api/admin/matches/[id]/route";
import { POST as matchActionRoute } from "@/app/api/volunteer/matches/[id]/action/route";
import { GET as verifyRoute } from "@/app/api/verify/[number]/route";
import { GET as verifyPdfRoute } from "@/app/api/verify/[number]/pdf/route";
import { BATCH, PASSWORD, RouteError, assertEmulatorTarget, at, call, clientSignIn, clientSignOut, clientSignUp, dayOffset, log, minutes, quietApp, retryingBulkWriter, rng, tokenFor } from "./lib";
import {
  COLLEGES,
  DEPARTMENTS,
  FLAGSHIP_ADMINS,
  FLAGSHIP_VOLUNTEERS,
  FRESH_ORGANIZER,
  FRESH_STUDENT,
  HEADS,
  OTHER_VOLUNTEERS,
  PENDING_VOLUNTEER,
  PLATFORM_ADMIN,
  email,
  festSpecs,
  generateStudentNames,
  phone,
  type EventSpec,
  type FestSpec,
  type StaffSpec,
} from "./data";

/* ───────────── types ───────────── */

interface Person {
  uid: string;
  email: string;
  name: string;
}
interface Student extends Person {
  college: string;
}
interface FestRec {
  id: string;
  slug: string;
  spec: FestSpec;
  head: Person;
  events: EventRec[];
}
interface EventRec {
  id: string;
  spec: EventSpec;
  fest: FestRec;
  date: string;
  /** Registered while published; scanned/served later. */
  entries: Entry[];
}
interface Entry {
  id: string;
  ev: EventRec;
  leader: Student;
  members: Student[];
  accepted: Set<string>;
  teamName?: string | undefined;
  status: string;
  ticketCode: string;
  /** Scripted so the video has a valid, never-scanned QR. */
  holdBack?: boolean;
}

const SCALE = Math.max(0.1, Number(process.env.DEMO_SCALE ?? "1"));
const scaled = (n: number): number => (n <= 3 ? n : Math.max(3, Math.round(n * SCALE)));

const failures: string[] = [];

/* ───────────── people ───────────── */

const tokens = new Map<string, { token: string; at: number }>();
const tok = async (emailAddress: string, fresh = false): Promise<string> => {
  const cached = tokens.get(emailAddress);
  if (!fresh && cached && Date.now() - cached.at < minutes(40)) return cached.token;
  const token = await tokenFor(emailAddress);
  tokens.set(emailAddress, { token, at: Date.now() });
  return token;
};

const users = () => adminDb().collection(COLLECTIONS.users);
const userRepo = new FirestoreUserRepository();
const attendanceRepo = new FirestoreAttendanceRepository();
const shiftRepo = new FirestoreShiftRepository();

/** A student exactly as the sign-up screen creates one: Auth account, then profile through the repository. */
const createStudent = async (name: string, college: string, index: number): Promise<Student> => {
  const address = email(name);
  const uid = await clientSignUp(address, name);
  await userRepo.createStudentProfile({
    id: uid,
    email: address,
    name,
    phone: phone(index),
    studentId: `${college.slice(0, 2).toUpperCase()}${String(23 + (index % 4))}${(DEPARTMENTS[index % DEPARTMENTS.length] ?? "GEN").slice(0, 2).toUpperCase()}${String(100 + index)}`,
    college,
    department: DEPARTMENTS[index % DEPARTMENTS.length],
    year: (index % 4) + 1,
    emailVerified: false,
  });
  // Stand-in for clicking the verification link (the emulator sends no mail).
  await adminAuth().updateUser(uid, { emailVerified: true });
  await users().doc(uid).set({ emailVerified: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { uid, email: address, name, college };
};

/** Invite through the real staff route, then do what the first sign-in does: choose a password, clear the flag. */
const inviteStaff = async (callerEmail: string, spec: StaffSpec, festIds: string[], phoneIndex: number): Promise<Person> => {
  const result = await call<any>(createStaffRoute, {
    token: await tok(callerEmail, true),
    path: "/api/admin/staff",
    body: { name: spec.name, email: email(spec.name), phone: phone(phoneIndex), designation: spec.designation, role: spec.role, festIds },
    label: `invite ${spec.name}`,
  });
  const uid: string = result.user.id;
  await adminAuth().updateUser(uid, { password: PASSWORD, emailVerified: true });
  await users().doc(uid).set({ emailVerified: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await setMustChangePassword(uid, false);
  return { uid, email: email(spec.name), name: spec.name };
};

/** An invitation nobody has accepted yet: created by the real route and left exactly as it is. */
const invitePending = async (callerEmail: string, spec: StaffSpec, festIds: string[], phoneIndex: number): Promise<Person> => {
  const result = await call<any>(createStaffRoute, {
    token: await tok(callerEmail, true),
    path: "/api/admin/staff",
    body: { name: spec.name, email: email(spec.name), phone: phone(phoneIndex), designation: spec.designation, role: spec.role, festIds },
    label: `invite ${spec.name}`,
  });
  return { uid: result.user.id, email: email(spec.name), name: spec.name };
};

/** The platform owner is bootstrapped out of band, like scripts/grant-super-admin.mjs — there is deliberately no route that mints one. */
const createPlatformAdmin = async (): Promise<Person> => {
  const address = email(PLATFORM_ADMIN.name);
  const created = await adminAuth().createUser({ email: address, displayName: PLATFORM_ADMIN.name, password: PASSWORD, emailVerified: true });
  await applyClaims(created.uid, { role: "super_admin", festIds: [] });
  await users()
    .doc(created.uid)
    .set({
      id: created.uid,
      uid: created.uid,
      email: address,
      name: PLATFORM_ADMIN.name,
      phone: phone(1),
      designation: PLATFORM_ADMIN.designation,
      staffCode: generateStaffCode("super_admin", new Date().getFullYear(), randomBytes),
      role: "super_admin",
      festIds: [],
      emailVerified: true,
      disabled: false,
      profileCompleted: true,
      mustChangePassword: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  return { uid: created.uid, email: address, name: PLATFORM_ADMIN.name };
};

/* ───────────── fests and events ───────────── */

const registerFest = async (spec: FestSpec, head: Student): Promise<FestRec> => {
  const result = await call<any>(registerEventRoute, {
    token: await tok(head.email, true),
    path: "/api/register-event",
    body: {
      organizationName: spec.organizationName,
      organizationType: spec.organizationType,
      ...(spec.website ? { organizationWebsite: spec.website } : {}),
      contactEmail: spec.contactEmail,
      city: spec.city,
      state: spec.state,
      name: spec.name,
      festType: spec.festType,
      startDate: dayOffset(spec.start),
      endDate: dayOffset(spec.end),
      venue: spec.venue,
      expectedParticipants: spec.expected,
      description: spec.description,
      eventHead: { name: head.name, designation: HEADS[spec.head].designation, phone: phone(800 + Object.keys(HEADS).indexOf(spec.head)) },
    },
    label: `register fest ${spec.name}`,
  });
  const fest = result.fest;
  // Publish it — the head is an admin of this fest now, so this is the ordinary edit route.
  await call(patchFestRoute, {
    token: await tok(head.email, true),
    method: "PATCH",
    path: `/api/admin/fests/${fest.id}`,
    params: { id: fest.id },
    body: {
      action: "edit",
      changes: {
        status: "published",
        // Always opened first so participants can register; a fest that is over is closed afterwards.
        registrationState: "open",
        tagline: spec.tagline,
        academicYear: spec.academicYear,
        themeColor: spec.themeColor,
        contactPhone: phone(700 + Object.keys(HEADS).indexOf(spec.head)),
      },
    },
    label: `publish ${spec.name}`,
  });
  return { id: fest.id, slug: fest.slug, spec, head, events: [] };
};

const createEvent = async (fest: FestRec, spec: EventSpec, asEmail: string): Promise<EventRec> => {
  const date = dayOffset(spec.day);
  const body: Record<string, unknown> = {
    festId: fest.id,
    slug: spec.slug,
    title: spec.title,
    description: spec.description,
    category: spec.category,
    visibility: "public",
    eventType: spec.eventType,
    teamSize: spec.teamSize,
    date,
    startTime: spec.startTime,
    endTime: spec.endTime,
    venue: spec.venue,
    capacity: spec.capacity,
    registrationOpen: true,
    waitlistEnabled: spec.waitlist ?? false,
    entryFee: spec.fee,
    rules: spec.rules,
    prizes: spec.prizes ?? [],
    ...(spec.prizePool ? { prizePool: spec.prizePool } : {}),
    coordinators: spec.coordinators,
    gates: spec.gates ?? [],
    mealSlots: (spec.meals ?? []).map((m) => ({ date, mealType: m.mealType, label: m.label })),
    status: "published",
    ...(spec.live ? { liveEnabled: true, tournamentType: spec.live.tournamentType, sportType: spec.live.sportType, matchConfig: spec.live.matchConfig } : {}),
  };
  const result = await call<any>(createEventRoute, { token: await tok(asEmail), path: "/api/admin/events", body, label: `create event ${spec.title}` });
  return { id: result.event.id, spec, fest, date, entries: [] };
};

const setEventStatus = async (ev: EventRec, status: string, asEmail: string): Promise<void> => {
  await call(patchEventRoute, {
    token: await tok(asEmail),
    method: "PATCH",
    path: `/api/admin/events/${ev.id}`,
    params: { id: ev.id },
    body: { status },
    label: `status ${ev.spec.title} → ${status}`,
  });
};

/* ───────────── registrations ───────────── */

const TEAM_NAMES = [
  "Syntax Savants", "Byte Bandits", "Null Pointers", "Stack Smashers", "Pixel Pirates", "Cache Me Outside", "Git Gud", "Kernel Panic", "Dark Mode Devs", "Binary Beasts", "Lambda Legion", "Ctrl Alt Elite",
  "Segfault Squad", "Tab Spaces", "Recursive Rebels", "Async Avengers", "The Debuggers", "Hash Collision", "Rubber Ducks", "Merge Conflict", "Zero Day", "Overflow", "Heap Heroes", "Quantum Quokkas",
  "Gearheads", "Volt Vipers", "Torque Titans", "Circuit Breakers", "Iron Orbit", "Spark Plugs", "Rhythm Riot", "Midnight Chords", "Amp Overload", "The Backline", "Velvet Static", "Echo Chamber",
];
let teamNameCursor = 0;
const nextTeamName = (): string => {
  const name = TEAM_NAMES[teamNameCursor % TEAM_NAMES.length] ?? "Team";
  const round = Math.floor(teamNameCursor / TEAM_NAMES.length);
  teamNameCursor += 1;
  return round === 0 ? name : `${name} ${round + 1}`;
};

const usedBy = new Map<string, Set<string>>();
const used = (ev: EventRec): Set<string> => {
  let set = usedBy.get(ev.id);
  if (!set) usedBy.set(ev.id, (set = new Set()));
  return set;
};

const enter = async (ev: EventRec, leader: Student, mates: Student[] = [], options: { teamName?: string; accept?: number | "all" | "none"; holdBack?: boolean } = {}): Promise<Entry | null> => {
  const label = `${leader.name} → ${ev.spec.title}`;
  try {
    const result = await call<any>(registerRoute, {
      token: await tok(leader.email),
      path: "/api/registrations",
      body: {
        eventId: ev.id,
        ...(options.teamName ? { teamName: options.teamName } : {}),
        answers: {},
        members: [leader, ...mates].map((s) => ({ name: s.name, email: s.email })),
      },
      label: `register ${label}`,
    });
    const reg = result.registration;
    const entry: Entry = {
      id: reg.id,
      ev,
      leader,
      members: [leader, ...mates],
      accepted: new Set([leader.email]),
      teamName: options.teamName,
      status: reg.status,
      ticketCode: reg.ticketCode,
      ...(options.holdBack ? { holdBack: true } : {}),
    };
    for (const s of entry.members) used(ev).add(s.uid);

    const toAccept = options.accept === "none" ? 0 : options.accept === undefined || options.accept === "all" ? mates.length : options.accept;
    for (const mate of mates.slice(0, toAccept)) {
      await call(teamRoute, { token: await tok(mate.email), path: `/api/registrations/${reg.id}/team`, params: { id: reg.id }, body: { action: "accept" }, label: `accept ${mate.name} → ${label}` });
      entry.accepted.add(mate.email);
    }
    if (toAccept > 0) entry.status = String((await adminDb().collection(COLLECTIONS.registrations).doc(reg.id).get()).data()?.status ?? entry.status);
    ev.entries.push(entry);
    return entry;
  } catch (error) {
    failures.push(error instanceof RouteError ? error.message : `${label}: ${String(error)}`);
    return null;
  }
};

const cancel = async (entry: Entry): Promise<void> => {
  try {
    await call(cancelRoute, { token: await tok(entry.leader.email), path: `/api/registrations/${entry.id}/cancel`, params: { id: entry.id }, body: {}, label: `cancel ${entry.leader.name}` });
    entry.status = "cancelled";
  } catch (error) {
    failures.push(error instanceof RouteError ? error.message : String(error));
  }
};

/** Students not yet on this event, in a stable shuffled order. */
const fresh = (pool: Student[], ev: EventRec, count: number): Student[] => {
  const taken = used(ev);
  const out: Student[] = [];
  for (const s of pool) {
    if (out.length >= count) break;
    if (!taken.has(s.uid) && !out.includes(s)) out.push(s);
  }
  return out;
};

const fillSolo = async (pool: Student[], ev: EventRec, target: number): Promise<void> => {
  const have = ev.entries.length;
  for (const s of fresh(pool, ev, Math.max(0, target - have))) await enter(ev, s);
};

const fillTeams = async (pool: Student[], ev: EventRec, teams: number, options: { partial?: number; draft?: number } = {}): Promise<void> => {
  const { min, max } = ev.spec.teamSize;
  for (let t = 0; t < teams; t += 1) {
    const size = rng.int(Math.max(min, 1), max);
    const people = fresh(pool, ev, size);
    if (people.length < size || !people[0]) break;
    const [leader, ...mates] = people as [Student, ...Student[]];
    const draft = t < (options.draft ?? 0);
    const partial = !draft && t < (options.draft ?? 0) + (options.partial ?? 0) && mates.length >= 2;
    await enter(ev, leader, mates, { teamName: nextTeamName(), accept: draft ? "none" : partial ? 1 : "all" });
  }
};

/* ───────────── scanning ───────────── */

interface Volunteers {
  entry: Person[];
  meal: Person[];
  scorers: { tanvi: Person; pooja: Person; dhruv: Person };
  all: Person[];
}

const acceptedKeys = (entry: Entry): string[] => entry.members.filter((m) => entry.accepted.has(m.email)).map((m) => memberKeyFor(m.email));

const scanEntries = async (ev: EventRec, entries: Entry[], volunteers: Person[], gates: string[]): Promise<number> => {
  const byVolunteer = new Map<string, Array<{ entry: Entry; gate: string }>>();
  entries.forEach((entry, i) => {
    const v = volunteers[i % volunteers.length]!;
    const list = byVolunteer.get(v.email) ?? [];
    list.push({ entry, gate: gates[i % Math.max(gates.length, 1)] ?? "Gate A" });
    byVolunteer.set(v.email, list);
  });
  let ok = 0;
  for (const v of volunteers) {
    const jobs = byVolunteer.get(v.email) ?? [];
    if (jobs.length === 0) continue;
    await clientSignIn(v.email);
    for (const { entry, gate } of jobs) {
      try {
        // A team often arrives in two waves on the same QR: the leader first, the rest later.
        const waves = entry.members.length > 2 && rng.chance(0.25) ? 2 : 1;
        const keys = acceptedKeys(entry);
        const first = waves === 2 ? keys.slice(0, 1) : keys;
        const outcome = await attendanceRepo.recordScan({ ticketCode: entry.ticketCode, eventId: ev.id, scannedBy: v.uid, gate, memberKeys: first });
        if (outcome.result !== "ok") throw new Error(`scan ${entry.ticketCode}: ${outcome.result}`);
        if (waves === 2) {
          const second = await attendanceRepo.recordScan({ ticketCode: entry.ticketCode, eventId: ev.id, scannedBy: v.uid, gate, memberKeys: keys.slice(1) });
          if (second.result !== "ok") throw new Error(`second wave ${entry.ticketCode}: ${second.result}`);
        }
        ok += 1;
      } catch (error) {
        failures.push(String(error));
      }
    }
  }
  await clientSignOut();
  return ok;
};

const serveMeals = async (ev: EventRec, entries: Entry[], slot: { mealType: any; label: string }, chance: number, servers: Person[]): Promise<number> => {
  let served = 0;
  for (const [i, v] of servers.entries()) {
    const mine = entries.filter((_, idx) => idx % servers.length === i);
    await clientSignIn(v.email);
    for (const entry of mine) {
      if (!rng.chance(chance)) continue;
      try {
        const outcome = await attendanceRepo.recordMeal({
          ticketCode: entry.ticketCode,
          eventId: ev.id,
          mealType: slot.mealType,
          servedOn: ev.date,
          collectedBy: v.uid,
          post: i === 0 ? "Food Counter 1" : "Food Counter 2",
          memberKeys: acceptedKeys(entry),
        });
        if (outcome.result !== "ok") throw new Error(`meal ${entry.ticketCode}: ${outcome.result}`);
        served += 1;
      } catch (error) {
        failures.push(String(error));
      }
    }
  }
  await clientSignOut();
  return served;
};

const confirmed = (ev: EventRec): Entry[] => ev.entries.filter((e) => e.status === "confirmed");

/* ───────────── main ───────────── */

const COLS: string[] = [...Object.values(COLLECTIONS), "certificateEvents"];

const snapshotIds = async (): Promise<Map<string, Set<string>>> => {
  const db = adminDb();
  const out = new Map<string, Set<string>>();
  for (const name of COLS) out.set(name, new Set((await db.collection(name).listDocuments()).map((d) => d.id)));
  return out;
};

export const seed = async (): Promise<void> => {
  const target = assertEmulatorTarget();
  log(`\n  TARGET  Firebase emulator · project ${target.project} · firestore ${target.firestore} · auth ${target.auth}`);
  log("  No production system is contacted by this run.\n");

  const baseline = await snapshotIds();
  const existing = await adminDb().collection(COLLECTIONS.fests).where("demoBatch", "==", BATCH).limit(1).get();
  if (!existing.empty) throw new Error(`The ${BATCH} dataset is already present. Run \`npm run demo:clean\` first.`);

  const restore = quietApp();
  const started = Date.now();
  const phase = (message: string) => log(`  [${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${message}`);

  try {
    /* ── 1. accounts ── */
    phase("Creating the platform owner and the event heads…");
    const platform = await createPlatformAdmin();
    const heads: Record<string, Student> = {};
    let headIndex = 0;
    for (const [key, h] of Object.entries(HEADS)) {
      heads[key] = await createStudent(h.name, h.college, 880 + headIndex);
      headIndex += 1;
    }

    phase("Creating students…");
    const names = generateStudentNames(Math.round(150 * Math.min(SCALE, 1) + (SCALE < 1 ? 20 : 0)));
    const students: Student[] = [];
    for (const [i, name] of names.entries()) {
      const college = i < 12 ? "NovaX Institute of Technology" : (COLLEGES[(i * 5) % COLLEGES.length] ?? "NovaX Institute of Technology");
      students.push(await createStudent(name, college, i + 1));
    }
    const S = (name: string): Student => students.find((s) => s.name === name)!;
    const pool = rng.shuffle(students);

    /* ── 2. fests ── */
    phase("Registering fests through /api/register-event and publishing them…");
    const fests: FestRec[] = [];
    for (const spec of festSpecs()) fests.push(await registerFest(spec, heads[spec.head]!));
    const F = (key: FestSpec["key"]): FestRec => fests.find((f) => f.spec.key === key)!;
    const nexus = F("nexus");
    const arjun = heads.arjun!;

    /* ── 3. staff ── */
    phase("Inviting admins and volunteers…");
    const adminIds = [nexus.id, F("hack").id, F("genesis").id];
    const admins: Person[] = [];
    for (const [i, a] of FLAGSHIP_ADMINS.entries()) admins.push(await inviteStaff(arjun.email, a, i === 0 ? adminIds : [nexus.id, F("hack").id], 600 + i));
    const [riya, aditya] = admins as [Person, Person];
    const vols: Person[] = [];
    for (const [i, v] of FLAGSHIP_VOLUNTEERS.entries()) vols.push(await inviteStaff(arjun.email, v, adminIds, 620 + i));
    const byFirst = (first: string) => vols.find((v) => v.name.startsWith(first))!;
    const volunteers: Volunteers = {
      entry: [byFirst("Sneha"), byFirst("Rahul"), byFirst("Mohit")],
      meal: [byFirst("Kabir"), byFirst("Ishita")],
      scorers: { tanvi: byFirst("Tanvi"), pooja: byFirst("Pooja"), dhruv: byFirst("Dhruv") },
      all: vols,
    };
    const pendingVolunteer = await invitePending(arjun.email, PENDING_VOLUNTEER, [nexus.id], 660);
    const freshOrganizer = await createStudent(FRESH_ORGANIZER.name, FRESH_ORGANIZER.college, 870);
    const freshStudent = await createStudent(FRESH_STUDENT.name, FRESH_STUDENT.college, 871);
    const otherVols: Person[] = [];
    for (const key of ["meera", "karan", "neha"] as const) {
      const fest = F(key === "meera" ? "aurora" : key === "karan" ? "meridian" : "orbit");
      for (const [i, v] of OTHER_VOLUNTEERS[key].entries()) otherVols.push(await inviteStaff(heads[key]!.email, v, [fest.id], 640 + otherVols.length + i));
    }

    /* ── 4. events ── */
    phase("Creating events…");
    for (const fest of fests) {
      const creator = fest.spec.key === "nexus" || fest.spec.key === "hack" || fest.spec.key === "genesis" ? riya.email : fest.head.email;
      for (const spec of fest.spec.events) fest.events.push(await createEvent(fest, spec, creator));
    }
    const E = (fest: FestRec, key: string): EventRec => fest.events.find((e) => e.spec.key === key)!;

    /* ── 5. registrations ── */
    phase("Registering participants (real tickets, teams, waitlist, cancellations)…");
    const ananya = S("Ananya Bose");
    const rohan = S("Rohan Gupta");
    const priya = S("Priya Nair");

    // Opening ceremony
    const opening = E(nexus, "opening");
    for (const s of [ananya, rohan, priya, S("Kavya Menon"), S("Siddharth Rao")]) await enter(opening, s);
    await fillSolo(pool, opening, scaled(opening.spec.entries));

    // Hackathon — Ananya's winning team, then the field
    const hack = E(nexus, "hackathon");
    await enter(hack, ananya, [S("Kavya Menon"), S("Siddharth Rao")], { teamName: "Syntax Savants", accept: "all" });
    await fillTeams(pool, hack, scaled(hack.spec.entries) - 1, { partial: 2 });

    // Workshop
    const genai = E(nexus, "genai");
    for (const s of [ananya, priya]) await enter(genai, s);
    await fillSolo(pool, genai, scaled(genai.spec.entries));

    // CodeStorm — a valid unscanned QR (Priya), an already-scanned one (Rohan), a cancelled one (Ishaan)
    const code = E(nexus, "codestorm");
    const ananyaCode = await enter(code, ananya);
    const rohanCode = await enter(code, rohan);
    const priyaCode = await enter(code, priya, [], { holdBack: true });
    const ishaanCode = await enter(code, S("Ishaan Verma"));
    await fillSolo(pool, code, scaled(code.spec.entries));

    // PixelPerfect — fill to capacity, then the waitlist, then two withdrawals promote waitlisted teams
    const pixel = E(nexus, "pixel");
    let seats = 0;
    while (seats < pixel.spec.capacity) {
      const size = rng.int(1, 2);
      const people = fresh(pool, pixel, size);
      if (people.length < size) break;
      const [leader, ...mates] = people as [Student, ...Student[]];
      if (await enter(pixel, leader, mates, { teamName: nextTeamName() })) seats += size;
      else break;
    }
    for (const s of [S("Aarav Shah"), S("Meghna Das"), S("Tanmay Joshi"), ...fresh(pool, pixel, 3)]) {
      if (!used(pixel).has(s.uid)) await enter(pixel, s, [], { teamName: nextTeamName() });
    }

    // Live tournaments, quiz, pitch, CTF, workshop, bands, closing
    await fillTeams(pool, E(nexus, "robowars"), scaled(8));
    const quiz = E(nexus, "quiz");
    await fillTeams(pool, quiz, scaled(quiz.spec.entries), { draft: 1, partial: 2 });
    await fillTeams(pool, E(nexus, "valorant"), scaled(8));
    await fillTeams(pool, E(nexus, "football"), 4);
    await fillTeams(pool, E(nexus, "cricket"), 4);
    await fillTeams(pool, E(nexus, "volleyball"), 4);
    await fillSolo(pool, E(nexus, "tt"), 6);
    await fillTeams(pool, E(nexus, "pitch"), scaled(12));
    const ctf = E(nexus, "ctf");
    await enter(ctf, ananya, [rohan, priya], { teamName: "Null Pointers", accept: "all" });
    await enter(ctf, S("Diya Chatterjee"), [S("Vihaan Kapoor"), S("Saanvi Reddy")], { teamName: "Byte Bandits", accept: "none" });
    await fillTeams(pool, ctf, scaled(14) - 2, { partial: 1 });
    await fillSolo(pool, E(nexus, "cyber"), scaled(52));
    await fillTeams(pool, E(nexus, "bands"), scaled(7));
    const closing = E(nexus, "closing");
    await enter(closing, ananya);
    await fillSolo(pool, closing, scaled(closing.spec.entries));

    // The other fests
    for (const fest of fests) {
      if (fest.spec.key === "nexus") continue;
      for (const ev of fest.events) {
        const entries = scaled(ev.spec.entries);
        if (entries === 0) continue;
        if (ev.spec.eventType === "solo") await fillSolo(pool, ev, entries);
        else await fillTeams(pool, ev, entries);
      }
    }

    // A student joins a not-yet-complete team with its join code instead of waiting for an invitation.
    {
      const draftTeam = quiz.entries.find((e) => e.status === "draft");
      const joiner = fresh(pool, quiz, 1)[0];
      if (draftTeam && joiner) {
        const code = String((await adminDb().collection(COLLECTIONS.registrations).doc(draftTeam.id).get()).data()?.joinCode ?? "");
        if (code) {
          try {
            await call(joinRoute, { token: await tok(joiner.email), path: "/api/registrations/join", body: { code, eventId: quiz.id }, label: "join by code" });
            used(quiz).add(joiner.uid);
          } catch (error) {
            failures.push(error instanceof RouteError ? error.message : String(error));
          }
        }
      }
    }

    // Withdrawals while events are still open: one cancelled QR per kind of event
    if (ishaanCode) await cancel(ishaanCode);
    const cancellable = (ev: EventRec, n: number) => ev.entries.filter((e) => e.status === "confirmed" && !["Ananya Bose", "Rohan Gupta", "Priya Nair"].includes(e.leader.name)).slice(0, n);
    for (const entry of [...cancellable(opening, 2), ...cancellable(genai, 2), ...cancellable(E(nexus, "cyber"), 1), ...cancellable(E(nexus, "bands"), 1), ...cancellable(pixel, 2)]) await cancel(entry);
    // Cancelling promotes waitlisted PixelPerfect entries; refresh statuses from the database.
    for (const fest of fests) {
      for (const ev of fest.events) {
        const snap = await adminDb().collection(COLLECTIONS.registrations).where("eventId", "==", ev.id).get();
        const status = new Map(snap.docs.map((d) => [d.id, String(d.data().status)]));
        for (const entry of ev.entries) entry.status = status.get(entry.id) ?? entry.status;
      }
    }

    // A fest that has finished stops taking registrations.
    for (const fest of fests) {
      if (fest.spec.registrationState !== "closed") continue;
      await call(patchFestRoute, {
        token: await tok(fest.head.email, true),
        method: "PATCH",
        path: `/api/admin/fests/${fest.id}`,
        params: { id: fest.id },
        body: { action: "edit", changes: { registrationState: "closed" } },
        label: `close registration ${fest.spec.name}`,
      });
    }

    /* ── 6. arenas and rosters ── */
    phase("Creating arenas and the volunteer roster…");
    const arenas: Record<string, string> = {};
    for (const [name, location] of [["Robo Cage", "Robotics Arena"], ["Esports Arena", "Esports Lounge"], ["Main Stage", "Open Air Theatre"], ["Football Ground", "Main Ground"], ["Cricket Nets", "Practice Ground"], ["Volleyball Court", "Indoor Sports Hall"], ["TT Hall", "Indoor Sports Hall"]] as const) {
      const res = await call<any>(createArenaRoute, { token: await tok(riya.email), path: "/api/admin/arenas", body: { festId: nexus.id, name, location }, label: `arena ${name}` });
      arenas[name] = res.arena.id;
    }
    await clientSignIn(riya.email);
    const today = dayOffset(0);
    const yesterday = dayOffset(-1);
    const tomorrow = dayOffset(1);
    const shift = async (v: Person, post: string, duty: "entry" | "meal" | "crowd" | "scoring", date: string, start: string, end: string, coordinator: string) => {
      await shiftRepo.create({ festId: nexus.id, userId: v.uid, post, duty, date, startTime: start, endTime: end, eventIds: [], coordinatorName: coordinator, notes: "" }, riya.uid);
    };
    const [sneha, rahul, mohit] = volunteers.entry as [Person, Person, Person];
    const [kabir, ishita] = volunteers.meal as [Person, Person];
    // Yesterday and tomorrow keep fixed day shifts. Today's windows are placed around the moment the
    // seed runs, so "on shift now" has people in it whatever the hour (clock times cannot wrap midnight).
    const fixed = [[yesterday, ["08:30", "13:00"], ["09:00", "17:00"], ["13:00", "21:00"]], [tomorrow, ["08:30", "13:00"], ["09:00", "17:00"], ["13:00", "22:00"]]] as const;
    for (const [date, a, b, c] of fixed) {
      await shift(sneha, "Gate A", "entry", date, a[0], a[1], "Riya Sen");
      await shift(rahul, "Gate B", "entry", date, b[0], b[1], "Riya Sen");
      await shift(mohit, "Gate A", "entry", date, c[0], c[1], "Riya Sen");
      await shift(kabir, "Food Counter 1", "meal", date, "11:00", "15:00", "Aditya Roy");
      await shift(ishita, "Food Counter 2", "meal", date, "15:00", "21:30", "Aditya Roy");
      await shift(byFirst("Vikram"), "Help Desk", "crowd", date, "09:00", "18:00", "Aditya Roy");
    }
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const clock = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const around = (from: number, to: number): [string, string] => {
      let start = Math.max(0, nowMinutes + from);
      let end = Math.min(23 * 60 + 59, nowMinutes + to);
      if (end - start < 120) {
        end = Math.min(23 * 60 + 59, start + 120);
        start = Math.max(0, end - 120);
      }
      return [clock(start), clock(end)];
    };
    const [sA, sB] = around(-180, 240);
    const [rA, rB] = around(-120, 300);
    const [kA, kB] = around(-90, 180);
    const [vA, vB] = around(-240, 360);
    const [tA, tB] = around(-60, 300);
    const [pA, pB] = around(-30, 360);
    const [mA, mB] = around(260, 480);
    const [iA, iB] = around(190, 420);
    await shift(sneha, "Gate A", "entry", today, sA, sB, "Riya Sen");
    await shift(rahul, "Gate B", "entry", today, rA, rB, "Riya Sen");
    await shift(mohit, "Gate A", "entry", today, mA, mB, "Riya Sen");
    await shift(kabir, "Food Counter 1", "meal", today, kA, kB, "Aditya Roy");
    await shift(ishita, "Food Counter 2", "meal", today, iA, iB, "Aditya Roy");
    await shift(byFirst("Vikram"), "Help Desk", "crowd", today, vA, vB, "Aditya Roy");
    await shift(volunteers.scorers.tanvi, arenas["Robo Cage"]!, "scoring", today, tA, tB, "Riya Sen");
    await shift(volunteers.scorers.pooja, arenas["Esports Arena"]!, "scoring", today, pA, pB, "Riya Sen");
    await shift(volunteers.scorers.pooja, arenas["Cricket Nets"]!, "scoring", today, pA, pB, "Riya Sen");
    await shift(volunteers.scorers.dhruv, arenas["Football Ground"]!, "scoring", today, tA, tB, "Riya Sen");
    await shift(volunteers.scorers.tanvi, arenas["TT Hall"]!, "scoring", today, tA, tB, "Riya Sen");
    await shift(volunteers.scorers.tanvi, arenas["Volleyball Court"]!, "scoring", yesterday, "14:00", "19:00", "Riya Sen");
    await shift(volunteers.scorers.tanvi, arenas["Volleyball Court"]!, "scoring", today, tA, tB, "Riya Sen");
    await clientSignOut();

    /* ── 7. check-in ── */
    phase("Scanning tickets at the gates (real scanner code, volunteer sessions)…");
    const entryVols = volunteers.entry;
    let scans = 0;
    const attendRate: Record<string, number> = { opening: 0.84, hackathon: 1, genai: 0.8, codestorm: 0.62, pixel: 0.6, robowars: 1, valorant: 1, football: 1, cricket: 1, volleyball: 1, tt: 1, "g-inaug": 0.8, "g-web": 0.85, "g-hw": 1, "g-quiz": 0.85 };
    const protectedFromScan = (e: Entry) => Boolean(e.holdBack);
    const toScan: Array<{ ev: EventRec; entries: Entry[] }> = [];
    for (const fest of [nexus, F("genesis")]) {
      for (const ev of fest.events) {
        const rate = attendRate[ev.spec.key];
        if (rate === undefined) continue;
        let list = confirmed(ev).filter((e) => !protectedFromScan(e));
        if (ev === code) list = list.filter((e) => e === rohanCode || e === ananyaCode || rng.chance(rate));
        else if (rate < 1) list = list.filter((e) => ["Ananya Bose", "Rohan Gupta", "Priya Nair"].includes(e.leader.name) || rng.chance(rate));
        toScan.push({ ev, entries: rng.shuffle(list) });
      }
    }
    for (const { ev, entries } of toScan) {
      const gates = ev.spec.gates ?? ["Gate A"];
      const isGenesis = ev.fest.spec.key === "genesis";
      scans += await scanEntries(ev, entries, isGenesis ? [sneha, rahul] : entryVols, gates);
    }
    // A duplicate scan or two — the second tap returns "already checked in" and writes nothing.
    await clientSignIn(sneha.email);
    for (const entry of [rohanCode, ...confirmed(opening).slice(0, 3)]) {
      if (!entry) continue;
      await attendanceRepo.recordScan({ ticketCode: entry.ticketCode, eventId: entry.ev.id, scannedBy: sneha.uid, gate: "Gate A", memberKeys: acceptedKeys(entry) }).catch(() => undefined);
    }
    await clientSignOut();
    phase(`  ${scans} entries checked in`);

    // Three people whose QR would not scan are admitted by an admin — the audited manual override.
    {
      const attendedNow = new Set((await attendedEntries(opening)).map((e) => e.id));
      const missed = confirmed(opening).filter((e) => !attendedNow.has(e.id)).slice(0, 3);
      for (const entry of missed) {
        try {
          await call(manualAttendanceRoute, { token: await tok(riya.email), path: "/api/admin/attendance/manual", body: { ticketCode: entry.ticketCode, eventId: opening.id, gate: "Gate A", reason: "Phone battery dead — verified college ID" }, label: "manual check-in" });
        } catch (error) {
          failures.push(error instanceof RouteError ? error.message : String(error));
        }
      }
    }

    /* ── 8. meals ── */
    phase("Serving meals…");
    let mealsServed = 0;
    for (const ev of [...nexus.events]) {
      for (const slot of ev.spec.meals ?? []) {
        const attended = await attendedEntries(ev);
        if (attended.length === 0) continue;
        // Today's dinner has not happened yet — those participants are eligible but have not collected.
        if (ev.spec.key === "valorant") continue;
        const chance = ev.spec.day < 0 ? 0.82 : 0.7;
        // CodeStorm's snack is scripted: Rohan has collected (already-used meal QR), Ananya has not (a valid one).
        const scripted = (e: Entry) => ev === code && (e === rohanCode || e === ananyaCode);
        mealsServed += await serveMeals(ev, attended.filter((e) => !scripted(e)), slot, chance, volunteers.meal);
        if (ev === code && rohanCode && attended.includes(rohanCode)) mealsServed += await serveMeals(ev, [rohanCode], slot, 1, [volunteers.meal[0]!]);
      }
    }
    phase(`  ${mealsServed} meal servings recorded`);

    /* ── 9. event status ── */
    phase("Moving events through their lifecycle…");
    for (const fest of [nexus, F("genesis")]) {
      for (const ev of fest.events) {
        if (ev.spec.final !== "published") await setEventStatus(ev, ev.spec.final, riya.email);
      }
    }

    /* ── 10. live tournaments ── */
    phase("Running the live tournaments (brackets, arenas, scoring)…");
    await runTournament(E(nexus, "robowars"), "Robo Cage", arenas, riya, volunteers.scorers.tanvi, "robo");
    await runTournament(E(nexus, "valorant"), "Esports Arena", arenas, riya, volunteers.scorers.pooja, "points");
    await runTournament(E(nexus, "football"), "Football Ground", arenas, riya, volunteers.scorers.dhruv, "football", "round_robin");
    await runTournament(E(nexus, "cricket"), "Cricket Nets", arenas, riya, volunteers.scorers.pooja, "cricket");
    await runTournament(E(nexus, "volleyball"), "Volleyball Court", arenas, riya, volunteers.scorers.tanvi, "volleyball", "knockout", "complete");
    await runTournament(E(nexus, "tt"), "TT Hall", arenas, riya, volunteers.scorers.tanvi, "volleyball", "manual");

    /* ── 11. results, certificates ── */
    phase("Publishing results and certificates…");
    const results = async (ev: EventRec, placed: Array<{ entry: Entry; position: number }>, asEmail: string, note?: string) => {
      const entries = placed.map(({ entry, position }) => ({
        registrationId: entry.id,
        position,
        award: position === 1 ? "winner" : position === 2 ? "runner_up" : position === 3 ? "second_runner_up" : "special_mention",
        displayName: entry.teamName ?? entry.leader.name,
        ...(position === 1 && note ? { note } : {}),
      }));
      await call(putResultsRoute, { token: await tok(asEmail), method: "PUT", path: `/api/admin/events/${ev.id}/results`, params: { id: ev.id }, body: { entries }, label: `results ${ev.spec.title}` });
      await call(publishResultsRoute, { token: await tok(asEmail), path: `/api/admin/events/${ev.id}/results/publish`, params: { id: ev.id }, body: {}, label: `publish results ${ev.spec.title}` });
    };
    const attendedOf = async (ev: EventRec) => (await attendedEntries(ev)).filter((e) => e.status === "confirmed");
    {
      const attended = await attendedOf(hack);
      const winner = attended.find((e) => e.teamName === "Syntax Savants")!;
      const others = attended.filter((e) => e !== winner);
      await results(hack, [{ entry: winner, position: 1 }, ...others.slice(0, 3).map((entry, i) => ({ entry, position: i + 2 }))], riya.email, "Built a retrieval-augmented tutor for NCERT physics in eleven hours.");
    }
    for (const key of ["g-hw", "g-quiz", "g-web"]) {
      const ev = E(F("genesis"), key);
      const attended = await attendedOf(ev);
      if (attended.length >= 3) await results(ev, attended.slice(0, 3).map((entry, i) => ({ entry, position: i + 1 })), riya.email);
    }
    const prepare = async (ev: EventRec) => call<any>(prepareCertsRoute, { token: await tok(riya.email), path: `/api/admin/events/${ev.id}/certificates`, params: { id: ev.id }, body: {}, label: `prepare certificates ${ev.spec.title}` });
    const release = async (ev: EventRec) => call<any>(publishCertsRoute, { token: await tok(platform.email, true), path: "/api/admin/certificates/publish", body: { eventId: ev.id }, label: `release certificates ${ev.spec.title}` });
    for (const ev of [opening, hack, genai, ...F("genesis").events]) await prepare(ev);
    for (const ev of [opening, hack, ...F("genesis").events]) await release(ev);
    // One certificate issued in error and revoked; the workshop's batch is prepared but not yet released.
    const revokeTarget = (await adminDb().collection(COLLECTIONS.certificates).where("eventId", "==", opening.id).get()).docs.find((d) => d.data().recipientName !== "Ananya Bose" && d.data().recipientName !== "Rohan Gupta" && d.data().recipientName !== "Priya Nair");
    if (revokeTarget) await call(revokeCertRoute, { token: await tok(riya.email), path: `/api/admin/certificates/${revokeTarget.id}/revoke`, params: { id: revokeTarget.id }, body: { reason: "Issued in error — duplicate registration" }, label: "revoke certificate" });

    /* ── 11b. public verification traffic ── */
    phase("Generating certificate verification and download traffic through the public routes…");
    {
      const released = (await adminDb().collection(COLLECTIONS.certificates).get()).docs.filter((d) => d.data().published !== false && d.data().revoked !== true).map((d) => String(d.data().certificateNumber));
      const publicGet = async (route: typeof verifyRoute, number: string, path: string) => {
        const response = await route(new Request(`http://localhost:3000${path}`), { params: Promise.resolve({ number }) });
        await response.arrayBuffer();
      };
      const picks = rng.shuffle(released);
      for (const n of picks.slice(0, scaled(160))) await publicGet(verifyRoute, n, `/api/verify/${n}`);
      for (const n of picks.slice(0, scaled(55))) await publicGet(verifyPdfRoute, n, `/api/verify/${n}/pdf`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 3000));
    }

    /* ── 12. announcements ── */
    phase("Posting announcements…");
    await call(patchEventRoute, { token: await tok(riya.email), method: "PATCH", path: `/api/admin/events/${quiz.id}`, params: { id: quiz.id }, body: { venue: "Auditorium C" }, label: "event venue update" });
    const announce = async (fest: FestRec, asEmail: string, title: string, body: string, eventId?: string) =>
      call(announceRoute, { token: await tok(asEmail), path: `/api/admin/fests/${fest.id}/announcements`, params: { id: fest.id }, body: { title, body, ...(eventId ? { eventId } : {}), email: false }, label: `announce ${title}` });
    await announce(nexus, arjun.email, "Welcome to NovaX Nexus 2026", "Doors open at 08:30 each day. Keep your ticket QR ready — it is your entry pass and your meal coupon.");
    await announce(nexus, riya.email, "PixelPerfect moved to the Design Studio", "Today's UI/UX challenge now starts at 11:00 in the Design Studio, ground floor of the Design Block.", pixel.id);
    await announce(nexus, aditya.email, "Dinner coupons", "Show the same ticket QR at Food Counter 2 between 19:30 and 21:30. One serving per person per slot.");
    await announce(F("genesis"), arjun.email, "Thank you for Genesis 2025", "Your certificates are in your Plansphere account and can be verified by anyone with the certificate number.");

    /* ── 13. dates, markers ── */
    phase("Spreading timestamps over the past weeks…");
    await backdate(fests, students.concat(Object.values(heads), freshOrganizer, freshStudent));
    phase("Stamping every demo record with demo:true / demoBatch…");
    const stamped = await stamp(baseline);

    restore();
    await report({ fests, students, heads, platform, riya, aditya, vols, otherVols, volunteers, stamped, scans, mealsServed, ananya, rohan, priya, ananyaCode, rohanCode, priyaCode, ishaanCode, code, nexus, pendingVolunteer, freshOrganizer, freshStudent });
  } finally {
    restore();
  }
};

/* ───────────── helpers that need the database ───────────── */

const attendedEntries = async (ev: EventRec): Promise<Entry[]> => {
  const snap = await adminDb().collection(COLLECTIONS.attendance).where("eventId", "==", ev.id).get();
  const ids = new Set(snap.docs.map((d) => d.id));
  return ev.entries.filter((e) => ids.has(e.id));
};

type PlayMode = "robo" | "points" | "football" | "cricket" | "volleyball";
type Format = "knockout" | "round_robin" | "manual";

/**
 * Builds the fixtures (a generated bracket, a round robin, or hand-made swiss/custom
 * fixtures), assigns them to an arena, then plays them through the volunteer scoring
 * route — the same calls a scorer's taps make. `partial` leaves the tournament mid-way
 * with a match live; `complete` plays it to a champion.
 */
const runTournament = async (
  ev: EventRec,
  arenaName: string,
  arenas: Record<string, string>,
  admin: Person,
  scorer: Person,
  mode: PlayMode,
  format: Format = "knockout",
  plan: "partial" | "complete" = "partial",
): Promise<void> => {
  const adminToken = await tok(admin.email, true);
  const arenaId = arenas[arenaName]!;
  const startMs = at(ev.date, ev.spec.startTime).getTime();
  const label = (e: Entry) => e.teamName ?? e.leader.name;

  if (format === "manual") {
    const entries = confirmed(ev);
    for (let i = 0; i + 1 < entries.length; i += 2) {
      await call(createMatchRoute, {
        token: adminToken,
        path: "/api/admin/matches",
        body: {
          festId: ev.fest.id,
          eventId: ev.id,
          arenaId,
          startTime: new Date(startMs + (i / 2) * minutes(30)).toISOString(),
          round: 1,
          roundLabel: `Round 1 · Board ${i / 2 + 1}`,
          matchIndex: i / 2,
          homeTeam: { registrationId: entries[i]!.id, name: label(entries[i]!), isBye: false },
          awayTeam: { registrationId: entries[i + 1]!.id, name: label(entries[i + 1]!), isBye: false },
        },
        label: `fixture ${ev.spec.title}`,
      });
    }
  } else {
    await call(bracketRoute, { token: adminToken, path: `/api/admin/events/${ev.id}/bracket`, params: { id: ev.id }, body: { tournamentType: format }, label: `bracket ${ev.spec.title}` });
    const generated = (await adminDb().collection(COLLECTIONS.matches).where("eventId", "==", ev.id).get()).docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
    let slot = startMs;
    for (const m of generated.sort((a, b) => a.round - b.round || a.matchIndex - b.matchIndex)) {
      await call(patchMatchRoute, { token: adminToken, method: "PATCH", path: `/api/admin/matches/${m.id}`, params: { id: m.id }, body: { arenaId, startTime: new Date(slot).toISOString() }, label: "assign arena" });
      slot += minutes(25);
    }
  }

  const scorerToken = await tok(scorer.email, true);
  const act = (id: string, body: unknown) => call(matchActionRoute, { token: scorerToken, path: `/api/volunteer/matches/${id}/action`, params: { id }, body, label: `match ${id}` });
  const refresh = async () => (await adminDb().collection(COLLECTIONS.matches).where("eventId", "==", ev.id).get()).docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const other = (side: "home" | "away") => (side === "home" ? "away" : "home");
  const score = (id: string, type: string, side?: "home" | "away", payload?: Record<string, unknown>) =>
    act(id, { action: "score", scoreAction: { type, ...(side ? { side } : {}), ...(payload ? { payload } : {}) } });
  const points = async (id: string, side: "home" | "away", n: number) => {
    for (let i = 0; i < n; i += 1) await score(id, "point", side);
  };
  const config = ev.spec.live?.matchConfig ?? {};

  const play = async (id: string, winner: "home" | "away", live: boolean) => {
    await act(id, { action: "start" });
    if (mode === "robo") {
      if (rng.chance(0.4)) await score(id, "round_win", other(winner));
      if (!live) {
        await score(id, "round_win", winner);
        await score(id, "round_win", winner);
      } else {
        await score(id, "point", winner, { value: 12 });
      }
    } else if (mode === "points") {
      const loserScore = rng.int(4, 11);
      if (!live) {
        await score(id, "point", winner, { value: 7 });
        await score(id, "point", other(winner), { value: loserScore });
        await score(id, "point", winner, { value: 6 });
      } else {
        await score(id, "point", winner, { value: 8 });
        await score(id, "point", other(winner), { value: 5 });
      }
    } else if (mode === "football") {
      const goals = async (side: "home" | "away", n: number) => {
        for (let i = 0; i < n; i += 1) await score(id, "goal", side);
      };
      if (!live) {
        const g = rng.int(1, 3);
        await goals(winner, g);
        if (rng.chance(0.6)) await score(id, "yellow_card", other(winner));
        await goals(other(winner), rng.int(0, g - 1));
        if (rng.chance(0.25)) await score(id, "red_card", other(winner));
        await act(id, { action: "finish" });
      } else {
        await goals(winner, 1);
        await score(id, "yellow_card", other(winner));
        await goals(other(winner), 1);
      }
    } else if (mode === "cricket") {
      const pattern = [1, 4, 0, 2, 6, 1, 1, 0, 2, 4, 1, 6, 0, 1, 2, 1, 4, 1];
      const ball = (runs: number) => score(id, "run", undefined, { runs });
      if (live) {
        for (let i = 0; i < 9; i += 1) {
          if (i === 5) await score(id, "wicket");
          else await ball(pattern[i]!);
        }
        return;
      }
      let first = 0;
      for (let i = 0; i < 18; i += 1) {
        if (i === 6) await score(id, "wicket");
        else {
          await ball(pattern[i]!);
          first += pattern[i]!;
        }
      }
      if (winner === "away") {
        for (let i = 0; i < Math.ceil((first + 1) / 6); i += 1) await ball(6);
      } else {
        for (const r of [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0]) await ball(r);
      }
    } else {
      const target = Number(config.pointsPerSet ?? 11);
      const winSet = async () => {
        await points(id, other(winner), rng.int(2, target - 4));
        await points(id, winner, target);
      };
      await winSet();
      if (!live) await winSet();
      else {
        await points(id, other(winner), 3);
        await points(id, winner, 4);
      }
    }
  };

  const winnerSide = (): "home" | "away" => (rng.chance(0.5) ? "home" : "away");
  let all = await refresh();
  if (format === "knockout") {
    const rounds = Math.max(...all.map((m) => m.round));
    for (let round = 1; round <= rounds; round += 1) {
      const inRound = all.filter((m) => m.round === round && m.status !== "completed").sort((a, b) => a.matchIndex - b.matchIndex);
      if (plan === "complete" || round === 1) {
        for (const m of inRound) await play(m.id, winnerSide(), false);
      } else {
        // Mid-tournament: the first match of this round is done, the second is live, anything after waits.
        if (inRound[0]) await play(inRound[0].id, winnerSide(), false);
        if (inRound[1]) await play(inRound[1].id, winnerSide(), true);
        break;
      }
      all = await refresh();
    }
  } else {
    // Round robin and hand-made fixtures: everything played except the last, which is live.
    const list = all.sort((a, b) => a.round - b.round || a.matchIndex - b.matchIndex);
    for (const [i, m] of list.entries()) {
      if (m.status === "completed") continue;
      await play(m.id, winnerSide(), plan === "partial" && i === list.length - 1);
    }
  }
};

/* ───────────── timestamps ───────────── */

const eventStart = (ev: EventRec): number => at(ev.date, ev.spec.startTime).getTime();
const eventEnd = (ev: EventRec): number => at(ev.date, ev.spec.endTime).getTime();

const backdate = async (fests: FestRec[], people: Student[]): Promise<void> => {
  const db = adminDb();
  const bw = retryingBulkWriter(db);
  const now = Date.now();
  const day = minutes(24 * 60);
  const ts = (ms: number) => Timestamp.fromMillis(Math.min(ms, now - minutes(2)));

  const events = new Map<string, EventRec>();
  const festCreated = new Map<string, number>();
  for (const fest of fests) {
    const firstStart = Math.min(...fest.events.map(eventStart));
    const created = firstStart - rng.int(26, 48) * day;
    festCreated.set(fest.id, created);
    bw.update(db.collection(COLLECTIONS.fests).doc(fest.id), { createdAt: ts(created), updatedAt: ts(Math.min(now, firstStart - day)) });
    for (const ev of fest.events) {
      events.set(ev.id, ev);
      const evCreated = created + rng.int(2, 9) * day;
      bw.update(db.collection(COLLECTIONS.events).doc(ev.id), { createdAt: ts(evCreated), updatedAt: ts(Math.min(now, evCreated + rng.int(1, 6) * day)) });
    }
  }

  const earliestByUser = new Map<string, number>();
  const regTimes = new Map<string, number>();
  const regs = await db.collection(COLLECTIONS.registrations).get();
  for (const doc of regs.docs) {
    const ev = events.get(String(doc.data().eventId));
    if (!ev) continue;
    const windowEnd = Math.min(now - minutes(30), eventStart(ev) - minutes(20));
    const windowStart = Math.max((festCreated.get(ev.fest.id) ?? now) + 4 * day, windowEnd - 22 * day);
    const r = rng.next();
    // Weighted toward the days just before the event, with a trickle in the last 24 hours.
    const t = windowStart + (windowEnd - windowStart) * (1 - r * r * 0.92);
    const created = Math.max(windowStart, Math.min(t, windowEnd));
    regTimes.set(doc.id, created);
    const update: Record<string, unknown> = { createdAt: ts(created), updatedAt: ts(created + minutes(rng.int(1, 90))) };
    if (doc.data().status === "cancelled") update.cancelledAt = ts(created + minutes(rng.int(60, 3000)));
    const members = (doc.data().members as any[]).map((m) => (m.invitedAt ? { ...m, invitedAt: ts(created), ...(m.respondedAt ? { respondedAt: ts(created + minutes(rng.int(5, 600))) } : {}) } : m));
    update.members = members;
    bw.update(doc.ref, update);
    for (const m of members) {
      if (m.userId) earliestByUser.set(m.userId, Math.min(earliestByUser.get(m.userId) ?? Infinity, created));
    }
  }

  for (const s of people) {
    const earliest = earliestByUser.get(s.uid) ?? now - 3 * day;
    bw.update(db.collection(COLLECTIONS.users).doc(s.uid), { createdAt: ts(earliest - rng.int(1, 30) * day - minutes(rng.int(5, 600))) });
  }
  const staff = await db.collection(COLLECTIONS.users).where("role", "in", ["volunteer", "admin", "super_admin"]).get();
  const studentIds = new Set(people.map((p) => p.uid));
  for (const doc of staff.docs) {
    if (studentIds.has(doc.id)) continue;
    bw.update(doc.ref, { createdAt: ts(now - rng.int(14, 30) * day), updatedAt: ts(now - rng.int(2, 10) * day) });
  }

  const att = await db.collection(COLLECTIONS.attendance).get();
  for (const doc of att.docs) {
    const ev = events.get(String(doc.data().eventId));
    if (!ev) continue;
    const base = eventStart(ev) + minutes(rng.int(2, 55));
    // Manual (admin) check-ins are the whole-entry form: they carry no per-member array.
    const rawMembers = (doc.data().members as any[] | undefined) ?? [];
    const update: Record<string, unknown> = { scannedAt: ts(base), createdAt: ts(base), updatedAt: ts(base) };
    if (rawMembers.length > 0) update.members = rawMembers.map((m, i) => ({ ...m, at: ts(base + minutes(i * rng.int(0, 25))) }));
    bw.update(doc.ref, update);
  }

  const meals = await db.collection(COLLECTIONS.foodCollections).get();
  const slotMinute: Record<string, [number, number]> = { breakfast: [8 * 60, 9 * 60 + 30], lunch: [12 * 60 + 30, 14 * 60], snack: [16 * 60, 17 * 60 + 30], dinner: [19 * 60 + 30, 21 * 60] };
  for (const doc of meals.docs) {
    const [from, to] = slotMinute[String(doc.data().mealType)] ?? [12 * 60, 13 * 60];
    const [y, m, d] = String(doc.data().servedOn).split("-").map(Number) as [number, number, number];
    const when = new Date(y, m - 1, d, 0, 0, 0).getTime() + minutes(rng.int(from, to));
    bw.update(doc.ref, { collectedAt: ts(when), createdAt: ts(when), updatedAt: ts(when) });
  }

  const certs = await db.collection(COLLECTIONS.certificates).get();
  for (const doc of certs.docs) {
    const ev = events.get(String(doc.data().eventId));
    if (!ev) continue;
    const issued = eventEnd(ev) + minutes(rng.int(60, 600));
    const update: Record<string, unknown> = { issuedAt: ts(issued), createdAt: ts(issued), updatedAt: ts(issued + minutes(30)) };
    if (doc.data().published !== false) {
      const releasedAt = issued + minutes(rng.int(60, 400));
      update.publishedAt = ts(releasedAt);
      // The console mail provider reports "skipped"; a released certificate is shown as delivered.
      update.delivery = { status: "sent", attempts: 1, sentAt: ts(releasedAt + minutes(rng.int(1, 8))) };
    }
    if (doc.data().revoked) update.revokedAt = ts(issued + minutes(rng.int(500, 900)));
    bw.update(doc.ref, update);
  }

  const certTimes = new Map(certs.docs.map((doc) => [doc.id, (events.get(String(doc.data().eventId)) ? eventEnd(events.get(String(doc.data().eventId))!) : now - 3 * day) + minutes(rng.int(200, 800))] as const));
  const certEvents = await db.collection("certificateEvents").get();
  for (const doc of certEvents.docs) {
    const base = certTimes.get(String(doc.data().certificateId)) ?? now - 2 * day;
    // Verifications and downloads trail off over the days after release.
    const at = base + (now - base) * rng.next() ** 1.6;
    bw.update(doc.ref, { at: ts(at) });
  }

  const resultDocs = await db.collection(COLLECTIONS.results).get();
  for (const doc of resultDocs.docs) {
    const ev = events.get(doc.id);
    if (!ev) continue;
    const when = eventEnd(ev) + minutes(rng.int(20, 90));
    bw.update(doc.ref, { createdAt: ts(when - minutes(30)), updatedAt: ts(when), ...(doc.data().publishedAt ? { publishedAt: ts(when) } : {}) });
    bw.update(db.collection(COLLECTIONS.events).doc(doc.id), { resultsPublishedAt: ts(when) });
  }

  const notes = await db.collection(COLLECTIONS.notifications).get();
  for (const doc of notes.docs) {
    const d = doc.data();
    const link = String(d.link ?? "");
    const regId = link.startsWith("/registered/") ? link.slice("/registered/".length) : undefined;
    const when = regId && regTimes.has(regId) ? (regTimes.get(regId) ?? now) + minutes(1) : now - rng.int(5, 6000) * minutes(1);
    bw.update(doc.ref, { createdAt: ts(when), updatedAt: ts(when), ...(rng.chance(0.45) && now - when > day ? { read: true, readAt: ts(when + minutes(rng.int(20, 900))) } : {}) });
  }

  for (const [name, spread] of [[COLLECTIONS.shifts, 6], [COLLECTIONS.arenas, 3], [COLLECTIONS.matches, 0]] as const) {
    if (spread === 0) continue;
    const snap = await db.collection(name).get();
    for (const doc of snap.docs) {
      const when = now - rng.int(1, spread) * day - minutes(rng.int(0, 700));
      bw.update(doc.ref, { createdAt: ts(when), updatedAt: ts(when) });
    }
  }
  await bw.close();
};

/* ───────────── markers ───────────── */

const stamp = async (baseline: Map<string, Set<string>>): Promise<Record<string, number>> => {
  const db = adminDb();
  const bw = retryingBulkWriter(db);
  const counts: Record<string, number> = {};
  for (const name of COLS) {
    const before = baseline.get(name) ?? new Set<string>();
    let n = 0;
    for (const ref of await db.collection(name).listDocuments()) {
      if (before.has(ref.id)) continue;
      bw.set(ref, { demo: true, demoBatch: BATCH }, { merge: true });
      n += 1;
    }
    counts[name] = n;
  }
  await bw.close();
  return counts;
};

/* ───────────── report ───────────── */

interface ReportInput {
  fests: FestRec[];
  students: Student[];
  heads: Record<string, Student>;
  platform: Person;
  riya: Person;
  aditya: Person;
  vols: Person[];
  otherVols: Person[];
  volunteers: Volunteers;
  stamped: Record<string, number>;
  scans: number;
  mealsServed: number;
  ananya: Student;
  rohan: Student;
  priya: Student;
  ananyaCode: Entry | null;
  rohanCode: Entry | null;
  priyaCode: Entry | null;
  ishaanCode: Entry | null;
  code: EventRec;
  nexus: FestRec;
  pendingVolunteer: Person;
  freshOrganizer: Student;
  freshStudent: Student;
}

const report = async (r: ReportInput): Promise<void> => {
  const db = adminDb();
  const count = async (name: string, field?: string, value?: unknown) => (field ? (await db.collection(name).where(field, "==", value).count().get()).data().count : (await db.collection(name).count().get()).data().count);
  const regs = await db.collection(COLLECTIONS.registrations).get();
  const byStatus: Record<string, number> = {};
  for (const d of regs.docs) byStatus[String(d.data().status)] = (byStatus[String(d.data().status)] ?? 0) + 1;
  const certs = await db.collection(COLLECTIONS.certificates).get();
  const released = certs.docs.filter((d) => d.data().published !== false && !d.data().revoked).length;
  const pending = certs.docs.filter((d) => d.data().published === false).length;
  const revoked = certs.docs.filter((d) => d.data().revoked === true).length;
  const eventCount = r.fests.reduce((n, f) => n + f.events.length, 0);
  const subEvents = r.nexus.events.length;
  const staffCount = 1 + Object.keys(r.heads).length + 2 + r.vols.length + r.otherVols.length + 1;

  const certOf = async (student: Student, ev: EventRec) => {
    const doc = await db.collection(COLLECTIONS.certificates).doc(`${ev.id}_${student.uid}`).get();
    return doc.exists ? `${doc.data()?.certificateNumber} (${doc.data()?.type})` : "—";
  };
  const hack = r.nexus.events.find((e) => e.spec.key === "hackathon")!;
  const opening = r.nexus.events.find((e) => e.spec.key === "opening")!;
  const genai = r.nexus.events.find((e) => e.spec.key === "genai")!;

  const lines: string[] = [];
  lines.push("# Plansphere video demo — accounts and key links", "", `Batch \`${BATCH}\` · password for every account: \`${PASSWORD}\``, "", "## Accounts", "", "| Role | Name | Email |", "|---|---|---|");
  lines.push(`| Platform owner (super admin) | ${r.platform.name} | ${r.platform.email} |`);
  for (const [key, h] of Object.entries(r.heads)) lines.push(`| Event Head → admin/owner (${key === "arjun" ? "NovaX fests" : HEADS[key as keyof typeof HEADS].college}) | ${h.name} | ${h.email} |`);
  lines.push(`| Admin | ${r.riya.name} | ${r.riya.email} |`, `| Admin | ${r.aditya.name} | ${r.aditya.email} |`);
  for (const v of r.vols) lines.push(`| Volunteer | ${v.name} | ${v.email} |`);
  for (const v of r.otherVols) lines.push(`| Volunteer (other fest) | ${v.name} | ${v.email} |`);
  lines.push(`| Volunteer — invited, not yet activated (temporary password only; cannot sign in) | ${r.pendingVolunteer.name} | ${r.pendingVolunteer.email} |`);
  for (const s of [r.ananya, r.rohan, r.priya]) lines.push(`| Student | ${s.name} | ${s.email} |`);
  lines.push(`| Student, no event registered yet — use this one to demo "Register your event" live | ${r.freshOrganizer.name} | ${r.freshOrganizer.email} |`);
  lines.push(`| Student with no registrations — register, get the ticket and show the QR live | ${r.freshStudent.name} | ${r.freshStudent.email} |`);
  lines.push("", "(…and the remaining students follow the pattern `first.last.demo@plansphere.demo`.)", "", "## Scenarios", "");
  lines.push(`- Flagship: http://localhost:3000/f/${r.nexus.slug}`);
  lines.push(`- **Valid, never-scanned QR** — ${r.priya.name}, ${r.code.spec.title}: ticket \`${r.priyaCode?.ticketCode}\``);
  lines.push(`- **Already-scanned QR (duplicate)** — ${r.rohan.name}, ${r.code.spec.title}: ticket \`${r.rohanCode?.ticketCode}\``);
  lines.push(`- **Already-used meal** — ${r.rohan.name}'s snack at ${r.code.spec.title}; **valid unused meal** — ${r.ananya.name}'s snack (checked in, not collected): ticket \`${r.ananyaCode?.ticketCode}\``);
  lines.push(`- **Cancelled ticket** — Ishaan Verma, ${r.code.spec.title}: ticket \`${r.ishaanCode?.ticketCode}\``);
  lines.push(`- **Wrong event** — scan ${r.priya.name}'s CodeStorm ticket while the scanner is set to PixelPerfect`);
  lines.push(`- **Invalid QR** — scan or type any code that is not in the system, e.g. \`PS-0000000000\``);
  lines.push(`- **Full journey (${r.ananya.name})** — Opening Ceremony: ${await certOf(r.ananya, opening)}; Neural Sprint (winner): ${await certOf(r.ananya, hack)}; Generative AI workshop: ${await certOf(r.ananya, genai)} (prepared, not yet released)`);
  lines.push(`- Verify a certificate publicly at http://localhost:3000/verify/<certificate number>`);
  writeFileSync(resolve(process.cwd(), ".demo-accounts.md"), `${lines.join("\n")}\n`);

  log("\n  ─────────────── DEMO DATASET READY ───────────────");
  log(`  fests                ${r.fests.length}`);
  log(`  events (all fests)   ${eventCount}   · flagship sub-events: ${subEvents}`);
  log(`  accounts             ${staffCount + r.students.length + 1}   · students ${r.students.length + 1} (incl. 1 fresh organizer), admins ${2 + Object.keys(r.heads).length} (2 + ${Object.keys(r.heads).length} event heads), volunteers ${r.vols.length + r.otherVols.length + 1} (incl. 1 pending invite), platform owner 1`);
  log(`  registrations        ${regs.size}   ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  log(`  tickets (QR codes)   ${regs.size}   (one per registration)`);
  log(`  attendance records   ${await count(COLLECTIONS.attendance)}`);
  log(`  meal servings        ${await count(COLLECTIONS.foodCollections)}`);
  log(`  certificates         ${certs.size}   released ${released} · prepared/pending ${pending} · revoked ${revoked}`);
  log(`  result sheets        ${await count(COLLECTIONS.results)}`);
  log(`  shifts / arenas      ${await count(COLLECTIONS.shifts)} / ${await count(COLLECTIONS.arenas)}`);
  log(`  matches              ${await count(COLLECTIONS.matches)}`);
  log(`  notifications        ${await count(COLLECTIONS.notifications)}`);
  log(`  audit entries        ${await count(COLLECTIONS.auditLog)}`);
  log(`  payments             none — Plansphere has no payment records, only each event's entry fee`);
  log(`  stamped docs         ${Object.values(r.stamped).reduce((a, b) => a + b, 0)} with demoBatch="${BATCH}"`);
  if (failures.length) {
    log(`\n  ${failures.length} non-fatal problem(s):`);
    for (const f of failures.slice(0, 12)) log(`    - ${f}`);
  }
  log("\n  Accounts and key tickets: .demo-accounts.md\n");
};
