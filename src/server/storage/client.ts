import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cleanEnvValue } from "./diagnose";

/**
 * The Supabase Storage client. Server only, service-role only.
 *
 * This is the file layer's equivalent of `server/firebase-admin.ts`:
 * Firebase Auth and Firestore remain the source of truth for identity and
 * data, but every file — a poster, an avatar, a certificate PDF — lives in
 * Supabase Storage. The service-role key bypasses Supabase's own row-level
 * security the same way the Firebase Admin SDK bypasses Firestore rules, so
 * the same rule applies: this client is reached only from route handlers
 * that have already run `requirePermission`/`requireFestAccess` against the
 * caller's Firebase token. It must never reach a client bundle.
 */

if (typeof window !== "undefined") {
  throw new Error(
    "src/server/storage/client.ts was imported into client code. It holds " +
      "the Supabase service-role key, which bypasses every storage policy, " +
      "and must only be used from route handlers and server modules.",
  );
}

/** Thrown when Supabase Storage is not configured. */
export class StorageNotConfiguredError extends Error {
  constructor(detail: string) {
    super(`Supabase Storage is not configured: ${detail} Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local (see .env.example).`);
    this.name = "StorageNotConfiguredError";
  }
}

/** The four buckets this app stores files in. Public buckets serve a permanent URL; private ones require a signed one. */
export const BUCKETS = {
  eventAssets: "event-assets",
  certificates: "certificates",
  avatars: "avatars",
  uploads: "uploads",
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

/** Buckets created as `public` in Supabase — safe to hand back a permanent URL for. */
export const PUBLIC_BUCKETS: ReadonlySet<BucketName> = new Set([BUCKETS.eventAssets, BUCKETS.avatars]);

export const isPublicBucket = (bucket: BucketName): boolean => PUBLIC_BUCKETS.has(bucket);

let cached: SupabaseClient | null = null;

/**
 * Lazy on purpose, exactly like `adminApp()` — importing this module (which
 * happens the moment any route that might upload a file loads) must never
 * throw just because the environment is not configured yet. The error only
 * surfaces when a request actually tries to touch storage.
 */
export const supabaseAdmin = (): SupabaseClient => {
  if (cached) return cached;

  // A value pasted into a host's dashboard often arrives with a trailing newline or wrapping quotes, which Supabase
  // rejects as a malformed header. The diagnosis (`diagnose.ts`) reads the variables the same way, so they cannot disagree.
  const url = cleanEnvValue(process.env.SUPABASE_URL);
  const serviceRoleKey = cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!url) throw new StorageNotConfiguredError("SUPABASE_URL is empty.");
  if (!serviceRoleKey) throw new StorageNotConfiguredError("SUPABASE_SERVICE_ROLE_KEY is empty.");

  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
};

/** True when Supabase Storage is configured and reachable enough to try. Never throws. */
export const isStorageConfigured = (): boolean => {
  try {
    supabaseAdmin();
    return true;
  } catch {
    return false;
  }
};

/** Test-only: forces the next `supabaseAdmin()` call to re-read env and re-create the client. */
export const resetStorageClientForTests = (): void => {
  cached = null;
};
