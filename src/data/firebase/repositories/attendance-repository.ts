import { deleteDoc, doc, getCountFromServer, getDoc, getDocs, query, where, type QueryConstraint } from "firebase/firestore";
import type { Unsubscribe } from "@/core/models/common";
import {
  attendanceIdFor,
  attendanceSchema,
  foodCollectionSchema,
  type Attendance,
  type FoodCollection,
  type MealType,
  type ScanMember,
  type ScanOutcome,
} from "@/core/models/attendance";
import type { AttendanceRepository } from "@/core/repositories/attendance-repository";
import { api } from "@/data/api-client";
import { COLLECTIONS } from "../client";
import { guard } from "../mapping";
import { col, parseDoc, parseDocs, sortBy, subscribeList } from "../query-helpers";

const attendance = () => col(COLLECTIONS.attendance);
const meals = () => col(COLLECTIONS.foodCollections);

/**
 * The server answers with JSON, so the dates inside a scan outcome arrive as strings. Turns them back into `Date`s,
 * which is what the screens and the offline queue expect.
 */
const reviveOutcome = (outcome: ScanOutcome): ScanOutcome => {
  const revive = (members: ScanMember[] | undefined): ScanMember[] | undefined =>
    members?.map((m) => ({ ...m, ...(m.at ? { at: new Date(m.at as unknown as string) } : {}) }));

  if (outcome.result === "ok") return { ...outcome, ...(outcome.members ? { members: revive(outcome.members) as ScanMember[] } : {}) };
  if (outcome.result === "already-recorded") {
    return { ...outcome, at: new Date(outcome.at as unknown as string), ...(outcome.members ? { members: revive(outcome.members) as ScanMember[] } : {}) };
  }
  return outcome;
};

export class FirestoreAttendanceRepository implements AttendanceRepository {
  /**
   * Check-in.
   *
   * The attendance document id *is* the registration id, and the write is a
   * transaction that creates only if absent. Two volunteers scanning the same
   * ticket in the same second therefore cannot both succeed: the second sees
   * the first's record and reports "already checked in" with its timestamp.
   * Firestore rules back this up by denying updates to attendance documents.
   *
   * Manual (non-QR) entry is an admin action and goes through the server so
   * it lands in the audit log; volunteers cannot mark it from here.
   */
  recordScan(input: { ticketCode: string; eventId: string; festId?: string; scannedBy: string; method?: "qr" | "manual"; gate?: string; scannedAt?: Date; memberKeys?: string[] }): Promise<ScanOutcome> {
    return guard("Recording check-in", async () => {
      if (input.method === "manual") {
        return api<ScanOutcome>("/api/admin/attendance/manual", {
          method: "POST",
          body: { ticketCode: input.ticketCode, eventId: input.eventId, gate: input.gate },
        });
      }

      // The server checks this volunteer's duty and competition, resolves the ticket, applies the admission rule and
      // writes the record in a transaction. The phone never reads the registration or writes the check-in itself.
      const outcome = await api<ScanOutcome>("/api/volunteer/scan", {
        method: "POST",
        body: {
          eventId: input.eventId,
          ticketCode: input.ticketCode,
          ...(input.memberKeys ? { memberKeys: input.memberKeys } : {}),
          ...(input.gate ? { gate: input.gate } : {}),
          ...(input.scannedAt ? { scannedAt: input.scannedAt.getTime() } : {}),
        },
      });
      return reviveOutcome(outcome);
    });
  }

  getByRegistration(registrationId: string): Promise<Attendance | null> {
    return guard("Loading check-in", async () => {
      const snapshot = await getDoc(doc(attendance(), attendanceIdFor(registrationId)));
      return snapshot.exists() ? parseDoc(attendanceSchema, snapshot, COLLECTIONS.attendance) : null;
    });
  }

  listByEvent(eventId: string): Promise<Attendance[]> {
    return guard("Loading check-ins", async () => {
      const snapshot = await getDocs(query(attendance(), where("eventId", "==", eventId)));
      return sortBy(parseDocs(attendanceSchema, snapshot.docs, COLLECTIONS.attendance), [(a) => a.scannedAt, "desc"]);
    });
  }

  attendedRegistrationIds(eventId: string): Promise<Set<string>> {
    return guard("Loading check-ins", async () => {
      const snapshot = await getDocs(query(attendance(), where("eventId", "==", eventId)));
      return new Set(snapshot.docs.map((d) => d.id));
    });
  }

  subscribeByEvent(eventId: string, onChange: (records: Attendance[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(
      query(attendance(), where("eventId", "==", eventId)),
      attendanceSchema,
      COLLECTIONS.attendance,
      (items) => onChange(sortBy(items, [(a) => a.scannedAt, "desc"])),
      onError,
    );
  }

  subscribeByFest(festId: string, onChange: (records: Attendance[]) => void, onError: (error: unknown) => void, limit = 50): Unsubscribe {
    return subscribeList(
      query(attendance(), where("festId", "==", festId)),
      attendanceSchema,
      COLLECTIONS.attendance,
      (items) => onChange(sortBy(items, [(a) => a.scannedAt, "desc"]).slice(0, limit)),
      onError,
    );
  }

  countByEvent(eventId: string): Promise<number> {
    return guard("Counting check-ins", async () => {
      const snapshot = await getCountFromServer(query(attendance(), where("eventId", "==", eventId)));
      return snapshot.data().count;
    });
  }

  countByFest(festId: string): Promise<number> {
    return guard("Counting check-ins", async () => {
      const snapshot = await getCountFromServer(query(attendance(), where("festId", "==", festId)));
      return snapshot.data().count;
    });
  }

  remove(registrationId: string): Promise<void> {
    return guard("Removing check-in", async () => {
      await deleteDoc(doc(attendance(), attendanceIdFor(registrationId)));
    });
  }

  /**
   * Meal handout. One document per serving, keyed entry + day + slot + n,
   * so a team of three collects exactly three lunches and a fourth scan is
   * refused. The transaction reads servings 1..memberCount and creates the
   * first gap; two counters serving the same team at once cannot both take
   * serving 3.
   */
  recordMeal(input: { ticketCode: string; eventId: string; festId?: string; mealType: MealType; servedOn: string; collectedBy: string; post?: string; scannedAt?: Date; memberKeys?: string[] }): Promise<ScanOutcome> {
    return guard("Recording meal", async () => {
      const outcome = await api<ScanOutcome>("/api/volunteer/meal", {
        method: "POST",
        body: {
          eventId: input.eventId,
          ticketCode: input.ticketCode,
          mealType: input.mealType,
          servedOn: input.servedOn,
          ...(input.memberKeys ? { memberKeys: input.memberKeys } : {}),
          ...(input.post ? { post: input.post } : {}),
          ...(input.scannedAt ? { scannedAt: input.scannedAt.getTime() } : {}),
        },
      });
      return reviveOutcome(outcome);
    });
  }

  listMealsByEvent(eventId: string, servedOn?: string): Promise<FoodCollection[]> {
    return guard("Loading meals", async () => {
      const constraints: QueryConstraint[] = [where("eventId", "==", eventId)];
      if (servedOn) constraints.push(where("servedOn", "==", servedOn));
      const snapshot = await getDocs(query(meals(), ...constraints));
      return sortBy(parseDocs(foodCollectionSchema, snapshot.docs, COLLECTIONS.foodCollections), [(m) => m.collectedAt, "desc"]);
    });
  }

  listMealsForUser(userId: string): Promise<FoodCollection[]> {
    return guard("Loading meals", async () => {
      const snapshot = await getDocs(query(meals(), where("userId", "==", userId)));
      return parseDocs(foodCollectionSchema, snapshot.docs, COLLECTIONS.foodCollections);
    });
  }

  countMeals(eventId: string, servedOn?: string, mealType?: MealType): Promise<number> {
    return guard("Counting meals", async () => {
      const constraints: QueryConstraint[] = [where("eventId", "==", eventId)];
      if (servedOn) constraints.push(where("servedOn", "==", servedOn));
      if (mealType) constraints.push(where("mealType", "==", mealType));
      const snapshot = await getCountFromServer(query(meals(), ...constraints));
      return snapshot.data().count;
    });
  }

  countMealsByFest(festId: string): Promise<number> {
    return guard("Counting meals", async () => {
      const snapshot = await getCountFromServer(query(meals(), where("festId", "==", festId)));
      return snapshot.data().count;
    });
  }
}
