import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";
import { RepositoryError } from "@/core/models/common";

/**
 * The client Firebase SDK.
 *
 * Initialisation is lazy on purpose. `next build` prerenders the public
 * pages, which import the repositories, which import this file — so anything
 * that throws at import time takes the whole build down the moment an
 * environment variable is missing. That is exactly what broke the first
 * Vercel deploy. Now a missing config is a `RepositoryError` raised when a
 * repository is *used*; the public pages already catch those and render an
 * empty state, so the build passes and the site says what is wrong instead of
 * refusing to exist.
 *
 * The `getApps()` guard keeps Fast Refresh from creating a second app on every
 * edit, and gives the Expo app in Phase 2 a single file to swap.
 */

const REQUIRED = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

/**
 * `process.env.NEXT_PUBLIC_*` is inlined at build time, so each variable has
 * to be referenced as a literal property access — a dynamic lookup like
 * `process.env[name]` is not replaced and reads as undefined in the browser.
 */
const readConfig = () => ({
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
});

/** Names of the required variables that are not set. Empty when configured. */
export const missingFirebaseConfig = (): string[] => {
  const config = readConfig();
  const present: Record<(typeof REQUIRED)[number], string | undefined> = {
    NEXT_PUBLIC_FIREBASE_API_KEY: config.apiKey,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: config.authDomain,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: config.projectId,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: config.messagingSenderId,
    NEXT_PUBLIC_FIREBASE_APP_ID: config.appId,
  };
  return REQUIRED.filter((name) => !present[name]);
};

export const isFirebaseConfigured = (): boolean => missingFirebaseConfig().length === 0;

export class FirebaseNotConfiguredError extends RepositoryError {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      "unavailable",
      `Firebase is not configured: set ${missing.join(", ")} in the environment ` +
        `(locally in .env.local, on Vercel under Project → Settings → Environment Variables).`,
    );
    this.name = "FirebaseNotConfiguredError";
    this.missing = missing;
  }
}

let warned = false;
let app: FirebaseApp | null = null;

export const firebaseApp = (): FirebaseApp => {
  if (app) return app;

  const missing = missingFirebaseConfig();

  if (missing.length) {
    // One loud line in the build log is worth more than a stack trace per page.
    if (!warned && typeof window === "undefined") {
      warned = true;
      console.warn(
        `\n[plansphere] Firebase web config is missing (${missing.join(", ")}). ` +
          `Pages will render without data until the variables are set.\n`,
      );
    }
    throw new FirebaseNotConfiguredError(missing);
  }

  const config = readConfig();

  app = getApps().length
    ? getApp()
    : initializeApp({
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
        messagingSenderId: config.messagingSenderId,
        appId: config.appId,
        ...(config.measurementId ? { measurementId: config.measurementId } : {}),
      });

  return app;
};

/**
 * Emulator wiring, opt-in via NEXT_PUBLIC_FIREBASE_EMULATOR=1 (the test suite
 * and local emulator development). `connect*Emulator` must run exactly once
 * per service instance, before the first request, hence the flags.
 */
const emulatorEnabled = () => process.env.NEXT_PUBLIC_FIREBASE_EMULATOR === "1";
const emulatorHost = (env: string | undefined, fallback: string) => {
  const [host = "127.0.0.1", port = fallback] = (env ?? `127.0.0.1:${fallback}`).split(":");
  return { host, port: Number(port) };
};
const connected = { auth: false, firestore: false };

export const firebaseAuth = (): Auth => {
  const auth = getAuth(firebaseApp());
  if (emulatorEnabled() && !connected.auth) {
    const { host, port } = emulatorHost(process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST, "9099");
    connectAuthEmulator(auth, `http://${host}:${port}`, { disableWarnings: true });
    connected.auth = true;
  }
  return auth;
};

export const firestore = (): Firestore => {
  const db = getFirestore(firebaseApp());
  if (emulatorEnabled() && !connected.firestore) {
    const { host, port } = emulatorHost(process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST, "8080");
    connectFirestoreEmulator(db, host, port);
    connected.firestore = true;
  }
  return db;
};

/** Collection names, in one place so a typo is a compile error, not a silent empty query. */
export const COLLECTIONS = {
  users: "users",
  fests: "fests",
  events: "events",
  registrations: "registrations",
  attendance: "attendance",
  results: "results",
  certificates: "certificates",
  foodCollections: "foodCollections",
  notifications: "notifications",
  shifts: "shifts",
  auditLog: "auditLog",
  emailLog: "emailLog",
  arenas: "arenas",
  matches: "matches",
  matchLog: "matchLog",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
