/**
 * The fictional world the demo lives in. Everything here is invented: the
 * people, colleges, companies and events do not exist, every address is on the
 * reserved `plansphere.demo` domain, and every phone number is in a block that
 * is not assigned to anyone.
 */
import { DEMO_DOMAIN } from "./lib";

export const email = (name: string): string => `${name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "")}.demo@${DEMO_DOMAIN}`;
export const phone = (n: number): string => `+91 98765 ${String(10000 + n).slice(-5)}`;

/* ───────────── people ───────────── */

export interface StaffSpec {
  name: string;
  designation: string;
  role: "admin" | "volunteer" | "super_admin";
}

export const PLATFORM_ADMIN: StaffSpec = { name: "Dev Kapoor", designation: "Plansphere platform owner", role: "super_admin" };

/** Registers events through /register-event, becoming the admin (and owner) of each. */
export const HEADS = {
  arjun: { name: "Arjun Mehta", designation: "Cultural & Technical Secretary", college: "NovaX Institute of Technology" },
  meera: { name: "Meera Iyer", designation: "Festival Convenor", college: "Lakeview Arts College" },
  karan: { name: "Karan Malhotra", designation: "Sports Council Secretary", college: "Meridian University" },
  neha: { name: "Neha Kulkarni", designation: "Developer Relations Lead", college: "Orbit Cloud Labs" },
} as const;

export const FLAGSHIP_ADMINS: StaffSpec[] = [
  { name: "Riya Sen", designation: "Operations Admin", role: "admin" },
  { name: "Aditya Roy", designation: "Registrations Admin", role: "admin" },
];

export const FLAGSHIP_VOLUNTEERS: StaffSpec[] = [
  { name: "Sneha Das", designation: "Gate A lead", role: "volunteer" },
  { name: "Rahul Sharma", designation: "Gate B lead", role: "volunteer" },
  { name: "Mohit Verma", designation: "Evening gate volunteer", role: "volunteer" },
  { name: "Kabir Singh", designation: "Food counter 1", role: "volunteer" },
  { name: "Ishita Paul", designation: "Food counter 2", role: "volunteer" },
  { name: "Vikram Rao", designation: "Help desk", role: "volunteer" },
  { name: "Tanvi Joshi", designation: "Robotics arena scorer", role: "volunteer" },
  { name: "Pooja Reddy", designation: "Esports and cricket scorer", role: "volunteer" },
  { name: "Dhruv Nambiar", designation: "Football ground scorer", role: "volunteer" },
];

/** Invited through the staff route but never signed in — shows the "Pending / Not activated" state. */
export const PENDING_VOLUNTEER: StaffSpec = { name: "Nikhil Bhatt", designation: "Registration desk (invited)", role: "volunteer" };

/** A signed-up account that has not registered an event yet — for demoing "Register your event" live. */
export const FRESH_ORGANIZER = { name: "Kiran Patel", college: "Westbrook Institute of Technology" } as const;

/** A verified student with a complete profile and no registrations — register, get a ticket and show the QR live. */
export const FRESH_STUDENT = { name: "Aditi Rao", college: "NovaX Institute of Technology" } as const;

export const OTHER_VOLUNTEERS: Record<"meera" | "karan" | "neha", StaffSpec[]> = {
  meera: [
    { name: "Lakshmi Nair", designation: "Stage manager", role: "volunteer" },
    { name: "Farhan Ali", designation: "Registration desk", role: "volunteer" },
  ],
  karan: [{ name: "Gaurav Mishra", designation: "Ground marshal", role: "volunteer" }],
  neha: [{ name: "Zoya Khan", designation: "Registration desk", role: "volunteer" }],
};

const FIRST = [
  "Aarav", "Vihaan", "Aditya", "Arnav", "Reyansh", "Ishaan", "Dhruv", "Kabir", "Krish", "Atharv", "Advait", "Shaurya", "Yash", "Pranav", "Nikhil", "Harsh", "Siddharth", "Tarun",
  "Diya", "Saanvi", "Aanya", "Myra", "Kavya", "Navya", "Ira", "Anika", "Tara", "Riddhi", "Shreya", "Pari", "Sanya", "Nisha", "Aditi", "Pallavi", "Mansi", "Radhika", "Sakshi", "Tanya",
];
const LAST = [
  "Sharma", "Verma", "Gupta", "Iyer", "Menon", "Pillai", "Reddy", "Rao", "Naidu", "Das", "Roy", "Sen", "Ghosh", "Chatterjee", "Banerjee", "Kapoor", "Malhotra", "Khanna", "Bhatia",
  "Joshi", "Kulkarni", "Patil", "Deshmukh", "Shah", "Mehta", "Desai", "Nair", "Varma", "Chopra", "Saxena", "Mishra", "Tiwari", "Pandey", "Bose", "Mukherjee", "Sinha", "Agarwal", "Jain",
];

export const NAMED_STUDENTS = [
  "Ananya Bose", "Rohan Gupta", "Priya Nair", "Ishaan Verma", "Kavya Menon", "Siddharth Rao", "Diya Chatterjee", "Vihaan Kapoor", "Saanvi Reddy", "Aarav Shah", "Meghna Das", "Tanmay Joshi",
] as const;

export const COLLEGES = [
  "NovaX Institute of Technology", "NovaX Institute of Technology", "NovaX Institute of Technology", "NovaX Institute of Technology",
  "Lakeview Arts College", "Meridian University", "Orbit School of Engineering", "St. Aurelius College", "Crestwood Institute of Management",
];
export const DEPARTMENTS = ["Computer Science", "Information Technology", "Electronics & Communication", "Mechanical Engineering", "AI & Data Science", "Electrical Engineering", "Design", "Management Studies"];

export const generateStudentNames = (count: number): string[] => {
  const names: string[] = [...NAMED_STUDENTS];
  const seen = new Set<string>([...names, "Aditi Rao", "Kiran Patel"]);
  for (let i = 0; names.length < count && i < 5000; i += 1) {
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[(i * 7 + Math.floor(i / FIRST.length) * 3) % LAST.length]!;
    const name = `${first} ${last}`;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
};

/* ───────────── fests and events ───────────── */

export interface EventSpec {
  key: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  eventType: "solo" | "team";
  teamSize: { min: number; max: number };
  /** Day offset from today: -1 yesterday, 0 today, 1 tomorrow. */
  day: number;
  startTime: string;
  endTime: string;
  venue: string;
  capacity: number;
  fee: number;
  waitlist?: boolean;
  gates?: string[];
  meals?: Array<{ mealType: "breakfast" | "lunch" | "dinner" | "snack"; label: string }>;
  rules: string[];
  prizes?: string[];
  prizePool?: string;
  coordinators: Array<{ name: string; phone: string; email?: string }>;
  live?: { sportType: string; tournamentType: "knockout" | "round_robin" | "swiss" | "custom"; matchConfig: Record<string, number | string> };
  /** Final status once the story is told. */
  final: "completed" | "ongoing" | "published";
  /** Solo entries / team entries to create. */
  entries: number;
}

export interface FestSpec {
  key: "nexus" | "hack" | "genesis" | "aurora" | "meridian" | "orbit";
  head: keyof typeof HEADS;
  name: string;
  tagline: string;
  description: string;
  festType: "tech" | "cultural" | "sports" | "hackathon" | "conference" | "other";
  organizationName: string;
  organizationType: "college" | "university" | "conference" | "club" | "company" | "ngo";
  website?: string;
  city: string;
  state: string;
  venue: string;
  start: number;
  end: number;
  expected: number;
  academicYear: string;
  themeColor: string;
  contactEmail: string;
  registrationState: "open" | "closed";
  events: EventSpec[];
}

const coord = (name: string, n: number) => ({ name, phone: phone(900 + n), email: email(name) });

const ev = (spec: Omit<EventSpec, "description"> & { description?: string }): EventSpec => ({
  description: spec.description ?? `${spec.title} — part of the festival programme. Register with your college email; your ticket QR is issued instantly.`,
  ...spec,
});

export const festSpecs = (): FestSpec[] => [
  {
    key: "nexus",
    head: "arjun",
    name: "NovaX Nexus 2026",
    tagline: "Three days of code, circuits and culture.",
    description:
      "NovaX Nexus is the flagship technical and cultural festival of NovaX Institute of Technology — hackathons, robotics, esports, workshops, a startup pitch and a battle of bands across three days on the OMR campus.",
    festType: "tech",
    organizationName: "NovaX Institute of Technology",
    organizationType: "college",
    website: "https://novax.example.edu",
    city: "Chennai",
    state: "Tamil Nadu",
    venue: "NovaX Institute of Technology, OMR Campus",
    start: -1,
    end: 1,
    expected: 1500,
    academicYear: "2026-27",
    themeColor: "#2f7d6d",
    contactEmail: email("Nexus Helpdesk"),
    registrationState: "open",
    events: [
      ev({ key: "opening", slug: "opening-ceremony", title: "Opening Ceremony", category: "other", eventType: "solo", teamSize: { min: 1, max: 1 }, day: -1, startTime: "09:30", endTime: "11:00", venue: "Main Auditorium", capacity: 800, fee: 0, gates: ["Gate A", "Gate B"], meals: [{ mealType: "snack", label: "Day 1 snack" }], rules: ["Be seated by 09:15.", "Carry your college ID."], coordinators: [coord("Sneha Das", 1)], final: "completed", entries: 130 }),
      ev({ key: "hackathon", slug: "neural-sprint-ai-hackathon", title: "AI Hackathon — Neural Sprint", category: "hackathon", eventType: "team", teamSize: { min: 2, max: 4 }, day: -1, startTime: "10:00", endTime: "22:00", venue: "Innovation Lab", capacity: 100, fee: 400, waitlist: true, gates: ["Lab Entrance"], meals: [{ mealType: "lunch", label: "Day 1 lunch" }, { mealType: "dinner", label: "Day 1 dinner" }, { mealType: "snack", label: "Day 1 snack" }], rules: ["Teams of 2 to 4.", "Build something with a language model, in twelve hours.", "Final demos are three minutes."], prizes: ["₹50,000 — Winner", "₹25,000 — Runner-up", "₹10,000 — Second runner-up"], prizePool: "₹85,000 across 3 places", coordinators: [coord("Aditya Roy", 2), coord("Neel Fernandes", 3)], final: "completed", entries: 22 }),
      ev({ key: "genai", slug: "generative-ai-workshop", title: "Workshop — Generative AI in Practice", category: "workshop", eventType: "solo", teamSize: { min: 1, max: 1 }, day: -1, startTime: "14:00", endTime: "17:00", venue: "Seminar Hall A", capacity: 120, fee: 150, gates: ["Hall A Door"], meals: [{ mealType: "snack", label: "Workshop snack" }], rules: ["Bring a laptop.", "Hands-on; no prior ML needed."], coordinators: [coord("Dr. Meenakshi Raman", 4)], final: "completed", entries: 88 }),
      ev({ key: "codestorm", slug: "codestorm-coding-contest", title: "CodeStorm — Coding Competition", category: "technical", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 0, startTime: "10:00", endTime: "13:00", venue: "Computer Centre, Lab 2", capacity: 150, fee: 100, gates: ["Lab 2 Door"], meals: [{ mealType: "snack", label: "Contest snack" }], rules: ["Individual contest, three hours.", "Any language; no internet."], prizes: ["₹15,000 — Winner", "₹8,000 — Runner-up"], prizePool: "₹23,000", coordinators: [coord("Vikram Rao", 5)], final: "ongoing", entries: 104 }),
      ev({ key: "pixel", slug: "pixelperfect-ui-ux-challenge", title: "PixelPerfect — UI/UX Design Challenge", category: "technical", eventType: "team", teamSize: { min: 1, max: 2 }, day: 0, startTime: "11:00", endTime: "14:00", venue: "Design Studio", capacity: 40, fee: 120, waitlist: true, gates: ["Studio Door"], rules: ["Solo or pairs.", "Redesign a real onboarding flow in three hours."], coordinators: [coord("Ritika Anand", 6)], final: "ongoing", entries: 0 }),
      ev({ key: "robowars", slug: "robowars-arena", title: "RoboWars Arena — Robotics Competition", category: "technical", eventType: "team", teamSize: { min: 3, max: 5 }, day: 0, startTime: "14:00", endTime: "18:00", venue: "Robotics Arena", capacity: 96, fee: 250, gates: ["Arena Gate"], meals: [{ mealType: "lunch", label: "Day 2 lunch" }], rules: ["Weight limit 8 kg.", "Best of three rounds, knockout bracket."], prizes: ["₹40,000 — Champion"], prizePool: "₹40,000", coordinators: [coord("Tanvi Joshi", 7)], live: { sportType: "Robo Fight", tournamentType: "knockout", matchConfig: { durationType: "rounds", rounds: 3, maxPlayers: 5 } }, final: "ongoing", entries: 8 }),
      ev({ key: "quiz", slug: "quizzard-tech-quiz", title: "Quizzard — Tech Quiz", category: "other", eventType: "team", teamSize: { min: 2, max: 3 }, day: 0, startTime: "15:00", endTime: "17:00", venue: "Auditorium B", capacity: 90, fee: 60, gates: ["Auditorium B Door"], meals: [{ mealType: "snack", label: "Quiz snack" }], rules: ["Teams of 2 or 3.", "Three rounds; buzzer finals."], coordinators: [coord("Ishita Paul", 8)], final: "published", entries: 15 }),
      ev({ key: "valorant", slug: "valorant-showdown", title: "Valorant Showdown — Gaming", category: "esports", eventType: "team", teamSize: { min: 5, max: 5 }, day: 0, startTime: "16:00", endTime: "20:00", venue: "Esports Lounge", capacity: 80, fee: 300, gates: ["Lounge Door"], meals: [{ mealType: "dinner", label: "Day 2 dinner" }], rules: ["Five per team.", "First to 13 rounds."], prizes: ["₹30,000 — Champions"], prizePool: "₹30,000", coordinators: [coord("Pooja Reddy", 9)], live: { sportType: "Valorant", tournamentType: "knockout", matchConfig: { durationType: "points", targetPoints: 13, maxPlayers: 5 } }, final: "ongoing", entries: 8 }),
      ev({ key: "football", slug: "inter-department-futsal", title: "Inter-Department Futsal", category: "sports", eventType: "team", teamSize: { min: 5, max: 7 }, day: 0, startTime: "12:00", endTime: "17:00", venue: "Football Ground", capacity: 64, fee: 0, gates: ["Ground Gate"], rules: ["Round robin, two halves of 15 minutes.", "Yellow and red cards are recorded live."], prizes: ["Department trophy"], coordinators: [coord("Dhruv Nambiar", 18)], live: { sportType: "Football", tournamentType: "round_robin", matchConfig: { durationType: "time", halves: 2, minutesPerHalf: 15, maxPlayers: 7 } }, final: "ongoing", entries: 4 }),
      ev({ key: "cricket", slug: "box-cricket-blast", title: "Box Cricket Blast", category: "sports", eventType: "team", teamSize: { min: 6, max: 8 }, day: 0, startTime: "13:00", endTime: "17:30", venue: "Cricket Nets", capacity: 64, fee: 50, gates: ["Nets Gate"], rules: ["Three-over innings, knockout.", "Chase wins the match."], prizes: ["Winners' trophy"], coordinators: [coord("Pooja Reddy", 9)], live: { sportType: "Cricket", tournamentType: "knockout", matchConfig: { durationType: "overs", overs: 3, maxPlayers: 6 } }, final: "ongoing", entries: 4 }),
      ev({ key: "volleyball", slug: "volleyball-smash", title: "Volleyball Smash", category: "sports", eventType: "team", teamSize: { min: 6, max: 8 }, day: -1, startTime: "15:00", endTime: "18:00", venue: "Indoor Sports Hall", capacity: 64, fee: 0, gates: ["Hall Door"], rules: ["Best of three sets to 11."], prizes: ["Champions' trophy"], coordinators: [coord("Tanvi Joshi", 7)], live: { sportType: "Volleyball", tournamentType: "knockout", matchConfig: { durationType: "sets", sets: 3, pointsPerSet: 11, maxPlayers: 6 } }, final: "completed", entries: 4 }),
      ev({ key: "tt", slug: "table-tennis-open", title: "Table Tennis Open", category: "sports", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 0, startTime: "10:00", endTime: "16:00", venue: "TT Hall", capacity: 32, fee: 0, gates: ["TT Hall Door"], rules: ["Swiss-style fixtures, best of three games to 7."], coordinators: [coord("Tanvi Joshi", 7)], live: { sportType: "Table Tennis", tournamentType: "swiss", matchConfig: { durationType: "sets", sets: 3, pointsPerSet: 7, maxPlayers: 1 } }, final: "ongoing", entries: 6 }),
      ev({ key: "pitch", slug: "pitch-perfect-startup-pitch", title: "Pitch Perfect — Startup Pitch", category: "conference", eventType: "team", teamSize: { min: 1, max: 3 }, day: 1, startTime: "10:00", endTime: "13:00", venue: "Incubation Hall", capacity: 60, fee: 0, gates: ["Incubation Hall Door"], rules: ["Five-minute pitch, five minutes of questions.", "Pitch decks due by 09:00."], prizes: ["₹25,000 seed grant"], prizePool: "₹25,000 seed grant", coordinators: [coord("Aarti Menon", 10)], final: "published", entries: 12 }),
      ev({ key: "ctf", slug: "capture-the-flag-ctf", title: "Capture the Flag — CTF", category: "technical", eventType: "team", teamSize: { min: 2, max: 3 }, day: 1, startTime: "09:30", endTime: "12:30", venue: "Cyber Lab", capacity: 90, fee: 0, gates: ["Cyber Lab Door"], rules: ["Teams of 2 or 3.", "Web, crypto and forensics challenges."], coordinators: [coord("Imran Siddiqui", 11)], final: "published", entries: 14 }),
      ev({ key: "cyber", slug: "cybersecurity-essentials-workshop", title: "Workshop — Cybersecurity Essentials", category: "workshop", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 1, startTime: "11:00", endTime: "13:00", venue: "Seminar Hall B", capacity: 100, fee: 150, gates: ["Hall B Door"], rules: ["Bring a laptop."], coordinators: [coord("Imran Siddiqui", 11)], final: "published", entries: 52 }),
      ev({ key: "bands", slug: "battle-of-bands-rhythm-nights", title: "Rhythm Nights — Battle of Bands", category: "cultural", eventType: "team", teamSize: { min: 3, max: 6 }, day: 1, startTime: "17:00", endTime: "20:00", venue: "Open Air Theatre", capacity: 120, fee: 200, gates: ["OAT Gate"], meals: [{ mealType: "dinner", label: "Day 3 dinner" }], rules: ["Twenty-minute sets.", "Bring your own instruments; backline provided."], prizes: ["₹30,000 — Winner"], prizePool: "₹30,000", coordinators: [coord("Lakshmi Pillai", 12)], final: "published", entries: 7 }),
      ev({ key: "closing", slug: "closing-ceremony-awards", title: "Closing Ceremony & Awards", category: "other", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 1, startTime: "20:30", endTime: "22:00", venue: "Main Auditorium", capacity: 800, fee: 0, gates: ["Gate A", "Gate B"], meals: [{ mealType: "dinner", label: "Day 3 gala dinner" }], rules: ["Winners announced across all events."], coordinators: [coord("Sneha Das", 1)], final: "published", entries: 78 }),
    ],
  },
  {
    key: "hack",
    head: "arjun",
    name: "NovaX HackHorizon 2026",
    tagline: "Thirty-six hours. One idea. Ship it.",
    description: "HackHorizon is NovaX's open hackathon: a bootcamp, a thirty-six-hour build and a demo day with industry judges.",
    festType: "hackathon",
    organizationName: "NovaX Institute of Technology",
    organizationType: "college",
    city: "Chennai",
    state: "Tamil Nadu",
    venue: "Innovation Lab, NovaX Institute",
    start: 21,
    end: 22,
    expected: 400,
    academicYear: "2026-27",
    themeColor: "#7a5cc4",
    contactEmail: email("HackHorizon Team"),
    registrationState: "open",
    events: [
      ev({ key: "bootcamp", slug: "api-bootcamp", title: "Pre-Hack Bootcamp — Building with APIs", category: "workshop", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 14, startTime: "10:00", endTime: "13:00", venue: "Seminar Hall A", capacity: 80, fee: 0, gates: ["Hall A Door"], rules: ["Bring a laptop."], coordinators: [coord("Aditya Roy", 2)], final: "published", entries: 24 }),
      ev({ key: "hh36", slug: "hackhorizon-36-hour-hackathon", title: "HackHorizon — 36-hour Hackathon", category: "hackathon", eventType: "team", teamSize: { min: 2, max: 4 }, day: 21, startTime: "09:00", endTime: "21:00", venue: "Innovation Lab", capacity: 120, fee: 300, waitlist: true, gates: ["Lab Entrance"], rules: ["Teams of 2 to 4.", "Open theme."], prizes: ["₹75,000 — Winner"], prizePool: "₹75,000", coordinators: [coord("Riya Sen", 13)], final: "published", entries: 9 }),
      ev({ key: "demoday", slug: "demo-day-awards", title: "Demo Day & Awards", category: "other", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 22, startTime: "15:00", endTime: "18:00", venue: "Main Auditorium", capacity: 400, fee: 0, gates: ["Gate A"], rules: ["Open to all registered participants."], coordinators: [coord("Riya Sen", 13)], final: "published", entries: 18 }),
    ],
  },
  {
    key: "genesis",
    head: "arjun",
    name: "NovaX Genesis 2025",
    tagline: "Where it all started.",
    description: "Genesis was NovaX's first open technical festival. It ended three weeks ago; every certificate has been issued and can be verified publicly.",
    festType: "tech",
    organizationName: "NovaX Institute of Technology",
    organizationType: "college",
    city: "Chennai",
    state: "Tamil Nadu",
    venue: "NovaX Institute of Technology, OMR Campus",
    start: -24,
    end: -22,
    expected: 600,
    academicYear: "2025-26",
    themeColor: "#c4783a",
    contactEmail: email("Genesis Helpdesk"),
    registrationState: "closed",
    events: [
      ev({ key: "g-inaug", slug: "genesis-inauguration", title: "Genesis Inauguration", category: "other", eventType: "solo", teamSize: { min: 1, max: 1 }, day: -24, startTime: "10:00", endTime: "11:30", venue: "Main Auditorium", capacity: 500, fee: 0, gates: ["Gate A"], rules: [], coordinators: [coord("Sneha Das", 1)], final: "completed", entries: 38 }),
      ev({ key: "g-web", slug: "web-dev-sprint", title: "Web Dev Sprint", category: "technical", eventType: "team", teamSize: { min: 1, max: 2 }, day: -23, startTime: "10:00", endTime: "15:00", venue: "Computer Centre, Lab 1", capacity: 80, fee: 100, gates: ["Lab 1 Door"], rules: ["Build a landing page from a brief."], coordinators: [coord("Vikram Rao", 5)], final: "completed", entries: 16 }),
      ev({ key: "g-hw", slug: "hardware-hack", title: "Hardware Hack", category: "technical", eventType: "team", teamSize: { min: 2, max: 4 }, day: -23, startTime: "11:00", endTime: "19:00", venue: "Electronics Lab", capacity: 60, fee: 200, gates: ["EL Door"], rules: ["Microcontroller projects only."], prizes: ["₹20,000 — Winner"], prizePool: "₹20,000", coordinators: [coord("Aditya Roy", 2)], final: "completed", entries: 9 }),
      ev({ key: "g-quiz", slug: "tech-quiz-bowl", title: "Tech Quiz Bowl", category: "other", eventType: "team", teamSize: { min: 2, max: 3 }, day: -22, startTime: "14:00", endTime: "16:30", venue: "Auditorium B", capacity: 60, fee: 50, gates: ["Aud B Door"], rules: ["Teams of 2 or 3."], coordinators: [coord("Ishita Paul", 8)], final: "completed", entries: 10 }),
    ],
  },
  {
    key: "aurora",
    head: "meera",
    name: "Aurora Arts Fiesta 2026",
    tagline: "An evening for every art.",
    description: "Lakeview Arts College's annual showcase of dance, music and film — small, warm and open to the public.",
    festType: "cultural",
    organizationName: "Lakeview Arts College",
    organizationType: "college",
    city: "Kochi",
    state: "Kerala",
    venue: "Lakeview Arts College, Marine Drive",
    start: 9,
    end: 10,
    expected: 300,
    academicYear: "2026-27",
    themeColor: "#b4488d",
    contactEmail: email("Aurora Desk"),
    registrationState: "open",
    events: [
      ev({ key: "dance", slug: "classical-dance-showcase", title: "Classical Dance Showcase", category: "cultural", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 9, startTime: "17:00", endTime: "19:00", venue: "Amphitheatre", capacity: 40, fee: 0, gates: ["Main Gate"], rules: ["Seven-minute performances."], coordinators: [coord("Lakshmi Nair", 14)], final: "published", entries: 12 }),
      ev({ key: "openmic", slug: "open-mic-night", title: "Open Mic Night", category: "cultural", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 9, startTime: "19:30", endTime: "22:00", venue: "Courtyard", capacity: 60, fee: 50, gates: ["Main Gate"], rules: ["Poetry, music or stand-up; five minutes."], coordinators: [coord("Farhan Ali", 15)], final: "published", entries: 9 }),
      ev({ key: "film", slug: "short-film-screening", title: "Short Film Screening & Q&A", category: "cultural", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 10, startTime: "16:00", endTime: "18:30", venue: "Film Studio", capacity: 80, fee: 0, gates: ["Studio Door"], rules: ["Q&A with the directors."], coordinators: [coord("Lakshmi Nair", 14)], final: "published", entries: 7 }),
    ],
  },
  {
    key: "meridian",
    head: "karan",
    name: "Meridian Sports Carnival 2026",
    tagline: "Inter-college. Intense. Unmissable.",
    description: "Meridian University's inter-college sports carnival: football, badminton and a 5K campus run.",
    festType: "sports",
    organizationName: "Meridian University",
    organizationType: "university",
    city: "Pune",
    state: "Maharashtra",
    venue: "Meridian University Sports Complex",
    start: 30,
    end: 32,
    expected: 800,
    academicYear: "2026-27",
    themeColor: "#2d6bb5",
    contactEmail: email("Meridian Sports Office"),
    registrationState: "open",
    events: [
      ev({ key: "football", slug: "inter-college-football-cup", title: "Inter-College Football Cup", category: "sports", eventType: "team", teamSize: { min: 7, max: 11 }, day: 30, startTime: "08:00", endTime: "18:00", venue: "Main Ground", capacity: 176, fee: 1500, gates: ["Ground Gate"], rules: ["Eleven-a-side knockout."], coordinators: [coord("Gaurav Mishra", 16)], final: "published", entries: 2 }),
      ev({ key: "badminton", slug: "badminton-singles-open", title: "Badminton Singles Open", category: "sports", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 31, startTime: "09:00", endTime: "17:00", venue: "Indoor Courts", capacity: 64, fee: 200, gates: ["Court Entrance"], rules: ["Knockout, best of three games."], coordinators: [coord("Gaurav Mishra", 16)], final: "published", entries: 14 }),
      ev({ key: "run", slug: "5k-campus-run", title: "5K Campus Run", category: "sports", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 32, startTime: "06:00", endTime: "08:30", venue: "Campus Loop", capacity: 300, fee: 0, gates: ["Start Line"], rules: ["Timing chips provided."], coordinators: [coord("Gaurav Mishra", 16)], final: "published", entries: 20 }),
    ],
  },
  {
    key: "orbit",
    head: "neha",
    name: "Orbit Dev Summit 2026",
    tagline: "Developer tools, built in public.",
    description: "A one-day-plus conference by Orbit Cloud Labs on developer tooling, databases and open source in India.",
    festType: "conference",
    organizationName: "Orbit Cloud Labs",
    organizationType: "company",
    website: "https://orbit.example.com",
    city: "Bengaluru",
    state: "Karnataka",
    venue: "Orbit Conference Centre, Whitefield",
    start: 45,
    end: 46,
    expected: 700,
    academicYear: "2026-27",
    themeColor: "#d1495b",
    contactEmail: email("Orbit Summit Desk"),
    registrationState: "open",
    events: [
      ev({ key: "keynote", slug: "keynote-future-of-dev-tools", title: "Keynote — The Future of Developer Tools", category: "conference", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 45, startTime: "10:00", endTime: "11:00", venue: "Hall 1", capacity: 500, fee: 499, gates: ["Hall 1 Door"], rules: [], coordinators: [coord("Zoya Khan", 17)], final: "published", entries: 22 }),
      ev({ key: "postgres", slug: "workshop-scaling-postgres", title: "Workshop — Scaling Postgres", category: "workshop", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 45, startTime: "13:00", endTime: "17:00", venue: "Workshop Room 2", capacity: 60, fee: 999, gates: ["Room 2 Door"], rules: ["Bring a laptop with Docker."], coordinators: [coord("Zoya Khan", 17)], final: "published", entries: 11 }),
      ev({ key: "panel", slug: "panel-open-source-in-india", title: "Panel — Open Source in India", category: "conference", eventType: "solo", teamSize: { min: 1, max: 1 }, day: 46, startTime: "11:00", endTime: "12:30", venue: "Hall 1", capacity: 500, fee: 0, gates: ["Hall 1 Door"], rules: [], coordinators: [coord("Zoya Khan", 17)], final: "published", entries: 16 }),
    ],
  },
];
