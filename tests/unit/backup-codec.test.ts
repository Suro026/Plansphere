// @vitest-environment node
import { Firestore, GeoPoint, Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { canonicalize, decodeData, decodeValue, diffFields, encodeData, encodeValue, validateEncoded } from "../../scripts/lib/backup-codec.mjs";

/**
 * The billing-free backup writes Firestore documents as typed JSON. These tests pin that no kind of value is lost or changed
 * on the way out and back, that user data can never be mistaken for a type tag, and that anything the format cannot hold is an
 * error rather than silent loss.
 */

// A Firestore handle that is never connected: enough to build document references.
const db = new Firestore({ projectId: "backup-codec-test" });

const roundTrip = (value: unknown) => decodeValue(JSON.parse(JSON.stringify(encodeValue(value))), db);

describe("every Firestore value type survives the round trip", () => {
  it("strings, booleans and null are left as they are", () => {
    for (const v of ["", "héllo ✓ 😀", true, false, null]) expect(roundTrip(v)).toBe(v);
    expect(encodeValue("plain")).toBe("plain");
  });

  it("an integer and a double stay different kinds", () => {
    expect(encodeValue(5n)).toEqual({ $: "int", v: "5" });
    expect(encodeValue(5)).toEqual({ $: "double", v: "5" });
    expect(roundTrip(5n)).toBe(5n);
    expect(roundTrip(5)).toBe(5);
  });

  it("integers beyond 2^53 keep every digit", () => {
    const big = 9007199254740993n;
    expect(roundTrip(big)).toBe(big);
    expect(roundTrip(-9223372036854775808n)).toBe(-9223372036854775808n);
  });

  it("doubles keep their exact value, including the ones JSON cannot hold", () => {
    for (const n of [0.1, -1.5e-300, Number.MAX_VALUE, Number.MIN_VALUE, Infinity, -Infinity]) expect(roundTrip(n)).toBe(n);
    expect(Number.isNaN(roundTrip(NaN) as number)).toBe(true);
    expect(Object.is(roundTrip(-0), -0)).toBe(true);
  });

  it("timestamps keep nanosecond precision and dates before 1970", () => {
    for (const ts of [new Timestamp(1_700_000_000, 123_456_789), new Timestamp(-86_400, 1), new Timestamp(0, 0), new Timestamp(253_402_300_799, 999_999_999)]) {
      const back = roundTrip(ts) as Timestamp;
      expect(back).toBeInstanceOf(Timestamp);
      expect(back.isEqual(ts)).toBe(true);
    }
  });

  it("a JS Date is stored as a timestamp", () => {
    expect((roundTrip(new Date("2026-10-29T12:34:56.789Z")) as Timestamp).toDate().toISOString()).toBe("2026-10-29T12:34:56.789Z");
  });

  it("geo points", () => {
    const back = roundTrip(new GeoPoint(-33.8688, 151.2093)) as GeoPoint;
    expect(back).toBeInstanceOf(GeoPoint);
    expect(back.isEqual(new GeoPoint(-33.8688, 151.2093))).toBe(true);
  });

  it("document references come back as references to the same path", () => {
    const ref = db.doc("fests/f1/events/e1");
    expect(encodeValue(ref)).toEqual({ $: "ref", path: "fests/f1/events/e1" });
    expect((roundTrip(ref) as { path: string }).path).toBe("fests/f1/events/e1");
  });

  it("bytes, including every byte value", () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const back = roundTrip(bytes) as Buffer;
    expect(Buffer.isBuffer(back)).toBe(true);
    expect(back.equals(bytes)).toBe(true);
    expect((roundTrip(new Uint8Array([1, 2, 3])) as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("nested maps and arrays of every kind", () => {
    const doc = {
      name: "Fest",
      stats: { events: 3n, ratio: 0.5, nested: { deep: [1n, 2.5, "x", null, { when: new Timestamp(10, 5) }] } },
      tags: [],
      empty: {},
      at: new GeoPoint(1, 2),
      ref: db.doc("a/b"),
      raw: Buffer.from("hi"),
    };
    const back = decodeData(JSON.parse(JSON.stringify(encodeData(doc))), db) as typeof doc;
    expect(canonicalize(encodeData(back))).toBe(canonicalize(encodeData(doc)));
    expect(back.stats.nested.deep[0]).toBe(1n);
    expect(back.stats.nested.deep[1]).toBe(2.5);
    expect(back.empty).toEqual({});
    expect(back.tags).toEqual([]);
  });
});

describe("user data can never be mistaken for a type tag", () => {
  it("a map with a field named $ is wrapped, and comes back exactly", () => {
    const tricky = { $: "int", v: "42" };
    const encoded = encodeValue(tricky);
    expect(encoded).toEqual({ $: "map", v: { $: "int", v: "42" } });
    expect(roundTrip(tricky)).toEqual({ $: "int", v: "42" });
  });

  it("a string that looks like a tag stays a string", () => {
    expect(roundTrip('{"$":"int","v":"1"}')).toBe('{"$":"int","v":"1"}');
  });

  it("a nested $ map is wrapped at every level", () => {
    const v = { a: { $: "timestamp", s: "1", n: 0 }, b: [{ $: "ref", path: "x/y" }] };
    expect(roundTrip(v)).toEqual(v);
  });
});

describe("what the format cannot hold is an error, not silent loss", () => {
  it("refuses undefined, functions, symbols and unknown classes", () => {
    expect(() => encodeValue(undefined)).toThrow(/undefined/);
    expect(() => encodeValue(() => 1)).toThrow(/unsupported/);
    expect(() => encodeValue(Symbol("x"))).toThrow(/unsupported/);
    expect(() => encodeValue(new (class Odd {})())).toThrow(/unsupported/);
    expect(() => encodeValue({ ok: 1n, bad: undefined })).toThrow(/undefined/);
  });

  it("refuses an unknown tag when decoding", () => {
    expect(() => decodeValue({ $: "mystery" }, db)).toThrow(/unknown type tag/);
  });
});

describe("structural validation (what the offline --verify runs)", () => {
  it("accepts everything the encoder produces", () => {
    const doc = encodeData({ a: 1n, b: 2.5, c: new Timestamp(1, 2), d: new GeoPoint(1, 2), e: db.doc("a/b"), f: Buffer.from("x"), g: { $: "x" }, h: [1n, { k: "v" }] });
    expect(validateEncoded(doc)).toEqual([]);
  });

  it("names the field of every malformed value, and never the value", () => {
    const problems = validateEncoded({
      ok: "fine",
      badInt: { $: "int", v: "12.5" },
      nested: { badTs: { $: "timestamp", s: "abc", n: 0 }, badRef: { $: "ref", path: "only-one-segment" } },
      badTag: { $: "wat" },
      list: [{ $: "bytes", b64: "%%%" }],
    });
    expect(problems.map((p) => p.split(":")[0]).sort()).toEqual(["badInt", "badTag", "list[0]", "nested.badRef", "nested.badTs"]);
    expect(problems.join(" ")).not.toContain("12.5");
  });
});

describe("comparison reports field names, never values", () => {
  it("is empty for equal documents regardless of key order", () => {
    expect(diffFields(encodeData({ a: 1n, b: { c: "x", d: 2n } }), encodeData({ b: { d: 2n, c: "x" }, a: 1n }))).toEqual([]);
  });

  it("lists the dotted path of each differing, missing or extra field", () => {
    const a = encodeData({ same: 1n, changed: "old", nested: { x: 1n, y: 2n }, onlyA: true });
    const b = encodeData({ same: 1n, changed: "new", nested: { x: 1n, y: 3n }, onlyB: true });
    expect(diffFields(a, b)).toEqual(["changed", "nested.y", "onlyA", "onlyB"]);
  });

  it("tells an integer from a double, which is how a lossy restore is caught", () => {
    expect(diffFields(encodeData({ n: 1 }), encodeData({ n: 1n }))).toEqual(["n"]);
  });

  it("treats a changed timestamp as one field, not its parts", () => {
    expect(diffFields(encodeData({ t: new Timestamp(1, 1) }), encodeData({ t: new Timestamp(1, 2) }))).toEqual(["t"]);
  });
});
