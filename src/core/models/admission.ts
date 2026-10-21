/**
 * Who may be let in — the one decision every gate asks.
 *
 * Online scanning, the offline roster, manual attendance, meal handout, wallet
 * passes, the public ticket page, the student's ticket and (as a mirror, in
 * `firestore.rules` → `admissible()`) the security rules all call this, so a
 * ticket is either valid everywhere or nowhere. Change the rule here and in
 * the rules file together; `tests/unit/admission.test.ts` and
 * `tests/emulator/admission.test.ts` pin the two to the same table.
 *
 * Pure and dependency-free (this directory is also compiled by the Expo app).
 *
 * The decision is made from two fields only:
 *
 *   status          the registration's seat state
 *   paymentStatus   absent / "not_required" for every free entry and every
 *                   entry made before payments existed
 *
 * | status           | admitted? | why |
 * |------------------|-----------|-----|
 * | confirmed        | yes       | a seat, subject to payment below |
 * | draft            | no        | a team that holds its seats while it assembles; it is not an entry until enough members have accepted |
 * | waitlisted       | no        | no seat is held, nothing is paid |
 * | pending_payment  | no        | the seat is only on hold |
 * | cancelled        | no        | |
 * | anything else    | no        | unknown states fail closed |
 *
 * Draft teams (decided): a draft is *not* admitted at any gate, on free events
 * and paid ones alike — the registration page has always told the leader the
 * ticket "is not valid at the gate" until the team is complete, and now the
 * gates agree. A draft becomes `confirmed` the moment enough members accept
 * (or join with the code), and from then on it is admitted like any other
 * confirmed entry. A paid team that has paid but is still a draft stays
 * inadmissible until it completes.
 *
 * Payment, independent of status: a missing / "not_required" / "paid" payment
 * status admits; anything else (pending, failed, expired, cancelled,
 * needs_review, refund_pending, refunded) does not.
 */

export type AdmissionBlock =
  /** Cancelled, or a state this code does not recognise. */
  | "cancelled"
  /** On the waitlist: no seat is held. */
  | "waitlisted"
  /** A team that has not yet reached its minimum size. */
  | "draft"
  /** A seat is on hold, or the payment is not verified. */
  | "unpaid"
  /** The payment was returned (or is being returned). */
  | "refunded";

export interface AdmissionSubject {
  status?: string | undefined;
  paymentStatus?: string | undefined;
}

const PAID_OK = new Set(["not_required", "paid"]);
const REFUNDED = new Set(["refund_pending", "refunded"]);

/** Why this entry cannot be admitted, or `null` if it can. */
export const admissionBlock = (entry: AdmissionSubject): AdmissionBlock | null => {
  // An entry that predates the status field is a confirmed one.
  const status = entry.status ?? "confirmed";

  if (status === "waitlisted") return "waitlisted";
  if (status === "draft") return "draft";
  if (status === "pending_payment") return "unpaid";
  if (status !== "confirmed") return "cancelled";

  const payment = entry.paymentStatus;
  if (payment === undefined || PAID_OK.has(payment)) return null;
  return REFUNDED.has(payment) ? "refunded" : "unpaid";
};

export const isAdmissible = (entry: AdmissionSubject): boolean => admissionBlock(entry) === null;

/** What a person is told. One wording per block, shared by the screens. */
export const ADMISSION_MESSAGES: Record<AdmissionBlock, string> = {
  cancelled: "This registration was cancelled.",
  waitlisted: "This entry is on the waitlist, so no seat is held and it does not admit anyone.",
  draft: "This team is not complete yet, so its ticket is not valid for entry. It becomes valid as soon as enough members have joined.",
  unpaid: "This seat has not been paid for, so the ticket is not valid yet.",
  refunded: "This entry was cancelled and its payment returned, so it no longer admits anyone.",
};
