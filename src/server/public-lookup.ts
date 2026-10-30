import { admissionBlock, type AdmissionBlock } from "@/core/models/admission";
import { COLLECTIONS, FieldValue, adminDb } from "./firebase-admin";
import type { RegistrationStatus } from "@/core/models/registration";

/**
 * Public lookups — what a stranger with a QR code is allowed to learn.
 *
 * Both deliberately return a narrow shape: the fields printed on the
 * certificate or ticket, the gate scan that backs it, and nothing else. No
 * email, no phone, no college ID, no document ids that would let someone
 * enumerate the collection.
 */

export interface PublicCertificate {
  certificateNumber: string;
  recipientName: string;
  type: string;
  position: number | null;
  eventTitle: string;
  festName: string;
  festSlug: string | null;
  issuer: string | null;
  teamName: string | null;
  memberCount: number;
  issuedAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
  fileUrl: string | null;
  attendanceVerifiedAt: string | null;
  attendanceGate: string | null;
}

const iso = (v: unknown): string | null => {
  const d = (v as { toDate?: () => Date } | undefined)?.toDate?.();
  return d ? d.toISOString() : null;
};

export const lookupCertificate = async (raw: string): Promise<{ certificate: PublicCertificate | null; reason?: "malformed" | "not-found" }> => {
  const certificateNumber = raw.trim().toUpperCase();
  if (!/^(?:PS|FF)-\d{4}-[0-9A-HJ-NP-Z]{8}$/.test(certificateNumber)) return { certificate: null, reason: "malformed" };

  const db = adminDb();
  const snap = await db.collection(COLLECTIONS.certificates).where("certificateNumber", "==", certificateNumber).limit(1).get();
  if (snap.empty) return { certificate: null, reason: "not-found" };

  const c = snap.docs[0]!.data();

  // A certificate that has been prepared but not released does not exist as
  // far as the public is concerned: nobody holds the number yet, and
  // confirming it would announce a decision the owner has not made.
  if (c.published === false) return { certificate: null, reason: "not-found" };

  const [attendance, fest, registration] = await Promise.all([
    db.collection(COLLECTIONS.attendance).doc(String(c.registrationId)).get(),
    db.collection(COLLECTIONS.fests).doc(String(c.festId)).get(),
    db.collection(COLLECTIONS.registrations).doc(String(c.registrationId)).get(),
  ]);

  // Fire-and-forget: a broken analytics write must never break the page a
  // recruiter is looking at, so it is never awaited into the response and
  // its failure is swallowed rather than thrown.
  void logCertificateEvent(snap.docs[0]!.id, c, "verify");

  return {
    certificate: {
      certificateNumber,
      recipientName: String(c.recipientName),
      type: String(c.type),
      position: typeof c.position === "number" ? c.position : null,
      eventTitle: String(c.eventTitle),
      festName: String(c.festName),
      festSlug: fest.data()?.slug ? String(fest.data()!.slug) : null,
      issuer: fest.data()?.organizationName ? String(fest.data()!.organizationName) : null,
      teamName: c.teamName ? String(c.teamName) : null,
      memberCount: Array.isArray(registration.data()?.members) ? (registration.data()!.members as unknown[]).length : 1,
      issuedAt: iso(c.issuedAt),
      revoked: c.revoked === true,
      revokedAt: iso(c.revokedAt),
      fileUrl: c.fileUrl ? String(c.fileUrl) : null,
      attendanceVerifiedAt: attendance.exists ? iso(attendance.data()!.scannedAt) : null,
      attendanceGate: attendance.exists && attendance.data()!.gate ? String(attendance.data()!.gate) : null,
    },
  };
};

/** Appends one row to the certificate analytics log. Never throws. */
export const logCertificateEvent = async (
  certificateId: string,
  certificate: { certificateNumber?: unknown; festId?: unknown; eventId?: unknown },
  type: "verify" | "download",
): Promise<void> => {
  try {
    const ref = adminDb().collection(COLLECTIONS.certificateEvents).doc();
    await ref.set({
      id: ref.id,
      certificateId,
      certificateNumber: String(certificate.certificateNumber ?? ""),
      festId: String(certificate.festId ?? ""),
      eventId: String(certificate.eventId ?? ""),
      type,
      at: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.warn("[analytics] couldn't log certificate event", type, error);
  }
};

export interface PublicTicket {
  ticketCode: string;
  holderName: string;
  eventTitle: string;
  festName: string;
  festSlug: string | null;
  issuer: string | null;
  eventDate: string | null;
  eventStartTime: string | null;
  venue: string | null;
  teamName: string | null;
  memberCount: number;
  status: RegistrationStatus;
  /** Why this ticket would not admit anyone, or null if it would. Same rule as every gate. */
  block: AdmissionBlock | null;
  entryAt: string | null;
  entryGate: string | null;
}

export const lookupTicket = async (raw: string): Promise<{ ticket: PublicTicket | null; reason?: "malformed" | "not-found" }> => {
  const ticketCode = raw.trim().toUpperCase();
  if (!/^(?:PS|FF)-[0-9A-HJ-NP-Z]{10}$/.test(ticketCode)) return { ticket: null, reason: "malformed" };

  const db = adminDb();
  const snap = await db.collection(COLLECTIONS.registrations).where("ticketCode", "==", ticketCode).limit(1).get();
  if (snap.empty) return { ticket: null, reason: "not-found" };

  const r = snap.docs[0]!;
  const reg = r.data();
  const [event, fest, attendance] = await Promise.all([
    db.collection(COLLECTIONS.events).doc(String(reg.eventId)).get(),
    db.collection(COLLECTIONS.fests).doc(String(reg.festId)).get(),
    db.collection(COLLECTIONS.attendance).doc(r.id).get(),
  ]);

  return {
    ticket: {
      ticketCode,
      holderName: String(reg.userName),
      eventTitle: String(reg.eventTitle ?? event.data()?.title ?? ""),
      festName: String(fest.data()?.name ?? ""),
      festSlug: fest.data()?.slug ? String(fest.data()!.slug) : null,
      issuer: fest.data()?.organizationName ? String(fest.data()!.organizationName) : null,
      eventDate: event.data()?.date ? String(event.data()!.date) : null,
      eventStartTime: event.data()?.startTime ? String(event.data()!.startTime) : null,
      venue: event.data()?.venue ? String(event.data()!.venue) : null,
      teamName: reg.teamName ? String(reg.teamName) : null,
      memberCount: Array.isArray(reg.members) ? (reg.members as unknown[]).length : 1,
      status: (reg.status as PublicTicket["status"]) ?? "confirmed",
      block: admissionBlock({ status: reg.status, paymentStatus: reg.paymentStatus }),
      entryAt: attendance.exists ? iso(attendance.data()!.scannedAt) : null,
      entryGate: attendance.exists && attendance.data()!.gate ? String(attendance.data()!.gate) : null,
    },
  };
};
