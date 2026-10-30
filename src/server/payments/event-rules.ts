import { PAYMENT_MIN_PAISE } from "@/core/models/payment";
import { ApiError } from "@/server/errors";
import { assertOrderingAllowed, loadAccount } from "./account";

/**
 * The rules for an event that asks for online payment, enforced where events
 * are written (never only in the form).
 *
 *  - the fee must be a real amount (at least one rupee);
 *  - going live — publishing — needs a fest payment account that is approved
 *    and usable *right now* (platform switch on, provider available, live mode
 *    allowed). A draft may be prepared before that.
 *
 * Throws a 422 an organizer can act on; never downgrades the event to free.
 */
export const assertPaidEventAllowed = async (args: { festId: string; paymentEnabled: boolean | undefined; entryFee: number; status: string; publishing: boolean }): Promise<void> => {
  if (args.paymentEnabled !== true) return;
  if (args.entryFee * 100 < PAYMENT_MIN_PAISE) {
    throw ApiError.unprocessable("Online payment needs an entry fee of at least ₹1. Set a fee, or turn online payment off for a free event.");
  }
  if (args.publishing) assertOrderingAllowed(await loadAccount(args.festId));
};
