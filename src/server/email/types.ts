/**
 * Email delivery, behind an interface.
 *
 * The provider is chosen by EMAIL_PROVIDER (Resend in production, a console
 * logger everywhere else). Everything that sends mail goes through
 * `emailService()`, and every send is recorded in the `emailLog` collection
 * with its outcome, so "did the invite go out?" is a query, not a guess.
 *
 * Implementations must not throw for an ordinary delivery failure. A bounced
 * address is normal at fest scale and must not abort a run of four hundred
 * certificates — it is reported per-recipient and recorded on the certificate
 * so it can be retried.
 */

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

/** Every template has one of these names; it is what the log is filtered by. */
export const EMAIL_TEMPLATES = [
  "registration_confirmed",
  "team_invite",
  "team_update",
  "waitlist_promoted",
  "payment_due",
  "certificate_issued",
  "password_reset",
  "staff_invite",
  "email_verification",
  "event_reminder",
  "event_updated",
  "event_cancelled",
  "announcement",
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Always provide one; some clients show only this. */
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
  replyTo?: string;
  /** Which template produced it — recorded in the log, sent to the provider as a tag. */
  template: EmailTemplate;
  /** What the message is about, for the log. Never secret. */
  meta?: {
    userId?: string;
    festId?: string;
    eventId?: string;
    subjectType?: string;
    subjectId?: string;
  };
}

export type EmailResult =
  | { ok: true; id?: string; attempts?: number }
  | { ok: false; error: string; retryable: boolean; attempts?: number };

export interface EmailService {
  /** Human-readable name of the active provider, for logs and the health route. */
  readonly name: string;

  /** True when the provider is configured well enough to actually send. */
  readonly canSend: boolean;

  send(message: EmailMessage): Promise<EmailResult>;

  /**
   * Sends a batch, returning one result per message in the same order.
   * Implementations may parallelise, but must respect their provider's rate
   * limit rather than firing four hundred requests at once.
   */
  sendMany(messages: EmailMessage[]): Promise<EmailResult[]>;
}
