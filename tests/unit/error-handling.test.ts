// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError, z } from "zod";
import { ApiError, PUBLIC_MESSAGES, describeError, toClientError } from "@/server/errors";
import { handler } from "@/server/api";
import { AdminNotConfiguredError } from "@/server/firebase-admin";
import { toRepositoryError } from "@/data/firebase/mapping";

/**
 * Regression tests: no internal detail may reach a client, in production or
 * development, whatever is thrown. Every response body is checked against a
 * list of strings that would betray the stack, the filesystem, Firebase, the
 * environment or the service account.
 */

const SENSITIVE = [
  "    at ", // stack frames
  "node_modules",
  "/var/task",
  "C:\\\\",
  ".ts:",
  ".js:",
  "firebase-admin",
  "Firestore",
  "gserviceaccount",
  "FIREBASE_SERVICE_ACCOUNT",
  "PERMISSION_DENIED",
  "collection(",
  "users/",
  "BEGIN PRIVATE KEY",
  "ENOENT",
];

const hostileErrors = (): Array<[string, unknown]> => {
  const stacky = new Error("7 PERMISSION_DENIED: Missing or insufficient permissions on collection(users/abc)");
  stacky.stack = `Error: 7 PERMISSION_DENIED\n    at Firestore.getAll (/var/task/node_modules/@google-cloud/firestore/build/src/index.js:123:45)\n    at handler (C:\\\\src\\\\server\\\\api.ts:10:1)`;
  const fs = Object.assign(new Error("ENOENT: no such file or directory, open '/var/task/.env'"), { code: "ENOENT" });
  const sa = new Error("Credential failed for firebase-adminsdk-fbsvc@proj.iam.gserviceaccount.com: -----BEGIN PRIVATE KEY----- MIIE");
  const grpc = Object.assign(new Error("14 UNAVAILABLE: Firestore backend unreachable at firestore.googleapis.com"), { code: 14 });
  const contention = Object.assign(new Error("3 INVALID_ARGUMENT: Transaction is invalid or closed."), { code: 3 });
  const nonError = { weird: "object", path: "/var/task/node_modules/x.js" };
  return [
    ["Admin SDK permission error with stack", stacky],
    ["filesystem error", fs],
    ["service account error", sa],
    ["gRPC UNAVAILABLE", grpc],
    ["lost transaction", contention],
    ["non-Error throw", nonError],
    ["string throw", "boom at /var/task/node_modules/secret.js"],
  ];
};

const run = async (thrown: unknown) => {
  const route = handler(async () => {
    throw thrown;
  });
  const res = await route(new Request("http://localhost/api/test", { method: "GET" }), { params: Promise.resolve({}) });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown>, headers: res.headers };
};

const expectClean = (text: string) => {
  for (const marker of SENSITIVE) expect(text, `response leaks "${marker}"`).not.toContain(marker);
};

import type { MockInstance } from "vitest";

let errorSpy: MockInstance<typeof console.error>;
let warnSpy: MockInstance<typeof console.warn>;
let infoSpy: MockInstance<typeof console.info>;

beforeEach(() => {
  process.env.RATE_LIMIT_DISABLED = "1";
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  infoSpy.mockRestore();
});

describe("handler() in production", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "production"));

  it.each(hostileErrors())("hides internals for: %s", async (_label, thrown) => {
    const { status, text, body } = await run(thrown);
    expect([500, 503]).toContain(status);
    expectClean(text);
    expect(body.error).toMatch(/^(Something went wrong on our side|The service is briefly unavailable)/);
    expect(body).not.toHaveProperty("debug");
    expect(body).not.toHaveProperty("stack");
    expect(typeof body.requestId).toBe("string");
  });

  it("maps transient Firestore failures to 503 with Retry-After, everything else to 500", async () => {
    const unavailable = await run(Object.assign(new Error("14 UNAVAILABLE"), { code: 14 }));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("3");
    const lost = await run(Object.assign(new Error("3 INVALID_ARGUMENT: Transaction is invalid or closed."), { code: 3 }));
    expect(lost.status).toBe(503);
    const bug = await run(new TypeError("Cannot read properties of undefined (reading 'data')"));
    expect(bug.status).toBe(500);
    expect(bug.body.code).toBe("internal");
  });

  it("does not name the environment variable when the Admin SDK is not configured", async () => {
    const { status, text, body } = await run(new AdminNotConfiguredError("FIREBASE_SERVICE_ACCOUNT is empty."));
    expect(status).toBe(503);
    expect(body.code).toBe("not-configured");
    expectClean(text);
    expect(text).not.toContain("SERVICE_ACCOUNT");
  });

  it("logs the full error with context server-side and reports nothing sensitive to the client", async () => {
    const [, stacky] = hostileErrors()[0]!;
    const { text } = await run(stacky);
    expectClean(text);
    const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[error]");
    expect(logged).toContain("PERMISSION_DENIED"); // the operator sees it
    expect(logged).toContain("/var/task/node_modules"); // stack is kept in the log
    expect(logged).toContain('"path":"/api/test"');
    expect(logged).toContain('"kind":"unhandled"');
  });

  it("passes through deliberate ApiErrors unchanged, with the right status", async () => {
    const cases: Array<[ApiError, number]> = [
      [ApiError.unauthorized(), 401],
      [ApiError.forbidden(), 403],
      [ApiError.notFound("That event no longer exists."), 404],
      [ApiError.conflict("You already hold an entry for this event."), 409],
      [ApiError.unprocessable("This event is full."), 422],
      [ApiError.tooMany(undefined, 42), 429],
      [ApiError.unavailable(), 503],
    ];
    for (const [error, status] of cases) {
      const res = await run(error);
      expect(res.status, error.code).toBe(status);
      expect(res.body.error).toBe(error.message);
      expect(res.body.code).toBe(error.code);
      expectClean(res.text);
    }
    const tooMany = await run(ApiError.tooMany(undefined, 42));
    expect(tooMany.headers.get("retry-after")).toBe("42");
    expect(tooMany.body.retryAfter).toBe(42);
  });

  it("returns field names, not schema internals, for validation errors", async () => {
    const schema = z.object({ email: z.string().email(), members: z.array(z.object({ name: z.string().min(1) })) });
    const parsed = schema.safeParse({ email: "nope", members: [{ name: "" }] });
    const { status, body, text } = await run(parsed.success ? new Error("unexpected") : parsed.error);
    expect(status).toBe(400);
    expect(body.details).toMatchObject({ email: expect.any(String), "members.0.name": expect.any(String) });
    expectClean(text);
  });

  it("labels every response with a request id, honouring one the client sent", async () => {
    const route = handler(async () => {
      throw new Error("x");
    });
    const res = await route(new Request("http://localhost/api/t", { headers: { "x-request-id": "abc-123" } }), { params: Promise.resolve({}) });
    expect(res.headers.get("x-request-id")).toBe("abc-123");
    expect(((await res.json()) as { requestId: string }).requestId).toBe("abc-123");
  });
});

describe("handler() in development", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "development"));

  it("adds a debug block with name and message, but still no stack or paths in it", async () => {
    const [, stacky] = hostileErrors()[0]!;
    const { body } = await run(stacky);
    expect(body.debug).toMatchObject({ name: "Error", message: expect.stringContaining("PERMISSION_DENIED") });
    expect(JSON.stringify(body)).not.toContain("    at ");
    expect(JSON.stringify(body)).not.toContain("node_modules");
    expect(body.error).toBe(PUBLIC_MESSAGES[500]); // the human line stays generic even in dev
  });

  it("names the missing variable for the developer when the Admin SDK is not configured", async () => {
    const { body } = await run(new AdminNotConfiguredError("FIREBASE_SERVICE_ACCOUNT is empty."));
    expect(body.error).toContain("FIREBASE_SERVICE_ACCOUNT");
  });
});

describe("toClientError / describeError", () => {
  it("never carries a stack into the client shape", () => {
    for (const [, thrown] of hostileErrors()) {
      const json = JSON.stringify(toClientError(thrown, "rid"));
      expect(json).not.toContain("    at ");
      expect(json).not.toContain("stack");
    }
  });
  it("describeError keeps stack, code and cause chain for the operator", () => {
    const inner = Object.assign(new Error("inner"), { code: 7 });
    const outer = new Error("outer", { cause: inner });
    const d = describeError(outer);
    expect(d.stack).toContain("outer");
    expect(d.cause).toMatchObject({ message: "inner", code: 7 });
  });
  it("ZodError handled even when thrown directly", () => {
    const e = new ZodError([]);
    expect(toClientError(e).status).toBe(400);
  });
});

describe("client repositories (toRepositoryError)", () => {
  it("replaces raw SDK and parse messages with the operation context", () => {
    const raw = new Error("Firebase: Error (auth/network-request-failed) at https://identitytoolkit.googleapis.com/v1/accounts");
    const mapped = toRepositoryError(raw, "Loading your events");
    expect(mapped.message).toBe("Loading your events failed. Please try again.");
    expect(mapped.message).not.toContain("googleapis");
    expect(mapped.cause).toBe(raw); // kept for logs
    const parse = toRepositoryError(new Error("Server returned an unexpected registration shape"), "Registering");
    expect(parse.message).toBe("Registering failed. Please try again.");
  });
});
