import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { decideEntry, decideMeal, parseTicketCode } from "@/lib/offline/scanner";
import { clearEvent, listQueue, replaceCheckins, replaceMeals, replaceRoster, type RosterEntry } from "@/lib/offline/db";
import { memberKeyFor } from "@/core/models/attendance";
import { event } from "./fixtures";

/**
 * QR validation as the gate sees it: the roster is cached in IndexedDB and
 * every decision is made locally. fake-indexeddb stands in for the browser.
 */

const ev = event({ id: "ev1", title: "Capture the Flag" });
const other = event({ id: "ev2", slug: "quiz", title: "Quiz Prelims" });

const roster = (over: Partial<RosterEntry> = {}): RosterEntry => {
  const base = {
    ticketCode: "FF-7K2M9QX4TB",
    registrationId: "reg1",
    eventId: "ev1",
    festId: "fest1",
    userId: "u1",
    userName: "Ishita Rao",
    userEmail: "ishita@x.test",
    memberCount: 1,
    status: "confirmed" as const,
    ...over,
  };
  const members = over.members ?? [{ key: memberKeyFor(base.userEmail), name: base.userName, email: base.userEmail }];
  return {
    ...base,
    members,
    search: over.search ?? [base.registrationId, base.ticketCode, base.teamName, base.userName, ...members.flatMap((m) => [m.name, m.email])].filter(Boolean).join(" ").toLowerCase(),
  };
};

const scan = (code: string, e = ev) => decideEntry({ event: e, code, scannedBy: "vol1", online: false, gate: "Gate A" });

describe("parseTicketCode", () => {
  it("accepts a bare code, the public /t/ URL the QR encodes, and lowercase input", () => {
    expect(parseTicketCode("PS-7K2M9QX4TB")).toBe("PS-7K2M9QX4TB");
    expect(parseTicketCode("https://plansphere.in/t/PS-7K2M9QX4TB")).toBe("PS-7K2M9QX4TB");
    expect(parseTicketCode("  ps-7k2m9qx4tb ")).toBe("PS-7K2M9QX4TB");
  });
  it("still scans a ticket issued before the Plansphere rename", () => {
    expect(parseTicketCode("FF-7K2M9QX4TB")).toBe("FF-7K2M9QX4TB");
    expect(parseTicketCode("https://plansphere.in/t/FF-7K2M9QX4TB")).toBe("FF-7K2M9QX4TB");
  });
  it("rejects anything that is not a ticket", () => {
    expect(parseTicketCode("https://evil.example/t/FF-7K2M9QX4TB?x=1")).toBe("FF-7K2M9QX4TB"); // the code is what matters, not the host
    expect(parseTicketCode("FF-0000INVALID")).toBeNull();
    expect(parseTicketCode("FF-7K2M9QX4TO")).toBeNull();
    expect(parseTicketCode("https://plansphere.in/t/FF-7K2M9QX4TB1")).toBeNull(); // too long — not truncated to a valid code
    expect(parseTicketCode("hello")).toBeNull();
    expect(parseTicketCode("")).toBeNull();
  });
});

describe("decideEntry (offline)", () => {
  beforeEach(async () => {
    await replaceRoster("ev1", [roster(), roster({ ticketCode: "FF-CANCELLED1", registrationId: "reg2", status: "cancelled", userName: "Gone" }), roster({ ticketCode: "FF-TEAMPASS01", registrationId: "reg3", teamName: "Null Pointers", memberCount: 3 })]);
    await replaceRoster("ev2", [roster({ ticketCode: "FF-QUIZONLY01", registrationId: "reg9", eventId: "ev2" })]);
    await replaceCheckins("ev1", []);
    await replaceMeals("ev1", []);
  });

  it("admits a valid ticket once and queues the write", async () => {
    const first = await scan("FF-7K2M9QX4TB");
    expect(first).toMatchObject({ result: "ok", queued: true, registration: { id: "reg1", userName: "Ishita Rao" } });
    const queue = await listQueue();
    expect(queue.some((q) => q.registrationId === "reg1" && q.kind === "entry" && q.gate === "Gate A")).toBe(true);
  });

  it("detects a duplicate scan and says it was this device", async () => {
    await scan("FF-7K2M9QX4TB");
    const second = await scan("FF-7K2M9QX4TB");
    expect(second).toMatchObject({ result: "already-recorded", by: "this device" });
    expect(second.result === "already-recorded" && second.at instanceof Date).toBe(true);
  });

  it("refuses a cancelled entry and an unknown code", async () => {
    expect(await scan("FF-CANCELLED1")).toEqual({ result: "cancelled" });
    expect(await scan("FF-NOTINROSTR")).toEqual({ result: "not-found" });
  });

  it("never admits or feeds an entry whose payment is not verified", async () => {
    await replaceRoster("ev1", [roster({ ticketCode: "FF-UNPAID0001", registrationId: "reg5", status: "pending_payment", paymentStatus: "pending", userName: "Not Paid" })]);
    expect(await scan("FF-UNPAID0001")).toEqual({ result: "unpaid" });
    expect(await decideMeal({ event: ev, code: "FF-UNPAID0001", scannedBy: "vol1", online: false, mealType: "lunch", servedOn: "2026-09-26" })).toEqual({ result: "unpaid" });
    expect((await listQueue()).some((q) => q.registrationId === "reg5")).toBe(false);
  });

  it("applies the shared admission rule to every status and payment state", async () => {
    const rows: Array<[string, Partial<RosterEntry>, string]> = [
      ["FF-WAITLIST001", { status: "waitlisted" }, "waitlisted"],
      ["FF-WAITLPAID01", { status: "waitlisted", paymentStatus: "paid" }, "waitlisted"],
      ["FF-HOLDONLY001", { status: "pending_payment", paymentStatus: "pending" }, "unpaid"],
      ["FF-FAILEDPAY01", { status: "confirmed", paymentStatus: "failed" }, "unpaid"],
      ["FF-REFUNDPEND1", { status: "confirmed", paymentStatus: "refund_pending" }, "cancelled"],
      ["FF-REFUNDED001", { status: "confirmed", paymentStatus: "refunded" }, "cancelled"],
      ["FF-DRAFTTEAM01", { status: "draft", memberCount: 2 }, "draft"],
      ["FF-DRAFTPAID001", { status: "draft", memberCount: 2, paymentStatus: "paid" }, "draft"],
      ["FF-PAIDTICKET1", { status: "confirmed", paymentStatus: "paid" }, "ok"],
      ["FF-FREETICKET1", { status: "confirmed" }, "ok"],
    ];
    await replaceRoster("ev1", rows.map(([ticketCode, over], i) => roster({ ticketCode, registrationId: `adm${i}`, ...over })));
    for (const [code, , result] of rows) {
      expect((await scan(code)).result, code).toBe(result);
      const meal = await decideMeal({ event: ev, code, scannedBy: "vol1", online: false, mealType: "lunch", servedOn: "2026-09-26" });
      expect(meal.result, `${code} meal`).toBe(result);
    }
    // Only the admitted ones reached the queue.
    const queued = (await listQueue()).map((q) => q.registrationId);
    expect(queued.filter((id) => id.startsWith("adm")).length).toBe(4);
  });

  it("flags a ticket for a different event as wrong-event", async () => {
    expect(await scan("FF-QUIZONLY01")).toMatchObject({ result: "wrong-event" });
    expect(await scan("FF-QUIZONLY01", other)).toMatchObject({ result: "ok" });
  });

  it("reads the code out of the URL the QR encodes", async () => {
    const code = parseTicketCode("https://plansphere.in/t/FF-TEAMPASS01");
    expect(code).toBe("FF-TEAMPASS01");
    expect(await scan(code!)).toMatchObject({ result: "ok", registration: { teamName: "Null Pointers", memberCount: 3 } });
  });
});

describe("decideMeal (offline)", () => {
  beforeEach(async () => {
    await clearEvent("ev1");
    await replaceRoster("ev1", [
      roster({
        ticketCode: "FF-TEAMPASS01",
        registrationId: "reg3",
        teamName: "Null Pointers",
        memberCount: 2,
        members: [
          { key: memberKeyFor("lead@x.test"), name: "Ishita Rao", email: "lead@x.test" },
          { key: memberKeyFor("mate@x.test"), name: "Rahul Nair", email: "mate@x.test" },
        ],
      }),
    ]);
    await replaceMeals("ev1", []);
  });

  const meal = (code: string) => decideMeal({ event: ev, code, scannedBy: "vol1", online: false, mealType: "lunch", servedOn: "2026-09-25" });

  it("serves everyone still outstanding, then refuses", async () => {
    // No selection means "whoever has not eaten yet" — the same default the
    // gate uses for late arrivals.
    expect(await meal("FF-TEAMPASS01")).toMatchObject({ result: "ok", serving: { n: 2, of: 2 } });
    expect(await meal("FF-TEAMPASS01")).toMatchObject({ result: "already-recorded" });
  });

  it("serves only the members the volunteer ticked", async () => {
    const lead = memberKeyFor("lead@x.test");
    const mate = memberKeyFor("mate@x.test");

    const first = await decideMeal({ event: ev, code: "FF-TEAMPASS01", scannedBy: "vol1", online: false, mealType: "lunch", servedOn: "2026-09-25", memberKeys: [lead] });
    expect(first).toMatchObject({ result: "ok", serving: { n: 1, of: 2 }, marked: [lead] });

    // The one who ate is refused; the one who has not is served.
    const again = await decideMeal({ event: ev, code: "FF-TEAMPASS01", scannedBy: "vol1", online: false, mealType: "lunch", servedOn: "2026-09-25", memberKeys: [lead] });
    expect(again.result).toBe("already-recorded");

    const second = await decideMeal({ event: ev, code: "FF-TEAMPASS01", scannedBy: "vol1", online: false, mealType: "lunch", servedOn: "2026-09-25", memberKeys: [mate] });
    expect(second).toMatchObject({ result: "ok", serving: { n: 2, of: 2 }, marked: [mate] });
  });

  it("keeps meal slots independent", async () => {
    await meal("FF-TEAMPASS01");
    await meal("FF-TEAMPASS01");
    const dinner = await decideMeal({ event: ev, code: "FF-TEAMPASS01", scannedBy: "vol1", online: false, mealType: "dinner", servedOn: "2026-09-25" });
    expect(dinner).toMatchObject({ result: "ok", serving: { n: 2, of: 2 } });
  });
});
