import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { adminAuth, adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { firebaseAuth } from "@/data/firebase/client";
import type { UserRole } from "@/core/models/user";

/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are asserted field by field */

/**
 * Shared plumbing for the emulator project.
 *
 * - `resetFirestore()` wipes the emulator between files via its REST API.
 * - `mintUser()` creates an Auth-emulator account with the same custom claims
 *   production sets, plus its `users` document, and returns a real ID token —
 *   so `authenticate()` in the route handlers runs unmodified.
 * - `callRoute()` invokes a Next route handler exactly as Next would.
 */

export const PROJECT = process.env.GCLOUD_PROJECT ?? "plansphere-test";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";

export const resetFirestore = async (): Promise<void> => {
  const res = await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  if (!res.ok) throw new Error(`clearFirestore failed: ${res.status}`);
};

export const resetAuth = async (): Promise<void> => {
  const res = await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
  if (!res.ok) throw new Error(`clearAuth failed: ${res.status}`);
};

export interface TestUser {
  uid: string;
  email: string;
  name: string;
  role: UserRole;
  idToken: string;
  password: string;
}

let counter = 0;

export const mintUser = async (input: { role?: UserRole; festIds?: string[]; name?: string; email?: string; emailVerified?: boolean; profile?: boolean; mustChangePassword?: boolean; profileCompleted?: boolean } = {}): Promise<TestUser> => {
  counter += 1;
  const role = input.role ?? "student";
  const email = (input.email ?? `${role}-${counter}@plansphere.test`).toLowerCase();
  const name = input.name ?? `${role[0]!.toUpperCase()}${role.slice(1)} ${counter}`;
  const password = "Test-password-1!";

  const user = await adminAuth().createUser({ email, password, displayName: name, emailVerified: input.emailVerified ?? true });
  await adminAuth().setCustomUserClaims(user.uid, {
    role,
    festIds: input.festIds ?? [],
    ...(input.mustChangePassword ? { mustChangePassword: true } : {}),
  });

  if (input.profile !== false) {
    await adminDb()
      .collection(COLLECTIONS.users)
      .doc(user.uid)
      .set({
        id: user.uid,
        email,
        name,
        role,
        festIds: input.festIds ?? [],
        profileCompleted: input.profileCompleted ?? true,
        mustChangePassword: input.mustChangePassword ?? false,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(role === "student" ? { college: "Test College", phone: "+919000000000" } : {}),
      });
  }

  // Exchange for an ID token through the emulator's Identity Toolkit.
  const res = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = (await res.json()) as { idToken?: string; error?: unknown };
  if (!body.idToken) throw new Error(`Could not sign in test user: ${JSON.stringify(body.error)}`);

  return { uid: user.uid, email, name, role, idToken: body.idToken, password };
};

/**
 * A fresh ID token for an existing test user, reflecting whatever custom
 * claims are on the account *right now* — a Firebase ID token bakes claims in
 * at mint time, so a token minted before a mid-test promotion (a role or
 * `festIds` change) still reads as the old role until a new one is issued.
 */
export const freshToken = async (user: Pick<TestUser, "email" | "password">): Promise<string> => {
  const res = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password, returnSecureToken: true }),
  });
  const body = (await res.json()) as { idToken?: string; error?: unknown };
  if (!body.idToken) throw new Error(`Could not refresh test user token: ${JSON.stringify(body.error)}`);
  return body.idToken;
};

/** Sign the client SDK in as this user (for repository tests that run under the rules). */
export const clientSignIn = async (user: TestUser): Promise<void> => {
  await signInWithEmailAndPassword(firebaseAuth(), user.email, user.password);
};
export const clientSignOut = (): Promise<void> => signOut(firebaseAuth());

type RouteHandler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

export const callRoute = async (
  handler: RouteHandler,
  input: {
    method?: string;
    path?: string;
    params?: Record<string, string>;
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
    /** For a route that answers a file (an export) rather than JSON. */
    raw?: boolean;
  } = {},
): Promise<{ status: number; body: Record<string, any>; contentType?: string; bytes?: Uint8Array }> => {
  const request = new Request(`http://localhost:3000${input.path ?? "/api/test"}`, {
    method: input.method ?? (input.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(input.headers ?? {}),
    },
    body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
  });
  const response = await handler(request, { params: Promise.resolve(input.params ?? {}) });

  if (input.raw) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, body: {}, contentType: response.headers.get("content-type") ?? undefined, bytes };
  }

  let body: Record<string, any> = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { status: response.status, body };
};

/* ───────────── seed data ───────────── */

export const seedFest = async (over: Record<string, unknown> = {}) => {
  const id = (over.id as string) ?? "fest1";
  await adminDb()
    .collection(COLLECTIONS.fests)
    .doc(id)
    .set({
      id,
      slug: "bits2bytes",
      name: "Bits2Bytes",
      tagline: "Test fest",
      description: "Test fest",
      organizationName: "Test College",
      venue: "Campus",
      city: "Chennai",
      startDate: "2026-09-25",
      endDate: "2026-09-27",
      status: "published",
      categories: ["technical"],
      stats: { events: 1, registrations: 0, checkIns: 0 },
      createdBy: "admin1",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });
  return id;
};

export const seedEvent = async (over: Record<string, unknown> = {}) => {
  const id = (over.id as string) ?? "ev1";
  await adminDb()
    .collection(COLLECTIONS.events)
    .doc(id)
    .set({
      id,
      festId: "fest1",
      slug: "ctf",
      title: "Capture the Flag",
      description: "Test event",
      category: "technical",
      eventType: "team",
      teamSize: { min: 1, max: 3 },
      date: "2026-09-26",
      startTime: "10:00",
      venue: "Lab 4",
      capacity: 3,
      registeredCount: 0,
      waitlistEnabled: false,
      entryFee: 0,
      registrationOpen: true,
      status: "published",
      gates: ["Gate A"],
      mealSlots: [],
      coordinators: [],
      createdBy: "admin1",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });
  return id;
};

export const eventDoc = async (id = "ev1") => (await adminDb().collection(COLLECTIONS.events).doc(id).get()).data()!;
export const festDoc = async (id = "fest1") => (await adminDb().collection(COLLECTIONS.fests).doc(id).get()).data()!;
