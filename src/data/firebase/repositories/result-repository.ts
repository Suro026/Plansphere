import { doc, getDoc, getDocs, onSnapshot, query, where } from "firebase/firestore";
import type { Unsubscribe } from "@/core/models/common";
import { resultSchema, type Result, type UpsertResult } from "@/core/models/result";
import type { ResultRepository } from "@/core/repositories/result-repository";
import { api } from "@/data/api-client";
import { COLLECTIONS } from "../client";
import { guard, toRepositoryError } from "../mapping";
import { col, parseDoc, parseDocs } from "../query-helpers";

const results = () => col(COLLECTIONS.results);

const parseFromApi = (raw: unknown): Result => {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Server returned an unexpected result shape");
  return parsed.data;
};

/**
 * Result sheets. Reads are direct; every write goes through the server, which
 * validates that each ranked entry belongs to the event and was checked in —
 * the rules deny result writes from any client.
 */
export class FirestoreResultRepository implements ResultRepository {
  getByEvent(eventId: string): Promise<Result | null> {
    return guard("Loading results", async () => {
      const snapshot = await getDoc(doc(results(), eventId));
      return snapshot.exists() ? parseDoc(resultSchema, snapshot, COLLECTIONS.results) : null;
    });
  }

  listByFest(festId: string): Promise<Result[]> {
    return guard("Loading results", async () => {
      const snapshot = await getDocs(query(results(), where("festId", "==", festId)));
      return parseDocs(resultSchema, snapshot.docs, COLLECTIONS.results);
    });
  }

  subscribeByEvent(eventId: string, onChange: (result: Result | null) => void, onError: (error: unknown) => void): Unsubscribe {
    return onSnapshot(
      doc(results(), eventId),
      (snapshot) => onChange(snapshot.exists() ? parseDoc(resultSchema, snapshot, COLLECTIONS.results) : null),
      (error) => onError(toRepositoryError(error, "Listening to results")),
    );
  }

  save(input: UpsertResult): Promise<Result> {
    return guard("Saving results", async () => {
      const response = await api<{ result: unknown }>(`/api/admin/events/${input.eventId}/results`, {
        method: "PUT",
        body: { entries: input.entries, status: "draft" },
      });
      return parseFromApi(response.result);
    });
  }

  publish(eventId: string): Promise<Result> {
    return guard("Publishing results", async () => {
      const response = await api<{ result: unknown }>(`/api/admin/events/${eventId}/results/publish`, {
        method: "POST",
      });
      return parseFromApi(response.result);
    });
  }

  unpublish(eventId: string): Promise<void> {
    return guard("Unpublishing results", () =>
      api<void>(`/api/admin/events/${eventId}/results/unpublish`, { method: "POST" }),
    );
  }

  /** Server-internal: stamped by the certificate route itself. */
  markCertificatesGenerated(): Promise<void> {
    return Promise.resolve();
  }
}
