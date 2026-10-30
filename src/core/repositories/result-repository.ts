import type { Unsubscribe } from "../models/common";
import type { Result, UpsertResult } from "../models/result";

/**
 * Result sheets. One per event, keyed by the event id.
 *
 * Publishing is separate from saving so a super admin can build the sheet
 * across several sittings without it counting as final. Only `publish` makes
 * the sheet eligible to generate certificates.
 */
export interface ResultRepository {
  getByEvent(eventId: string): Promise<Result | null>;

  listByFest(festId: string): Promise<Result[]>;

  subscribeByEvent(
    eventId: string,
    onChange: (result: Result | null) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  /** Creates or replaces the sheet, leaving its published state untouched. */
  save(input: UpsertResult): Promise<Result>;

  /**
   * Marks the sheet published and stamps the event's `resultsPublishedAt`.
   *
   * Validates that every listed `registrationId` really belongs to the event
   * before it does so, since a stale sheet could otherwise award a certificate
   * to somebody who competed elsewhere.
   */
  publish(eventId: string): Promise<Result>;

  unpublish(eventId: string): Promise<void>;

  /** Stamped once a certificate run finishes, so a re-publish is detectable. */
  markCertificatesGenerated(eventId: string): Promise<void>;
}
