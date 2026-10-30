import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { inspectServiceAccount } from "../../scripts/lib/service-account.mjs";

/**
 * The Firebase Admin SDK. Server only.
 *
 * Everything here runs with full privileges and bypasses every rule in
 * firestore.rules. That is the entire reason the privileged operations live
 * behind API routes: the route checks who is calling and what they are allowed
 * to do, and only then touches the database. A bug that skips the check here
 * is equivalent to having no security rules at all.
 *
 * Importing this from a client component is a build error waiting to happen —
 * `firebase-admin` cannot bundle for the browser — but the explicit guard
 * below turns a confusing bundler failure into a sentence that says what went
 * wrong.
 */

if (typeof window !== "undefined") {
  throw new Error(
    "src/server/firebase-admin.ts was imported into client code. It holds " +
      "credentials that bypass all security rules and must only be used from " +
      "route handlers and server components.",
  );
}

const APP_NAME = "plansphere-admin";

/** Thrown when the service account is absent or unusable. */
export class AdminNotConfiguredError extends Error {
  constructor(detail: string) {
    super(
      `Firebase Admin is not configured: ${detail} ` +
        `Set FIREBASE_SERVICE_ACCOUNT in .env.local (see .env.example).`,
    );
    this.name = "AdminNotConfiguredError";
  }
}

interface ServiceAccountJson {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * Accepts the service account as raw JSON or base64-encoded JSON.
 *
 * Base64 is what the setup writes, because a PEM private key contains newlines
 * and `.env` files only preserve those inside quotes — a raw paste silently
 * truncates at the first line break, which fails much later with an opaque
 * "invalid PEM" from the crypto layer.
 */
const parseServiceAccount = (raw: string): ServiceAccountJson => {
  // One reading for the app, /api/health and every script (scripts/lib/service-account.mjs): it names the actual mistake - the
  // private key pasted alone, a truncated value, the wrong file - and never echoes any of the value.
  const reading = inspectServiceAccount(raw);
  if (!reading.ok) throw new AdminNotConfiguredError(`${reading.message}`);
  return reading.account;
};

let cached: App | null = null;

const adminApp = (): App => {
  if (cached) return cached;

  const existing = getApps().find((app) => app.name === APP_NAME);

  if (existing) {
    cached = existing;
    return cached;
  }

  // Against the local emulators no credential is needed or wanted: the
  // emulator accepts any project id and never talks to Google. This is how
  // the emulator test suite and `firebase emulators:start` development run.
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    const projectId = process.env.GCLOUD_PROJECT ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "plansphere-emulator";
    cached = initializeApp({ projectId }, APP_NAME);
    return cached;
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw || !raw.trim()) {
    throw new AdminNotConfiguredError("FIREBASE_SERVICE_ACCOUNT is empty.");
  }

  const account = parseServiceAccount(raw);

  cached = initializeApp(
    {
      credential: cert({
        projectId: account.project_id,
        clientEmail: account.client_email,
        privateKey: account.private_key,
      }),
      projectId: account.project_id,
    },
    APP_NAME,
  );

  return cached;
};

export const adminAuth = (): Auth => getAuth(adminApp());

export const adminDb = (): Firestore => getFirestore(adminApp());

/** True when the service account is present and parseable. */
export const isAdminConfigured = (): boolean => {
  try {
    adminApp();
    return true;
  } catch {
    return false;
  }
};

/** Re-export so route handlers can build server timestamps and increments. */
export { FieldValue, Timestamp } from "firebase-admin/firestore";

/** Collection names, mirroring the client-side constant. */
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
  /**
   * One row per verification or download of a certificate — the analytics
   * module's only new collection. Written fire-and-forget from the public
   * verify/pdf routes, read only by the analytics routes below; nothing
   * client-side ever touches it, so it carries no Firestore rules of its
   * own and falls to the catch-all deny at the bottom of firestore.rules.
   */
  certificateEvents: "certificateEvents",
  arenas: "arenas",
  matches: "matches",
  matchLog: "matchLog",
  /**
   * Personal details of the person who registered a fest (`eventHead`: name, designation, phone, LinkedIn, ID-document
   * reference), one document per fest. Server-only: the `fests` document is world-readable once published, so nothing
   * private may be stored on it. Rules deny every client read and write.
   */
  festPrivate: "festPrivate",
  /**
   * Event-level roles: one document per (fest, person) - `{festId}__{userId}` - holding the role they have on that one
   * main event and the sub-events and duties they are assigned (see `core/models/membership.ts`). Written by the server
   * alone; the rules let a member read their own and let nothing write.
   */
  festMembers: "festMembers",
  /**
   * Optional paid registration. All four are server-only: Firestore rules deny
   * every client read and write (see the "payments" block in firestore.rules),
   * and staff see payment state through the API and the registration's own
   * `paymentStatus`.
   *
   *   paymentAccounts  one per fest — provider, mode, approval status. No secrets.
   *   paymentSecrets   one per fest — the merchant credentials, AES-256-GCM encrypted.
   *   payments         one per registration — the money state, orders and refunds.
   *   paymentEvents    webhook de-duplication ledger.
   */
  paymentAccounts: "paymentAccounts",
  paymentSecrets: "paymentSecrets",
  payments: "payments",
  paymentEvents: "paymentEvents",
  /**
   * The platform boundary (see `core/platform.ts`). `platformStaff/{uid}` is the registry of accounts allowed to act as the
   * platform; `platformConfig/boundary` says whether that registry is enforced. Both are written ONLY by
   * `npm run platform-staff` against the service account; rules deny every client read and write.
   */
  platformStaff: "platformStaff",
  platformConfig: "platformConfig",
} as const;

/** Ensures the app is only ever initialised once per process. */
export const getAdminApp = adminApp;
