/**
 * A lossless, typed JSON encoding for Firestore values - the format of the billing-free backup (`docs/BACKUP-WITHOUT-BILLING.md`).
 *
 * Plain `JSON.stringify` of a document destroys information: a Timestamp becomes an object that no longer knows it is a
 * timestamp, a reference becomes a blob, bytes become a Buffer shape, NaN becomes null, an integer and a double are the same
 * number. Every non-JSON value is therefore wrapped as `{ "$": "<type>", ... }`; strings, booleans, null, arrays and plain
 * maps stay as they are. A map that itself has a field named `$` is wrapped too (`{ "$": "map", "v": {...} }`), so no
 * user data can be mistaken for a type tag. An unknown kind of value is an ERROR, never silently dropped or stringified.
 *
 * Read the database with `useBigInt: true`: then the SDK returns integers as BigInt and doubles as numbers, which is what lets
 * this tell `1` (integer) from `1.0` (double) at read time.
 *
 * Known limit, stated rather than hidden: the Node SDK WRITES a whole-number JS double as an integer. So a restore turns a
 * stored double that happens to be whole (1.0) into an integer (1). `compareDump` reports exactly that as a difference.
 */

import { DocumentReference, GeoPoint, Timestamp } from "firebase-admin/firestore";

const TAG = "$";

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const doubleToString = (n) => (Object.is(n, -0) ? "-0" : String(n));

/** Firestore value -> JSON-safe typed value. */
export const encodeValue = (value) => {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "bigint":
      return { [TAG]: "int", v: value.toString() };
    case "number":
      return { [TAG]: "double", v: doubleToString(value) };
    case "undefined":
      throw new Error("a Firestore document cannot hold undefined");
    default:
      break;
  }
  if (value instanceof Timestamp) return { [TAG]: "timestamp", s: String(value.seconds), n: value.nanoseconds };
  if (value instanceof Date) {
    const ts = Timestamp.fromDate(value);
    return { [TAG]: "timestamp", s: String(ts.seconds), n: ts.nanoseconds };
  }
  if (value instanceof GeoPoint) return { [TAG]: "geopoint", lat: value.latitude, lng: value.longitude };
  if (value instanceof DocumentReference) return { [TAG]: "ref", path: value.path };
  if (value instanceof Uint8Array) return { [TAG]: "bytes", b64: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encodeValue);
  // A vector value (Firestore vector search) exposes toArray().
  if (value && typeof value === "object" && value.constructor?.name === "VectorValue" && typeof value.toArray === "function") {
    return { [TAG]: "vector", v: value.toArray().map(doubleToString) };
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).map(([k, v]) => [k, encodeValue(v)]);
    const body = Object.fromEntries(entries);
    return Object.prototype.hasOwnProperty.call(value, TAG) ? { [TAG]: "map", v: body } : body;
  }
  throw new Error(`unsupported Firestore value of type ${value?.constructor?.name ?? typeof value}`);
};

const parseDouble = (text) => {
  if (text === "NaN") return NaN;
  if (text === "Infinity") return Infinity;
  if (text === "-Infinity") return -Infinity;
  if (text === "-0") return -0;
  const n = Number(text);
  if (Number.isNaN(n)) throw new Error(`invalid double "${text}"`);
  return n;
};

/**
 * Typed value -> Firestore value. `db` is needed only to rebuild references.
 * @param {unknown} value
 * @param {{ doc: (path: string) => unknown }} db
 */
export const decodeValue = (value, db) => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => decodeValue(item, db));
  if (!Object.prototype.hasOwnProperty.call(value, TAG)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeValue(v, db)]));
  }
  switch (value[TAG]) {
    case "int":
      return BigInt(value.v);
    case "double":
      return parseDouble(value.v);
    case "timestamp":
      return new Timestamp(Number(value.s), value.n);
    case "geopoint":
      return new GeoPoint(value.lat, value.lng);
    case "ref":
      return db.doc(value.path);
    case "bytes":
      return Buffer.from(value.b64, "base64");
    case "vector":
      throw new Error("vector values cannot be restored by this tool");
    case "map":
      return Object.fromEntries(Object.entries(value.v).map(([k, v]) => [k, decodeValue(v, db)]));
    default:
      throw new Error(`unknown type tag "${String(value[TAG])}"`);
  }
};

/**
 * Structural validation of an encoded value with no SDK objects built - what the offline `--verify` runs. Returns a list of
 * problems (empty when well formed); never throws and never includes a value.
 */
export const validateEncoded = (value, path = "") => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return [];
  if (typeof value !== "object") return [`${path || "(root)"}: not a JSON value`];
  if (Array.isArray(value)) return value.flatMap((item, i) => validateEncoded(item, `${path}[${i}]`));
  if (!Object.prototype.hasOwnProperty.call(value, TAG)) {
    return Object.entries(value).flatMap(([k, v]) => validateEncoded(v, path ? `${path}.${k}` : k));
  }
  const bad = (what) => [`${path || "(root)"}: ${what}`];
  switch (value[TAG]) {
    case "int":
      return typeof value.v === "string" && /^-?\d+$/.test(value.v) ? [] : bad("malformed int");
    case "double":
      return typeof value.v === "string" && (["NaN", "Infinity", "-Infinity", "-0"].includes(value.v) || !Number.isNaN(Number(value.v))) ? [] : bad("malformed double");
    case "timestamp":
      return typeof value.s === "string" && /^-?\d+$/.test(value.s) && Number.isInteger(value.n) && value.n >= 0 && value.n < 1e9 ? [] : bad("malformed timestamp");
    case "geopoint":
      return typeof value.lat === "number" && typeof value.lng === "number" ? [] : bad("malformed geopoint");
    case "ref":
      return typeof value.path === "string" && value.path.split("/").length % 2 === 0 ? [] : bad("malformed reference");
    case "bytes":
      return typeof value.b64 === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value.b64) ? [] : bad("malformed bytes");
    case "vector":
      return Array.isArray(value.v) ? [] : bad("malformed vector");
    case "map":
      return value.v && typeof value.v === "object" && !Array.isArray(value.v) ? Object.entries(value.v).flatMap(([k, v]) => validateEncoded(v, path ? `${path}.${k}` : k)) : bad("malformed map");
    default:
      return bad(`unknown type tag "${String(value[TAG])}"`);
  }
};

/** Encode a whole document's data. */
export const encodeData = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encodeValue(v)]));

/** Decode a whole document's data. */
export const decodeData = (data, db) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, decodeValue(v, db)]));

/** Stable text for an encoded value (object keys sorted), so two equal values compare equal as strings. */
export const canonicalize = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * The dotted paths of the fields where two encoded documents differ. Reports field names only, never values.
 * @returns {string[]}
 */
export const diffFields = (a, b, path = "") => {
  if (canonicalize(a) === canonicalize(b)) return [];
  const isMap = (v) => v && typeof v === "object" && !Array.isArray(v) && !Object.prototype.hasOwnProperty.call(v, TAG);
  if (isMap(a) && isMap(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].sort().flatMap((k) => diffFields(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return [path || "(root)"];
};
