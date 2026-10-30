import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@/core/models/event";
import type { Repositories } from "@/core/repositories";
import type { QueuedScan, RosterEntry } from "@/lib/offline/db";

/**
 * How long the people in the scanner's cache stay on a device, and whose they are.
 *
 * The roster is the names of everyone registered for the competitions a volunteer has worked. It must go when the
 * volunteer does (sign-out, another account taking over, a revoked role), when it is stale (an old version of the cache,
 * a competition long over), and it must never be shown to - or uploaded by - the wrong account.
 */

const { apiMock, ApiClientErrorMock } = vi.hoisted(() => {
  class ApiClientErrorMock extends Error {
    constructor(readonly status: number) {
      super(`status ${status}`);
    }
  }
  return { apiMock: vi.fn(), ApiClientErrorMock };
});

vi.mock("@/data/api-client", () => ({ api: apiMock, ApiClientError: ApiClientErrorMock }));

const db = await import("@/lib/offline/db");
const scanner = await import("@/lib/offline/scanner");
const { claimScannerCache, clearEventRoster, clearScannerCache, enqueue, getMeta, listQueue, purgeStaleRosters, replaceRoster, rosterSize, setMeta, SCANNER_CACHE_VERSION } = db;

const entry = (eventId: string, n: number): RosterEntry => ({
  ticketCode: `PS-TEST${eventId}${n}`,
  registrationId: `${eventId}-reg${n}`,
  eventId,
  festId: "fest1",
  userName: `Person ${n}`,
  memberCount: 1,
  status: "confirmed",
  members: [{ key: `k${n}`, name: `Person ${n}`, email: `p___@x.test` }],
  search: `person ${n}`,
});

const scan = (id: string, ownerUid?: string): QueuedScan => ({
  id,
  kind: "entry",
  eventId: "ev1",
  festId: "fest1",
  registrationId: `ev1-${id}`,
  ticketCode: `PS-TEST${id}`,
  scannedAt: Date.now(),
  attempts: 0,
  ...(ownerUid ? { ownerUid } : {}),
});

const event = { id: "ev1", festId: "fest1", title: "Capture the Flag", mealSlots: [] } as unknown as Event;

beforeEach(async () => {
  apiMock.mockReset();
  for (const item of await listQueue()) await db.dequeue(item.id);
  await clearScannerCache();
  await db.setMeta("cache:owner", null);
  await db.setMeta("cache:version", null);
});

describe("a cache belongs to one account", () => {
  it("keeps the signed-in account's own roster across opens", async () => {
    await claimScannerCache("vol-a");
    await replaceRoster("ev1", [entry("ev1", 1)]);
    await claimScannerCache("vol-a");
    expect(await rosterSize("ev1")).toBe(1);
    expect(await getMeta("cache:owner")).toBe("vol-a");
  });

  it("empties it the moment a different account takes the device, with no sign-out in between", async () => {
    await claimScannerCache("vol-a");
    await replaceRoster("ev1", [entry("ev1", 1), entry("ev1", 2)]);
    await db.setMeta("roster:ev1:refreshedAt", Date.now());

    await claimScannerCache("vol-b");
    expect(await rosterSize("ev1")).toBe(0);
    expect(await getMeta("roster:ev1:refreshedAt")).toBeNull();
    expect(await getMeta("cache:owner")).toBe("vol-b");
  });

  it("empties a cache written under an older version, even for the same account", async () => {
    await claimScannerCache("vol-a");
    await replaceRoster("ev1", [entry("ev1", 1)]);
    await setMeta("cache:version", SCANNER_CACHE_VERSION - 1);

    await claimScannerCache("vol-a");
    expect(await rosterSize("ev1")).toBe(0);
    expect(await getMeta("cache:version")).toBe(SCANNER_CACHE_VERSION);
  });

  it("treats a cache with no version at all as old, so a roster from before the privacy changes does not linger", async () => {
    await replaceRoster("ev1", [entry("ev1", 1)]);
    await claimScannerCache("vol-a");
    expect(await rosterSize("ev1")).toBe(0);
  });

  it("never touches a scan waiting to upload when the cache changes hands", async () => {
    await claimScannerCache("vol-a");
    await enqueue(scan("q1", "vol-a"));
    await claimScannerCache("vol-b");
    expect((await listQueue()).map((q) => q.id)).toEqual(["q1"]);
  });
});

describe("a queued scan is uploaded by the account that made it", () => {
  const repos = (recordScan: ReturnType<typeof vi.fn>) => ({ attendance: { recordScan, recordMeal: vi.fn() } }) as unknown as Repositories;
  const ok = { result: "ok", registration: { id: "r", userName: "P", ticketCode: "t", memberCount: 1 } };

  it("syncs its own and leaves another account's waiting", async () => {
    await enqueue(scan("mine", "vol-a"));
    await enqueue(scan("theirs", "vol-b"));
    const recordScan = vi.fn().mockResolvedValue(ok);

    const result = await scanner.syncQueue(repos(recordScan), "vol-a");

    expect(result.synced).toBe(1);
    expect(recordScan).toHaveBeenCalledTimes(1);
    expect(recordScan.mock.calls[0]![0]).toMatchObject({ ticketCode: "PS-TESTmine", scannedBy: "vol-a" });
    expect((await listQueue()).map((q) => q.id)).toEqual(["theirs"]);

    // And it goes up when its owner is back.
    await scanner.syncQueue(repos(recordScan), "vol-b");
    expect(recordScan).toHaveBeenCalledTimes(2);
    expect(await listQueue()).toEqual([]);
  });

  it("still syncs scans queued before owners were recorded", async () => {
    await enqueue(scan("old"));
    const recordScan = vi.fn().mockResolvedValue(ok);
    expect((await scanner.syncQueue(repos(recordScan), "vol-a")).synced).toBe(1);
  });

  it("stamps the scanning account on every scan it queues", async () => {
    await replaceRoster("ev1", [entry("ev1", 1)]);
    await scanner.decideEntry({ event, code: "PS-TESTev11", scannedBy: "vol-z", online: false });
    expect((await listQueue())[0]).toMatchObject({ kind: "entry", ownerUid: "vol-z" });
  });
});

describe("the names do not outlive the permission to see them", () => {
  it("drops one competition's people when the server says the volunteer no longer has it, and keeps the others and the queue", async () => {
    await replaceRoster("ev1", [entry("ev1", 1)]);
    await replaceRoster("ev2", [entry("ev2", 1)]);
    await enqueue(scan("q1", "vol-a"));
    await setMeta("roster:ev1:refreshedAt", Date.now());

    await clearEventRoster("ev1");

    expect(await rosterSize("ev1")).toBe(0);
    expect(await rosterSize("ev2")).toBe(1);
    expect(await getMeta("roster:ev1:refreshedAt")).toBeNull();
    expect(await listQueue()).toHaveLength(1);
  });

  it("clears a competition's roster when a refresh is refused (revoked, suspended, reassigned, gone)", async () => {
    for (const status of [403, 404]) {
      await replaceRoster("ev1", [entry("ev1", 1)]);
      apiMock.mockRejectedValueOnce(new ApiClientErrorMock(status));
      await expect(scanner.refreshRoster(event)).rejects.toBeInstanceOf(ApiClientErrorMock);
      expect(await rosterSize("ev1"), `status ${status}`).toBe(0);
    }
  });

  it("keeps the roster through an outage, which says nothing about permission", async () => {
    await replaceRoster("ev1", [entry("ev1", 1)]);
    apiMock.mockRejectedValueOnce(new ApiClientErrorMock(503));
    await expect(scanner.refreshRoster(event)).rejects.toBeInstanceOf(ApiClientErrorMock);
    expect(await rosterSize("ev1")).toBe(1);
  });

  it("replaces the whole roster on a successful refresh, so a person who left the entry no longer shows", async () => {
    await replaceRoster("ev1", [entry("ev1", 1), entry("ev1", 2)]);
    apiMock.mockResolvedValueOnce({ roster: [entry("ev1", 2)], checkins: [], meals: [] });
    await scanner.refreshRoster(event);
    expect(await rosterSize("ev1")).toBe(1);
  });

  it("purges rosters of competitions not refreshed for a week, and keeps recent ones", async () => {
    const now = Date.now();
    await replaceRoster("old", [entry("old", 1)]);
    await replaceRoster("recent", [entry("recent", 1)]);
    await setMeta("roster:old:refreshedAt", now - 8 * 24 * 60 * 60 * 1000);
    await setMeta("roster:recent:refreshedAt", now - 60 * 60 * 1000);

    expect(await purgeStaleRosters(undefined, now)).toBe(1);
    expect(await rosterSize("old")).toBe(0);
    expect(await rosterSize("recent")).toBe(1);
    expect(await getMeta("roster:old:refreshedAt")).toBeNull();
  });
});
