import type { Unsubscribe } from "../models/common";
import type { AuditEntry } from "../models/audit";

/** Read-only from the client; entries are written by the server. */
export interface AuditRepository {
  listForFest(festId: string, limit?: number): Promise<AuditEntry[]>;

  listForSubject(subjectType: AuditEntry["subjectType"], subjectId: string): Promise<AuditEntry[]>;

  subscribeForFest(
    festId: string,
    onChange: (entries: AuditEntry[]) => void,
    onError: (error: unknown) => void,
    limit?: number,
  ): Unsubscribe;
}
