import { z } from "zod";
import { idSchema, shortTextSchema } from "@/core/models/common";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { audit } from "@/server/audit";
import { emailService } from "@/server/email";
import { announcementEmail } from "@/server/email/templates";
import { activeParticipants, notifyMany } from "@/server/notify";

export const maxDuration = 300;

const announcementSchema = z.object({
  title: shortTextSchema,
  body: z.string().trim().min(1).max(2000),
  /** Limit to one event's participants; omit for the whole fest. */
  eventId: idSchema.optional(),
  /** Also email everyone. Off by default — the inbox is the cheaper channel. */
  email: z.boolean().default(false),
});

/**
 * POST /api/admin/fests/[id]/announcements — a message from the organizers
 * to everyone holding a confirmed entry (for the fest, or for one event).
 * Admin-only and audited: this is the one place staff can write to every
 * participant's inbox at once.
 */
export const POST = handler(async (request, context) => {
  const caller = await requirePermission(request, "announcement:send");
  const { id: festId } = await context.params;
  if (!festId) throw ApiError.badRequest("Missing fest id.");
  requireFestAccess(caller, festId);

  const input = await readBody(request, announcementSchema);
  const db = adminDb();
  const fest = await db.collection(COLLECTIONS.fests).doc(festId).get();
  if (!fest.exists) throw ApiError.notFound("No such fest.");

  if (input.eventId) {
    const event = await db.collection(COLLECTIONS.events).doc(input.eventId).get();
    if (!event.exists || event.data()?.festId !== festId) throw ApiError.unprocessable("That event is not part of this fest.");
  }

  const people = await activeParticipants(input.eventId ? { eventId: input.eventId } : { festId });
  const link = `/f/${String(fest.data()?.slug ?? "")}`;

  const notified = await notifyMany(
    people.map((r) => ({
      userId: r.userId,
      type: "announcement" as const,
      title: input.title,
      body: input.body,
      link,
      festId,
      ...(input.eventId ? { eventId: input.eventId } : {}),
    })),
  );

  let emailed = 0;
  if (input.email && people.length) {
    const results = await emailService().sendMany(
      people.map((r) =>
        announcementEmail({
          to: r.email,
          recipientName: r.name,
          festName: String(fest.data()?.name ?? ""),
          title: input.title,
          body: input.body,
          link: `${(process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")}${link}`,
          meta: { userId: r.userId, festId, ...(input.eventId ? { eventId: input.eventId } : {}), subjectType: "announcement" },
        }),
      ),
    );
    emailed = results.filter((r) => r.ok).length;
  }

  await audit(caller, {
    action: "announcement_sent",
    summary: `Announced "${input.title}" to ${notified} participant${notified === 1 ? "" : "s"}${input.email ? ` (${emailed} emailed)` : ""}`,
    festId,
    ...(input.eventId ? { eventId: input.eventId } : {}),
    subjectType: "fest",
    subjectId: festId,
    details: { email: input.email, recipients: people.length },
  });

  return ok({ recipients: people.length, notified, emailed });
}, { rateLimit: RATE_LIMITS.authenticated.announcement });
