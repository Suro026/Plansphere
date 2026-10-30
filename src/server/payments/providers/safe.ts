import type { PaymentCredentials, PaymentProviderAdapter, ProviderContext } from "./types";
import { OrderTerminalError } from "./types";

/**
 * Everything an adapter does passes through here before the rest of the app
 * sees it.
 *
 * Why: a provider SDK or HTTP client error will happily put the request URL,
 * headers or body — credentials included — into its message, and the app logs
 * error messages and sends them to Sentry. An adapter author cannot be relied
 * on to remember. So the app does not trust adapter errors: it replaces them
 * with a `ProviderError` whose message has been scrubbed of every credential
 * value the merchant gave us and of anything that looks like a secret, with the
 * original (`cause`, stack) dropped.
 */

export class ProviderError extends Error {
  readonly operation: string;
  constructor(operation: string, message: string) {
    super(message);
    this.name = "ProviderError";
    this.operation = operation;
  }
}

const SECRET_SHAPES: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [redacted]"],
  [/((?:api[_-]?key|secret|token|password|passwd|signature|authorization|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi, "$1[redacted]"],
  [/([?&](?:api[_-]?key|secret|token|signature|key)=)[^&\s]+/gi, "$1[redacted]"],
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[redacted key]"],
];

const MAX_MESSAGE = 300;

/** Removes every credential value, and anything shaped like a secret, from text bound for a log or a person. */
export const redactSecrets = (text: string, credentials: PaymentCredentials = {}): string => {
  let out = text;
  const values = Object.values(credentials)
    .filter((v) => typeof v === "string" && v.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join("[redacted]");
  for (const [shape, replacement] of SECRET_SHAPES) out = out.replace(shape, replacement);
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error");

const sanitize = (operation: string, error: unknown, credentials: PaymentCredentials): ProviderError =>
  new ProviderError(operation, redactSecrets(`${operation} failed: ${messageOf(error)}`, credentials));

/* ───────────── checkout URLs ───────────── */

/**
 * Is this an https URL on one of the adapter's declared hosts?
 *
 * Exact hostnames, or `*.example.com` (any label(s) under it — never the bare
 * domain and never `evilexample.com`). No credentials in the URL, no
 * non-standard port, no other scheme (`javascript:`, `data:`, `http:`).
 * An empty list accepts nothing.
 */
export const isAllowedRedirect = (raw: string, hosts: readonly string[]): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return hosts.some((entry) => {
    const allowed = entry.toLowerCase();
    return allowed.startsWith("*.") ? host.length > allowed.length - 1 && host.endsWith(allowed.slice(1)) : host === allowed;
  });
};

/* ───────────── the wrapper ───────────── */

/**
 * Returns the adapter with the same shape and the safe behaviour built in:
 * errors scrubbed, checkout URLs validated, webhook parsing that cannot throw.
 * `OrderTerminalError` is part of the contract (not a failure) and passes through.
 */
export const PROVIDER_CALL_TIMEOUT_MS = 20_000;

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer from the provider within ${Math.round(ms / 1000)}s`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export const guardAdapter = (adapter: PaymentProviderAdapter, options: { timeoutMs?: number } = {}): PaymentProviderAdapter => {
  const timeoutMs = options.timeoutMs ?? PROVIDER_CALL_TIMEOUT_MS;
  const call = async <T>(operation: string, ctx: ProviderContext, run: () => Promise<T>): Promise<T> => {
    try {
      // Every provider call is time-boxed, so the housekeeping time budgets mean something: a call that never
      // answers fails (and is retried later) instead of holding up every payment behind it. The order and refund
      // calls are idempotent per id, so asking again later is safe.
      return await withTimeout(run(), timeoutMs);
    } catch (error) {
      if (error instanceof OrderTerminalError) throw error;
      throw sanitize(operation, error, ctx.credentials);
    }
  };

  return {
    ...adapter,
    createOrder: (ctx, input) =>
      call("createOrder", ctx, async () => {
        const session = await adapter.createOrder(ctx, input);
        if (session.redirectUrl !== undefined && !isAllowedRedirect(session.redirectUrl, adapter.checkoutHosts)) {
          throw new Error("the provider returned a checkout address that is not on its allowed hosts");
        }
        return session;
      }),
    fetchOrder: (ctx, orderId) => call("fetchOrder", ctx, () => adapter.fetchOrder(ctx, orderId)),
    refund: (ctx, input) => call("refund", ctx, () => adapter.refund(ctx, input)),
    fetchRefund: (ctx, input) => call("fetchRefund", ctx, () => adapter.fetchRefund(ctx, input)),
    verifyCredentials: async (ctx) => {
      try {
        const check = await withTimeout(adapter.verifyCredentials(ctx), timeoutMs);
        // Even a well-behaved adapter's reason is scrubbed before it can reach a response or a log.
        return check.ok ? check : { ok: false, reason: redactSecrets(check.reason, ctx.credentials) };
      } catch (error) {
        return { ok: false, reason: sanitize("verifyCredentials", error, ctx.credentials).message };
      }
    },
    peekWebhook: (raw) => {
      try {
        return adapter.peekWebhook(raw);
      } catch {
        return null;
      }
    },
    verifyWebhook: (ctx, raw, headers) => {
      try {
        return adapter.verifyWebhook(ctx, raw, headers);
      } catch {
        return null;
      }
    },
  };
};
