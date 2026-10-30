import * as Sentry from "@sentry/nextjs";
import { randomUUID } from "node:crypto";
import { COLLECTIONS, FieldValue, adminDb, isAdminConfigured } from "@/server/firebase-admin";
import type { EmailMessage, EmailResult, EmailService } from "./types";

export type { EmailMessage, EmailResult, EmailService, EmailAttachment, EmailTemplate } from "./types";
export { EMAIL_TEMPLATES } from "./types";

/** The sender identity for plansphere.in. Overridable per environment. */
export const DEFAULT_FROM = "Plansphere <noreply@plansphere.in>";

/* ───────────── console ───────────── */

/**
 * Logs the message instead of sending it.
 *
 * `canSend` is false, which is what the certificate pipeline and the auth
 * routes read to mark deliveries `skipped` (or fall back to Firebase's own
 * mailer) rather than claiming an email went out when none did.
 */
class ConsoleEmailService implements EmailService {
  readonly name = "console";
  readonly canSend = false;

  async send(message: EmailMessage): Promise<EmailResult> {
    const attachments = message.attachments?.length
      ? ` [${message.attachments.length} attachment(s): ${message.attachments.map((a) => a.filename).join(", ")}]`
      : "";
    console.info(`[email:console] ${message.template} -> ${message.to} :: ${message.subject}${attachments}`);
    return { ok: true, id: `console-${Date.now()}`, attempts: 1 };
  }

  async sendMany(messages: EmailMessage[]): Promise<EmailResult[]> {
    return Promise.all(messages.map((message) => this.send(message)));
  }
}

/* ───────────── resend ───────────── */

/** Backoff between attempts. Resend's 429 clears within a second; 5xx may take longer. */
const RETRY_DELAYS_MS = [600, 1800, 4000];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resend, over plain fetch — one endpoint, no SDK dependency.
 *
 * Retries: a 429 or 5xx, or a network failure, is retried up to three more
 * times with backoff. Every attempt of one message carries the same
 * `Idempotency-Key`, so a retry after a timed-out-but-delivered request cannot
 * produce a duplicate email. 4xx other than 429 is final — a rejected address
 * does not get better by asking again.
 */
class ResendEmailService implements EmailService {
  readonly name = "resend";
  readonly canSend: boolean;

  private readonly apiKey: string;
  private readonly from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
    this.canSend = Boolean(apiKey && from);
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const idempotencyKey = `plansphere/${message.template}/${randomUUID()}`;
    let last: EmailResult = { ok: false, error: "not attempted", retryable: true };

    for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt += 1) {
      last = { ...(await this.attempt(message, idempotencyKey)), attempts: attempt };
      if (last.ok || !last.retryable) return last;
      const delay = RETRY_DELAYS_MS[attempt - 1];
      if (delay === undefined) break;
      await sleep(delay);
    }
    return last;
  }

  private async attempt(message: EmailMessage, idempotencyKey: string): Promise<EmailResult> {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          tags: [{ name: "template", value: message.template }],
          ...(message.attachments?.length
            ? {
                attachments: message.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  content: attachment.content.toString("base64"),
                })),
              }
            : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (response.ok) {
        const body = (await response.json()) as { id?: string };
        return { ok: true, ...(body.id ? { id: body.id } : {}) };
      }

      const detail = await response.text();
      return {
        ok: false,
        error: `Resend responded ${response.status}: ${detail.slice(0, 300)}`,
        retryable: response.status === 429 || response.status >= 500,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : "Network error",
        retryable: true,
      };
    }
  }

  async sendMany(messages: EmailMessage[]): Promise<EmailResult[]> {
    const results: EmailResult[] = [];
    // Sequential: Resend's free tier allows 2 requests per second, and a
    // certificate run is hundreds of messages. Going wide would trip the
    // limit and mark good addresses as failures.
    for (const message of messages) {
      results.push(await this.send(message));
      await sleep(550);
    }
    return results;
  }
}

/* ───────────── delivery log ───────────── */

/**
 * Wraps any provider and records each send in `emailLog`.
 *
 * The log is what the admin console shows under "Email", and what a support
 * question ("I never got my certificate") is answered from. Logging failures
 * never fail the send: the email is the product, the log is bookkeeping.
 */
class LoggedEmailService implements EmailService {
  readonly name: string;
  readonly canSend: boolean;

  constructor(private readonly inner: EmailService) {
    this.name = inner.name;
    this.canSend = inner.canSend;
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    let result: EmailResult;
    try {
      result = await this.inner.send(message);
    } catch (error) {
      // Providers should not throw, but a bug in one must not take the caller down.
      result = { ok: false, error: error instanceof Error ? error.message : String(error), retryable: false };
    }
    await this.record(message, result);
    if (!result.ok && this.inner.canSend) {
      Sentry.captureMessage(`Email delivery failed: ${message.template}`, { level: "warning", tags: { kind: "email", template: message.template }, extra: { error: result.error, attempts: result.attempts, retryable: result.retryable } });
    }
    return result;
  }

  async sendMany(messages: EmailMessage[]): Promise<EmailResult[]> {
    const results = await this.inner.sendMany(messages);
    await Promise.all(messages.map((message, i) => this.record(message, results[i] ?? { ok: false, error: "no result", retryable: false })));
    return results;
  }

  private async record(message: EmailMessage, result: EmailResult): Promise<void> {
    if (!isAdminConfigured()) return;
    try {
      await adminDb()
        .collection(COLLECTIONS.emailLog)
        .add({
          to: message.to,
          subject: message.subject,
          template: message.template,
          provider: this.inner.name,
          // A console "send" is not a delivery; the log must say so.
          status: !this.inner.canSend ? "skipped" : result.ok ? "sent" : "failed",
          providerId: result.ok ? (result.id ?? null) : null,
          attempts: result.attempts ?? 1,
          error: result.ok ? null : result.error.slice(0, 500),
          retryable: result.ok ? null : result.retryable,
          userId: message.meta?.userId ?? null,
          festId: message.meta?.festId ?? null,
          eventId: message.meta?.eventId ?? null,
          subjectType: message.meta?.subjectType ?? null,
          subjectId: message.meta?.subjectId ?? null,
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (error) {
      console.warn("[email] could not write emailLog:", error instanceof Error ? error.message : error);
      Sentry.captureException(error, { tags: { kind: "email-log" }, level: "warning" });
    }
  }
}

/* ───────────── factory ───────────── */

let cached: EmailService | null = null;

/** Resolves the configured provider once per process. */
export const emailService = (): EmailService => {
  if (cached) return cached;

  const provider = (process.env.EMAIL_PROVIDER ?? "console").toLowerCase();
  let inner: EmailService;

  if (provider === "resend") {
    const apiKey = process.env.RESEND_API_KEY ?? "";
    const from = process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;
    if (!apiKey) {
      console.warn("[email] EMAIL_PROVIDER=resend but RESEND_API_KEY is missing; falling back to console.");
      inner = new ConsoleEmailService();
    } else {
      inner = new ResendEmailService(apiKey, from);
    }
  } else {
    if (provider !== "console") console.warn(`[email] Unknown EMAIL_PROVIDER "${provider}"; falling back to console.`);
    inner = new ConsoleEmailService();
  }

  cached = new LoggedEmailService(inner);
  return cached;
};
