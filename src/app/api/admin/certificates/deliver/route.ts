import { z } from "zod";
import { handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { emailService } from "@/server/email";
import { certificateIssuedEmail } from "@/server/email/templates";
import { renderCertificatePdf } from "@/server/certificates/pdf";
import type { CertificateType } from "@/core/models/certificate";

// Up to 200 PDFs and emails per call, one after another.
export const maxDuration = 300;

const bodySchema = z.object({
  festId: z.string().min(1),
  eventId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

/**
 * POST /api/admin/certificates/deliver — retry pending and failed emails.
 *
 * Certificates issued while EMAIL_PROVIDER=console sit at `skipped`; once a
 * provider is configured this flushes them. Also the retry path for bounces.
 * Never re-sends a certificate already marked `sent`.
 */
export const POST = handler(async (request) => {
  const caller = await requirePermission(request, "certificate:issue");
  const { festId, eventId, limit } = await readBody(request, bodySchema);
  requireFestAccess(caller, festId);

  const mailer = emailService();
  if (!mailer.canSend) {
    return ok({ attempted: 0, sent: 0, failed: 0, reason: `No email provider configured (EMAIL_PROVIDER=${mailer.name}).` });
  }

  const db = adminDb();
  let q = db.collection(COLLECTIONS.certificates).where("festId", "==", festId).where("delivery.status", "in", ["pending", "failed", "skipped"]);
  if (eventId) q = q.where("eventId", "==", eventId);
  const snap = await q.limit(limit).get();

  const fest = await db.collection(COLLECTIONS.fests).doc(festId).get();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");

  let sent = 0;
  let failed = 0;

  for (const doc of snap.docs) {
    const c = doc.data();
    if (c.revoked === true) continue;

    let pdf: Uint8Array | null = null;
    try {
      pdf = await renderCertificatePdf({
        recipientName: String(c.recipientName),
        type: c.type as CertificateType,
        eventTitle: String(c.eventTitle),
        festName: String(c.festName),
        organizationName: String(fest.data()?.organizationName ?? ""),
        teamName: c.teamName ? String(c.teamName) : undefined,
        position: typeof c.position === "number" ? c.position : undefined,
        issuedOn: c.issuedAt?.toDate?.() ?? new Date(),
        certificateNumber: String(c.certificateNumber),
        verifyUrl: `${appUrl}/verify/${c.certificateNumber}`,
      });
    } catch {
      pdf = null;
    }

    const message = certificateIssuedEmail({
      to: String(c.recipientEmail),
      recipientName: String(c.recipientName),
      eventTitle: String(c.eventTitle),
      festName: String(c.festName),
      type: c.type as CertificateType,
      certificateNumber: String(c.certificateNumber),
      attachmentFilename: pdf ? `${c.certificateNumber}.pdf` : undefined,
      meta: { userId: String(c.userId), festId: String(c.festId), eventId: String(c.eventId), subjectType: "certificate", subjectId: doc.id },
    });
    if (pdf) message.attachments = [{ filename: `${c.certificateNumber}.pdf`, content: Buffer.from(pdf), contentType: "application/pdf" }];

    const result = await mailer.send(message);
    if (result.ok) {
      sent += 1;
      await doc.ref.update({ "delivery.status": "sent", "delivery.sentAt": FieldValue.serverTimestamp(), "delivery.attempts": FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
    } else {
      failed += 1;
      await doc.ref.update({ "delivery.status": "failed", "delivery.lastError": result.error.slice(0, 500), "delivery.attempts": FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
    }
  }

  return ok({ attempted: snap.size, sent, failed });
}, { rateLimit: RATE_LIMITS.authenticated.certificates });
