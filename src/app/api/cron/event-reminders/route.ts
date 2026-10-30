import { NextResponse } from "next/server";
import { handler, ok } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { emailService } from "@/server/email";
import { eventReminderEmail } from "@/server/email/templates";
import { activeParticipants, notifyMany } from "@/server/notify";

export const maxDuration = 300;

/**
 * GET /api/cron/event-reminders — the day-before reminder.
 *
 * Vercel Cron calls this once a day (see vercel.json) with
 * `Authorization: Bearer $CRON_SECRET`. It finds every published event
 * happening tomorrow (in India Standard Time — fests here run on IST, and a
 * UTC "tomorrow" would fire a day early for evening events), and sends each
 * confirmed participant one in-app notification and one email.
 *
 * Idempotent: an event is stamped `reminderSentAt` inside the same run, so a
 * retried or manually triggered call cannot remind anyone twice.
 */
export const GET = handler(async (request) => {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") ?? "";
  if (!secret || header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(Date.now() + 24 * 60 * 60 * 1000),
  );

  const db = adminDb();
  const events = await db.collection(COLLECTIONS.events).where("status", "==", "published").where("date", "==", tomorrow).get();

  const summary: Array<{ eventId: string; title: string; notified: number; emailed: number; skipped?: string }> = [];

  for (const doc of events.docs) {
    const event = doc.data();
    if (event.reminderSentAt) {
      summary.push({ eventId: doc.id, title: String(event.title), notified: 0, emailed: 0, skipped: "already sent" });
      continue;
    }
    // Claim first, so two overlapping runs cannot both send.
    await doc.ref.update({ reminderSentAt: FieldValue.serverTimestamp() });

    const fest = await db.collection(COLLECTIONS.fests).doc(String(event.festId)).get();
    const festName = String(fest.data()?.name ?? "");
    const people = await activeParticipants({ eventId: doc.id });
    const regs = new Map((await db.collection(COLLECTIONS.registrations).where("eventId", "==", doc.id).where("status", "==", "confirmed").get()).docs.map((r) => [r.id, r.data()]));

    const notified = await notifyMany(
      people.map((r) => ({
        userId: r.userId,
        type: "event_reminder" as const,
        title: `Tomorrow: ${event.title}`,
        body: `${event.startTime} · ${event.venue} · open your pass once while online`,
        link: `/my-pass?r=${r.registrationId}`,
        festId: String(event.festId),
        eventId: doc.id,
      })),
    );

    const results = await emailService().sendMany(
      people.map((r) =>
        eventReminderEmail({
          to: r.email,
          recipientName: r.name,
          eventTitle: String(event.title),
          festName,
          date: String(event.date),
          startTime: String(event.startTime),
          venue: String(event.venue),
          ticketCode: String(regs.get(r.registrationId)?.ticketCode ?? ""),
          registrationId: r.registrationId,
          meta: { userId: r.userId, festId: String(event.festId), eventId: doc.id, subjectType: "registration", subjectId: r.registrationId },
        }),
      ),
    );

    summary.push({ eventId: doc.id, title: String(event.title), notified, emailed: results.filter((r) => r.ok).length });
  }

  return ok({ date: tomorrow, events: summary });
}, { rateLimit: RATE_LIMITS.public.cron, appCheck: false });
