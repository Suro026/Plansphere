import { supabaseAdmin, type BucketName } from "./client";

/** A day is a sane default for a link someone downloads from a page they are looking at right now. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24;

/**
 * A time-limited URL into a private bucket (`certificates`, `uploads`).
 *
 * Deliberately not persisted anywhere as if it were permanent: a signed URL
 * expires, so the only thing safe to store in Firestore for a private-bucket
 * file is its `{ bucket, path }` — callers that need a link later call this
 * again for a fresh one, exactly the way `/api/verify/[number]/pdf` already
 * renders a certificate on demand rather than trusting a stored link to
 * still be good.
 */
export const createSignedUrl = async (bucket: BucketName, path: string, expiresInSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS): Promise<string> => {
  const { data, error } = await supabaseAdmin().storage.from(bucket).createSignedUrl(path, expiresInSeconds);
  if (error || !data?.signedUrl) throw error ?? new Error("Supabase returned no signed URL.");
  return data.signedUrl;
};
