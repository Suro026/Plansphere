import { z } from "zod";
import { ApiError, authenticate, handler, ok, requireFestAccess, type Caller } from "@/server/api";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { RATE_LIMITS } from "@/server/rate-limit";
import { MAX_UPLOAD_BYTES, UPLOAD_POLICY, acceptFlexibleUpload, acceptImageUpload, acceptPdfUpload, type UploadKind } from "@/server/storage/upload";
import { can } from "@/core/permissions";
import { audit } from "@/server/audit";

// Multipart bodies need the Node runtime and a body-size ceiling.
export const runtime = "nodejs";
export const maxDuration = 30;

const querySchema = z.object({
  kind: z.enum(["festBanner", "festLogo", "festHero", "festThumbnail", "festSocial", "eventPoster", "eventRulebook", "eventTeamPhoto", "certificateTemplate", "profilePhoto", "eventHeadIdentity"]),
  /** The fest id for fest-owned kinds; ignored for profile photos (always self). */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
});

/** Who may write under which owner. The policy says what; this says who. */
const authorize = async (caller: Caller, kind: UploadKind, id: string | undefined): Promise<string> => {
  const policy = UPLOAD_POLICY[kind];
  if (policy.owner === "user" || policy.permission === "self") return caller.uid;
  if (!id) throw ApiError.badRequest("Missing fest id.");
  if (!can(caller.role, policy.permission)) throw ApiError.forbidden();
  requireFestAccess(caller, id);
  const fest = await adminDb().collection(COLLECTIONS.fests).doc(id).get();
  if (!fest.exists) throw ApiError.notFound("No such fest.");
  return id;
};

/**
 * POST /api/uploads?kind=…&id=… — multipart/form-data with one `file` field.
 *
 * Accepts PNG, JPEG, WebP (and GIF, flattened to PNG). Everything else is
 * refused by content, not by name. The processed file goes to Supabase
 * Storage under a random name in the kind's bucket, and the URL comes back
 * for the form to save. Every write goes through here with the Supabase
 * service-role key — a browser never talks to Supabase directly — so this
 * route is the only way a file enters a bucket.
 */
export const POST = handler(async (request) => {
  const caller = await authenticate(request);

  // Cheap gate before touching the body: a declared size over the ceiling
  // is refused without buffering it.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES + 64 * 1024) {
    throw new ApiError(413, "too-large", `Uploads are limited to ${MAX_UPLOAD_BYTES / 1048576} MB.`);
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw ApiError.badRequest("Bad upload request.");
  const { kind, id } = parsed.data;

  const ownerId = await authorize(caller, kind, id);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw ApiError.badRequest("Send the file as multipart/form-data in a field named `file`.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw ApiError.badRequest("No file was attached.");
  if (file.size > UPLOAD_POLICY[kind].maxBytes) {
    throw new ApiError(413, "too-large", `That file is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${UPLOAD_POLICY[kind].maxBytes / 1048576} MB.`);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const input = { kind, ownerId, uploadedBy: caller.uid, bytes, declaredType: file.type || null };
  const stored = UPLOAD_POLICY[kind].flexible
    ? await acceptFlexibleUpload(input)
    : UPLOAD_POLICY[kind].document
      ? await acceptPdfUpload(input)
      : await acceptImageUpload(input);

  if (UPLOAD_POLICY[kind].owner === "fest") {
    await audit(caller, {
      action: "file_uploaded",
      summary: `Uploaded ${kind} (${stored.contentType}, ${Math.round(stored.bytes / 1024)} KB)`,
      festId: ownerId,
      subjectType: "fest",
      subjectId: ownerId,
      details: { path: stored.path, sha256: stored.sha256 },
    });
  }

  return ok({ url: stored.url, bucket: stored.bucket, path: stored.path, contentType: stored.contentType, width: stored.width, height: stored.height, bytes: stored.bytes }, 201);
}, { rateLimit: RATE_LIMITS.authenticated.uploads });
