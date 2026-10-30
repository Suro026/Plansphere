import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canUndo,
  decideEntry,
  decideMeal,
  manualSearch,
  peekEntry,
  syncQueue,
  undoRemainingMs,
  undoScan,
  UNDO_WINDOW_MS,
} from "@/lib/offline/scanner";
import { clearEvent, getMealRecord, listQueue, listToday, replaceMeals, replaceRoster, type RosterEntry } from "@/lib/offline/db";
import { memberKeyFor } from "@/core/models/attendance";
import { event } from "./fixtures";

/**
 * The volunteer scanner's offline half: the write queue, per-member partial
 * attendance, the meal duplicate guard, undo's 30-second window, and manual
 * search. `decideEntry`/`decideMeal` themselves are covered in
 * scanner.test.ts; this file covers what Part 5 of the spec adds on top.
 */

const ev = event({ id: "ev1", title: "Capture the Flag" });

const leadEmail = "lead@x.test";
const mateEmail = "mate@x.test";
const thirdEmail = "third@x.test";
const leadKey = memberKeyFor(leadEmail);
const mateKey = memberKeyFor(mateEmail);
const thirdKey = memberKeyFor(thirdEmail);

const team: RosterEntry = {
  ticketCode: "FF-TEAMPASS01",
  registrationId: "reg-team",
  eventId: "ev1",
  festId: "fest1",
  userId: "u1",
  userName: "Ishita Rao",
  userEmail: leadEmail,
  teamName: "Null Pointers",
  memberCount: 3,
  status: "confirmed",
  members: [
    { key: leadKey, name: "Ishita Rao", email: leadEmail },
    { key: mateKey, name: "Rahul Nair", email: mateEmail, phone: "+919000000002" },
    { key: thirdKey, name: "Arijit Das", email: thirdEmail, college: "Loyola" },
  ],
  search: "reg-team ff-teampass01 null pointers ishita rao lead@x.test rahul nair mate@x.test +919000000002 arijit das third@x.test loyola",
};

const solo: RosterEntry = {
  ticketCode: "FF-SOLO000001",
  registrationId: "reg-solo",
  eventId: "ev1",
  festId: "fest1",
  userId: "u2",
  userName: "Priya Menon",
  userEmail: "priya@x.test",
  memberCount: 1,
  status: "confirmed",
  members: [{ key: memberKeyFor("priya@x.test"), name: "Priya Menon", email: "priya@x.test" }],
  search: "reg-solo ff-solo000001 priya menon priya@x.test",
};

beforeEach(async () => {
  await clearEvent("ev1");
  await replaceRoster("ev1", [team, solo]);
});

describe("team partial attendance", () => {
  it("a peek before writing shows who has arrived without marking anyone", async () => {
    const first = await peekEntry("ev1", "FF-TEAMPASS01");
    expect(first).toMatchObject({ result: "ready", complete: false });
    if (first.result !== "ready") throw new Error("expected ready");
    expect(first.members.every((m) => !m.done)).toBe(true);

    // A peek must not itself be a scan.
    expect(await listQueue()).toHaveLength(0);
  });

  it("marks only the members named, and the entry stays open until the minimum arrives", async () => {
    const first = await decideEntry({ event: ev, code: "FF-TEAMPASS01", scannedBy: "vol1", online: false, memberKeys: [leadKey] });
    expect(first).toMatchObject({ result: "ok", marked: [leadKey] });
    if (first.result !== "ok") throw new Error("expected ok");
    expect(first.members?.find((m) => m.key === leadKey)?.done).toBe(true);
    expect(first.members?.find((m) => m.key === mateKey)?.done).toBe(false);

    // The same QR, scanned again for the late arrival.
    const second = await decideEntry({ event: ev, code: "FF-TEAMPASS01", scannedBy: "vol1", online: false, memberKeys: [mateKey] });
    expect(second).toMatchObject({ result: "ok", marked: [mateKey] });
    if (second.result !== "ok") throw new Error("expected ok");
    expect(second.members?.filter((m) => m.done).map((m) => m.key).sort()).toEqual([leadKey, mateKey].sort());
    expect(second.members?.find((m) => m.key === thirdKey)?.done).toBe(false);
  });

  it("cannot mark the same member twice — a repeat of an already-present key changes nothing", async () => {
    await decideEntry({ event: ev, code: "FF-TEAMPASS01", scannedBy: "vol1", online: false, memberKeys: [leadKey, mateKey] });
    const again = await decideEntry({ event: ev, code: "FF-TEAMPASS01", scannedBy: "vol1", online: false, memberKeys: [leadKey] });
    expect(again.result).toBe("already-recorded");
    if (again.result !== "already-recorded") throw new Error("expected already-recorded");
    expect(again.members?.filter((m) => m.done)).toHaveLength(2);
  });

  it("reports complete once everyone has been marked, and refuses a further scan outright", async () => {
    await decideEntry({ event: ev, code: "FF-TEAMPASS01", scannedBy: "vol1", online: false, memberKeys: [leadKey, mateKey, thirdKey] });
    const peek = await peekEntry("ev1", "FF-TEAMPASS01");
    expect(peek).toMatchObject({ result: "ready", complete: true });

    const rescan = await decideEntry({ event: ev, code: "FF-TEAMPASS01", scannedBy: "vol1", online: false });
    expect(rescan.result).toBe("already-recorded");
  });

  it("a solo ticket has one member and marks them outright, no checklist needed", async () => {
    const outcome = await decideEntry({ event: ev, code: "FF-SOLO000001", scannedBy: "vol1", online: false });
    expect(outcome).toMatchObject({ result: "ok", registration: { memberCount: 1 } });
    if (outcome.result !== "ok") throw new Error("expected ok");
    expect(outcome.members).toHaveLength(1);
    expect(outcome.members?.[0]?.done).toBe(true);
  });
});

describe("food round duplicate prevention", () => {
  beforeEach(async () => {
    await replaceMeals("ev1", []);
  });

  const lunch = (keys?: string[]) =>
    decideMeal({ event: ev, code: "FF-TEAMPASS01", scannedBy: "vol1", online: false, mealType: "lunch", servedOn: "2026-09-25", ...(keys ? { memberKeys: keys } : {}) });

  it("serves the members ticked and nobody else", async () => {
    const first = await lunch([leadKey, mateKey]);
    expect(first).toMatchObject({ result: "ok", serving: { n: 2, of: 3 } });

    const record = await getMealRecord("ev1", "reg-team", "2026-09-25", "lunch");
    expect(record.members.sort()).toEqual([leadKey, mateKey].sort());
  });

  it("refuses a second collection for someone who already has one, in the same round", async () => {
    await lunch([leadKey]);
    const repeat = await lunch([leadKey]);
    expect(repeat.result).toBe("already-recorded");

    const record = await getMealRecord("ev1", "reg-team", "2026-09-25", "lunch");
    expect(record.served).toBe(1);
  });

  it("keeps meal rounds independent — lunch does not block dinner", async () => {
    await lunch([leadKey]);
    const dinner = await decideMeal({ event: ev, code: "FF-TEAMPASS01", scannedBy: "vol1", online: false, mealType: "dinner", servedOn: "2026-09-25", memberKeys: [leadKey] });
    expect(dinner).toMatchObject({ result: "ok", serving: { n: 1, of: 3 } });
  });

  it("a mixed request serves only whoever has not already collected", async () => {
    await lunch([leadKey]);
    const mixed = await lunch([leadKey, mateKey, thirdKey]);
    expect(mixed).toMatchObject({ result: "ok", marked: [mateKey, thirdKey] });
  });
});

describe("undo, within 30 seconds and not a moment after", () => {
  it("takes back an entry scan while it is still queued", async () => {
    await decideEntry({ event: ev, code: "FF-SOLO000001", scannedBy: "vol1", online: false });
    const [entry] = await listToday("ev1");
    expect(entry).toBeDefined();
    expect(canUndo(entry!)).toBe(true);

    const result = await undoScan(entry!.id);
    expect(result).toEqual({ ok: true });

    // The queue is empty and the peek shows nobody marked.
    expect(await listQueue()).toHaveLength(0);
    const peek = await peekEntry("ev1", "FF-SOLO000001");
    expect(peek).toMatchObject({ result: "ready", complete: false });

    const rows = await listToday("ev1");
    expect(rows.find((r) => r.id === entry!.id)?.undone).toBe(true);
  });

  it("refuses an undo once the window has passed", async () => {
    await decideEntry({ event: ev, code: "FF-SOLO000001", scannedBy: "vol1", online: false });
    const [entry] = await listToday("ev1");

    const result = await undoScan(entry!.id, entry!.at + UNDO_WINDOW_MS + 1);
    expect(result).toEqual({ ok: false, reason: "expired" });

    // Nothing was touched: the scan still stands.
    expect(await listQueue()).toHaveLength(1);
    const peek = await peekEntry("ev1", "FF-SOLO000001");
    expect(peek).toMatchObject({ complete: true });
  });

  it("canUndo and undoRemainingMs agree with the window", () => {
    const entry = { at: 1_000, outcome: "ok" as const, undone: false };
    expect(canUndo(entry, 1_000)).toBe(true);
    expect(canUndo(entry, 1_000 + UNDO_WINDOW_MS)).toBe(true);
    expect(canUndo(entry, 1_000 + UNDO_WINDOW_MS + 1)).toBe(false);
    expect(undoRemainingMs(entry, 1_000 + 10_000)).toBe(UNDO_WINDOW_MS - 10_000);
    expect(undoRemainingMs(entry, 1_000 + UNDO_WINDOW_MS + 500)).toBe(0);
  });

  it("refuses to undo a scan that already reached the server", async () => {
    await decideEntry({ event: ev, code: "FF-SOLO000001", scannedBy: "vol1", online: false });
    const [entry] = await listToday("ev1");

    // Simulate a successful sync: the queue item is gone, the record stands.
    const queued = await listQueue();
    for (const item of queued) {
      const { dequeue } = await import("@/lib/offline/db");
      await dequeue(item.id);
    }

    const result = await undoScan(entry!.id);
    expect(result).toEqual({ ok: false, reason: "synced" });
  });

  it("does not offer undo on a duplicate — there is nothing to take back", async () => {
    await decideEntry({ event: ev, code: "FF-SOLO000001", scannedBy: "vol1", online: false });
    await decideEntry({ event: ev, code: "FF-SOLO000001", scannedBy: "vol1", online: false });
    const rows = await listToday("ev1");
    const dup = rows.find((r) => r.outcome === "already-recorded");
    expect(dup).toBeDefined();
    expect(canUndo(dup!)).toBe(false);
  });
});

describe("manual search", () => {
  it("matches a registration id, ticket code, team name, member name or phone", async () => {
    expect((await manualSearch("ev1", "reg-team")).map((r) => r.registrationId)).toEqual(["reg-team"]);
    expect((await manualSearch("ev1", "FF-TEAMPASS01")).map((r) => r.registrationId)).toEqual(["reg-team"]);
    expect((await manualSearch("ev1", "Null Pointers")).map((r) => r.registrationId)).toEqual(["reg-team"]);
    expect((await manualSearch("ev1", "Rahul")).map((r) => r.registrationId)).toEqual(["reg-team"]);
    expect((await manualSearch("ev1", "+919000000002")).map((r) => r.registrationId)).toEqual(["reg-team"]);
    expect((await manualSearch("ev1", "Priya")).map((r) => r.registrationId)).toEqual(["reg-solo"]);
  });

  it("requires every term to match, narrowing rather than widening", async () => {
    // Search runs against the whole entry, not one member at a time — a
    // volunteer typing "arijit loyola" is narrowing in on the team, not
    // asserting Arijit personally studies there.
    expect((await manualSearch("ev1", "arijit loyola")).map((r) => r.registrationId)).toEqual(["reg-team"]);
    // A term nothing on the entry contains narrows the result to nothing.
    expect(await manualSearch("ev1", "arijit nonexistent")).toEqual([]);
    expect(await manualSearch("ev1", "priya loyola")).toEqual([]); // Priya's entry has no such text
  });

  it("is case-insensitive and returns nothing for an empty term", async () => {
    expect((await manualSearch("ev1", "NULL POINTERS")).map((r) => r.registrationId)).toEqual(["reg-team"]);
    expect(await manualSearch("ev1", "   ")).toEqual([]);
  });

  it("finds nothing for another event's roster", async () => {
    expect(await manualSearch("ev2", "Null Pointers")).toEqual([]);
  });
});

describe("offline queue and sync", () => {
  it("queues writes while offline and drains them once a repository is available", async () => {
    await decideEntry({ event: ev, code: "FF-SOLO000001", scannedBy: "vol1", online: false });
    expect(await listQueue()).toHaveLength(1);

    const recordScan = vi.fn().mockResolvedValue({ result: "ok", registration: { id: "reg-solo", userName: "Priya Menon", ticketCode: "FF-SOLO000001", memberCount: 1 } });
    const repos = { attendance: { recordScan, recordMeal: vi.fn() } } as never;

    const summary = await syncQueue(repos, "vol1");
    expect(summary).toEqual({ synced: 1, failed: 0 });
    expect(recordScan).toHaveBeenCalledTimes(1);
    expect(await listQueue()).toHaveLength(0);
  });

  it("preserves the original scan timestamp when syncing late", async () => {
    const before = Date.now();
    await decideEntry({ event: ev, code: "FF-SOLO000001", scannedBy: "vol1", online: false });
    const [queued] = await listQueue();
    expect(queued!.scannedAt).toBeGreaterThanOrEqual(before);

    const recordScan = vi.fn().mockImplementation(async (input: { scannedAt?: Date }) => {
      // The repository receives the moment of the original scan, not now.
      expect(input.scannedAt?.getTime()).toBe(queued!.scannedAt);
      return { result: "ok", registration: { id: "reg-solo", userName: "Priya Menon", ticketCode: "FF-SOLO000001", memberCount: 1 } };
    });
    await syncQueue({ attendance: { recordScan, recordMeal: vi.fn() } } as never, "vol1");
  });

  it("treats a server 'already-recorded' as synced, not as a failure — another device won the race", async () => {
    await decideEntry({ event: ev, code: "FF-SOLO000001", scannedBy: "vol1", online: false });
    const recordScan = vi.fn().mockResolvedValue({ result: "already-recorded", at: new Date(), by: "Other Volunteer" });
    const summary = await syncQueue({ attendance: { recordScan, recordMeal: vi.fn() } } as never, "vol1");
    expect(summary).toEqual({ synced: 1, failed: 0 });
    expect(await listQueue()).toHaveLength(0);
  });

  it("keeps a transient failure in the queue for the next attempt rather than dropping it", async () => {
    await decideEntry({ event: ev, code: "FF-SOLO000001", scannedBy: "vol1", online: false });
    const recordScan = vi.fn().mockRejectedValue(new Error("network unreachable"));
    const summary = await syncQueue({ attendance: { recordScan, recordMeal: vi.fn() } } as never, "vol1");
    expect(summary.failed).toBe(1);
    expect(await listQueue()).toHaveLength(1);
  });
});
