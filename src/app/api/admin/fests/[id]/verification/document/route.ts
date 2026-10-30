import { ApiError, handler, ok, requirePermission } from "@/server/api";
import { audit } from "@/server/audit";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { createSignedUrl } from "@/server/storage/signed-url";
import { BUCKETS } from "@/server/storage/client";

/**
 * GET /api/admin/fests/[id]/verification/document — a short-lived link to the application's identity document.
 *
 * The only way anyone reads one. The file sits in the private `uploads` bucket under a random name; nothing public
 * points at it, and no client ever learns the path. A reviewer (`fest:verify`) asks here and is handed a link that
 * expires in minutes. The path comes from the server-only `festPrivate` record, never from the request, so the route
 * cannot be pointed at another file. Opening one is audited, without the link or the path.
 */
const SIGNED_LINK_SECONDS = 5 * 60;

export const GET = handler(async (request, context) => {
  const caller = await requirePermission(request, "fest:verify");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing event id.");

  const snapshot = await adminDb().collection(COLLECTIONS.festPrivate).doc(id).get();
  const documents = snapshot.data()?.verification?.documents as Array<{ kind?: string; bucket?: string; path?: string }> | undefined;
  const document = documents?.find((item) => item.kind === "identity" && item.path);
  if (!document?.path) throw ApiError.notFound("This application has no identity document on file.");
  // Only ever the private bucket, whatever the stored record says.
  if (document.bucket !== BUCKETS.uploads) throw ApiError.notFound("This application has no identity document on file.");

  let url: string;
  try {
    url = await createSignedUrl(BUCKETS.uploads, document.path, SIGNED_LINK_SECONDS);
  } catch {
    // No stack, no path: a missing object and an unconfigured bucket both end up here.
    throw ApiError.unavailable("The document could not be opened. Storage may not be configured, or the file may be missing.");
  }

  await audit(caller, {
    action: "verification_document_viewed",
    summary: "Opened the identity document of an event application",
    festId: id,
    subjectType: "fest",
    subjectId: id,
    details: { kind: "identity" },
  });

  return ok({ url, expiresInSeconds: SIGNED_LINK_SECONDS });
});
