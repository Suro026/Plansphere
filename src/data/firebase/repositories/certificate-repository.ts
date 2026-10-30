import {
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  query,
  where,
  type QueryConstraint,
} from "firebase/firestore";
import type { Page, Unsubscribe } from "@/core/models/common";
import { certificateSchema, isReleased, type Certificate, type CertificateDraft } from "@/core/models/certificate";
import type { CertificateQuery, CertificateRepository, GenerateSummary } from "@/core/repositories/certificate-repository";
import { api } from "@/data/api-client";
import { COLLECTIONS } from "../client";
import { guard } from "../mapping";
import { col, parseDoc, parseDocs, sortBy, subscribeList } from "../query-helpers";

const certificates = () => col(COLLECTIONS.certificates);

const constraintsFor = (q: CertificateQuery): QueryConstraint[] => {
  const out: QueryConstraint[] = [];
  if (q.userId) out.push(where("userId", "==", q.userId));
  if (q.eventId) out.push(where("eventId", "==", q.eventId));
  if (q.festId) out.push(where("festId", "==", q.festId));
  if (q.type) out.push(where("type", "==", q.type));
  if (q.deliveryStatus) out.push(where("delivery.status", "==", q.deliveryStatus));
  if (!q.includeRevoked) out.push(where("revoked", "==", false));
  // Equality filters only — ordering happens in memory, so no composite
  // index is required. A fest issues hundreds of certificates, not millions.
  return out;
};

/**
 * Certificates. Every write is server-side — a client that could write here
 * could award itself a first prize — so this class is reads plus thin calls
 * to the generation and revocation routes.
 */
export class FirestoreCertificateRepository implements CertificateRepository {
  getById(id: string): Promise<Certificate | null> {
    return guard("Loading certificate", async () => {
      const snapshot = await getDoc(doc(certificates(), id));
      return snapshot.exists() ? parseDoc(certificateSchema, snapshot, COLLECTIONS.certificates) : null;
    });
  }

  /**
   * Public verification is served by `/api/verify/[number]` rather than a
   * direct read, because the verify page must work for a recruiter with no
   * account and the rules only let a signed-in owner read their own.
   */
  getByCertificateNumber(certificateNumber: string): Promise<Certificate | null> {
    return guard("Verifying certificate", async () => {
      const response = await api<{ certificate: unknown | null }>(
        `/api/verify/${encodeURIComponent(certificateNumber.trim().toUpperCase())}`,
        { auth: false },
      );
      if (!response.certificate) return null;
      const parsed = certificateSchema.safeParse(response.certificate);
      return parsed.success ? parsed.data : null;
    });
  }

  list(q: CertificateQuery = {}): Promise<Page<Certificate>> {
    return guard("Loading certificates", async () => {
      const snapshot = await getDocs(query(certificates(), ...constraintsFor(q)));
      const items = sortBy(parseDocs(certificateSchema, snapshot.docs, COLLECTIONS.certificates), [(c) => c.issuedAt, "desc"]);
      const limit = q.limit ?? items.length;
      return { items: items.slice(0, limit), cursor: null, hasMore: items.length > limit };
    });
  }

  listForUser(userId: string): Promise<Certificate[]> {
    return guard("Loading your certificates", async () => {
      const snapshot = await getDocs(query(certificates(), where("userId", "==", userId), where("revoked", "==", false)));
      const items = parseDocs(certificateSchema, snapshot.docs, COLLECTIONS.certificates).filter(isReleased);
      return sortBy(items, [(c) => c.issuedAt, "desc"]);
    });
  }

  subscribeForUser(userId: string, onChange: (items: Certificate[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(
      query(certificates(), where("userId", "==", userId), where("revoked", "==", false)),
      certificateSchema,
      COLLECTIONS.certificates,
      // Prepared-but-unreleased certificates are filtered here rather than in
      // the query: `published` is absent on everything issued before the
      // release desk existed, and Firestore cannot match a missing field.
      (items) => onChange(sortBy(items.filter(isReleased), [(c) => c.issuedAt, "desc"])),
      onError,
    );
  }

  /** Not called from the client; the generation route computes drafts itself. */
  issueMany(_drafts: CertificateDraft[]): Promise<{ created: Certificate[]; existing: Certificate[] }> {
    void _drafts;
    return Promise.reject(new Error("issueMany is server-only; use generateForEvent"));
  }

  /** Runs eligibility, issues, renders PDFs and queues email for one event. */
  generateForEvent(eventId: string, options: { dryRun?: boolean } = {}): Promise<GenerateSummary> {
    return guard("Generating certificates", () =>
      api<GenerateSummary>(`/api/admin/events/${eventId}/certificates`, {
        method: "POST",
        body: { dryRun: options.dryRun ?? false },
      }),
    );
  }

  attachFile(): Promise<void> {
    return Promise.reject(new Error("attachFile is server-only"));
  }

  markDelivery(): Promise<void> {
    return Promise.reject(new Error("markDelivery is server-only"));
  }

  listPendingDelivery(limit = 100): Promise<Certificate[]> {
    return guard("Loading pending deliveries", async () => {
      const snapshot = await getDocs(query(certificates(), where("delivery.status", "in", ["pending", "failed"])));
      return sortBy(parseDocs(certificateSchema, snapshot.docs, COLLECTIONS.certificates), [(c) => c.issuedAt, "asc"]).slice(0, limit);
    });
  }

  deliverPending(festId: string, eventId?: string) {
    return guard("Sending certificates", () =>
      api<{ attempted: number; sent: number; failed: number; reason?: string }>("/api/admin/certificates/deliver", {
        method: "POST",
        body: { festId, eventId },
      }),
    );
  }

  revoke(id: string, reason: string): Promise<void> {
    return guard("Revoking certificate", () =>
      api<void>(`/api/admin/certificates/${id}/revoke`, { method: "POST", body: { reason } }),
    );
  }

  countByEvent(eventId: string): Promise<number> {
    return guard("Counting certificates", async () => {
      const snapshot = await getCountFromServer(
        query(certificates(), where("eventId", "==", eventId), where("revoked", "==", false)),
      );
      return snapshot.data().count;
    });
  }

  countByFest(festId: string): Promise<number> {
    return guard("Counting certificates", async () => {
      const snapshot = await getCountFromServer(
        query(certificates(), where("festId", "==", festId), where("revoked", "==", false)),
      );
      return snapshot.data().count;
    });
  }
}
