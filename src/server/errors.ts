import * as Sentry from "@sentry/nextjs";
import { ZodError } from "zod";
import { AdminNotConfiguredError } from "./firebase-admin";

/**
 * Centralised error handling for everything that runs on the server.
 *
 * Two audiences, two shapes:
 *
 *   the client  — `toClientError(error)`: a status, a short stable `code`, a
 *                 sentence written for a person, and a request id. Never a
 *                 stack, a path, a collection name, an SDK message, or an
 *                 environment variable. In development only, a `debug` block
 *                 with the error name and message (still no stack).
 *
 *   the operator — `describeError(error)` + `logError(...)`: name, message,
 *                 code, stack, cause chain and request context, as one JSON
 *                 line, plus Sentry for anything unexpected.
 *
 * The rule: anything that is not an `ApiError` we threw on purpose is an
 * internal detail and is replaced by the generic message for its status.
 */

/* ───────────── the one error routes throw on purpose ───────────── */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, "bad-request", message, details);
  }

  static unauthorized(message: string = PUBLIC_MESSAGES[401]) {
    return new ApiError(401, "unauthenticated", message);
  }

  static forbidden(message: string = PUBLIC_MESSAGES[403]) {
    return new ApiError(403, "forbidden", message);
  }

  static notFound(message: string = PUBLIC_MESSAGES[404]) {
    return new ApiError(404, "not-found", message);
  }

  static conflict(message: string) {
    return new ApiError(409, "conflict", message);
  }

  static unprocessable(message: string) {
    return new ApiError(422, "unprocessable", message);
  }

  static tooMany(message: string = PUBLIC_MESSAGES[429], retryAfter?: number) {
    return new ApiError(429, "rate-limited", message, retryAfter !== undefined ? { retryAfter } : undefined);
  }

  static unavailable(message: string = PUBLIC_MESSAGES[503]) {
    return new ApiError(503, "unavailable", message);
  }
}

/* ───────────── what people see ───────────── */

/** Generic copy per status. Used whenever the real cause must stay internal. */
export const PUBLIC_MESSAGES = {
  400: "Some fields need fixing.",
  401: "Sign in to continue.",
  403: "You do not have permission to do that.",
  404: "Not found.",
  409: "That conflicts with something that already exists.",
  422: "That request can’t be completed as it is.",
  429: "Too many requests. Try again shortly.",
  500: "Something went wrong on our side. Please try again.",
  503: "The service is briefly unavailable. Nothing was changed — try again in a few seconds.",
} as const;

export type PublicStatus = keyof typeof PUBLIC_MESSAGES;

export interface ClientError {
  status: number;
  body: {
    error: string;
    code: string;
    requestId?: string;
    details?: unknown;
    retryAfter?: number;
    /** Development only — name and message, never a stack. */
    debug?: { name: string; message: string };
  };
  headers?: Record<string, string>;
  /** How the operator log should classify it. */
  kind: "expected" | "config" | "transient" | "validation" | "unhandled";
}

const isProduction = () => process.env.NODE_ENV === "production";

/** gRPC codes from the Admin SDK that mean "Firestore is having a moment", not "we have a bug". */
const TRANSIENT_FIRESTORE = new Set([4, 8, 10, 13, 14]); // DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, ABORTED, INTERNAL, UNAVAILABLE

export const isTransientFirestore = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? Number((error as { code: unknown }).code) : NaN;
  if (TRANSIENT_FIRESTORE.has(code)) return true;
  // A transaction that lost every retry under contention comes back as
  // INVALID_ARGUMENT with this message; it is a "try again", not a bug.
  const message = error instanceof Error ? error.message : "";
  return /Transaction is invalid or closed|too much contention/i.test(message);
};

/** Zod issues → `{ "members.1.email": "Invalid email" }`, field names only. */
export const fieldErrors = (error: ZodError): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_";
    if (!out[path]) out[path] = issue.message;
  }
  return out;
};

/**
 * Decides what the client is told. Pure: no logging, no Sentry.
 */
export const toClientError = (error: unknown, requestId?: string): ClientError => {
  const debug = !isProduction() && error instanceof Error ? { debug: { name: error.name, message: error.message } } : {};

  if (error instanceof ApiError) {
    const retryAfter = typeof (error.details as { retryAfter?: unknown } | undefined)?.retryAfter === "number" ? (error.details as { retryAfter: number }).retryAfter : undefined;
    return {
      status: error.status,
      kind: "expected",
      body: {
        error: error.message,
        code: error.code,
        ...(error.details !== undefined && retryAfter === undefined ? { details: error.details } : {}),
        ...(retryAfter !== undefined ? { retryAfter } : {}),
      },
      ...(retryAfter !== undefined ? { headers: { "Retry-After": String(retryAfter) } } : {}),
    };
  }

  if (error instanceof ZodError) {
    return { status: 400, kind: "validation", body: { error: PUBLIC_MESSAGES[400], code: "bad-request", details: fieldErrors(error) } };
  }

  if (error instanceof AdminNotConfiguredError) {
    // The env-var name is useful to a developer and useless to an attacker,
    // but it still describes our deployment; production gets the generic line.
    return {
      status: 503,
      kind: "config",
      body: { error: isProduction() ? PUBLIC_MESSAGES[503] : error.message, code: "not-configured", ...(requestId ? { requestId } : {}), ...debug },
      headers: { "Retry-After": "30" },
    };
  }

  if (isTransientFirestore(error)) {
    return {
      status: 503,
      kind: "transient",
      body: { error: PUBLIC_MESSAGES[503], code: "unavailable", ...(requestId ? { requestId } : {}), ...debug },
      headers: { "Retry-After": "3" },
    };
  }

  return {
    status: 500,
    kind: "unhandled",
    body: { error: PUBLIC_MESSAGES[500], code: "internal", ...(requestId ? { requestId } : {}), ...debug },
  };
};

/* ───────────── what operators see ───────────── */

export interface ErrorDescription {
  name: string;
  message: string;
  code?: string | number;
  status?: number;
  stack?: string;
  cause?: ErrorDescription;
}

/** Everything about an error, for logs and Sentry. Follows `cause` three levels. */
export const describeError = (error: unknown, depth = 0): ErrorDescription => {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: string | number; status?: number; cause?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(withCode.code !== undefined ? { code: withCode.code } : {}),
      ...(withCode.status !== undefined ? { status: withCode.status } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
      ...(withCode.cause !== undefined && depth < 3 ? { cause: describeError(withCode.cause, depth + 1) } : {}),
    };
  }
  return { name: "NonError", message: typeof error === "string" ? error : JSON.stringify(error) };
};

export interface ErrorContext {
  requestId?: string;
  method?: string;
  path?: string;
  uid?: string | null;
  ip?: string;
  [key: string]: unknown;
}

/**
 * Logs the full error server-side with its context, and reports to Sentry
 * for anything that was not an expected `ApiError`. Never returns anything
 * the client should see.
 */
export const logError = (error: unknown, context: ErrorContext, kind: ClientError["kind"]): void => {
  const described = describeError(error);
  if (kind === "expected" || kind === "validation") {
    // Not our bug; a warning-level line without the stack is enough to see patterns.
    const brief = { name: described.name, message: described.message, ...(described.code !== undefined ? { code: described.code } : {}), ...(described.status !== undefined ? { status: described.status } : {}) };
    console.warn("[error]", JSON.stringify({ at: "error", kind, ...context, error: brief }));
    return;
  }
  const line = JSON.stringify({ at: "error", kind, ...context, error: described });
  console.error("[error]", line);
  Sentry.captureException(error, {
    tags: { kind, ...(context.requestId ? { requestId: context.requestId } : {}) },
    extra: { ...context },
    level: kind === "transient" ? "warning" : "error",
  });
};
