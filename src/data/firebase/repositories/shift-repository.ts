import {
  addDoc,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
  type QueryConstraint,
} from "firebase/firestore";
import type { Unsubscribe } from "@/core/models/common";
import { shiftSchema, type CreateShift, type Shift, type UpdateShift } from "@/core/models/shift";
import { userSchema } from "@/core/models/user";
import type { ShiftRepository } from "@/core/repositories/shift-repository";
import { COLLECTIONS, firestore } from "../client";
import { guard, stripUndefined } from "../mapping";
import { col, parseDoc, parseDocs, sortBy, subscribeList } from "../query-helpers";

const shifts = () => col(COLLECTIONS.shifts);

const byTime = (items: Shift[]) => sortBy(items, [(s) => s.date, "asc"], [(s) => s.startTime, "asc"]);

/** Fills the denormalised name/email from the volunteer's profile. */
const withUser = async (input: CreateShift) => {
  const snapshot = await getDoc(doc(col(COLLECTIONS.users), input.userId));
  const user = snapshot.exists() ? parseDoc(userSchema, snapshot, COLLECTIONS.users) : null;
  if (!user) throw new Error("That volunteer account does not exist");
  return { userName: user.fullName, userEmail: user.email };
};

export class FirestoreShiftRepository implements ShiftRepository {
  getById(id: string): Promise<Shift | null> {
    return guard("Loading shift", async () => {
      const snapshot = await getDoc(doc(shifts(), id));
      return snapshot.exists() ? parseDoc(shiftSchema, snapshot, COLLECTIONS.shifts) : null;
    });
  }

  listForUser(festId: string, userId: string): Promise<Shift[]> {
    return guard("Loading your shifts", async () => {
      const snapshot = await getDocs(
        query(shifts(), where("festId", "==", festId), where("userId", "==", userId)),
      );
      return byTime(parseDocs(shiftSchema, snapshot.docs, COLLECTIONS.shifts));
    });
  }

  subscribeForUser(festId: string, userId: string, onChange: (items: Shift[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(
      query(shifts(), where("festId", "==", festId), where("userId", "==", userId)),
      shiftSchema,
      COLLECTIONS.shifts,
      (items) => onChange(byTime(items)),
      onError,
    );
  }

  listByFest(festId: string, date?: string): Promise<Shift[]> {
    return guard("Loading roster", async () => {
      const constraints: QueryConstraint[] = [where("festId", "==", festId)];
      if (date) constraints.push(where("date", "==", date));
      const snapshot = await getDocs(query(shifts(), ...constraints));
      return byTime(parseDocs(shiftSchema, snapshot.docs, COLLECTIONS.shifts));
    });
  }

  subscribeByFest(festId: string, onChange: (items: Shift[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(
      query(shifts(), where("festId", "==", festId)),
      shiftSchema,
      COLLECTIONS.shifts,
      (items) => onChange(byTime(items)),
      onError,
    );
  }

  create(input: CreateShift, createdBy: string): Promise<Shift> {
    return guard("Creating shift", async () => {
      const ref = await addDoc(
        shifts(),
        stripUndefined({
          ...input,
          ...(await withUser(input)),
          cancelled: false,
          createdBy,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
      );
      const created = await getDoc(ref);
      const parsed = parseDoc(shiftSchema, created, COLLECTIONS.shifts);
      if (!parsed) throw new Error("Shift was written but could not be read back");
      return parsed;
    });
  }

  createMany(inputs: CreateShift[], createdBy: string): Promise<number> {
    return guard("Creating shifts", async () => {
      const batch = writeBatch(firestore());
      for (const input of inputs) {
        batch.set(
          doc(shifts()),
          stripUndefined({
            ...input,
            ...(await withUser(input)),
            cancelled: false,
            createdBy,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }),
        );
      }
      await batch.commit();
      return inputs.length;
    });
  }

  update(id: string, changes: UpdateShift): Promise<void> {
    return guard("Saving shift", async () => {
      await updateDoc(doc(shifts(), id), stripUndefined({ ...changes, updatedAt: serverTimestamp() }));
    });
  }

  delete(id: string): Promise<void> {
    return guard("Removing shift", async () => {
      await deleteDoc(doc(shifts(), id));
    });
  }
}
