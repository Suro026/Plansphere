import { z } from "zod";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { audit } from "@/server/audit";
import { issueCertificatesForEvent } from "@/server/certificates/issue";

const bodySchema = z.object({ dryRun: z.boolean().default(false) });

/**
 * POST /api/admin/events/[id]/certificates — the post-event run.
 *
 * This *prepares*: it computes who is eligible and writes their certificates,
 * and stops there. Nothing is emailed and the student sees nothing, because
 * releasing is the platform owner's decision and happens at
 * /api/admin/certificates/publish. That split is the whole point — an admin
 * gets to find the misspelt name before four hundred PDFs go out.
 *
 * Still refused until the event is marked completed: a certificate that says
 * "participated" for an event still in progress is a false statement.
 */
export const POST = handler(async (request, context) => {
  const caller = await requirePermission(request, "certificate:issue");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing event id.");
  const { dryRun } = await readBody(request, bodySchema);

  const db = adminDb();
  const eventSnap = await db.collection(COLLECTIONS.events).doc(id).get();
  if (!eventSnap.exists) throw ApiError.notFound("That event no longer exists.");
  const event = eventSnap.data()!;
  requireFestAccess(caller, String(event.festId), id);

  if (event.status !== "completed") {
    throw ApiError.unprocessable("Mark the event completed first — certificates state that the event has ended.");
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
  const summary = await issueCertificatesForEvent({
    eventId: id,
    actorId: caller.uid,
    dryRun,
    appUrl,
    // A super admin running this from the fest console releases in one step;
    // anyone else prepares and hands over.
    mode: caller.role === "super_admin" ? "publish" : "prepare",
    ...(event.certificateTemplateUrl ? { templateUrl: String(event.certificateTemplateUrl) } : {}),
  });

  if (!dryRun) {
    await audit(caller, {
      action: caller.role === "super_admin" ? "certificates_published" : "certificates_generated",
      summary:
        caller.role === "super_admin"
          ? `Released certificates for "${event.title}" · ${summary.published} to recipients, ${summary.emailed} emailed, ${summary.failed} failed`
          : `Prepared certificates for "${event.title}" · ${summary.created} written, ${summary.existing} already held one — awaiting release`,
      festId: String(event.festId),
      eventId: id,
      subjectType: "event",
      subjectId: id,
      details: { ...summary, unmatched: summary.unmatched.length },
    });
  }

  return ok(summary);
}, { rateLimit: RATE_LIMITS.authenticated.certificates });
