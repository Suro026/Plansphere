import { PAYMENT_STATUS_LABELS, type RegistrationPaymentStatus } from "../models/payment";
import type { Registration } from "../models/registration";
import type { Attendance } from "../models/attendance";
import type { Event } from "../models/event";
import { answerColumns, mergeRegistrationFields, type RegistrationFields } from "../models/registration-fields";

/**
 * The registration export, as one shared shape.
 *
 * Building the header row and the data rows here — rather than once per
 * format — is what keeps CSV, XLSX and PDF from quietly drifting apart: a
 * fest's custom question added to one export and not the others is a bug
 * this file makes structurally impossible, because there is only one place
 * that decides what a column is.
 */

export interface ExportFilters {
  eventId?: string;
  status?: "confirmed" | "waitlisted" | "draft" | "cancelled";
  college?: string;
  department?: string;
}

export interface ExportRow {
  registrationId: string;
  eventTitle: string;
  teamName: string;
  student: string;
  college: string;
  phone: string;
  status: string;
  payment: string;
  qr: string;
  attendance: string;
  answers: Record<string, string>;
}

/** The leader's college — from their answer if the fest asked, else from the roster. */
const leaderCollege = (registration: Registration): string =>
  registration.answers?.college ?? registration.members.find((m) => m.isLeader)?.college ?? registration.members[0]?.college ?? "";

const leaderDepartment = (registration: Registration): string => registration.answers?.department ?? "";

const leaderPhone = (registration: Registration): string =>
  registration.answers?.phone ?? registration.members.find((m) => m.isLeader)?.phone ?? registration.members[0]?.phone ?? "";

/** "Free" / "₹500" — derived from the event's fee, since there is no payment gateway to ask instead. */
const paymentLabel = (entryFee: number | undefined, paymentStatus?: string): string => {
  const base = !entryFee ? "Free" : `₹${entryFee.toLocaleString("en-IN")}`;
  // Collected online: say where the money stands. Free and legacy entries read exactly as before.
  const state = paymentStatus && paymentStatus !== "not_required" ? PAYMENT_STATUS_LABELS[paymentStatus as RegistrationPaymentStatus] : undefined;
  return state ? `${base} · ${state}` : base;
};

export const filterRegistrations = (
  registrations: readonly Registration[],
  filters: ExportFilters,
): Registration[] =>
  registrations.filter((r) => {
    if (filters.eventId && r.eventId !== filters.eventId) return false;
    if (filters.status && r.status !== filters.status) return false;
    if (filters.college && !leaderCollege(r).toLowerCase().includes(filters.college.toLowerCase())) return false;
    if (filters.department && !leaderDepartment(r).toLowerCase().includes(filters.department.toLowerCase())) return false;
    return true;
  });

/**
 * The registration fields an export should show columns for. An event
 * without its own override just uses the fest's; see
 * `mergeRegistrationFields`.
 */
export const exportAnswerColumns = (
  fest: { registrationFields?: RegistrationFields | undefined },
  events: readonly Pick<Event, "id" | "registrationFields" | "entryFee">[],
  eventId: string | undefined,
): { key: string; label: string }[] => {
  if (eventId) {
    const event = events.find((e) => e.id === eventId);
    return answerColumns(mergeRegistrationFields(fest.registrationFields, event?.registrationFields));
  }
  // Fest-wide export: every column any of its events could ask for, merged
  // and deduplicated by key so the sheet has one "College" column, not one
  // per event.
  const seen = new Map<string, { key: string; label: string }>();
  for (const event of events) {
    for (const column of answerColumns(mergeRegistrationFields(fest.registrationFields, event.registrationFields))) {
      if (!seen.has(column.key)) seen.set(column.key, column);
    }
  }
  return [...seen.values()];
};

export const buildExportRows = (
  registrations: readonly Registration[],
  attendance: ReadonlyMap<string, Attendance>,
  eventById: ReadonlyMap<string, Pick<Event, "title" | "entryFee">>,
): ExportRow[] =>
  registrations.map((r) => {
    const att = attendance.get(r.id);
    const event = eventById.get(r.eventId);
    return {
      registrationId: r.id,
      eventTitle: event?.title ?? r.eventTitle,
      teamName: r.teamName ?? "",
      student: r.userName,
      college: leaderCollege(r),
      phone: leaderPhone(r),
      status: att ? "checked_in" : r.status,
      payment: paymentLabel(event?.entryFee, r.paymentStatus),
      qr: r.ticketCode,
      attendance: att ? att.scannedAt.toISOString() : "",
      answers: r.answers ?? {},
    };
  });

/** Header + rows, ready for any of the three formats — the one table every export starts from. */
export const buildExportTable = (
  rows: readonly ExportRow[],
  answerCols: readonly { key: string; label: string }[],
  includeEventColumn: boolean,
): { headers: string[]; rows: (string | number)[][] } => {
  const headers = [
    ...(includeEventColumn ? ["Event"] : []),
    "Registration ID",
    "Student / Team",
    "College",
    "Phone",
    "Status",
    "Payment",
    "QR (ticket code)",
    "Attendance",
    ...answerCols.map((c) => c.label),
  ];

  const data = rows.map((row) => [
    ...(includeEventColumn ? [row.eventTitle] : []),
    row.registrationId,
    row.teamName ? `${row.teamName} (${row.student})` : row.student,
    row.college,
    row.phone,
    row.status,
    row.payment,
    row.qr,
    row.attendance,
    ...answerCols.map((c) => row.answers[c.key] ?? ""),
  ]);

  return { headers, rows: data };
};

/** CSV, quoted per RFC 4180. */
export const tableToCsv = (headers: readonly string[], rows: readonly (string | number)[][]): string => {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [headers.map(esc).join(","), ...rows.map((row) => row.map(esc).join(","))].join("\r\n");
};
