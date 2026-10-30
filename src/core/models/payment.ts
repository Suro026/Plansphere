import { z } from "zod";
import { dateSchema, idSchema } from "./common";

/**
 * Optional paid registration — the vocabulary shared by the server, the UI and
 * the tests. No platform package is imported here (this directory is compiled
 * as-is by the Expo app).
 *
 * Money is held as integer **paise**, currency INR. The amount is never taken
 * from a client: the server derives it from the event (`entryAmountPaise`).
 * Plansphere takes no commission and adds no fee on top; the amount charged is
 * exactly the event's entry fee.
 *
 * Pricing unit: **one charge per registration**. A team pays once, however many
 * members it ends up with. (Charging per member would require partial refunds
 * whenever a teammate declines — deliberately not done here.)
 */

export const CURRENCY = "INR" as const;
export const PAYMENT_MIN_PAISE = 100;

/** Providers that have an adapter in this codebase. `test` never exists in production. */
export const PAYMENT_PROVIDERS = ["test"] as const;
export const paymentProviderSchema = z.enum(PAYMENT_PROVIDERS);
export type PaymentProviderId = z.infer<typeof paymentProviderSchema>;

export const PAYMENT_MODES = ["sandbox", "live"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/**
 * A fest's payment account.
 *
 *   not_configured   nothing saved
 *   pending_review   credentials saved by the fest owner; waiting for a platform
 *                    administrator to confirm the provider arrangement
 *   active           approved; paid events may be published and orders created
 *   suspended        switched off by a platform administrator
 *
 * Secrets are never part of this shape — they live encrypted in a separate,
 * server-only collection.
 */
export const PAYMENT_ACCOUNT_STATUSES = ["not_configured", "pending_review", "active", "suspended"] as const;
export type PaymentAccountStatus = (typeof PAYMENT_ACCOUNT_STATUSES)[number];

export const paymentAccountSchema = z.object({
  festId: idSchema,
  provider: paymentProviderSchema,
  mode: z.enum(PAYMENT_MODES),
  status: z.enum(PAYMENT_ACCOUNT_STATUSES),
  /** Non-secret identifier of the organizer's merchant (e.g. an app id). Shown to staff. */
  merchantRef: z.string().max(200).optional(),
  updatedAt: dateSchema.optional(),
  approvedAt: dateSchema.optional(),
});

export type PaymentAccount = z.infer<typeof paymentAccountSchema>;

/** The money state of one registration's payment. */
export const PAYMENT_STATUSES = [
  "created", // order not yet confirmed by the provider
  "pending", // customer is paying
  "paid", // verified server-side: amount, currency and order match
  "failed", // the last attempt failed; the customer may retry while the hold lasts
  "expired", // hold lapsed with no verified payment
  "cancelled", // abandoned: the entry was cancelled before any payment
  "needs_review", // paid at the provider but something does not match; staff decide
  "refund_pending", // a refund is owed and not yet completed
  "partially_refunded",
  "refunded",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * What the registration document shows. `not_required` is every free entry
 * (and every entry that predates payments — the field is simply absent there).
 */
export const REGISTRATION_PAYMENT_STATUSES = [
  "not_required",
  "pending",
  "failed",
  "paid",
  "expired",
  "cancelled",
  "needs_review",
  "refund_pending",
  "refunded",
] as const;
export const registrationPaymentStatusSchema = z.enum(REGISTRATION_PAYMENT_STATUSES);
export type RegistrationPaymentStatus = z.infer<typeof registrationPaymentStatusSchema>;

/** The slice of an event that decides whether a registration costs money. */
export interface PricedEvent {
  entryFee?: number | undefined;
  paymentEnabled?: boolean | undefined;
}

/**
 * Does registering for this event require an online payment?
 *
 * Only when the organizer has switched online payment on *and* the fee is a
 * real amount. An event with `entryFee > 0` and no switch is exactly what it
 * has always been: a fee shown on the page and collected outside Plansphere.
 */
export const eventRequiresPayment = (event: PricedEvent): boolean =>
  event.paymentEnabled === true && Number(event.entryFee ?? 0) * 100 >= PAYMENT_MIN_PAISE;

/** The amount to charge, in paise, from the event alone. */
export const entryAmountPaise = (event: PricedEvent): number => Math.round(Number(event.entryFee ?? 0) * 100);

/** What starting a checkout tells the client: already paid, or where to go to pay. */
export type PaymentCheckoutResult = { state: "paid" } | { state: "checkout"; redirectUrl?: string; amountPaise: number; expiresAt: number };

/** Short, human wording for a registration's payment state. */
export const PAYMENT_STATUS_LABELS: Record<RegistrationPaymentStatus, string> = {
  not_required: "No payment",
  pending: "Payment pending",
  failed: "Payment failed",
  paid: "Paid",
  expired: "Payment window expired",
  cancelled: "Cancelled before payment",
  needs_review: "Payment under review",
  refund_pending: "Refund pending",
  refunded: "Refunded",
};

export const formatRupees = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 === 0 ? 0 : 2 })}`;
