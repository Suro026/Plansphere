import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../errors";
import { BUCKETS, isPublicBucket, supabaseAdmin, type BucketName } from "./client";
import { createSignedUrl, DEFAULT_SIGNED_URL_TTL_SECONDS } from "./signed-url";
import { describeRejectedType, EXTENSION, processImage, sniffType, type DetectedType } from "./image";

export { sniffType, describeRejectedType, processImage, convertToWebp, type DetectedImage, type DetectedType, type ProcessedImage } from "./image";

/**
 * File uploads — one path in, for every kind of file the app accepts.
 *
 * This is the orchestration layer: it decides *which* Supabase bucket and
 * folder a kind of file belongs in, runs the shared validation and image
 * pipeline (`./image.ts`), and calls the Supabase primitives (`./client.ts`,
 * `./signed-url.ts`) to actually store the bytes. Nothing about the request
 * is trusted — see `./image.ts` for the detail — and nothing here changes
 * that: only the storage backend underneath it did.
 */

/* ───────────── what may be uploaded ───────────── */

export type UploadKind =
  | "festBanner"
  | "festLogo"
  | "festHero"
  | "festThumbnail"
  | "festSocial"
  | "eventPoster"
  | "eventRulebook"
  | "eventTeamPhoto"
  | "certificateTemplate"
  | "profilePhoto"
  | "eventHeadIdentity";

export interface UploadPolicy {
  /** Owner segment: a fest id, or a user id. */
  owner: "fest" | "user";
  /** Which Supabase bucket this kind lives in. */
  bucket: BucketName;
  /** Folder under the owner. */
  folder: string;
  maxBytes: number;
  /** Longest side after processing. */
  maxDimension: number;
  /** Which capability the route must check before calling in. */
  permission: "upload:festArtwork" | "upload:eventPoster" | "certificate:publish" | "self";
  /** PDF kinds skip image processing entirely — sharp cannot decode one. */
  document?: boolean;
  /** Accepts either an image or a PDF — whichever the bytes actually are. */
  flexible?: boolean;
}

export const UPLOAD_POLICY: Record<UploadKind, UploadPolicy> = {
  festBanner: { owner: "fest", bucket: BUCKETS.eventAssets, folder: "banners", maxBytes: 5 * 1024 * 1024, maxDimension: 2400, permission: "upload:festArtwork" },
  festLogo: { owner: "fest", bucket: BUCKETS.eventAssets, folder: "logos", maxBytes: 2 * 1024 * 1024, maxDimension: 1024, permission: "upload:festArtwork" },
  festHero: { owner: "fest", bucket: BUCKETS.eventAssets, folder: "hero", maxBytes: 6 * 1024 * 1024, maxDimension: 2400, permission: "upload:festArtwork" },
  festThumbnail: { owner: "fest", bucket: BUCKETS.eventAssets, folder: "thumbnails", maxBytes: 3 * 1024 * 1024, maxDimension: 1200, permission: "upload:festArtwork" },
  festSocial: { owner: "fest", bucket: BUCKETS.eventAssets, folder: "social", maxBytes: 3 * 1024 * 1024, maxDimension: 1200, permission: "upload:festArtwork" },
  eventPoster: { owner: "fest", bucket: BUCKETS.eventAssets, folder: "posters", maxBytes: 5 * 1024 * 1024, maxDimension: 2400, permission: "upload:eventPoster" },
  eventTeamPhoto: { owner: "fest", bucket: BUCKETS.eventAssets, folder: "team", maxBytes: 3 * 1024 * 1024, maxDimension: 1200, permission: "upload:eventPoster" },
  eventRulebook: { owner: "fest", bucket: BUCKETS.eventAssets, folder: "rulebooks", maxBytes: 10 * 1024 * 1024, maxDimension: 0, permission: "upload:eventPoster", document: true },
  /**
   * The artwork a certificate is printed on. Releasing certificates is a
   * super admin action, and so is replacing the paper they are printed on —
   * and unlike the fest's public artwork, there is no reason a stranger
   * should ever fetch this file directly, so it lives in the private
   * `certificates` bucket rather than the public `event-assets` one.
   */
  certificateTemplate: { owner: "fest", bucket: BUCKETS.certificates, folder: "certificate-templates", maxBytes: 8 * 1024 * 1024, maxDimension: 3508, permission: "certificate:publish" },
  profilePhoto: { owner: "user", bucket: BUCKETS.avatars, folder: "photo", maxBytes: 3 * 1024 * 1024, maxDimension: 1024, permission: "self" },
  /**
   * An Event Head's ID card (a photo) or authorization letter (a PDF), taken
   * during self-service registration — before any fest exists, so this is
   * owned by the *user*, not a fest. Kept for the record only: nothing here
   * verifies it, and nothing in the registration flow waits on it.
   */
  eventHeadIdentity: { owner: "user", bucket: BUCKETS.uploads, folder: "identity", maxBytes: 8 * 1024 * 1024, maxDimension: 2400, permission: "self", flexible: true },
};

/** The largest any request body may be, whatever the kind. Checked first. */
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(UPLOAD_POLICY).map((p) => p.maxBytes));

/* ───────────── naming ───────────── */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * `fests/{festId}/banners/{uuid}.png` — the path *within* the kind's bucket.
 * The owner id is validated against a strict alphabet (Firestore ids and
 * Firebase uids both fit), the folder is ours, the filename is random. No
 * component comes from the client, and the random name is what makes
 * replacing a fest's banner a cache-busting *new* URL rather than a stale
 * CDN-cached one at a fixed path.
 */
export const objectPathFor = (kind: UploadKind, ownerId: string, contentType: DetectedType): string => {
  const policy = UPLOAD_POLICY[kind];
  if (!SAFE_ID.test(ownerId)) throw ApiError.badRequest("Invalid owner id.");
  const root = policy.owner === "fest" ? "fests" : "users";
  return `${root}/${ownerId}/${policy.folder}/${randomUUID()}.${EXTENSION[contentType]}`;
};

/* ───────────── storing ───────────── */

export interface StoredUpload {
  bucket: BucketName;
  path: string;
  url: string;
  contentType: string;
  bytes: number;
  width?: number;
  height?: number;
  sha256: string;
}

/**
 * Writes to the kind's bucket with custom object metadata recording who
 * uploaded it and what it is — what an abuse report is answered from, same
 * as the Firebase Storage version this replaces. A public bucket gets back
 * its permanent CDN URL; a private one gets a signed URL good for
 * `DEFAULT_SIGNED_URL_TTL_SECONDS` — long enough to use immediately, but a
 * caller that needs the link again later must ask `createSignedUrl` for a
 * fresh one rather than keep this one past its expiry.
 */
export const storeUpload = async (
  bucket: BucketName,
  path: string,
  bytes: Buffer,
  contentType: string,
  meta: { uploadedBy: string; kind: UploadKind | "certificatePdf"; width?: number; height?: number },
): Promise<StoredUpload> => {
  const client = supabaseAdmin();
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const { error } = await client.storage.from(bucket).upload(path, bytes, {
    contentType,
    // Supabase's cacheControl is the max-age in seconds, not a full header
    // string — one year, matching the immutable-forever intent of a
    // randomly-named object that is never overwritten.
    cacheControl: `${365 * 24 * 60 * 60}`,
    upsert: false,
    metadata: {
      uploadedBy: meta.uploadedBy,
      kind: meta.kind,
      sha256,
      ...(meta.width ? { width: String(meta.width), height: String(meta.height) } : {}),
    },
  });

  if (error) {
    // A missing bucket (never created in the Supabase dashboard) is a
    // deployment gap, not a bug: say so instead of a generic 500.
    if (/bucket.*not.*found/i.test(error.message)) {
      throw ApiError.unavailable("Image uploads aren’t enabled on this deployment yet. Paste an https:// image URL instead, or ask the platform admin to create the storage buckets.");
    }
    throw error;
  }

  const url = isPublicBucket(bucket) ? client.storage.from(bucket).getPublicUrl(path).data.publicUrl : await createSignedUrl(bucket, path, DEFAULT_SIGNED_URL_TTL_SECONDS);

  return {
    bucket,
    path,
    url,
    contentType,
    bytes: bytes.length,
    ...(meta.width ? { width: meta.width, height: meta.height } : {}),
    sha256,
  };
};

/* ───────────── the whole pipeline ───────────── */

export interface UploadInput {
  kind: UploadKind;
  ownerId: string;
  uploadedBy: string;
  bytes: Buffer;
  declaredType: string | null;
}

/** Validate, sniff, process, name, store. Throws ApiError for anything refused. */
export const acceptImageUpload = async (input: UploadInput): Promise<StoredUpload> => {
  const policy = UPLOAD_POLICY[input.kind];
  if (input.bytes.length === 0) throw ApiError.badRequest("The file is empty.");
  if (input.bytes.length > policy.maxBytes) {
    throw new ApiError(413, "too-large", `That file is ${(input.bytes.length / 1048576).toFixed(1)} MB; the limit is ${policy.maxBytes / 1048576} MB.`);
  }

  const detected = sniffType(input.bytes);
  if (!detected || detected === "application/pdf") {
    throw new ApiError(415, "unsupported-type", describeRejectedType(input.bytes, input.declaredType));
  }

  const image = await processImage(input.bytes, detected, policy.maxDimension);
  if (image.bytes.length > policy.maxBytes) {
    throw new ApiError(413, "too-large", `That image is too large even after processing; the limit is ${policy.maxBytes / 1048576} MB.`);
  }

  const path = objectPathFor(input.kind, input.ownerId, image.contentType);
  return storeUpload(policy.bucket, path, image.bytes, image.contentType, { uploadedBy: input.uploadedBy, kind: input.kind, width: image.width, height: image.height });
};

/**
 * Accepts a PDF, and only a PDF, verified by its bytes rather than its name
 * or declared type — the anti-MIME-spoofing requirement. There is nothing
 * to re-encode — sharp cannot open a PDF, and there is no equivalent of
 * "strip the metadata and flatten it" for one without a much heavier
 * dependency than a rulebook justifies — so a PDF is stored exactly as
 * uploaded, behind the same randomised name as every other kind, capped at
 * 10 MB by the same `UPLOAD_POLICY`.
 */
export const acceptPdfUpload = async (input: UploadInput): Promise<StoredUpload> => {
  const policy = UPLOAD_POLICY[input.kind];
  if (input.bytes.length === 0) throw ApiError.badRequest("The file is empty.");
  if (input.bytes.length > policy.maxBytes) {
    throw new ApiError(413, "too-large", `That file is ${(input.bytes.length / 1048576).toFixed(1)} MB; the limit is ${policy.maxBytes / 1048576} MB.`);
  }

  const detected = sniffType(input.bytes);
  if (detected !== "application/pdf") {
    throw new ApiError(415, "unsupported-type", input.declaredType ? `"${input.declaredType}" is not a PDF.` : "That file is not a PDF.");
  }

  const path = objectPathFor(input.kind, input.ownerId, "application/pdf");
  return storeUpload(policy.bucket, path, input.bytes, "application/pdf", { uploadedBy: input.uploadedBy, kind: input.kind });
};

/**
 * Accepts whichever of the two the bytes actually are — an ID card is
 * usually a photo, an authorization letter is usually a PDF, and asking the
 * uploader to know which bucket that maps to is not worth a second field.
 * Detected by content, same as the other two; a PDF is stored as-is, an
 * image goes through the same strip-and-bound pipeline as any other photo.
 */
export const acceptFlexibleUpload = async (input: UploadInput): Promise<StoredUpload> => {
  const policy = UPLOAD_POLICY[input.kind];
  if (input.bytes.length === 0) throw ApiError.badRequest("The file is empty.");
  if (input.bytes.length > policy.maxBytes) {
    throw new ApiError(413, "too-large", `That file is ${(input.bytes.length / 1048576).toFixed(1)} MB; the limit is ${policy.maxBytes / 1048576} MB.`);
  }

  const detected = sniffType(input.bytes);
  if (!detected) throw new ApiError(415, "unsupported-type", describeRejectedType(input.bytes, input.declaredType));

  if (detected === "application/pdf") {
    const path = objectPathFor(input.kind, input.ownerId, "application/pdf");
    return storeUpload(policy.bucket, path, input.bytes, "application/pdf", { uploadedBy: input.uploadedBy, kind: input.kind });
  }

  const image = await processImage(input.bytes, detected, policy.maxDimension);
  if (image.bytes.length > policy.maxBytes) {
    throw new ApiError(413, "too-large", `That image is too large even after processing; the limit is ${policy.maxBytes / 1048576} MB.`);
  }
  const path = objectPathFor(input.kind, input.ownerId, image.contentType);
  return storeUpload(policy.bucket, path, image.bytes, image.contentType, { uploadedBy: input.uploadedBy, kind: input.kind, width: image.width, height: image.height });
};
