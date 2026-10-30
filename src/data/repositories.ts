import type { Repositories } from "@/core/repositories";
import { FirestoreUserRepository } from "./firebase/repositories/user-repository";
import { FirestoreFestRepository } from "./firebase/repositories/fest-repository";
import { FirestoreEventRepository } from "./firebase/repositories/event-repository";
import { FirestoreRegistrationRepository } from "./firebase/repositories/registration-repository";
import { FirestoreAttendanceRepository } from "./firebase/repositories/attendance-repository";
import { FirestoreResultRepository } from "./firebase/repositories/result-repository";
import { FirestoreCertificateRepository } from "./firebase/repositories/certificate-repository";
import { FirestoreNotificationRepository } from "./firebase/repositories/notification-repository";
import { FirestoreShiftRepository } from "./firebase/repositories/shift-repository";
import { FirestoreAuditRepository } from "./firebase/repositories/audit-repository";
import { FirestoreArenaRepository } from "./firebase/repositories/arena-repository";
import { FirestoreMatchRepository } from "./firebase/repositories/match-repository";

/**
 * The composition root.
 *
 * This is the single place that names a concrete implementation. Screens get
 * the `Repositories` object through `useRepositories()` and never import from
 * `data/firebase` directly — so moving to PostgreSQL later is a new file next
 * to this one and a one-line change here.
 */
let instance: Repositories | null = null;

export const createRepositories = (): Repositories => ({
  users: new FirestoreUserRepository(),
  fests: new FirestoreFestRepository(),
  events: new FirestoreEventRepository(),
  registrations: new FirestoreRegistrationRepository(),
  attendance: new FirestoreAttendanceRepository(),
  results: new FirestoreResultRepository(),
  certificates: new FirestoreCertificateRepository(),
  notifications: new FirestoreNotificationRepository(),
  shifts: new FirestoreShiftRepository(),
  audit: new FirestoreAuditRepository(),
  arenas: new FirestoreArenaRepository(),
  matches: new FirestoreMatchRepository(),
});

export const repositories = (): Repositories => {
  if (!instance) instance = createRepositories();
  return instance;
};
