import {
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  orderBy,
  query,
  where,
  type QueryConstraint,
} from "firebase/firestore";
import type { Page, Unsubscribe } from "@/core/models/common";
import { eventSchema } from "@/core/models/event";
import {
  registrationSchema,
  type CreateRegistrationInput,
  type Registration,
  type RegistrationWithEvent,
  type TeamAction,
} from "@/core/models/registration";
import { attendanceSchema } from "@/core/models/attendance";
import type { PaymentCheckoutResult } from "@/core/models/payment";
import type { RegistrationQuery, RegistrationRepository } from "@/core/repositories/registration-repository";
import { api } from "@/data/api-client";
import { COLLECTIONS } from "../client";
import { guard } from "../mapping";
import { col, getManyById, matchesSearch, parseDoc, runPage, sortBy, subscribeList } from "../query-helpers";

const registrations = () => col(COLLECTIONS.registrations);

/**
 * Equality filters merge on single-field indexes automatically; the orderBy
 * is what needs a composite index. Admin tables (event/fest scope) keep it
 * for pagination — see firestore.indexes.json — while a student's own list
 * is small enough to sort in memory.
 */
const constraintsFor = (q: RegistrationQuery, paged: boolean): QueryConstraint[] => {
  const out: QueryConstraint[] = [];
  if (q.eventId) out.push(where("eventId", "==", q.eventId));
  if (q.festId) out.push(where("festId", "==", q.festId));
  if (q.userId) out.push(where("userId", "==", q.userId));
  if (q.status) out.push(where("status", "==", q.status));
  if (paged) out.push(orderBy("createdAt", "desc"));
  return out;
};

const applySearch = (items: Registration[], q: RegistrationQuery): Registration[] =>
  q.search
    ? items.filter((r) =>
        matchesSearch(
          [r.userName, r.userEmail, r.ticketCode, r.teamName, ...r.members.flatMap((m) => [m.name, m.email])],
          q.search,
        ),
      )
    : items;

/**
 * Registrations.
 *
 * Reads are direct and live. The three writes that change who holds a seat —
 * create, cancel, and linking a teammate's account — go through the server,
 * because each has to move the event's seat counter in the same transaction,
 * and the rules deliberately keep that counter out of any client's reach.
 */
export class FirestoreRegistrationRepository implements RegistrationRepository {
  getById(id: string): Promise<Registration | null> {
    return guard("Loading registration", async () => {
      const snapshot = await getDoc(doc(registrations(), id));
      return snapshot.exists() ? parseDoc(registrationSchema, snapshot, COLLECTIONS.registrations) : null;
    });
  }

  getByTicketCode(ticketCode: string, festId?: string): Promise<Registration | null> {
    return guard("Looking up ticket", async () => {
      // Staff may only read entries of fests they manage, and Firestore proves that from the query, so a staff lookup
      // has to name the fest. (A super admin may omit it.)
      const snapshot = await getDocs(
        query(registrations(), where("ticketCode", "==", ticketCode.trim().toUpperCase()), ...(festId ? [where("festId", "==", festId)] : [])),
      );
      const first = snapshot.docs[0];
      return first ? parseDoc(registrationSchema, first, COLLECTIONS.registrations) : null;
    });
  }

  list(q: RegistrationQuery = {}): Promise<Page<Registration>> {
    return guard("Loading registrations", async () => {
      const page = await runPage(
        query(registrations(), ...constraintsFor(q, true)),
        registrationSchema,
        COLLECTIONS.registrations,
        q,
      );
      page.items = applySearch(page.items, q);
      return page;
    });
  }

  listForEvent(eventId: string, festId: string): Promise<Registration[]> {
    return guard("Loading roster", async () => {
      const snapshot = await getDocs(query(registrations(), where("eventId", "==", eventId), where("festId", "==", festId)));
      return snapshot.docs
        .map((d) => parseDoc(registrationSchema, d, COLLECTIONS.registrations))
        .filter((r): r is Registration => r !== null);
    });
  }

  listForUserWithEvents(userId: string, email?: string): Promise<RegistrationWithEvent[]> {
    return guard("Loading your events", async () => {
      // Entries I created are read directly (the rules prove them from the query). Team entries that merely name me are
      // NOT readable by a client: they carry every member's contact details. The server returns those with the other
      // members' details removed.
      const [own, named] = await Promise.all([
        getDocs(query(registrations(), where("userId", "==", userId))),
        email ? api<{ registrations: unknown[] }>("/api/registrations/mine").catch(() => null) : null,
      ]);

      const seen = new Set<string>();
      const all: Registration[] = [];
      for (const d of own.docs) {
        seen.add(d.id);
        const parsed = parseDoc(registrationSchema, d, COLLECTIONS.registrations);
        if (parsed) all.push(parsed);
      }
      for (const raw of named?.registrations ?? []) {
        const parsed = registrationSchema.safeParse(raw);
        if (!parsed.success || seen.has(parsed.data.id)) continue;
        seen.add(parsed.data.id);
        all.push(parsed.data);
      }

      const mine = sortBy(all, [(r) => r.createdAt, "desc"]);

      if (mine.length === 0) return [];

      // Attendance is read per entry by its deterministic id: a `get` the
      // owner rule allows, where a list by registration id would not be.
      const [events, attendanceDocs] = await Promise.all([
        getManyById(COLLECTIONS.events, mine.map((r) => r.eventId), eventSchema),
        Promise.all(mine.map((r) => getDoc(doc(col(COLLECTIONS.attendance), r.id)).catch(() => null))),
      ]);

      const eventById = new Map(events.map((e) => [e.id, e]));
      const attended = new Set(
        attendanceDocs
          .map((d) => (d && d.exists() ? parseDoc(attendanceSchema, d, COLLECTIONS.attendance) : null))
          .filter((a): a is NonNullable<typeof a> => a !== null)
          .map((a) => a.registrationId),
      );

      return mine.map((registration) => {
        const event = eventById.get(registration.eventId);
        return {
          registration,
          event: event
            ? {
                id: event.id,
                title: event.title,
                date: event.date,
                startTime: event.startTime,
                venue: event.venue,
                ...(event.posterUrl ? { posterUrl: event.posterUrl } : {}),
              }
            : null,
          attended: attended.has(registration.id),
        };
      });
    });
  }

  subscribe(q: RegistrationQuery, onChange: (items: Registration[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(
      query(registrations(), ...constraintsFor(q, false)),
      registrationSchema,
      COLLECTIONS.registrations,
      (items) => onChange(applySearch(sortBy(items, [(r) => r.createdAt, "desc"]), q)),
      onError,
    );
  }

  create(input: CreateRegistrationInput): Promise<Registration> {
    return guard("Registering", async () => {
      const result = await api<{ registration: unknown }>("/api/registrations", { method: "POST", body: input });
      const parsed = registrationSchema.safeParse(result.registration);
      if (!parsed.success) throw new Error("Server returned an unexpected registration shape");
      return parsed.data;
    });
  }

  startPayment(id: string): Promise<PaymentCheckoutResult> {
    return guard("Starting payment", async () => {
      const result = await api<{ state: "paid" } | { state: "checkout"; checkout: { redirectUrl?: string }; amountPaise: number; expiresAt: number }>(`/api/registrations/${id}/payment`, { method: "POST" });
      if (result.state === "paid") return { state: "paid" as const };
      return { state: "checkout" as const, ...(result.checkout.redirectUrl ? { redirectUrl: result.checkout.redirectUrl } : {}), amountPaise: result.amountPaise, expiresAt: result.expiresAt };
    });
  }

  cancel(id: string): Promise<void> {
    return guard("Cancelling registration", () =>
      api<void>(`/api/registrations/${id}/cancel`, { method: "POST" }),
    );
  }

  teamAction(id: string, input: TeamAction): Promise<Registration> {
    const label =
      input.action === "invite" ? "Inviting teammate"
      : input.action === "remove" ? "Removing teammate"
      : input.action === "rename" ? "Renaming team"
      : input.action === "accept" ? "Joining team"
      : "Declining invitation";
    return guard(label, async () => {
      const result = await api<{ registration: unknown }>(`/api/registrations/${id}/team`, { method: "POST", body: input });
      const parsed = registrationSchema.safeParse(result.registration);
      if (!parsed.success) throw new Error("Server returned an unexpected registration shape");
      return parsed.data;
    });
  }

  staffAction(id: string, action: "promote" | "cancel", reason?: string): Promise<"promoted" | "cancelled" | "noop"> {
    return guard(action === "promote" ? "Promoting entry" : "Cancelling entry", async () => {
      const response = await api<{ result: "promoted" | "cancelled" | "noop" }>(`/api/admin/registrations/${id}`, {
        method: "POST",
        body: { action, reason },
      });
      return response.result;
    });
  }

  existsForUserAndEvent(userId: string, eventId: string): Promise<boolean> {
    return guard("Checking registration", async () => {
      const snapshot = await getCountFromServer(
        query(
          registrations(),
          where("userId", "==", userId),
          where("eventId", "==", eventId),
          // A draft team is an entry too: it blocks a second one.
          where("status", "in", ["draft", "confirmed", "waitlisted"]),
        ),
      );
      return snapshot.data().count > 0;
    });
  }

  countByEvent(eventId: string): Promise<number> {
    return guard("Counting registrations", async () => {
      const snapshot = await getCountFromServer(
        query(registrations(), where("eventId", "==", eventId), where("status", "in", ["draft", "confirmed"])),
      );
      return snapshot.data().count;
    });
  }

  countByFest(festId: string): Promise<number> {
    return guard("Counting registrations", async () => {
      const snapshot = await getCountFromServer(
        query(registrations(), where("festId", "==", festId), where("status", "in", ["draft", "confirmed"])),
      );
      return snapshot.data().count;
    });
  }

  linkMemberAccountsByEmail(): Promise<number> {
    return guard("Linking your team entries", async () => {
      const result = await api<{ linked: number }>("/api/registrations/link-account", { method: "POST" });
      return result.linked;
    });
  }
}
