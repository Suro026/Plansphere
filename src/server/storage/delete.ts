import { supabaseAdmin, type BucketName } from "./client";

/**
 * Removes one or more objects from a bucket. Supabase's `remove()` already
 * accepts an array and does not error on a path that is not there, which is
 * exactly the "delete is idempotent" behaviour the rest of the app expects
 * (replacing a fest's banner deletes the old one best-effort; a missing old
 * file is not a failure).
 */
export const deleteFile = async (bucket: BucketName, path: string): Promise<void> => {
  const { error } = await supabaseAdmin().storage.from(bucket).remove([path]);
  if (error) throw error;
};

export const deleteFiles = async (bucket: BucketName, paths: string[]): Promise<void> => {
  if (paths.length === 0) return;
  const { error } = await supabaseAdmin().storage.from(bucket).remove(paths);
  if (error) throw error;
};
