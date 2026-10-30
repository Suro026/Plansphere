import { NextResponse } from "next/server";
import { handler } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { logCertificateEvent } from "@/server/public-lookup";
import { renderCertificatePdf } from "@/server/certificates/pdf";
import type { CertificateType } from "@/core/models/certificate";

/**
 * GET /api/verify/[number]/pdf — the certificate as a PDF, rendered on
 * demand from the record.
 *
 * This is the download link when Storage is unavailable, and it is always a
 * faithful copy: the PDF is produced from the same document the verify page
 * shows, so it cannot disagree with it. A revoked certificate renders with a
 * REVOKED banner rather than 404ing — someone holding a printout should be
 * able to learn that it no longer stands.
 */
export const GET = handler(async (request, context) => {
  const { number } = await context.params;
  const certificateNumber = (number ?? "").trim().toUpperCase();

  const db = adminDb();
  const snap = await db.collection(COLLECTIONS.certificates).where("certificateNumber", "==", certificateNumber).limit(1).get();
  if (snap.empty) return NextResponse.json({ error: "No such certificate." }, { status: 404 });

  const c = snap.docs[0]!.data();
  void logCertificateEvent(snap.docs[0]!.id, c, "download");
  const fest = await db.collection(COLLECTIONS.fests).doc(String(c.festId)).get();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");

  const pdf = await renderCertificatePdf({
    recipientName: String(c.recipientName),
    type: c.type as CertificateType,
    eventTitle: String(c.eventTitle),
    festName: String(c.festName),
    organizationName: String(fest.data()?.organizationName ?? ""),
    teamName: c.teamName ? String(c.teamName) : undefined,
    position: typeof c.position === "number" ? c.position : undefined,
    issuedOn: c.issuedAt?.toDate?.() ?? new Date(),
    certificateNumber,
    verifyUrl: `${appUrl}/verify/${certificateNumber}`,
    note: c.revoked === true ? "REVOKED — this certificate no longer stands." : undefined,
  });

  return new NextResponse(Buffer.from(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${certificateNumber}.pdf"`,
      "Cache-Control": "public, max-age=300",
    },
  });
}, { rateLimit: RATE_LIMITS.public.verify });
