import { z } from "zod";
import { registrationSchema, type Registration } from "@/core/models/registration";
import { attendanceSchema, type Attendance } from "@/core/models/attendance";
import { eventSchema, type Event } from "@/core/models/event";
import {
  buildExportRows,
  buildExportTable,
  exportAnswerColumns,
  filterRegistrations,
  tableToCsv,
} from "@/core/services/registration-export";
import { buildXlsx } from "@/lib/xlsx";
import { ApiError, handler, requireFestAccess, requirePermission } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { toDates } from "@/server/serialize";
import { buildTablePdf } from "@/server/export-pdf";

/**
 * GET /api/admin/registrations/export — the registration dashboard's export.
 *
 * One route for all three formats: the header row, the filtering and the
 * dynamic-answer columns are computed exactly once (`registration-export.ts`)
 * and each format is a different serialization of the same table, which is
 * what keeps a CSV, an XLSX and a PDF of the same filters from ever
 * disagreeing about what they contain.
 *
 * Requires `registration:read` and the caller's own fest scope — an export is
 * a read like any other in this app's permission model, just a bulk one.
 */
const querySchema = z.object({
  festId: z.string().min(1),
  eventId: z.string().min(1).optional(),
  status: z.enum(["confirmed", "waitlisted", "draft", "cancelled"]).optional(),
  college: z.string().max(200).optional(),
  department: z.string().max(200).optional(),
  format: z.enum(["csv", "xlsx", "pdf"]).default("csv"),
});

export const GET = handler(async (request) => {
  const caller = await requirePermission(request, "registration:read");
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw ApiError.badRequest("Bad export request.");
  const { festId, eventId, status, college, department, format } = parsed.data;

  // A single competition's export is open to whoever is assigned to it; the whole fest's is the head's.
  requireFestAccess(caller, festId, eventId);

  const db = adminDb();
  const fest = await db.collection(COLLECTIONS.fests).doc(festId).get();
  if (!fest.exists) throw ApiError.notFound("That fest no longer exists.");
  const festData = fest.data()!;

  let regQuery = db.collection(COLLECTIONS.registrations).where("festId", "==", festId) as FirebaseFirestore.Query;
  if (eventId) regQuery = regQuery.where("eventId", "==", eventId);
  const regSnap = await regQuery.get();
  const registrations: Registration[] = regSnap.docs
    .map((doc) => registrationSchema.safeParse(toDates({ ...doc.data(), id: doc.id })))
    .filter((r) => r.success)
    .map((r) => r.data!);

  const eventsSnap = await db.collection(COLLECTIONS.events).where("festId", "==", festId).get();
  const events: Event[] = eventsSnap.docs
    .map((doc) => eventSchema.safeParse(toDates({ ...doc.data(), id: doc.id })))
    .filter((e) => e.success)
    .map((e) => e.data!);
  const eventById = new Map(events.map((e) => [e.id, e]));

  const attendanceSnap = eventId
    ? await db.collection(COLLECTIONS.attendance).where("eventId", "==", eventId).get()
    : await db.collection(COLLECTIONS.attendance).where("festId", "==", festId).get();
  const attendance = new Map<string, Attendance>(
    attendanceSnap.docs
      .map((doc) => attendanceSchema.safeParse(toDates({ ...doc.data(), id: doc.id })))
      .filter((a) => a.success)
      .map((a) => [a.data!.registrationId, a.data!]),
  );

  const filtered = filterRegistrations(registrations, { eventId, status, college, department });
  const rows = buildExportRows(filtered, attendance, eventById);
  const answerCols = exportAnswerColumns(festData, events, eventId);
  const { headers, rows: table } = buildExportTable(rows, answerCols, !eventId);

  const filenameBase = `${festData.slug ?? "fest"}${eventId ? `-${eventById.get(eventId)?.slug ?? eventId}` : ""}-registrations`;

  if (format === "csv") {
    const csv = "﻿" + tableToCsv(headers, table);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filenameBase}.csv"`,
      },
    });
  }

  if (format === "xlsx") {
    const bytes = buildXlsx("Registrations", headers, table);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filenameBase}.xlsx"`,
      },
    });
  }

  const pdf = await buildTablePdf({
    title: `${festData.name ?? "Fest"} — registrations`,
    subtitle: `${filtered.length} of ${registrations.length} · ${eventId ? (eventById.get(eventId)?.title ?? "one event") : "all events"} · exported ${new Date().toLocaleDateString("en-GB")}`,
    headers,
    rows: table,
  });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filenameBase}.pdf"`,
    },
  });
}, { rateLimit: RATE_LIMITS.authenticated.exports });
