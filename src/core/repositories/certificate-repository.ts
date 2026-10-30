import type { Page, PageRequest, Unsubscribe } from "../models/common";
import type {
  Certificate,
  CertificateDraft,
  CertificateType,
  DeliveryStatus,
} from "../models/certificate";

export interface CertificateQuery extends PageRequest {
  userId?: string;
  eventId?: string;
  festId?: string;
  type?: CertificateType;
  deliveryStatus?: DeliveryStatus;
  /** Revoked certificates are excluded unless this is explicitly true. */
  includeRevoked?: boolean;
}

export interface CertificateRepository {
  getById(id: string): Promise<Certificate | null>;

  /** Public verification by the number printed on the certificate. */
  getByCertificateNumber(certificateNumber: string): Promise<Certificate | null>;

  list(query?: CertificateQuery): Promise<Page<Certificate>>;

  /**
   * A student's own certificates. Returns only issued, unrevoked ones, so a
   * student who was not eligible sees an empty list rather than a placeholder
   * for something they did not earn.
   */
  listForUser(userId: string): Promise<Certificate[]>;

  subscribeForUser(
    userId: string,
    onChange: (certificates: Certificate[]) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  /**
   * Writes a batch of drafts as issued certificates.
   *
   * Each is keyed `${eventId}_${userId}`, so re-running generation for an
   * event updates the existing rows instead of issuing duplicates. Returns
   * both what it created and what already existed, which is what lets the
   * dashboard say "42 issued, 8 already had one" after a re-publish.
   */
  issueMany(drafts: CertificateDraft[]): Promise<{ created: Certificate[]; existing: Certificate[] }>;

  /**
   * The whole post-event run for one event: eligibility, issue, PDF, email.
   * `dryRun` computes and reports without writing, for the confirmation step
   * ("78 eligible · 3 winner · 75 participation · 2 without accounts").
   */
  generateForEvent(eventId: string, options?: { dryRun?: boolean }): Promise<GenerateSummary>;

  attachFile(id: string, fileUrl: string): Promise<void>;

  markDelivery(id: string, delivery: { status: DeliveryStatus; error?: string }): Promise<void>;

  /** Certificates still waiting to be emailed, for the delivery worker. */
  listPendingDelivery(limit?: number): Promise<Certificate[]>;

  /** Retries every pending/failed/skipped email for a fest (or one event). */
  deliverPending(festId: string, eventId?: string): Promise<{ attempted: number; sent: number; failed: number; reason?: string }>;

  revoke(id: string, reason: string): Promise<void>;

  countByEvent(eventId: string): Promise<number>;

  countByFest(festId: string): Promise<number>;
}

export interface GenerateSummary {
  dryRun: boolean;
  eligible: number;
  created: number;
  /** How many were released to their recipients in this run. */
  published: number;
  existing: number;
  emailed: number;
  skipped: number;
  failed: number;
  unmatched: Array<{ name: string; email: string; type: string }>;
  byType: Record<string, number>;
}
