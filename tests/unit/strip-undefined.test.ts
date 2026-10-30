import { describe, expect, it } from "vitest";
import { Timestamp, increment, serverTimestamp } from "firebase/firestore";
import { stripUndefined } from "@/data/firebase/mapping";

describe("stripUndefined", () => {
  it("drops undefined at every plain-object level", () => {
    expect(stripUndefined({ a: 1, b: undefined, nested: { c: undefined, d: 2 } })).toEqual({ a: 1, nested: { d: 2 } });
  });

  it("hands Firestore sentinels through untouched instead of copying them into maps", () => {
    const stamp = serverTimestamp();
    const bump = increment(1);
    const now = Timestamp.now();
    const out = stripUndefined({ createdAt: stamp, count: bump, at: now, when: new Date(0), gone: undefined });

    expect(out.createdAt).toBe(stamp);
    expect(out.count).toBe(bump);
    expect(out.at).toBe(now);
    expect(out.when).toBeInstanceOf(Date);
    expect("gone" in out).toBe(false);
  });
});
