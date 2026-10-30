import type { Unsubscribe } from "../models/common";
import type { CreateShift, Shift, UpdateShift } from "../models/shift";

export interface ShiftRepository {
  getById(id: string): Promise<Shift | null>;

  /** A volunteer's own roster for a fest, soonest first. */
  listForUser(festId: string, userId: string): Promise<Shift[]>;

  subscribeForUser(
    festId: string,
    userId: string,
    onChange: (shifts: Shift[]) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  /** Every shift in a fest, optionally for one day, for the admin roster. */
  listByFest(festId: string, date?: string): Promise<Shift[]>;

  subscribeByFest(
    festId: string,
    onChange: (shifts: Shift[]) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  create(input: CreateShift, createdBy: string): Promise<Shift>;

  createMany(inputs: CreateShift[], createdBy: string): Promise<number>;

  update(id: string, changes: UpdateShift): Promise<void>;

  delete(id: string): Promise<void>;
}
