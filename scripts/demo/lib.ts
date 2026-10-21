/* eslint-disable @typescript-eslint/no-explicit-any -- route response bodies are inspected field by field */
/**
 * Shared plumbing for the video-demo seeder.
 *
 * The seeder never talks to production. It drives the app's real route
 * handlers and the real Firestore repositories, in-process, against the local
 * Firebase emulators — the same way the emulator test suite does — so every
 * ticket, certificate and counter is produced by the product's own logic.
 */
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, signOut } from "firebase/auth";
import { firebaseAuth } from "@/data/firebase/client";

export const BATCH = "video-demo-2026";
export const PASSWORD = "PlanDemo@2026";
export const DEMO_DOMAIN = "plansphere.demo";

const AUTH_HOST = () => process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "";
const API_KEY = () => process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "demo-api-key";

/**
 * Refuses to run against anything but a local emulator.
 *
 * `demo-` project ids are Firebase's convention for "never touches Google":
 * the emulators accept them and no real project can have one. Anything else —
 * including the production project in `.env.local` — is rejected here, before
 * a single document is written.
 */
export const assertEmulatorTarget = (): { project: string; firestore: string; auth: string } => {
  const project = process.env.GCLOUD_PROJECT ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "";
  const firestore = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  const auth = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "";
  if (!project.startsWith("demo-") || !firestore || !auth || process.env.NEXT_PUBLIC_FIREBASE_EMULATOR !== "1") {
    console.error(
      "\n  REFUSING TO RUN: this script only targets the local Firebase emulators.\n" +
        `  project=${project || "(unset)"}  firestore=${firestore || "(unset)"}  auth=${auth || "(unset)"}\n` +
        "  Use `npm run demo:seed` / `npm run demo:clean`, which set the emulator environment for you.\n",
    );
    process.exit(2);
  }
  return { project, firestore, auth };
};

/* ───────────── deterministic randomness ───────────── */

export const makeRng = (seed: number) => {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (p: number) => next() < p,
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
  };
};

export const rng = makeRng(20261004);

/* ───────────── dates ───────────── */

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dayOffset = (days: number): string => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return ymd(d);
};
/** A local date + "HH:MM" as a real Date. */
export const at = (date: string, time: string): Date => new Date(`${date}T${time}:00`);
export const minutes = (m: number): number => m * 60_000;

/* ───────────── tokens and route calls ───────────── */

export const tokenFor = async (email: string, password = PASSWORD): Promise<string> => {
  const res = await fetch(`http://${AUTH_HOST()}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = (await res.json()) as { idToken?: string; error?: unknown };
  if (!body.idToken) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(body.error)}`);
  return body.idToken;
};

export type RouteHandler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

export class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
    label: string,
  ) {
    super(`${label} → ${status} ${JSON.stringify(body)?.slice(0, 300)}`);
  }
}

export const call = async <T = any>(
  handler: RouteHandler,
  input: { token: string; method?: string; path?: string; params?: Record<string, string>; body?: unknown; label: string },
): Promise<T> => {
  const request = new Request(`http://localhost:3000${input.path ?? "/api/demo"}`, {
    method: input.method ?? (input.body !== undefined ? "POST" : "GET"),
    headers: {
      authorization: `Bearer ${input.token}`,
      ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
  });
  const response = await handler(request, { params: Promise.resolve(input.params ?? {}) });
  let body: any = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (response.status >= 400) throw new RouteError(response.status, body, input.label);
  return body as T;
};

/* ───────────── client-SDK sessions (the volunteer scanner runs on these) ───────────── */

export const clientSignIn = async (email: string): Promise<void> => {
  await signInWithEmailAndPassword(firebaseAuth(), email, PASSWORD);
};
export const clientSignOut = (): Promise<void> => signOut(firebaseAuth());
export const clientSignUp = async (email: string, name: string): Promise<string> => {
  const credential = await createUserWithEmailAndPassword(firebaseAuth(), email, PASSWORD);
  await updateProfile(credential.user, { displayName: name });
  return credential.user.uid;
};

/**
 * A BulkWriter that retries. The emulator can stall for a minute under a large
 * batch; by default that surfaces as DEADLINE_EXCEEDED and aborts the run.
 */
export const retryingBulkWriter = (db: { bulkWriter: (options?: any) => any }) => {
  const writer = db.bulkWriter({ throttling: { initialOpsPerSecond: 200, maxOpsPerSecond: 500 } });
  writer.onWriteError((error: { failedAttempts: number }) => error.failedAttempts < 8);
  return writer;
};

/* ───────────── logging ───────────── */

export const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

/** The app logs one line per API call and per email; a seed run would drown in them. */
export const quietApp = (): (() => void) => {
  if (process.env.DEMO_VERBOSE === "1") return () => undefined;
  const original = { info: console.info, warn: console.warn, log: console.log };
  console.info = () => undefined;
  console.warn = () => undefined;
  console.log = () => undefined;
  return () => {
    console.info = original.info;
    console.warn = original.warn;
    console.log = original.log;
  };
};
