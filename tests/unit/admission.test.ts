import { describe, expect, it } from "vitest";
import { admissionBlock, isAdmissible, type AdmissionBlock } from "@/core/models/admission";
import { blockOutcome } from "@/core/models/attendance";
import { REGISTRATION_PAYMENT_STATUSES } from "@/core/models/payment";
import { REGISTRATION_STATUSES } from "@/core/models/registration";

/**
 * The admission rule, as a table. Every gate (online scan, offline roster,
 * manual entry, meals, wallet, public ticket, the student's ticket) calls
 * `admissionBlock`, and firestore.rules mirrors it; the emulator suite
 * (tests/emulator/admission.test.ts) checks the rules against this same table.
 */

const PAID_OK = [undefined, "not_required", "paid"] as const;
const PAID_NOT = REGISTRATION_PAYMENT_STATUSES.filter((p) => p !== "not_required" && p !== "paid");

/** Expected block for every status × paymentStatus pair. */
const expected = (status: string | undefined, paymentStatus: string | undefined): AdmissionBlock | null => {
  if (status === "waitlisted") return "waitlisted";
  if (status === "draft") return "draft";
  if (status === "pending_payment") return "unpaid";
  if (status === "cancelled") return "cancelled";
  if (status !== undefined && status !== "confirmed" && status !== "draft") return "cancelled";
  if (PAID_OK.includes(paymentStatus as never)) return null;
  return paymentStatus === "refund_pending" || paymentStatus === "refunded" ? "refunded" : "unpaid";
};

describe("admissionBlock", () => {
  it("answers correctly for every registration status × payment status", () => {
    const statuses = [undefined, ...REGISTRATION_STATUSES];
    const payments = [undefined, ...REGISTRATION_PAYMENT_STATUSES];
    for (const status of statuses) {
      for (const paymentStatus of payments) {
        expect(admissionBlock({ status, paymentStatus }), `${status} / ${paymentStatus}`).toBe(expected(status, paymentStatus));
      }
    }
  });

  it("free and legacy entries behave as they always did", () => {
    // No paymentStatus (made before payments) or not_required (free, made after).
    for (const paymentStatus of [undefined, "not_required"]) {
      expect(isAdmissible({ status: "confirmed", paymentStatus })).toBe(true);
      expect(isAdmissible({ status: "cancelled", paymentStatus })).toBe(false);
    }
    // An entry from before the status field existed is a confirmed one.
    expect(isAdmissible({})).toBe(true);
  });

  it("refuses a waitlisted entry whatever its payment status — on a free event and a paid one", () => {
    for (const paymentStatus of [undefined, "not_required", "paid", ...PAID_NOT]) {
      expect(admissionBlock({ status: "waitlisted", paymentStatus }), String(paymentStatus)).toBe("waitlisted");
    }
  });

  it("refuses every unpaid or returned payment, and a pending_payment hold even if marked paid", () => {
    for (const paymentStatus of PAID_NOT) expect(isAdmissible({ status: "confirmed", paymentStatus }), paymentStatus).toBe(false);
    expect(admissionBlock({ status: "pending_payment", paymentStatus: "paid" })).toBe("unpaid");
    expect(admissionBlock({ status: "confirmed", paymentStatus: "refund_pending" })).toBe("refunded");
    expect(admissionBlock({ status: "confirmed", paymentStatus: "refunded" })).toBe("refunded");
  });

  it("fails closed on a status or payment status it does not recognise", () => {
    expect(isAdmissible({ status: "teleported" })).toBe(false);
    expect(isAdmissible({ status: "confirmed", paymentStatus: "mystery" })).toBe(false);
  });

  it("never admits a draft team — free or paid, paid up or not — until it is confirmed", () => {
    for (const paymentStatus of [undefined, "not_required", "paid", ...PAID_NOT]) {
      expect(isAdmissible({ status: "draft", paymentStatus }), String(paymentStatus)).toBe(false);
    }
    // A free draft and a paid-up draft both read as "team not complete", not as a payment problem.
    expect(admissionBlock({ status: "draft" })).toBe("draft");
    expect(admissionBlock({ status: "draft", paymentStatus: "paid" })).toBe("draft");
    // The same entry once the team completes and it becomes confirmed.
    expect(isAdmissible({ status: "confirmed" })).toBe(true);
    expect(isAdmissible({ status: "confirmed", paymentStatus: "paid" })).toBe(true);
    expect(isAdmissible({ status: "confirmed", paymentStatus: "pending" })).toBe(false);
  });
});

describe("blockOutcome", () => {
  it("maps every block to a scan result the screens understand", () => {
    expect(blockOutcome("cancelled")).toEqual({ result: "cancelled" });
    expect(blockOutcome("refunded")).toEqual({ result: "cancelled" });
    expect(blockOutcome("waitlisted")).toEqual({ result: "waitlisted" });
    expect(blockOutcome("draft")).toEqual({ result: "draft" });
    expect(blockOutcome("unpaid")).toEqual({ result: "unpaid" });
  });
});
