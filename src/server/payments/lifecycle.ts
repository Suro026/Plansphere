import { entryAmountPaise, eventRequiresPayment, formatRupees } from "@/core/models/payment";
import { occupiesSeat, teamIsComplete } from "@/core/models/registration";
import { COLLECTIONS, FieldValue, Timestamp, adminDb } from "@/server/firebase-admin";
import { emailService } from "@/server/email";
import { paymentDueEmail } from "@/server/email/templates";
import { notify } from "@/server/notify";
import { announcePromotion } from "@/server/waitlist";
import { announceRegistration } from "@/server/registrations/announce";
import { holdMinutes, PROVIDER_UNREACHABLE_GRACE_MS, RECONCILE_AFTER_MS } from "./config";
import { accountBinding, bindingProblem, orderingBlocker, loadAccount, providerContextFor, type BindingProblem, type StoredAccount } from "./account";
import type { OrderSnapshot, RefundResult } from "./providers/types";

/**
 * The registration/payment state machine — provider independent.
 *
 * Nothing in this file knows which gateway is in use; it reads the adapter
 * through `providerContextFor`. The rules it enforces:
 *
 *  - A paid entry is `pending_payment` and holds its seat (counters include it)
 *    until a payment is **verified server-side**: the provider order is re-read
 *    here, and its amount, currency and association to the registration must
 *    match before the entry becomes `confirmed`/`draft`.
 *  - Every transition is a Firestore transaction that re-reads the documents it
 *    depends on, so a duplicate webhook, a late webhook, a double click and an
 *    expiring hold can race without changing the outcome.
 *  - Money that cannot be reconciled automatically never confirms a ticket: it
 *    becomes `needs_review` or an explicit refund, never a silent success.
 *  - A waitlisted entry is never charged; promotion on a paid event starts a
 *    hold, it does not grant a ticket.
 */

type Db = FirebaseFirestore.Firestore;
type Tx = FirebaseFirestore.Transaction;
type Snap = FirebaseFirestore.DocumentSnapshot;
type QSnap = FirebaseFirestore.QueryDocumentSnapshot;
type Data = FirebaseFirestore.DocumentData;

const log = (event: string, fields: Record<string, unknown>) => console.info("[payments]", JSON.stringify({ event, ...fields }));

export const paymentRef = (db: Db, registrationId: string) => db.collection(COLLECTIONS.payments).doc(registrationId);

export interface RefundRecord {
  id: string;
  orderId: string;
  amountPaise: number;
  reason: string;
  /** System-caused refunds (event cancelled, duplicate or late payment) are issued automatically; others wait for staff. */
  autoRefund: boolean;
  status: "requested" | "pending" | "success" | "failed";
  /** Provider-side attempt number. A refund the provider has definitively failed is retried under a new provider refund id. */
  attempt?: number;
  requestedAt: Timestamp;
  providerRefundId?: string;
  message?: string;
}

const refundsOf = (payment: Data | undefined): RefundRecord[] => (Array.isArray(payment?.refunds) ? (payment!.refunds as RefundRecord[]) : []);
const refundedPaise = (refunds: RefundRecord[], orderId?: string): number =>
  refunds.filter((r) => r.status === "success" && (orderId === undefined || r.orderId === orderId)).reduce((n, r) => n + r.amountPaise, 0);

/** The order whose payment the registration relies on (not a duplicate payment that is being returned). */
const primaryOrderOf = (pay: Data): string => String(pay.paidOrderId ?? pay.capturedOrderId ?? pay.orderId);

/*
 * When an owed refund is tried again. A refund the provider cannot take now is
 * retried on a growing delay (2 min, 4, 8 … capped at 6 h) so that one payment
 * that keeps failing can never use up the retry job's attention, and a refund
 * that has failed this many times in a row is flagged `refund_stuck` for staff.
 */
const REFUND_BACKOFF_BASE_MS = 2 * 60_000;
const REFUND_BACKOFF_MAX_MS = 6 * 60 * 60_000;
const REFUND_PENDING_RECHECK_MS = 15 * 60_000;
export const REFUND_STUCK_AFTER_FAILURES = 10;
/** A refund still "pending" at the provider after this many 15-minute re-checks (a day) is handed to a person. */
export const REFUND_STUCK_AFTER_POLLS = 96;

export const refundBackoffMs = (failures: number): number => Math.min(REFUND_BACKOFF_MAX_MS, REFUND_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));

/** Fields that say "a refund is owed". Only automatic refunds are also scheduled; one waiting for staff is not. */
const owed = (autoRefund: boolean) => ({ openRefunds: true, ...(autoRefund ? { nextRefundAt: FieldValue.serverTimestamp() } : {}) });

const hasOpenRefund = (refunds: RefundRecord[]): boolean => refunds.some((r) => r.status === "requested" || r.status === "failed" || r.status === "pending");

/* ───────────── holds ───────────── */

/**
 * Starts a seat hold for a paid entry. Writes only — the caller has already
 * read what it needs. Returns the fields to merge into the registration.
 */
export const writeHold = (
  tx: Tx,
  db: Db,
  args: { registrationId: string; eventId: string; festId: string; userId: string; event: Data; account: StoredAccount },
) => {
  const amountPaise = entryAmountPaise(pricing(args.event));
  const holdExpiresAt = Timestamp.fromMillis(Date.now() + holdMinutes() * 60_000);
  tx.set(paymentRef(db, args.registrationId), {
    id: args.registrationId,
    registrationId: args.registrationId,
    eventId: args.eventId,
    festId: args.festId,
    userId: args.userId,
    // Bound to the merchant account it was created under; see `bindingProblem`.
    ...accountBinding(args.account),
    orderId: args.registrationId,
    orderIds: [args.registrationId],
    attempt: 1,
    amountPaise,
    currency: "INR",
    status: "created",
    refunds: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { status: "pending_payment" as const, paymentStatus: "pending" as const, amountPaise, holdExpiresAt };
};

const pricing = (data: Data) => ({ entryFee: data.entryFee as number | undefined, paymentEnabled: data.paymentEnabled as boolean | undefined });

/* ───────────── cancellation (shared by student, staff, expiry, event cancellation) ───────────── */

export type CancelKind = "student" | "staff" | "expired" | "event_cancelled" | "abandoned";

export interface CancelPlan {
  db: Db;
  regRef: FirebaseFirestore.DocumentReference;
  reg: Data;
  event: Data;
  eventRef: FirebaseFirestore.DocumentReference;
  festRef: FirebaseFirestore.DocumentReference;
  seats: number;
  occupied: boolean;
  payment: Snap | null;
  promote: QSnap | null;
  promoteAccount: StoredAccount | null;
}

/** All the reads a cancellation needs, done before any write (Firestore transactions require that). */
export const planCancellation = async (tx: Tx, db: Db, regSnap: Snap, eventSnap: Snap, opts: { allowPromotion?: boolean } = {}): Promise<CancelPlan> => {
  const reg = regSnap.data()!;
  const event = eventSnap.data() ?? {};
  const seats = Number(reg.seats ?? (Array.isArray(reg.members) ? reg.members.length : 1));
  const occupied = occupiesSeat((reg.status ?? "confirmed") as never);
  const paymentStatus = String(reg.paymentStatus ?? "not_required");

  const payment = ["paid", "pending", "failed", "needs_review"].includes(paymentStatus) ? await tx.get(paymentRef(db, regSnap.id)) : null;

  let promote: QSnap | null = null;
  if (occupied && event.waitlistEnabled === true && opts.allowPromotion !== false) {
    // Equality-only query (no index needed); earliest-first in memory.
    const waiting = await tx.get(db.collection(COLLECTIONS.registrations).where("eventId", "==", reg.eventId).where("status", "==", "waitlisted"));
    const ordered = [...waiting.docs].sort((a, b) => (a.data().createdAt?.toMillis?.() ?? 0) - (b.data().createdAt?.toMillis?.() ?? 0));
    const capacity = Number(event.capacity ?? 0);
    const after = Number(event.registeredCount ?? 0) - seats;
    promote = ordered.find((d) => capacity === 0 || after + Number(d.data().seats ?? 1) <= capacity) ?? null;
  }

  // A paid event promotes into a payment hold, which needs a usable payment
  // account. If there isn't one, the entry stays on the waitlist rather than
  // being moved into a state that can never be paid.
  let promoteAccount: StoredAccount | null = null;
  if (promote && eventRequiresPayment(pricing(event))) {
    const accountSnap = await tx.get(db.collection(COLLECTIONS.paymentAccounts).doc(String(reg.festId)));
    const account = accountSnap.exists ? (accountSnap.data() as StoredAccount) : null;
    if (orderingBlocker(account)) promote = null;
    else promoteAccount = account;
  }

  return { db, regRef: regSnap.ref, reg, event, eventRef: eventSnap.ref, festRef: db.collection(COLLECTIONS.fests).doc(String(reg.festId)), seats, occupied, payment, promote, promoteAccount };
};

export interface Promoted {
  id: string;
  userId: string;
  needsPayment: boolean;
}

/** The writes of a cancellation. Returns the promoted entry (if any) so the caller can announce it after commit. */
export const writeCancellation = (tx: Tx, plan: CancelPlan, kind: CancelKind): { promoted: Promoted | null; refundOwed: boolean } => {
  const { db, regRef, reg, event, eventRef, festRef, seats, occupied, payment, promote, promoteAccount } = plan;
  const now = FieldValue.serverTimestamp();
  const update: Record<string, unknown> = { status: "cancelled", cancelledAt: now, updatedAt: now };
  const paymentStatus = String(reg.paymentStatus ?? "not_required");
  let refundOwed = false;

  if (paymentStatus === "paid" && payment?.exists) {
    const data = payment.data()!;
    const refunds = refundsOf(data);
    const record: RefundRecord = {
      id: `${regRef.id}_r${refunds.length + 1}`,
      orderId: String(data.paidOrderId ?? data.orderId),
      amountPaise: Number(data.amountPaise) - refundedPaise(refunds, primaryOrderOf(data)),
      reason: kind,
      autoRefund: kind === "event_cancelled",
      status: "requested",
      requestedAt: Timestamp.now(),
    };
    tx.update(payment.ref, { status: "refund_pending", ...owed(record.autoRefund), refunds: FieldValue.arrayUnion(record), updatedAt: now });
    update.paymentStatus = "refund_pending";
    refundOwed = true;
  } else if (paymentStatus === "pending" || paymentStatus === "failed") {
    const next = kind === "expired" ? "expired" : "cancelled";
    update.paymentStatus = next;
    update.holdExpiresAt = FieldValue.delete();
    if (payment?.exists) tx.update(payment.ref, { status: next, updatedAt: now });
  }
  // `needs_review` is left exactly as it is: staff settle it, cancelling does not hide it.

  tx.update(regRef, update);

  let promoted: Promoted | null = null;
  if (occupied) {
    let delta = -seats;
    if (promote) {
      const data = promote.data();
      const promotedSeats = Number(data.seats ?? 1);
      if (promoteAccount) {
        // Paid event: the promoted entry is given a hold to pay, not a ticket.
        const hold = writeHold(tx, db, { registrationId: promote.id, eventId: String(reg.eventId), festId: String(reg.festId), userId: String(data.userId), event, account: promoteAccount });
        tx.update(promote.ref, { ...hold, promotedAt: now, updatedAt: now });
        promoted = { id: promote.id, userId: String(data.userId), needsPayment: true };
      } else {
        // A promoted team still short of its minimum becomes a draft, not a confirmed entry.
        const members = (data.members ?? []) as { isLeader?: boolean; inviteStatus?: string }[];
        const status = data.type === "team" && !teamIsComplete(members, (event.teamSize ?? { min: 1, max: 1 }) as { min: number }) ? "draft" : "confirmed";
        tx.update(promote.ref, { status, promotedAt: now, updatedAt: now });
        promoted = { id: promote.id, userId: String(data.userId), needsPayment: false };
      }
      delta += promotedSeats;
    }
    tx.update(eventRef, { registeredCount: FieldValue.increment(delta), updatedAt: now });
    tx.update(festRef, { "stats.registrations": FieldValue.increment(delta) });
  }

  return { promoted, refundOwed };
};

/** In-app (and, for a paid promotion, email) notice for an entry that moved up the waitlist. */
export const announcePromoted = async (promoted: Promoted | null): Promise<void> => {
  if (!promoted) return;
  if (!promoted.needsPayment) {
    await announcePromotion(promoted.id);
    return;
  }
  await announceRegistration(promoted.id);
  // The person was waiting for a seat: tell them by email too, with the clock they are on.
  const db = adminDb();
  const regSnap = await db.collection(COLLECTIONS.registrations).doc(promoted.id).get();
  if (!regSnap.exists) return;
  const reg = regSnap.data()!;
  const festSnap = await db.collection(COLLECTIONS.fests).doc(String(reg.festId)).get();
  await emailService().send(
    paymentDueEmail({
      to: String(reg.userEmail),
      recipientName: String(reg.userName ?? ""),
      eventTitle: String(reg.eventTitle ?? ""),
      festName: String(festSnap.data()?.name ?? ""),
      amountLabel: formatRupees(Number(reg.amountPaise ?? 0)),
      holdMinutes: holdMinutes(),
      ...(reg.teamName ? { teamName: String(reg.teamName) } : {}),
      registrationId: promoted.id,
      meta: { userId: String(reg.userId), festId: String(reg.festId), eventId: String(reg.eventId), subjectType: "registration", subjectId: promoted.id },
    }),
  );
};

/* ───────────── verified payment → registration ───────────── */

export type PaymentOutcome =
  | { kind: "confirmed"; status: "confirmed" | "draft" }
  | { kind: "reinstated"; status: "confirmed" | "draft" }
  | { kind: "refund_started"; refundId: string; reason: string }
  | { kind: "failed" }
  | { kind: "needs_review" }
  /** A settled payment's provider record changed or a second payment appeared; logged and flagged, nothing else touched. */
  | { kind: "flagged"; reason: string }
  | { kind: "noop"; reason: string };

const eventAcceptsLatePayment = (event: Data, seats: number): boolean => {
  if (event.status !== "published" || event.registrationOpen === false) return false;
  const capacity = Number(event.capacity ?? 0);
  return capacity === 0 || Number(event.registeredCount ?? 0) + seats <= capacity;
};

/**
 * Applies a provider order's *verified* state to a registration.
 *
 * `snapshot` must come from the adapter's `fetchOrder` (the lifecycle's own
 * server-to-server read), never from a webhook body. Safe to call any number of
 * times, in any order, from the webhook, the reconciliation job and the hold
 * expiry: it only moves an entry forward from the state it actually finds.
 */
export const applyOrderSnapshot = async (registrationId: string, snapshot: OrderSnapshot): Promise<PaymentOutcome> => {
  const db = adminDb();
  const regRef = db.collection(COLLECTIONS.registrations).doc(registrationId);

  const outcome = await db.runTransaction(async (tx): Promise<PaymentOutcome> => {
    const [regSnap, paySnap] = await Promise.all([tx.get(regRef), tx.get(paymentRef(db, registrationId))]);
    if (!regSnap.exists || !paySnap.exists) return { kind: "noop", reason: "unknown registration or payment" };
    const reg = regSnap.data()!;
    const pay = paySnap.data()!;
    const eventSnap = await tx.get(db.collection(COLLECTIONS.events).doc(String(reg.eventId)));
    const event = eventSnap.data() ?? {};
    const now = FieldValue.serverTimestamp();

    const orderIds = (pay.orderIds ?? [pay.orderId]) as string[];
    if (!orderIds.includes(snapshot.orderId)) return { kind: "noop", reason: "order does not belong to this registration" };

    const settled = ["paid", "refund_pending", "partially_refunded", "refunded"].includes(String(pay.status));

    if (snapshot.status === "pending") {
      if (pay.status === "created") tx.update(paySnap.ref, { status: "pending", updatedAt: now });
      return { kind: "noop", reason: "still pending" };
    }

    if (snapshot.status === "failed" || snapshot.status === "expired") {
      if (settled || pay.status === "needs_review") return { kind: "noop", reason: "already settled" };
      tx.update(paySnap.ref, { status: "failed", failureReason: snapshot.failureReason ?? snapshot.status, updatedAt: now });
      if (reg.status === "pending_payment") tx.update(regRef, { paymentStatus: "failed", updatedAt: now });
      return { kind: "failed" };
    }

    // snapshot.status === "paid". Order matters here: what is already settled is
    // decided first, so that nothing a later snapshot says can disturb a payment
    // the registration relies on; only then is a *new* payment checked and applied.
    const amountOk = snapshot.amountPaise === Number(pay.amountPaise) && snapshot.currency === "INR";

    if (settled) {
      const primary = primaryOrderOf(pay);
      const anomaly = (type: string) => ({ type, orderId: snapshot.orderId, amountPaise: snapshot.amountPaise, currency: snapshot.currency, at: Timestamp.now() });

      if (snapshot.orderId === primary) {
        // The order we already settled, read again. Identical = a replay. Different = the provider's
        // record has moved under us (amount, currency, a second payment id): log it and flag it for
        // staff, but leave the payment, the registration and the ticket exactly as they are.
        const secondPayment = Boolean(snapshot.providerPaymentId && pay.providerPaymentId && snapshot.providerPaymentId !== pay.providerPaymentId);
        if (!amountOk || secondPayment) {
          const type = secondPayment ? "second_payment_on_settled_order" : "settled_order_changed";
          tx.update(paySnap.ref, { flags: FieldValue.arrayUnion(type), anomalies: FieldValue.arrayUnion(anomaly(type)), updatedAt: now });
          return { kind: "flagged", reason: type };
        }
        return { kind: "noop", reason: "duplicate notification" };
      }

      // A different order for a registration that is already paid: the customer paid twice. That
      // order is returned in full, for exactly what it captured, whatever its amount. Never the original.
      const refunds = refundsOf(pay);
      if (refunds.some((r) => r.orderId === snapshot.orderId)) return { kind: "noop", reason: "duplicate payment already being refunded" };
      const flags = ["duplicate_payment", ...(amountOk ? [] : ["duplicate_payment_amount_mismatch"])];
      if (!(snapshot.amountPaise > 0)) {
        tx.update(paySnap.ref, { flags: FieldValue.arrayUnion(...flags, "duplicate_payment_unrefundable"), anomalies: FieldValue.arrayUnion(anomaly("duplicate_payment_unrefundable")), updatedAt: now });
        return { kind: "flagged", reason: "duplicate payment with no refundable amount" };
      }
      const record: RefundRecord = {
        id: `${registrationId}_dup${refunds.length + 1}`,
        orderId: snapshot.orderId,
        amountPaise: snapshot.amountPaise,
        reason: "duplicate_payment",
        autoRefund: true,
        status: "requested",
        requestedAt: Timestamp.now(),
      };
      tx.update(paySnap.ref, { flags: FieldValue.arrayUnion(...flags), ...owed(true), refunds: FieldValue.arrayUnion(record), updatedAt: now });
      return { kind: "refund_started", refundId: record.id, reason: "duplicate_payment" };
    }

    if (pay.status === "needs_review") {
      // Already held for a person to look at (a mismatch, or the merchant account changed). A further
      // paid snapshot does not release it; staff decide.
      return { kind: "noop", reason: "already under review" };
    }

    if (!amountOk) {
      tx.update(paySnap.ref, {
        status: "needs_review",
        flags: FieldValue.arrayUnion("amount_or_currency_mismatch"),
        capturedAmountPaise: snapshot.amountPaise,
        capturedCurrency: snapshot.currency,
        capturedOrderId: snapshot.orderId,
        ...(snapshot.providerPaymentId ? { providerPaymentId: snapshot.providerPaymentId } : {}),
        updatedAt: now,
      });
      tx.update(regRef, { paymentStatus: "needs_review", updatedAt: now });
      return { kind: "needs_review" };
    }

    const paidFields = {
      status: "paid",
      paidAt: now,
      paidOrderId: snapshot.orderId,
      ...(snapshot.providerOrderId ? { providerOrderId: snapshot.providerOrderId } : {}),
      ...(snapshot.providerPaymentId ? { providerPaymentId: snapshot.providerPaymentId } : {}),
      updatedAt: now,
    };
    const teamSize = (event.teamSize ?? { min: 1, max: 1 }) as { min: number };
    const members = (reg.members ?? []) as { isLeader?: boolean; inviteStatus?: string }[];
    const finalStatus: "confirmed" | "draft" = event.eventType === "team" && !teamIsComplete(members, teamSize) ? "draft" : "confirmed";

    if (reg.status === "pending_payment" || reg.status === "confirmed" || reg.status === "draft") {
      tx.update(paySnap.ref, paidFields);
      if (reg.status === "pending_payment") {
        tx.update(regRef, { status: finalStatus, paymentStatus: "paid", holdExpiresAt: FieldValue.delete(), updatedAt: now });
        return { kind: "confirmed", status: finalStatus };
      }
      tx.update(regRef, { paymentStatus: "paid", holdExpiresAt: FieldValue.delete(), updatedAt: now });
      return { kind: "noop", reason: "entry was already confirmed" };
    }

    // The entry is no longer holding a seat: cancelled (hold lapsed, or the entry was withdrawn) or waitlisted.
    const seats = Number(reg.seats ?? 1);
    const lapsed = reg.status === "cancelled" && reg.paymentStatus === "expired";
    let canReinstate = false;
    if (lapsed && eventAcceptsLatePayment(event, seats)) {
      // Only if the person hasn't meanwhile taken another entry for this event.
      const others = await tx.get(
        db.collection(COLLECTIONS.registrations).where("eventId", "==", reg.eventId).where("userId", "==", reg.userId).where("status", "in", ["confirmed", "pending_payment", "waitlisted", "draft"]).limit(1),
      );
      canReinstate = others.empty;
    }

    if (canReinstate) {
      tx.update(paySnap.ref, paidFields);
      tx.update(regRef, { status: finalStatus, paymentStatus: "paid", cancelledAt: FieldValue.delete(), holdExpiresAt: FieldValue.delete(), updatedAt: now });
      tx.update(eventSnap.ref, { registeredCount: FieldValue.increment(seats), updatedAt: now });
      tx.update(db.collection(COLLECTIONS.fests).doc(String(reg.festId)), { "stats.registrations": FieldValue.increment(seats) });
      return { kind: "reinstated", status: finalStatus };
    }

    // No seat to give back (or the entry was deliberately withdrawn): the money is returned, automatically.
    const reason = lapsed ? "late_payment_no_seat" : reg.status === "waitlisted" ? "payment_while_waitlisted" : "paid_after_cancellation";
    const refunds = refundsOf(pay);
    const record: RefundRecord = {
      id: `${registrationId}_r${refunds.length + 1}`,
      orderId: snapshot.orderId,
      amountPaise: snapshot.amountPaise,
      reason,
      autoRefund: true,
      status: "requested",
      requestedAt: Timestamp.now(),
    };
    tx.update(paySnap.ref, { ...paidFields, status: "refund_pending", ...owed(true), flags: FieldValue.arrayUnion(reason), refunds: FieldValue.arrayUnion(record) });
    tx.update(regRef, { paymentStatus: "refund_pending", updatedAt: now });
    return { kind: "refund_started", refundId: record.id, reason };
  });

  log("order_applied", { registrationId, orderId: snapshot.orderId, provider: "see payment", outcome: outcome.kind });

  if (outcome.kind === "confirmed" || outcome.kind === "reinstated") await announceRegistration(registrationId);
  if (outcome.kind === "refund_started") await executeRefund(registrationId, outcome.refundId).catch((error) => log("refund_error", { registrationId, refundId: outcome.refundId, message: error instanceof Error ? error.message : "unknown" }));
  return outcome;
};

/* ───────────── refunds ───────────── */

/** Applies a refund's outcome (from the provider call or its webhook) to the payment and the registration. Idempotent. */
export const recordRefundOutcome = async (registrationId: string, refundId: string, outcome: { status: "success" | "pending" | "failed"; providerRefundId?: string; message?: string }): Promise<void> => {
  const db = adminDb();
  const notifyUser = await db.runTransaction(async (tx) => {
    const paySnap = await tx.get(paymentRef(db, registrationId));
    if (!paySnap.exists) return null;
    const pay = paySnap.data()!;
    const refunds = refundsOf(pay);
    const index = refunds.findIndex((r) => r.id === refundId);
    if (index < 0) return null;
    const current = refunds[index]!;
    // A finished refund never goes backwards; a failed one may be retried to success.
    if (current.status === "success") return null;
    const next = refunds.map((r, i) => (i === index ? { ...r, status: outcome.status === "pending" ? "pending" : outcome.status, ...(outcome.providerRefundId ? { providerRefundId: outcome.providerRefundId } : {}), ...(outcome.message ? { message: outcome.message.slice(0, 300) } : {}) } : r)) as RefundRecord[];
    const open = hasOpenRefund(next);
    const primary = primaryOrderOf(pay);
    if (current.orderId !== primary) {
      // A duplicate payment being returned: the registration's own payment is unaffected.
      tx.update(paySnap.ref, { refunds: next, openRefunds: open, ...(open ? {} : { nextRefundAt: FieldValue.delete() }), ...(outcome.status === "success" ? { refundFailures: 0, refundPolls: 0 } : {}), updatedAt: FieldValue.serverTimestamp() });
      return null;
    }
    const refunded = refundedPaise(next, primary);
    const captured = Number(pay.capturedAmountPaise ?? pay.amountPaise);
    const paymentStatus = refunded >= captured ? "refunded" : refunded > 0 ? "partially_refunded" : "refund_pending";
    tx.update(paySnap.ref, { refunds: next, openRefunds: open, status: paymentStatus, ...(open ? {} : { nextRefundAt: FieldValue.delete() }), ...(outcome.status === "success" ? { refundFailures: 0, refundPolls: 0 } : {}), updatedAt: FieldValue.serverTimestamp() });
    if (paymentStatus === "refunded") tx.update(db.collection(COLLECTIONS.registrations).doc(registrationId), { paymentStatus: "refunded", updatedAt: FieldValue.serverTimestamp() });
    return outcome.status === "success" && paymentStatus === "refunded" ? { userId: String(pay.userId), festId: String(pay.festId), eventId: String(pay.eventId) } : null;
  });

  if (notifyUser) {
    await notify({
      userId: notifyUser.userId,
      type: "refund_update",
      title: "Your refund has been issued",
      body: "The amount is on its way back to the payment method you used.",
      link: `/registered/${registrationId}`,
      festId: notifyUser.festId,
      eventId: notifyUser.eventId,
    });
  }
};

/** A refund the provider has definitively failed is asked for again under a fresh provider refund id, this many times at most. */
export const MAX_REFUND_ATTEMPTS = 5;

/** The id the provider knows this refund by: the record id, with an attempt suffix after the first attempt. */
export const providerRefundIdOf = (record: Pick<RefundRecord, "id" | "attempt">): string => (record.attempt && record.attempt > 1 ? `${record.id}_a${record.attempt}` : record.id);

/** Back from a provider refund id (webhooks) to our record id. Registration ids contain no underscores, so the suffix is unambiguous. */
export const refundRecordIdOf = (providerRefundId: string): string => providerRefundId.replace(/_a\d+$/, "");

export type RefundExecution = "success" | "pending" | "failed" | "skipped" | "blocked";

/**
 * A payment must only ever be touched with the merchant account it was created
 * under. When the fest's account has changed since, the payment is flagged for
 * a person and the caller gets no provider contact. An unpaid hold goes to
 * review; a settled payment keeps its registration state and only its refund
 * path is blocked. Idempotent.
 */
export const flagBindingProblem = async (registrationId: string, problem: BindingProblem): Promise<void> => {
  const db = adminDb();
  const flag = `account_changed:${problem}`;
  await db.runTransaction(async (tx) => {
    const [regSnap, paySnap] = await Promise.all([tx.get(db.collection(COLLECTIONS.registrations).doc(registrationId)), tx.get(paymentRef(db, registrationId))]);
    if (!paySnap.exists) return;
    const pay = paySnap.data()!;
    const now = FieldValue.serverTimestamp();
    const already = Array.isArray(pay.flags) && (pay.flags as string[]).includes(flag);
    const unsettled = ["created", "pending", "failed"].includes(String(pay.status));
    const holding = regSnap.exists && regSnap.data()!.status === "pending_payment";
    tx.update(paySnap.ref, {
      ...(unsettled && holding ? { status: "needs_review" } : {}),
      ...(already ? {} : { flags: FieldValue.arrayUnion(flag), anomalies: FieldValue.arrayUnion({ type: "account_changed", problem, at: Timestamp.now() }) }),
      updatedAt: now,
    });
    if (unsettled && holding) tx.update(regSnap.ref, { paymentStatus: "needs_review", updatedAt: now });
  });
  log("account_changed", { registrationId, problem });
};

/** Moves a refund to its next provider attempt, once (compare-and-set), and returns the attempt now in force. */
const nextRefundAttempt = async (registrationId: string, recordId: string, seen: number): Promise<number> => {
  const db = adminDb();
  return db.runTransaction(async (tx) => {
    const paySnap = await tx.get(paymentRef(db, registrationId));
    const refunds = refundsOf(paySnap.data());
    const record = refunds.find((r) => r.id === recordId);
    if (!record) return seen;
    const current = record.attempt ?? 1;
    if (current !== seen) return current; // someone else already moved on
    tx.update(paySnap.ref, { refunds: refunds.map((r) => (r.id === recordId ? { ...r, attempt: current + 1, status: "requested" as const } : r)), openRefunds: true, updatedAt: FieldValue.serverTimestamp() });
    return current + 1;
  });
};

/**
 * Asks the provider to perform one recorded refund — and, first, whether it
 * already has it. Every attempt begins with `fetchRefund`, so a duplicate
 * request (retry, double click, cron racing a webhook) resolves to the refund
 * that exists instead of creating a second one or reporting a false failure.
 * `blocked` means the fest's merchant account is no longer the one the payment
 * was made under: nothing is sent.
 */
export const executeRefund = async (registrationId: string, refundId: string): Promise<RefundExecution> => {
  const outcome = await attemptRefund(registrationId, refundId);
  // Whatever did not finish is tried again later, on a delay that grows with repeated failure.
  if (outcome === "failed" || outcome === "pending" || outcome === "blocked") await scheduleRefundRetry(registrationId, outcome).catch(() => undefined);
  return outcome;
};

/**
 * Pushes an unfinished payment's next refund attempt into the future — or, once
 * it has failed or stayed pending too long, stops: it is flagged `refund_stuck`
 * and taken off the schedule, so automatic retrying is bounded and a person
 * decides (staff "Approve refund" resets it and tries again).
 */
const scheduleRefundRetry = async (registrationId: string, outcome: "failed" | "pending" | "blocked"): Promise<void> => {
  const db = adminDb();
  await db.runTransaction(async (tx) => {
    const paySnap = await tx.get(paymentRef(db, registrationId));
    if (!paySnap.exists || paySnap.data()!.openRefunds !== true) return;
    const data = paySnap.data()!;
    const failures = Number(data.refundFailures ?? 0) + (outcome === "failed" ? 1 : 0);
    const polls = Number(data.refundPolls ?? 0) + (outcome === "pending" ? 1 : 0);
    const delay = outcome === "pending" ? REFUND_PENDING_RECHECK_MS : outcome === "blocked" ? REFUND_BACKOFF_MAX_MS : refundBackoffMs(failures);
    const stuck = failures >= REFUND_STUCK_AFTER_FAILURES || polls >= REFUND_STUCK_AFTER_POLLS;
    const alreadyFlagged = ((data.flags ?? []) as string[]).includes("refund_stuck");
    tx.update(paySnap.ref, {
      refundFailures: failures,
      refundPolls: polls,
      nextRefundAt: stuck ? FieldValue.delete() : Timestamp.fromMillis(Date.now() + delay),
      ...(stuck && !alreadyFlagged ? { flags: FieldValue.arrayUnion("refund_stuck") } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
};

const attemptRefund = async (registrationId: string, refundId: string): Promise<RefundExecution> => {
  const db = adminDb();
  const paySnap = await paymentRef(db, registrationId).get();
  if (!paySnap.exists) return "skipped";
  const pay = paySnap.data()!;
  const record = refundsOf(pay).find((r) => r.id === refundId);
  if (!record || record.status === "success") return "skipped";

  const account = await loadAccount(String(pay.festId));
  if (!account) return "skipped";
  const problem = bindingProblem(pay, account);
  if (problem) {
    await flagBindingProblem(registrationId, problem);
    return "blocked";
  }

  let result: RefundResult;
  try {
    const { adapter, ctx } = await providerContextFor(account);
    let attempt = record.attempt ?? 1;
    const idFor = () => providerRefundIdOf({ id: record.id, attempt });
    let lookup = await adapter.fetchRefund(ctx, { orderId: record.orderId, refundId: idFor() });
    if (lookup.status === "failed") {
      if (attempt >= MAX_REFUND_ATTEMPTS) {
        await recordRefundOutcome(registrationId, record.id, { status: "failed", ...(lookup.message ? { message: lookup.message } : {}) });
        return "failed";
      }
      attempt = await nextRefundAttempt(registrationId, record.id, attempt);
      lookup = await adapter.fetchRefund(ctx, { orderId: record.orderId, refundId: idFor() });
    }
    result = lookup.status === "not_found" ? await adapter.refund(ctx, { orderId: record.orderId, refundId: idFor(), amountPaise: record.amountPaise }) : lookup;
  } catch (error) {
    // Provider unreachable or misconfigured: the refund stays owed and is retried. The message is already scrubbed of credentials.
    log("refund_unreachable", { registrationId, refundId, message: error instanceof Error ? error.message : "unknown" });
    return "failed";
  }
  if (result.amountPaise !== undefined && result.amountPaise !== record.amountPaise) {
    await db.collection(COLLECTIONS.payments).doc(registrationId).update({
      flags: FieldValue.arrayUnion("refund_amount_mismatch"),
      anomalies: FieldValue.arrayUnion({ type: "refund_amount_mismatch", refundId, amountPaise: result.amountPaise, at: Timestamp.now() }),
    });
  }
  await recordRefundOutcome(registrationId, record.id, result);
  return result.status;
};

/**
 * Retries the automatic refunds that are due.
 *
 * Due = `nextRefundAt` has passed. A payment that fails is pushed back on a
 * growing delay by `executeRefund`, so the oldest-due ones are always taken
 * first and a few permanently failing payments cannot starve the rest. Each
 * payment is handled on its own: nothing one of them throws stops the run, and
 * the run stops cleanly when its time budget is spent. Refunds that wait for
 * staff approval are never touched here.
 */
export const retryAutoRefunds = async (options: { limit?: number; budgetMs?: number; now?: number } = {}): Promise<number> => {
  const { limit = 50, budgetMs = 120_000, now = Date.now() } = options;
  const deadline = Date.now() + budgetMs;
  const db = adminDb();
  const due = await db.collection(COLLECTIONS.payments).where("nextRefundAt", "<=", Timestamp.fromMillis(now)).orderBy("nextRefundAt").limit(limit).get();
  let done = 0;
  for (const doc of due.docs) {
    if (Date.now() > deadline) break;
    const eligible = refundsOf(doc.data()).filter((r) => r.autoRefund && (r.status === "requested" || r.status === "failed" || r.status === "pending"));
    if (eligible.length === 0) {
      // Nothing automatic is owed here (it was approved by staff, or finished): take it off the schedule.
      await doc.ref.update({ nextRefundAt: FieldValue.delete() }).catch(() => undefined);
      continue;
    }
    for (const record of eligible) {
      if (Date.now() > deadline) break;
      const outcome = await executeRefund(doc.id, record.id).catch((error) => {
        log("refund_error", { registrationId: doc.id, refundId: record.id, message: error instanceof Error ? error.message : "unknown" });
        return "failed" as const;
      });
      if (outcome === "success") done += 1;
      // Nothing was attempted (the payment, record or account is gone): still push it out, or it would stay at the
      // front of the queue and block everything behind it.
      if (outcome === "skipped") await scheduleRefundRetry(doc.id, "failed").catch(() => undefined);
    }
  }
  return done;
};

/* ───────────── expiry and reconciliation ───────────── */

const millis = (value: unknown): number => (value && typeof (value as Timestamp).toMillis === "function" ? (value as Timestamp).toMillis() : 0);

/** Releases one unpaid hold, unless the payment turned out to be made. Returns whether it was released. */
const expireOne = async (registrationId: string): Promise<boolean> => {
  const db = adminDb();
  const regRef = db.collection(COLLECTIONS.registrations).doc(registrationId);
  const promoted = await db.runTransaction(async (tx) => {
    const regSnap = await tx.get(regRef);
    if (!regSnap.exists) return undefined;
    const reg = regSnap.data()!;
    if (reg.status !== "pending_payment" || millis(reg.holdExpiresAt) > Date.now()) return undefined;
    const paySnap = await tx.get(paymentRef(db, registrationId));
    // Money is (or may be) involved: not for the expiry job to discard.
    if (paySnap.exists && ["paid", "needs_review"].includes(String(paySnap.data()!.status))) return undefined;
    const eventSnap = await tx.get(db.collection(COLLECTIONS.events).doc(String(reg.eventId)));
    const plan = await planCancellation(tx, db, regSnap, eventSnap);
    return writeCancellation(tx, plan, "expired").promoted;
  });
  if (promoted === undefined) return false;
  await announcePromoted(promoted);
  log("hold_expired", { registrationId });
  return true;
};

/**
 * Releases unpaid holds whose time is up — but first asks the provider whether
 * the payment actually went through (a webhook can be delayed or lost). If the
 * provider can't be reached the hold is kept, unless it is long overdue.
 */
export const expirePendingHolds = async (
  scope: { eventId?: string; limit?: number; budgetMs?: number } = {},
): Promise<{ expired: number; confirmed: number; skipped: number; errors: number }> => {
  const deadline = Date.now() + (scope.budgetMs ?? 120_000);
  const db = adminDb();
  let query: FirebaseFirestore.Query = db.collection(COLLECTIONS.registrations).where("status", "==", "pending_payment");
  if (scope.eventId) query = query.where("eventId", "==", scope.eventId);
  const pending = await query.limit(scope.limit ?? 500).get();
  const result = { expired: 0, confirmed: 0, skipped: 0, errors: 0 };

  // Longest-overdue first, so a backlog is worked off in order and the same few never go first forever.
  const ordered = [...pending.docs].sort((x, y) => millis(x.data().holdExpiresAt) - millis(y.data().holdExpiresAt));
  for (const doc of ordered) {
    if (Date.now() > deadline) break;
    const dueAt = millis(doc.data().holdExpiresAt);
    if (dueAt > Date.now()) continue;
    try {
      const outcome = await verifyWithProvider(doc.id).catch(() => "unreachable" as const);
      if (outcome === "confirmed") {
        result.confirmed += 1;
        continue;
      }
      if (outcome === "blocked") {
        // The merchant account changed under this payment. It is flagged for review and is never expired
        // automatically: money may be attached that this account cannot see.
        result.skipped += 1;
        continue;
      }
      if (outcome === "unreachable" && Date.now() - dueAt < PROVIDER_UNREACHABLE_GRACE_MS) {
        result.skipped += 1;
        continue;
      }
      if (await expireOne(doc.id)) result.expired += 1;
      else result.skipped += 1;
    } catch (error) {
      // One hold that cannot be processed never stops the others.
      result.errors += 1;
      log("expiry_error", { registrationId: doc.id, message: error instanceof Error ? error.message : "unknown" });
    }
  }
  return result;
};

/** Reads the order from the provider and applies it. "confirmed" if that made the entry paid. */
const verifyWithProvider = async (registrationId: string): Promise<"confirmed" | "not_paid" | "unreachable" | "blocked"> => {
  const db = adminDb();
  const paySnap = await paymentRef(db, registrationId).get();
  if (!paySnap.exists) return "not_paid";
  const pay = paySnap.data()!;
  const account = await loadAccount(String(pay.festId));
  if (!account) return "not_paid";
  const problem = bindingProblem(pay, account);
  if (problem) {
    await flagBindingProblem(registrationId, problem);
    return "blocked";
  }
  const { adapter, ctx } = await providerContextFor(account);
  const orderIds = (pay.orderIds ?? [pay.orderId]) as string[];
  let confirmed = false;
  for (const orderId of orderIds) {
    const snapshot = await adapter.fetchOrder(ctx, orderId);
    const outcome = await applyOrderSnapshot(registrationId, snapshot);
    if (outcome.kind === "confirmed" || outcome.kind === "reinstated" || outcome.kind === "needs_review") confirmed = true;
  }
  return confirmed ? "confirmed" : "not_paid";
};

/**
 * Re-checks payments that have been "pending" for a while — catches webhooks
 * that never arrived. Longest since last checked first; each check is
 * isolated; stops at its time budget.
 */
export const reconcilePendingPayments = async (options: { limit?: number; budgetMs?: number } = {}): Promise<number> => {
  const deadline = Date.now() + (options.budgetMs ?? 120_000);
  const db = adminDb();
  const pending = await db.collection(COLLECTIONS.payments).where("status", "in", ["created", "pending", "failed"]).limit(options.limit ?? 500).get();
  const checkedAt = (d: FirebaseFirestore.DocumentData) => millis(d.lastReconciledAt ?? d.updatedAt ?? d.createdAt);
  const ordered = [...pending.docs].sort((x, y) => checkedAt(x.data()) - checkedAt(y.data()));
  let applied = 0;
  for (const doc of ordered) {
    if (Date.now() > deadline) break;
    if (Date.now() - checkedAt(doc.data()) < RECONCILE_AFTER_MS) continue;
    try {
      const reg = await db.collection(COLLECTIONS.registrations).doc(doc.id).get();
      if (!reg.exists || reg.data()!.status !== "pending_payment") continue;
      const outcome = await verifyWithProvider(doc.id).catch(() => "unreachable" as const);
      if (outcome === "confirmed") applied += 1;
      // Remember we looked, so the next run starts with whoever has waited longest.
      await doc.ref.update({ lastReconciledAt: FieldValue.serverTimestamp() }).catch(() => undefined);
    } catch (error) {
      log("reconcile_error", { registrationId: doc.id, message: error instanceof Error ? error.message : "unknown" });
    }
  }
  return applied;
};

/* ───────────── organizer cancels the event ───────────── */

export interface EventCancelResult {
  released: number;
  refunds: number;
  /** Work still outstanding: holds not yet released, paid entries without a refund, refunds not yet finished. 0 = done. */
  remaining: number;
}

/**
 * An event was cancelled: unpaid holds are dropped, and every paid entry is
 * owed a full automatic refund.
 *
 * **Resumable.** The event carries `refundsPending: true` from the moment it is
 * cancelled, and this function clears it only when nothing is left. It can be
 * run again at any time (the cron does, and so can staff) and each step is
 * idempotent — a hold already released, a refund already recorded or already
 * done is skipped — so a run cut short by a timeout, a crash or a provider
 * outage loses nothing. `budgetMs` bounds a single run.
 *
 * Refunds that were already waiting for staff (an entry cancelled by its
 * holder earlier) become automatic: the organizer cancelling the event settles
 * the question of whether they are owed.
 */
export const handleEventCancelled = async (eventId: string, options: { budgetMs?: number; retryStuck?: boolean } = {}): Promise<EventCancelResult> => {
  const deadline = Date.now() + (options.budgetMs ?? 25_000);
  const db = adminDb();
  const over = () => Date.now() > deadline;
  let released = 0;
  let recorded = 0;

  // Refunds are owed because the event was cancelled. If it has since been reinstated (or never was cancelled),
  // nothing is released or refunded; the leftover flag is simply cleared.
  const eventSnap = await db.collection(COLLECTIONS.events).doc(eventId).get();
  if (!eventSnap.exists || eventSnap.data()!.status !== "cancelled") {
    if (eventSnap.exists) await eventSnap.ref.update({ refundsPending: FieldValue.delete() }).catch(() => undefined);
    log("event_cancel_skipped", { eventId, reason: "event is not cancelled" });
    return { released: 0, refunds: 0, remaining: 0 };
  }

  const regs = await db.collection(COLLECTIONS.registrations).where("eventId", "==", eventId).get();
  for (const doc of regs.docs) {
    if (over()) break;
    const reg = doc.data();
    const paymentStatus = String(reg.paymentStatus ?? "not_required");
    try {
      if (reg.status === "pending_payment") {
        // Money may be attached to a hold that is frozen or under review: those are not released here.
        if (paymentStatus === "needs_review") continue;
        const did = await db.runTransaction(async (tx) => {
          const regSnap = await tx.get(doc.ref);
          if (regSnap.data()?.status !== "pending_payment") return false;
          const eventSnap = await tx.get(db.collection(COLLECTIONS.events).doc(eventId));
          const plan = await planCancellation(tx, db, regSnap, eventSnap, { allowPromotion: false });
          writeCancellation(tx, plan, "abandoned");
          return true;
        });
        if (did) released += 1;
      } else if (paymentStatus === "paid" && reg.status !== "cancelled") {
        const made = await db.runTransaction(async (tx) => {
          const [regSnap, paySnap] = await Promise.all([tx.get(doc.ref), tx.get(paymentRef(db, doc.id))]);
          if (!paySnap.exists || regSnap.data()?.paymentStatus !== "paid") return false;
          const pay = paySnap.data()!;
          const refunds = refundsOf(pay);
          if (refunds.some((r) => r.reason === "event_cancelled")) return false;
          const record: RefundRecord = { id: `${doc.id}_r${refunds.length + 1}`, orderId: primaryOrderOf(pay), amountPaise: Number(pay.amountPaise) - refundedPaise(refunds, primaryOrderOf(pay)), reason: "event_cancelled", autoRefund: true, status: "requested", requestedAt: Timestamp.now() };
          tx.update(paySnap.ref, { status: "refund_pending", ...owed(true), refunds: FieldValue.arrayUnion(record), updatedAt: FieldValue.serverTimestamp() });
          tx.update(doc.ref, { paymentStatus: "refund_pending", updatedAt: FieldValue.serverTimestamp() });
          return true;
        });
        if (made) recorded += 1;
      }
    } catch (error) {
      log("event_cancel_error", { eventId, registrationId: doc.id, message: error instanceof Error ? error.message : "unknown" });
    }
  }

  // Refunds owed on this event, however they arose: make them automatic, then work through them.
  const payments = await db.collection(COLLECTIONS.payments).where("eventId", "==", eventId).where("openRefunds", "==", true).get();
  for (const doc of payments.docs) {
    if (over()) break;
    // A refund that has given up is a person's to restart (staff "Approve refund", or "resume" with retryStuck).
    const stuck = ((doc.data().flags ?? []) as string[]).includes("refund_stuck");
    if (stuck && !options.retryStuck) continue;
    try {
      if (stuck) await doc.ref.update({ flags: FieldValue.arrayRemove("refund_stuck"), refundFailures: 0, refundPolls: 0 });
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref);
        const refunds = refundsOf(fresh.data());
        if (refunds.some((r) => (r.status === "requested" || r.status === "failed") && !r.autoRefund)) {
          tx.update(doc.ref, { refunds: refunds.map((r) => (r.status === "requested" || r.status === "failed" ? { ...r, autoRefund: true } : r)), ...owed(true), updatedAt: FieldValue.serverTimestamp() });
        }
      });
      for (const record of refundsOf((await doc.ref.get()).data())) {
        if (over()) break;
        if (record.status === "requested" || record.status === "failed" || record.status === "pending") await executeRefund(doc.id, record.id);
      }
    } catch (error) {
      log("event_cancel_error", { eventId, paymentId: doc.id, message: error instanceof Error ? error.message : "unknown" });
    }
  }

  const remaining = await eventRefundWorkLeft(eventId);
  const eventRef = db.collection(COLLECTIONS.events).doc(eventId);
  if (remaining === 0) await eventRef.update({ refundsPending: FieldValue.delete() }).catch(() => undefined);
  log("event_cancelled", { eventId, released, refunds: recorded, remaining });
  return { released, refunds: recorded, remaining };
};

/** How much is still to do for a cancelled event. Counts holds, unrefunded paid entries and unfinished refunds. */
export const eventRefundWorkLeft = async (eventId: string): Promise<number> => {
  const db = adminDb();
  const regs = db.collection(COLLECTIONS.registrations);
  const [holds, paid, owedRefunds] = await Promise.all([
    regs.where("eventId", "==", eventId).where("status", "==", "pending_payment").get(),
    regs.where("eventId", "==", eventId).where("paymentStatus", "==", "paid").get(),
    db.collection(COLLECTIONS.payments).where("eventId", "==", eventId).where("openRefunds", "==", true).get(),
  ]);
  // A hold frozen for review is staff's to resolve; it does not keep the sweep running.
  const releasable = holds.docs.filter((d) => d.data().paymentStatus !== "needs_review").length;
  const unrefunded = paid.docs.filter((d) => d.data().status !== "cancelled").length;
  return releasable + unrefunded + owedRefunds.size;
};

/** Finishes the cancellation work of every event that still has some (called by the cron). */
export const sweepCancelledEvents = async (options: { budgetMs?: number; limit?: number } = {}): Promise<{ events: number; remaining: number }> => {
  const deadline = Date.now() + (options.budgetMs ?? 60_000);
  const db = adminDb();
  const flagged = await db.collection(COLLECTIONS.events).where("refundsPending", "==", true).limit(options.limit ?? 25).get();
  let remaining = 0;
  let events = 0;
  for (const doc of flagged.docs) {
    if (Date.now() > deadline) {
      remaining += 1;
      continue;
    }
    events += 1;
    try {
      remaining += (await handleEventCancelled(doc.id, { budgetMs: Math.max(1000, deadline - Date.now()) })).remaining > 0 ? 1 : 0;
    } catch (error) {
      remaining += 1;
      log("event_cancel_error", { eventId: doc.id, message: error instanceof Error ? error.message : "unknown" });
    }
  }
  return { events, remaining };
};

/* ───────────── staff actions on money ───────────── */

/**
 * Staff approve the refunds that were queued for them (a student withdrew a
 * paid entry), or retry ones the provider has not completed. Each refund id is
 * idempotent at the provider, so a double click cannot refund twice.
 */
export const approveRefunds = async (registrationId: string): Promise<{ attempted: number; results: RefundExecution[] }> => {
  const db = adminDb();
  const ids = await db.runTransaction(async (tx) => {
    const paySnap = await tx.get(paymentRef(db, registrationId));
    if (!paySnap.exists) throw new Error("no-payment");
    const refunds = refundsOf(paySnap.data());
    const open = refunds.filter((r) => r.status === "requested" || r.status === "failed");
    // A person asking for it is also how a refund that gave up ("stuck") is started again.
    if (open.length) tx.update(paySnap.ref, { refunds: refunds.map((r) => (open.includes(r) ? { ...r, autoRefund: true } : r)), ...owed(true), refundFailures: 0, refundPolls: 0, flags: FieldValue.arrayRemove("refund_stuck"), updatedAt: FieldValue.serverTimestamp() });
    return open.map((r) => r.id);
  });
  const results: RefundExecution[] = [];
  for (const id of ids) results.push(await executeRefund(registrationId, id));
  return { attempted: ids.length, results };
};

/**
 * A payment flagged `needs_review` (paid at the provider, but amount/currency
 * did not match) is settled by returning the money and releasing the entry.
 * Accepting a mismatched payment as good is deliberately not possible.
 */
export const resolveReviewWithRefund = async (registrationId: string): Promise<{ refundId: string } | null> => {
  const db = adminDb();
  const regRef = db.collection(COLLECTIONS.registrations).doc(registrationId);
  const result = await db.runTransaction(async (tx) => {
    const [regSnap, paySnap] = await Promise.all([tx.get(regRef), tx.get(paymentRef(db, registrationId))]);
    if (!regSnap.exists || !paySnap.exists) return null;
    const pay = paySnap.data()!;
    // Only a payment that actually captured money (and was flagged for it) is returned here; a hold frozen by an
    // account change has nothing to refund and is let go with `releaseFlaggedHold` instead.
    if (pay.status !== "needs_review" || pay.capturedAmountPaise === undefined) return null;
    const eventSnap = await tx.get(db.collection(COLLECTIONS.events).doc(String(regSnap.data()!.eventId)));
    const plan = await planCancellation(tx, db, regSnap, eventSnap);
    const reg = regSnap.data()!;
    const now = FieldValue.serverTimestamp();
    const refunds = refundsOf(pay);
    const record: RefundRecord = {
      id: `${registrationId}_r${refunds.length + 1}`,
      orderId: String(pay.capturedOrderId ?? pay.orderId),
      amountPaise: Number(pay.capturedAmountPaise ?? pay.amountPaise),
      reason: "review_refund",
      autoRefund: true,
      status: "requested",
      requestedAt: Timestamp.now(),
    };
    const written = reg.status === "cancelled" ? { promoted: null } : writeCancellation(tx, plan, "staff");
    tx.update(paySnap.ref, { status: "refund_pending", ...owed(true), capturedAmountPaise: record.amountPaise, refunds: FieldValue.arrayUnion(record), updatedAt: now });
    tx.update(regRef, { paymentStatus: "refund_pending", updatedAt: now });
    return { refundId: record.id, promoted: written.promoted };
  });
  if (!result) return null;
  await announcePromoted(result.promoted);
  await executeRefund(registrationId, result.refundId).catch(() => undefined);
  return { refundId: result.refundId };
};

/**
 * Staff let go of an unpaid hold that was frozen because the fest's merchant
 * account changed under it. The seat goes back to the pool and the next person
 * on the waitlist is offered it. Only for a payment that never captured money
 * as far as this system knows; whatever the customer may have paid to the
 * previous merchant account has to be settled in that account, and the
 * payment record says so (`released_after_account_change`).
 */
export const releaseFlaggedHold = async (registrationId: string): Promise<boolean> => {
  const db = adminDb();
  const regRef = db.collection(COLLECTIONS.registrations).doc(registrationId);
  const promoted = await db.runTransaction(async (tx) => {
    const [regSnap, paySnap] = await Promise.all([tx.get(regRef), tx.get(paymentRef(db, registrationId))]);
    if (!regSnap.exists || !paySnap.exists) return undefined;
    const pay = paySnap.data()!;
    const flagged = (Array.isArray(pay.flags) ? (pay.flags as string[]) : []).some((f) => f.startsWith("account_changed:"));
    if (!flagged || pay.status !== "needs_review" || regSnap.data()!.status !== "pending_payment" || pay.capturedAmountPaise !== undefined) return undefined;
    const eventSnap = await tx.get(db.collection(COLLECTIONS.events).doc(String(regSnap.data()!.eventId)));
    const plan = await planCancellation(tx, db, regSnap, eventSnap);
    const written = writeCancellation(tx, plan, "staff");
    const now = FieldValue.serverTimestamp();
    tx.update(paySnap.ref, { status: "cancelled", flags: FieldValue.arrayUnion("released_after_account_change"), updatedAt: now });
    tx.update(regRef, { paymentStatus: "cancelled", holdExpiresAt: FieldValue.delete(), updatedAt: now });
    return written.promoted;
  });
  if (promoted === undefined) return false;
  await announcePromoted(promoted);
  return true;
};
