import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { emailService } from "@/server/email";
import { registrationConfirmedEmail, teamInviteEmail } from "@/server/email/templates";
import { notify, notifyMany } from "@/server/notify";

/**
 * What a person is told about a registration, once it exists.
 *
 * Extracted verbatim from `POST /api/registrations` so the same messages go out
 * from the two places a registration can become real: the request that created
 * it (free events) and the verified payment that confirmed it (paid events).
 *
 * What goes out depends on the entry's state when this is called:
 *   free      confirmed, draft team or waitlisted — the usual confirmation,
 *             and the teammate invitations.
 *   unpaid    `pending_payment` — only a prompt to pay; no ticket email and no
 *             teammate invitations yet.
 *   paid      called again once payment is verified — the confirmation (when
 *             the team is complete) and the teammate invitations that were
 *             held back.
 *
 * Runs after the transaction: none of it can undo a correctly granted seat.
 */
export const announceRegistration = async (registrationId: string): Promise<void> => {
  const db = adminDb();
  const regSnap = await db.collection(COLLECTIONS.registrations).doc(registrationId).get();
  if (!regSnap.exists) return;
  const registration = regSnap.data()!;
  const [eventSnap, festSnap] = await Promise.all([
    db.collection(COLLECTIONS.events).doc(String(registration.eventId)).get(),
    db.collection(COLLECTIONS.fests).doc(String(registration.festId)).get(),
  ]);
  const event = eventSnap.data() ?? {};
  const festName = String(festSnap.data()?.name ?? "");
  const status = String(registration.status);
  const leaderName = String(registration.userName ?? "");
  const leaderEmail = String(registration.userEmail ?? "");
  const teamName = registration.teamName ? String(registration.teamName) : undefined;
  const meta = { userId: String(registration.userId), festId: String(registration.festId), eventId: String(registration.eventId), subjectType: "registration", subjectId: registrationId };

  if (status === "pending_payment") {
    await notify({
      userId: String(registration.userId),
      type: "payment_required",
      title: "Complete your payment to confirm your seat",
      body: `${event.title ?? registration.eventTitle} · ${festName}`,
      link: `/registered/${registrationId}`,
      festId: String(registration.festId),
      eventId: String(registration.eventId),
    });
    return;
  }

  await notify({
    userId: String(registration.userId),
    type: "registration_confirmed",
    title: status === "waitlisted" ? "You're on the waitlist" : status === "draft" ? "Your team is not complete yet" : "You're in",
    body: `${event.title ?? registration.eventTitle} · ${festName}`,
    link: `/registered/${registrationId}`,
    festId: String(registration.festId),
    eventId: String(registration.eventId),
  });

  if (status === "confirmed") {
    await emailService().send(
      registrationConfirmedEmail({
        to: leaderEmail,
        recipientName: leaderName,
        eventTitle: String(event.title ?? registration.eventTitle),
        festName,
        date: String(event.date ?? ""),
        startTime: String(event.startTime ?? ""),
        venue: String(event.venue ?? ""),
        ticketCode: String(registration.ticketCode),
        registrationId,
        ...(teamName ? { teamName } : {}),
        meta,
      }),
    );
  }

  // Invitations to teammates: an in-app notification where an account exists, and an email either way.
  const teammates = ((registration.members ?? []) as Array<{ name: string; email: string; userId?: string; isLeader?: boolean }>).filter((m) => !m.isLeader);
  if (teammates.length && teamName) {
    await notifyMany(
      teammates
        .filter((m) => m.userId)
        .map((m) => ({
          userId: m.userId!,
          type: "team_invite" as const,
          title: `${leaderName} added you to ${teamName}`,
          body: `${event.title ?? registration.eventTitle} · ${festName}`,
          link: "/teams",
          festId: String(registration.festId),
          eventId: String(registration.eventId),
        })),
    );
    await emailService().sendMany(
      teammates.map((m) =>
        teamInviteEmail({
          to: m.email,
          recipientName: m.name,
          leaderName,
          teamName,
          eventTitle: String(event.title ?? registration.eventTitle),
          festName,
          date: String(event.date ?? ""),
          meta: { ...meta, userId: m.userId ?? undefined },
        }),
      ),
    );
  }
};
