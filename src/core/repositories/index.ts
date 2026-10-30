export type { UserRepository } from "./user-repository";
export type { FestRepository, FestQuery } from "./fest-repository";
export type { EventRepository, EventQuery } from "./event-repository";
export type {
  RegistrationRepository,
  RegistrationQuery,
} from "./registration-repository";
export type { AttendanceRepository } from "./attendance-repository";
export type { ResultRepository } from "./result-repository";
export type { CertificateRepository, CertificateQuery } from "./certificate-repository";
export type { NotificationRepository } from "./notification-repository";
export type { ShiftRepository } from "./shift-repository";
export type { AuditRepository } from "./audit-repository";
export type { GenerateSummary } from "./certificate-repository";
export type { ArenaRepository } from "./arena-repository";
export type { MatchRepository, MatchQuery } from "./match-repository";

import type { UserRepository } from "./user-repository";
import type { FestRepository } from "./fest-repository";
import type { EventRepository } from "./event-repository";
import type { RegistrationRepository } from "./registration-repository";
import type { AttendanceRepository } from "./attendance-repository";
import type { ResultRepository } from "./result-repository";
import type { CertificateRepository } from "./certificate-repository";
import type { NotificationRepository } from "./notification-repository";
import type { ShiftRepository } from "./shift-repository";
import type { AuditRepository } from "./audit-repository";
import type { ArenaRepository } from "./arena-repository";
import type { MatchRepository } from "./match-repository";

/**
 * The full set of repositories, resolved once and handed to the UI through a
 * React context.
 *
 * Swapping Firestore for PostgreSQL later means writing a second object that
 * satisfies this type. No screen changes, because no screen ever names a
 * concrete implementation.
 */
export interface Repositories {
  users: UserRepository;
  fests: FestRepository;
  events: EventRepository;
  registrations: RegistrationRepository;
  attendance: AttendanceRepository;
  results: ResultRepository;
  certificates: CertificateRepository;
  notifications: NotificationRepository;
  shifts: ShiftRepository;
  audit: AuditRepository;
  arenas: ArenaRepository;
  matches: MatchRepository;
}
