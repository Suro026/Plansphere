import { COLLECTIONS, adminDb } from "./firebase-admin";
import { emailService } from "./email";
import { waitlistPromotedEmail } from "./email/templates";
import { notify } from "./notify";

/**
 * Tells the holder of a just-promoted entry that they are in — in-app and by
 * email. Shared by the two places promotion happens: a student withdrawing
 * (which promotes the next fit automatically) and staff promoting by hand.
 */
export const announcePromotion = async (registrationId: string): Promise<void> => {
  const db = adminDb();
  const snap = await db.collection(COLLECTIONS.registrations).doc(registrationId).get();
  if (!snap.exists) return;
  const reg = snap.data()!;
  const [event, fest] = await Promise.all([
    db.collection(COLLECTIONS.events).doc(String(reg.eventId)).get(),
    db.collection(COLLECTIONS.fests).doc(String(reg.festId)).get(),
  ]);
  const eventTitle = String(reg.eventTitle ?? event.data()?.title ?? "");
  const festName = String(fest.data()?.name ?? "");

  await notify({
    userId: String(reg.userId),
    type: "waitlist_promoted",
    title: "A seat opened up — you're in",
    body: `${eventTitle} · ${festName}`,
    link: `/registered/${registrationId}`,
    festId: String(reg.festId),
    eventId: String(reg.eventId),
  });

  await emailService().send(
    waitlistPromotedEmail({
      to: String(reg.userEmail),
      recipientName: String(reg.userName ?? ""),
      eventTitle,
      festName,
      date: String(event.data()?.date ?? ""),
      startTime: String(event.data()?.startTime ?? ""),
      venue: String(event.data()?.venue ?? ""),
      ticketCode: String(reg.ticketCode ?? ""),
      registrationId,
      ...(reg.teamName ? { teamName: String(reg.teamName) } : {}),
      meta: { userId: String(reg.userId), festId: String(reg.festId), eventId: String(reg.eventId), subjectType: "registration", subjectId: registrationId },
    }),
  );
};
