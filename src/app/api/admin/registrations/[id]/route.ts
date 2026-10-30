import { z } from "zod";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { audit } from "@/server/audit";
import { eventRequiresPayment } from "@/core/models/payment";
import { assertOrderingAllowed, type StoredAccount } from "@/server/payments/account";
import { announcePromoted, planCancellation, writeCancellation, writeHold } from "@/server/payments/lifecycle";
import { notify } from "@/server/notify";

const actionSchema = z.object({
  action: z.enum(["promote", "cancel"]),
  reason: z.string().trim().max(500).optional(),
});

/**
 * POST /api/admin/registrations/[id] — staff actions on one entry.
 *
 *  promote  waitlisted → confirmed, if the seats fit; bumps the counters
 *  cancel   confirmed/waitlisted → cancelled, releases seats, promotes the
 *           next waitlisted entry that fits
 *
 * Both run as transactions against the event so a promotion can never
 * overbook, and both are audited under the acting admin's name.
 */
export const POST = handler(async (request, context) => {
  const caller = await requirePermission(request, "registration:manage");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing registration id.");

  const { action, reason } = await readBody(request, actionSchema);
  const db = adminDb();
  const regRef = db.collection(COLLECTIONS.registrations).doc(id);

  const first = await regRef.get();
  if (!first.exists) throw ApiError.notFound("That registration no longer exists.");
  requireFestAccess(caller, String(first.data()!.festId), String(first.data()!.eventId));

  const outcome = await db.runTransaction(async (tx) => {
    const regSnap = await tx.get(regRef);
    const reg = regSnap.data()!;
    const eventRef = db.collection(COLLECTIONS.events).doc(String(reg.eventId));
    const eventSnap = await tx.get(eventRef);
    const event = eventSnap.data() ?? {};
    const capacity = Number(event.capacity ?? 0);
    const registered = Number(event.registeredCount ?? 0);
    const seats = Number(reg.seats ?? (Array.isArray(reg.members) ? reg.members.length : 1));
    const festRef = db.collection(COLLECTIONS.fests).doc(String(reg.festId));

    if (action === "promote") {
      if (reg.status !== "waitlisted") throw ApiError.unprocessable("Only a waitlisted entry can be promoted.");
      if (capacity > 0 && registered + seats > capacity) {
        throw ApiError.unprocessable(
          `Only ${Math.max(0, capacity - registered)} seat(s) free and this entry needs ${seats}. Raise capacity first.`,
        );
      }
      // On a paid event a promotion offers a seat to pay for; it never grants a free ticket.
      let hold: ReturnType<typeof writeHold> | null = null;
      if (eventRequiresPayment(event)) {
        const accountSnap = await tx.get(db.collection(COLLECTIONS.paymentAccounts).doc(String(reg.festId)));
        const account = assertOrderingAllowed(accountSnap.exists ? (accountSnap.data() as StoredAccount) : null);
        hold = writeHold(tx, db, { registrationId: id, eventId: String(reg.eventId), festId: String(reg.festId), userId: String(reg.userId), event, account });
      }
      tx.update(regRef, { ...(hold ?? { status: "confirmed" }), updatedAt: FieldValue.serverTimestamp() });
      tx.update(eventRef, { registeredCount: FieldValue.increment(seats), updatedAt: FieldValue.serverTimestamp() });
      tx.update(festRef, { "stats.registrations": FieldValue.increment(seats) });
      return { kind: "promoted" as const, reg, seats, needsPayment: hold !== null };
    }

    // cancel
    if (reg.status === "cancelled") return { kind: "noop" as const, reg, seats };
    const plan = await planCancellation(tx, db, regSnap, eventSnap);
    const written = writeCancellation(tx, plan, "staff");
    return { kind: "cancelled" as const, reg, seats, promoted: written.promoted, refundOwed: written.refundOwed };
  });

  if (outcome.kind === "promoted") {
    await audit(caller, {
      action: "waitlist_promoted",
      summary: `Promoted ${outcome.reg.teamName ?? outcome.reg.userName} from waitlist · ${outcome.reg.ticketCode}`,
      festId: String(outcome.reg.festId),
      eventId: String(outcome.reg.eventId),
      subjectType: "registration",
      subjectId: id,
    });
    await announcePromoted({ id, userId: String(outcome.reg.userId), needsPayment: outcome.needsPayment });
  }

  if (outcome.kind === "cancelled") {
    await audit(caller, {
      action: "registration_cancelled_by_staff",
      summary: `Cancelled ${outcome.reg.teamName ?? outcome.reg.userName} · ${outcome.reg.ticketCode}${reason ? ` — ${reason}` : ""}`,
      festId: String(outcome.reg.festId),
      eventId: String(outcome.reg.eventId),
      subjectType: "registration",
      subjectId: id,
      details: { reason },
    });
    // The entry that moved up because of this cancellation is told too.
    await announcePromoted(outcome.promoted);
    await notify({
      userId: String(outcome.reg.userId),
      type: "registration_cancelled",
      title: "Your registration was cancelled by the organizers",
      body: `${outcome.reg.eventTitle}${reason ? ` — ${reason}` : ""}`,
      link: "/my-events",
      festId: String(outcome.reg.festId),
      eventId: String(outcome.reg.eventId),
    });
  }

  return ok({ result: outcome.kind });
});
