import { z } from "zod";
import { idSchema } from "@/core/models/common";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { audit } from "@/server/audit";
import { issueCertificatesForEvent } from "@/server/certificates/issue";

// One PDF and one email per recipient, in sequence: a few dozen certificates
// already outlast the platform's default function limit.
export const maxDuration = 300;

/**
 * The release desk.
 *
 * Preparing certificates and releasing them are deliberately two different
 * acts by two different people. An admin runs the eligibility pass, reads the
 * list, and fixes the spelling of a name; the platform owner presses publish,
 * and that is the irreversible half — the email goes out, the download opens,
 * and a certificate cannot be un-sent.
 *
 *   GET  ?eventId=…   who is eligible, and what they already hold
 *   POST { eventId, userIds?, templateUrl? }   release to some or all of them
 */

const bodySchema = z.object({
  eventId: idSchema,
  /** Empty means everyone eligible. */
  userIds: z.array(idSchema).max(2000).default([]),
  /** Artwork to print on. Stored on the event so a re-run keeps it. */
  templateUrl: z.string().url().max(2000).optional(),
});

/** GET /api/admin/certificates/publish?eventId=… — the release preview. */
export const GET = handler(async (request) => {
  // Preparing is an admin capability: they need to see the list to fix it.
  const caller = await requirePermission(request, "certificate:issue");

  const eventId = new URL(request.url).searchParams.get("eventId");
  if (!eventId) throw ApiError.badRequest("Missing event id.");

  const db = adminDb();
  const eventSnap = await db.collection(COLLECTIONS.events).doc(eventId).get();
  if (!eventSnap.exists) throw ApiError.notFound("That event no longer exists.");
  const event = eventSnap.data()!;
  requireFestAccess(caller, String(event.festId), eventId);

  // What the eligibility pass would produce, without writing anything.
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
  const preview = await issueCertificatesForEvent({ eventId, actorId: caller.uid, dryRun: true, appUrl });

  // Joined with what already exists, so the list can say "held, not released"
  // rather than making the super admin guess.
  const held = await db.collection(COLLECTIONS.certificates).where("eventId", "==", eventId).get();
  const byUser = new Map(held.docs.map((doc) => [String(doc.data().userId), doc.data()]));

  const recipients = preview.drafts.map((draft) => {
    const existing = byUser.get(draft.userId);
    return {
      userId: draft.userId,
      registrationId: draft.registrationId,
      name: draft.recipientName,
      email: draft.recipientEmail,
      type: draft.type,
      teamName: draft.teamName ?? null,
      position: draft.position ?? null,
      issued: Boolean(existing),
      released: Boolean(existing) && existing!.published !== false,
      revoked: existing?.revoked === true,
      certificateNumber: existing ? String(existing.certificateNumber) : null,
      deliveryStatus: existing ? String(existing.delivery?.status ?? "pending") : null,
    };
  });

  return ok({
    event: { id: eventId, title: String(event.title ?? ""), festId: String(event.festId ?? ""), status: String(event.status ?? "draft") },
    templateUrl: event.certificateTemplateUrl ? String(event.certificateTemplateUrl) : null,
    canPublish: caller.role === "super_admin",
    recipients,
    unmatched: preview.unmatched,
    byType: preview.byType,
  });
});

/**
 * POST /api/admin/certificates/publish — release. Super admin only.
 *
 * Idempotent by construction: certificate ids are `${eventId}_${userId}`, so
 * a second run over the same people updates the same documents instead of
 * issuing anyone a second copy, and anything already released is skipped
 * rather than re-emailed.
 */
export const POST = handler(async (request) => {
  const caller = await requirePermission(request, "certificate:publish");
  const { eventId, userIds, templateUrl } = await readBody(request, bodySchema);

  const db = adminDb();
  const eventRef = db.collection(COLLECTIONS.events).doc(eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) throw ApiError.notFound("That event no longer exists.");
  const event = eventSnap.data()!;

  if (event.status !== "completed") {
    throw ApiError.unprocessable("Mark the event completed first — a certificate states that the event has ended.");
  }

  // Remember the template on the event so a later top-up run prints the same
  // paper without the super admin having to find the file again.
  if (templateUrl && templateUrl !== event.certificateTemplateUrl) {
    await eventRef.update({ certificateTemplateUrl: templateUrl, updatedAt: FieldValue.serverTimestamp() });
    await audit(caller, {
      action: "certificate_template_set",
      summary: `Certificate artwork set for "${event.title}"`,
      festId: String(event.festId),
      eventId,
      subjectType: "event",
      subjectId: eventId,
    });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");

  const summary = await issueCertificatesForEvent({
    eventId,
    actorId: caller.uid,
    dryRun: false,
    appUrl,
    mode: "publish",
    ...(userIds.length > 0 ? { only: new Set(userIds) } : {}),
    ...(templateUrl ?? event.certificateTemplateUrl ? { templateUrl: templateUrl ?? String(event.certificateTemplateUrl) } : {}),
  });

  await audit(caller, {
    action: "certificates_published",
    summary: `Released certificates for "${event.title}" · ${summary.published} to recipients, ${summary.emailed} emailed, ${summary.failed} failed`,
    festId: String(event.festId),
    eventId,
    subjectType: "event",
    subjectId: eventId,
    details: { ...summary, unmatched: summary.unmatched.length, selected: userIds.length || "all" },
  });

  return ok(summary);
}, { rateLimit: RATE_LIMITS.authenticated.certificates });
