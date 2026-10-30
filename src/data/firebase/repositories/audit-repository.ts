import { getDocs, query, where } from "firebase/firestore";
import type { Unsubscribe } from "@/core/models/common";
import { auditEntrySchema, type AuditEntry } from "@/core/models/audit";
import type { AuditRepository } from "@/core/repositories/audit-repository";
import { COLLECTIONS } from "../client";
import { guard } from "../mapping";
import { col, parseDocs, sortBy, subscribeList } from "../query-helpers";

const entries = () => col(COLLECTIONS.auditLog);
const newestFirst = (items: AuditEntry[]) => sortBy(items, [(e) => e.createdAt, "desc"]);

export class FirestoreAuditRepository implements AuditRepository {
  listForFest(festId: string, limit = 50): Promise<AuditEntry[]> {
    return guard("Loading audit log", async () => {
      const snapshot = await getDocs(query(entries(), where("festId", "==", festId)));
      return newestFirst(parseDocs(auditEntrySchema, snapshot.docs, COLLECTIONS.auditLog)).slice(0, limit);
    });
  }

  listForSubject(subjectType: AuditEntry["subjectType"], subjectId: string): Promise<AuditEntry[]> {
    return guard("Loading history", async () => {
      const snapshot = await getDocs(
        query(entries(), where("subjectType", "==", subjectType), where("subjectId", "==", subjectId)),
      );
      return newestFirst(parseDocs(auditEntrySchema, snapshot.docs, COLLECTIONS.auditLog));
    });
  }

  subscribeForFest(festId: string, onChange: (items: AuditEntry[]) => void, onError: (error: unknown) => void, limit = 50): Unsubscribe {
    return subscribeList(
      query(entries(), where("festId", "==", festId)),
      auditEntrySchema,
      COLLECTIONS.auditLog,
      (items) => onChange(newestFirst(items).slice(0, limit)),
      onError,
    );
  }
}
