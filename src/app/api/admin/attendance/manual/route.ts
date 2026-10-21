import { z } from "zod";
import { admissionBlock } from "@/core/models/admission";
import { blockOutcome } from "@/core/models/attendance";
import { handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { audit } from "@/server/audit";
import { compact } from "@/server/serialize";

const bodySchema = z.object({
  /** Ticket code or the registrant's email — whichever the desk has. */
  ticketCode: z.string().trim().min(3).max(254),
  eventId: z.string().min(1),
  gate: z.string().trim().max(200).optional(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * POST /api/admin/attendance/manual — mark entry without a scan.
 *
 * The design's copy: "Mark entry for a participant whose phone died. The
 * override is written to the audit log against your account and shows as
 * manual in every report." Admin-only; a volunteer's account cannot do this
 * from the scanner, which is the point.
 */
export const POST = handler(async (request) => {
  const caller = await requirePermission(request, "attendance:manual");
  const input = await readBody(request, bodySchema);
  const db = adminDb();

  const needle = input.ticketCode.trim();
  const byCode = await db.collection(COLLECTIONS.registrations).where("ticketCode", "==", needle.toUpperCase()).limit(1).get();
  const match = byCode.empty
    ? await db.collection(COLLECTIONS.registrations).where("eventId", "==", input.eventId).where("userEmail", "==", needle.toLowerCase()).limit(1).get()
    : byCode;

  if (match.empty) return ok({ result: "not-found" });

  const regSnap = match.docs[0]!;
  const reg = regSnap.data();
  requireFestAccess(caller, String(reg.festId));

  if (reg.eventId !== input.eventId) {
    const other = await db.collection(COLLECTIONS.events).doc(String(reg.eventId)).get();
    return ok({ result: "wrong-event", expectedEventTitle: String(other.data()?.title ?? reg.eventTitle) });
  }
  const block = admissionBlock({ status: reg.status, paymentStatus: reg.paymentStatus });
  if (block) return ok(blockOutcome(block));

  const attRef = db.collection(COLLECTIONS.attendance).doc(regSnap.id);
  const actorSnap = await db.collection(COLLECTIONS.users).doc(caller.uid).get();
  const actorName = String(actorSnap.data()?.name ?? actorSnap.data()?.fullName ?? caller.email);

  const outcome = await db.runTransaction(async (tx) => {
    const existing = await tx.get(attRef);
    if (existing.exists) {
      const d = existing.data()!;
      return { result: "already-recorded" as const, at: d.scannedAt?.toDate?.() ?? new Date(), by: d.scannedByName ?? undefined };
    }
    tx.set(
      attRef,
      compact({
        id: attRef.id,
        registrationId: regSnap.id,
        eventId: reg.eventId,
        festId: reg.festId,
        userId: reg.userId,
        userName: reg.userName,
        userEmail: reg.userEmail,
        ticketCode: reg.ticketCode,
        teamName: reg.teamName,
        method: "manual",
        gate: input.gate,
        scannedAt: FieldValue.serverTimestamp(),
        scannedBy: caller.uid,
        scannedByName: actorName,
        queuedOffline: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }),
    );
    tx.update(db.collection(COLLECTIONS.fests).doc(String(reg.festId)), { "stats.checkIns": FieldValue.increment(1) });
    return {
      result: "ok" as const,
      registration: {
        id: regSnap.id,
        userName: String(reg.userName),
        ticketCode: String(reg.ticketCode),
        ...(reg.teamName ? { teamName: String(reg.teamName) } : {}),
        memberCount: Array.isArray(reg.members) ? reg.members.length : 1,
      },
    };
  });

  if (outcome.result === "ok") {
    await audit(
      { ...caller, name: actorName },
      {
        action: "manual_entry",
        summary: `Manual entry · ${reg.ticketCode} (${reg.userName})${input.reason ? ` — ${input.reason}` : ""}`,
        festId: String(reg.festId),
        eventId: String(reg.eventId),
        subjectType: "registration",
        subjectId: regSnap.id,
        details: { gate: input.gate, reason: input.reason },
      },
    );
  }

  return ok(outcome);
});
