import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearEvent, clearScannerCache, enqueue, listQueue, queueLength, replaceRoster, rosterSize, type QueuedScan, type RosterEntry } from "@/lib/offline/db";

/**
 * Signing out of the scanner empties the roster cached on the device (the names of everyone registered) - but never a
 * scan that has not reached the server yet.
 */

const entry = (n: number): RosterEntry => ({
  ticketCode: `PS-TEST00000${n}`,
  registrationId: `reg${n}`,
  eventId: "ev1",
  festId: "fest1",
  userId: `u${n}`,
  userName: `Person ${n}`,
  userEmail: `p${n}@x.test`,
  memberCount: 1,
  status: "confirmed",
  members: [{ key: `k${n}`, name: `Person ${n}`, email: `p${n}@x.test`, phone: "+919800000000" }],
  search: `person ${n}`,
});

const queued: QueuedScan = { id: "q1", kind: "entry", eventId: "ev1", festId: "fest1", registrationId: "reg1", ticketCode: "PS-TEST000001", scannedAt: Date.now(), attempts: 0 };

beforeEach(async () => {
  await clearEvent("ev1");
  for (const item of await listQueue()) await clearEvent(item.eventId);
});

describe("clearScannerCache", () => {
  it("empties the cached roster when nothing is waiting to upload", async () => {
    await replaceRoster("ev1", [entry(1), entry(2)]);
    expect(await rosterSize("ev1")).toBe(2);

    expect(await clearScannerCache()).toBe(true);
    expect(await rosterSize("ev1")).toBe(0);
  });

  it("empties the roster even while a scan is still queued, keeps only that scan, and says the device is not entirely clean", async () => {
    await replaceRoster("ev1", [entry(1)]);
    await enqueue(queued);

    // Nothing in the roster is needed to upload a queued scan (the server resolves the ticket itself), so the people go;
    // the scan, which already happened at the gate, stays.
    expect(await clearScannerCache()).toBe(false);
    expect(await rosterSize("ev1")).toBe(0);
    expect(await queueLength()).toBe(1);
  });

  it("is harmless on a device that never scanned anything", async () => {
    expect(await clearScannerCache()).toBe(true);
  });
});
