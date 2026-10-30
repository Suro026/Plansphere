import { ApiError } from "@/server/errors";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { notifyMany } from "@/server/notify";
import { bindingProblem, type StoredAccount } from "./account";
import { flagBindingProblem } from "./lifecycle";

/**
 * What changing a fest's merchant account does to money already in flight.
 *
 * A payment is bound to the provider, mode and credentials it was created
 * under (`accountBinding` / `bindingProblem`). Saving different credentials is
 * therefore allowed only in ways that cannot strand or misdirect that money:
 *
 *  - Provider or mode (sandbox ↔ live) may change only when nothing is open.
 *    Open = an unpaid hold or a payment in review, or a refund still owed.
 *  - Credentials may change at any time, but every open payment that the new
 *    account no longer provably belongs to (not the same merchant, as reported
 *    by the provider) is flagged for review, and nothing is sent to the
 *    provider for it until a person has looked.
 */

const OPEN_PAYMENT_STATUSES = ["created", "pending", "failed", "needs_review"];

/** The fest's payments that are not finished: unpaid holds, payments in review, and any with a refund still owed. */
export const openPayments = async (festId: string): Promise<Array<{ id: string; data: FirebaseFirestore.DocumentData }>> => {
  const db = adminDb();
  const [unfinished, refunding] = await Promise.all([
    db.collection(COLLECTIONS.payments).where("festId", "==", festId).where("status", "in", OPEN_PAYMENT_STATUSES).limit(500).get(),
    db.collection(COLLECTIONS.payments).where("festId", "==", festId).where("openRefunds", "==", true).limit(500).get(),
  ]);
  const byId = new Map<string, FirebaseFirestore.DocumentData>();
  for (const doc of [...unfinished.docs, ...refunding.docs]) byId.set(doc.id, doc.data());
  return [...byId].map(([id, data]) => ({ id, data }));
};

/** Throws a 409 if switching provider or mode would leave open money on the old account. */
export const assertSafeAccountChange = async (festId: string, previous: StoredAccount | null, next: { provider: string; mode: string }): Promise<void> => {
  if (!previous) return;
  if (previous.provider === next.provider && previous.mode === next.mode) return;
  const open = await openPayments(festId);
  if (open.length > 0) {
    throw ApiError.conflict(
      `This fest has ${open.length} unpaid or refunding payment${open.length === 1 ? "" : "s"} on the current ${previous.mode} account, so the provider or mode can't be changed yet. Let them finish (or be released) first.`,
    );
  }
};

/** After an account is saved: flag every open payment the new account cannot be trusted with. Returns how many were flagged. */
export const flagOpenPaymentsAfterChange = async (festId: string, account: StoredAccount): Promise<number> => {
  let flagged = 0;
  for (const { id, data } of await openPayments(festId)) {
    const problem = bindingProblem(data, account);
    if (problem) {
      await flagBindingProblem(id, problem);
      flagged += 1;
    }
  }
  return flagged;
};

/* ───────────── who may change where a fest's money goes ───────────── */

/**
 * Credentials decide where students' money lands, so changing them is not an
 * ordinary admin task. Only the fest's owner (the account that registered it,
 * `Fest.ownerId`) or a platform administrator may save or approve them; the
 * other admins of the fest can see the status, and are told when it changes.
 */
export const canConfigureCredentials = (caller: { uid: string; role: string }, fest: { ownerId?: string }): boolean =>
  caller.role === "super_admin" || (caller.role === "admin" && Boolean(fest.ownerId) && fest.ownerId === caller.uid);

/**
 * Tells everyone who should know that a fest's payment account changed: the
 * fest's other admins (including its owner) and every platform administrator,
 * but not the person who did it. Best effort — the change has already happened
 * and is in the audit log, so a failed notification never undoes it.
 */
export const notifyPaymentAccountChange = async (festId: string, actorUid: string, title: string, body: string): Promise<number> => {
  try {
    const users = adminDb().collection(COLLECTIONS.users);
    const [admins, supers] = await Promise.all([users.where("festIds", "array-contains", festId).get(), users.where("role", "==", "super_admin").get()]);
    const recipients = new Map<string, string>();
    for (const doc of [...admins.docs, ...supers.docs]) {
      const role = doc.data().role;
      if (doc.id !== actorUid && (role === "admin" || role === "super_admin")) recipients.set(doc.id, doc.id);
    }
    return await notifyMany([...recipients.keys()].map((userId) => ({ userId, type: "payment_account" as const, title, body, link: "/admin", festId })));
  } catch {
    return 0;
  }
};

/**
 * Takes a fest's payment account out of service without touching its payments.
 * Used when ownership changes hands: the new owner must save and have approved
 * credentials of their own before anything new can be charged, while payments
 * and refunds already in flight remain bound to the merchant they were made under.
 */
export const suspendPaymentAccount = async (festId: string, reason: string): Promise<boolean> => {
  const ref = adminDb().collection(COLLECTIONS.paymentAccounts).doc(festId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.status === "suspended") return false;
  await ref.update({ status: "suspended", suspendedReason: reason, updatedAt: FieldValue.serverTimestamp() });
  return true;
};

/** Removes a fest's payment account and stored credentials (used when the fest itself is deleted). */
export const deletePaymentAccount = async (festId: string): Promise<void> => {
  const db = adminDb();
  await Promise.all([db.collection(COLLECTIONS.paymentAccounts).doc(festId).delete(), db.collection(COLLECTIONS.paymentSecrets).doc(festId).delete()]);
};
