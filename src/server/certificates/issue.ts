import { computeCertificateEligibility } from "@/core/services/certificate-eligibility";
import { certificateIdFor, generateCertificateNumber, type CertificateDraft, type CertificateType } from "@/core/models/certificate";
import { registrationSchema, type Registration } from "@/core/models/registration";
import { resultSchema, type Result } from "@/core/models/result";
import type { GenerateSummary } from "@/core/repositories/certificate-repository";
import { COLLECTIONS, FieldValue, adminDb } from "../firebase-admin";
import { emailService } from "../email";
import { notify } from "../notify";
import { certificateIssuedEmail } from "../email/templates";
import { compact, randomBytes, toDates } from "../serialize";
import { renderCertificatePdf } from "./pdf";
import { BUCKETS } from "../storage/client";
import { storeUpload } from "../storage/upload";

/**
 * The post-event certificate run for one event.
 *
 *  1. Gather registrations, attendance, the result sheet, and resolve any
 *     teammate emails to accounts.
 *  2. `computeCertificateEligibility` — the pure policy in src/core — decides
 *     who gets what. Nothing here second-guesses it.
 *  3. Issue: one document per person per event, keyed deterministically, so
 *     a re-run after an amended result sheet updates rather than duplicates.
 *  4. Render the PDF, cache it best-effort in the private `certificates`
 *     Supabase bucket, email it, notify in-app. The link everyone actually
 *     gets is always the on-demand PDF route (below) — never a stored URL —
 *     because that bucket is private and a signed URL into it expires,
 *     while a certificate has to keep working for years.
 *
 * `dryRun` performs step 1–2 only and returns the counts for the
 * confirmation screen.
 */

export interface IssueOptions {
  eventId: string;
  actorId: string;
  dryRun: boolean;
  appUrl: string;
  /**
   * `prepare` writes the certificates and stops. `publish` releases them:
   * the student sees them, the email goes out, the download works. An admin
   * may only prepare; releasing is the platform owner's.
   */
  mode?: "prepare" | "publish";
  /** Restrict the run to these recipients. Empty or absent means everyone eligible. */
  only?: ReadonlySet<string>;
  /** Artwork to print on, uploaded by the super admin. */
  templateUrl?: string;
}

/** Fetches the template once for the whole run; a failure is not fatal. */
const loadTemplate = async (url: string | undefined): Promise<Uint8Array | undefined> => {
  if (!url) return undefined;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    console.warn("[certificates] template unavailable, using the built-in design:", (error as Error).message);
    return undefined;
  }
};

const publicPdfUrl = (appUrl: string, certificateNumber: string) => `${appUrl}/api/verify/${certificateNumber}/pdf`;

export const issueCertificatesForEvent = async (
  options: IssueOptions,
): Promise<GenerateSummary & { eventTitle: string; drafts: CertificateDraft[] }> => {
  const db = adminDb();
  const { eventId, actorId, dryRun, appUrl } = options;
  const publish = options.mode !== "prepare";
  const only = options.only;

  const eventSnap = await db.collection(COLLECTIONS.events).doc(eventId).get();
  if (!eventSnap.exists) throw new Error("Event not found");
  const event = eventSnap.data()!;

  const festSnap = await db.collection(COLLECTIONS.fests).doc(String(event.festId)).get();
  const fest = festSnap.data() ?? {};

  // Registrations — parsed through the shared schema so the policy sees the
  // same shape the client does.
  const regSnap = await db.collection(COLLECTIONS.registrations).where("eventId", "==", eventId).get();
  const registrations: Registration[] = regSnap.docs
    .map((d) => registrationSchema.safeParse(toDates({ ...d.data(), id: d.id })))
    .filter((r) => r.success)
    .map((r) => r.data!);

  const attSnap = await db.collection(COLLECTIONS.attendance).where("eventId", "==", eventId).get();
  const attendedRegistrationIds = new Set(attSnap.docs.map((d) => d.id));

  const resultSnap = await db.collection(COLLECTIONS.results).doc(eventId).get();
  const result: Result | null = resultSnap.exists
    ? (() => {
        const parsed = resultSchema.safeParse(toDates({ ...resultSnap.data(), id: resultSnap.id }));
        return parsed.success ? parsed.data : null;
      })()
    : null;

  // Resolve teammates entered by email to accounts.
  const emails = [...new Set(registrations.flatMap((r) => r.members.filter((m) => !m.userId).map((m) => m.email.toLowerCase())))];
  const userIdByEmail = new Map<string, string>();
  for (let i = 0; i < emails.length; i += 30) {
    const chunk = emails.slice(i, i + 30);
    if (!chunk.length) break;
    const found = await db.collection(COLLECTIONS.users).where("email", "in", chunk).get();
    for (const d of found.docs) userIdByEmail.set(String(d.data().email).toLowerCase(), d.id);
  }

  const outcome = computeCertificateEligibility({
    event: { id: eventId, title: String(event.title), festId: String(event.festId) },
    fest: { id: String(event.festId), name: String(fest.name ?? "") },
    registrations,
    attendedRegistrationIds,
    result,
    userIdByEmail,
  });

  const base: GenerateSummary & { eventTitle: string; drafts: CertificateDraft[] } = {
    dryRun,
    // The release desk needs the list, not just the count: it is what the
    // super admin ticks names off.
    drafts: outcome.drafts,
    eventTitle: String(event.title),
    eligible: outcome.drafts.length,
    created: 0,
    published: 0,
    existing: 0,
    emailed: 0,
    skipped: 0,
    failed: 0,
    unmatched: outcome.unmatched.map((u) => ({ name: u.name, email: u.email, type: u.type })),
    byType: outcome.summary.byType,
  };

  if (dryRun) return base;

  const mailer = emailService();
  const template = await loadTemplate(options.templateUrl);
  const year = new Date().getFullYear();

  const noteFor = (draft: CertificateDraft): string | undefined => {
    if (!result || draft.type === "participation") return undefined;
    const entry = result.entries.find((e) => e.registrationId === draft.registrationId);
    return entry?.note;
  };

  for (const draft of outcome.drafts) {
    // A release can be limited to the recipients the super admin ticked.
    if (only && only.size > 0 && !only.has(draft.userId)) continue;

    const id = certificateIdFor(draft.eventId, draft.userId);
    const ref = db.collection(COLLECTIONS.certificates).doc(id);
    const existing = await ref.get();

    // Re-runs: keep the number, refresh type/position if the sheet changed.
    const certificateNumber: string = existing.exists ? String(existing.data()!.certificateNumber) : generateCertificateNumber(year, randomBytes);
    const issuedAt: Date = existing.exists && existing.data()!.issuedAt?.toDate ? existing.data()!.issuedAt.toDate() : new Date();
    const typeChanged = existing.exists && existing.data()!.type !== draft.type;

    const alreadyReleased = existing.exists && existing.data()!.published !== false;

    // Nothing left to do: the certificate exists, says the right thing, and
    // has already reached its recipient. A prepare run stops here too — the
    // document is there and re-rendering it would only churn Storage.
    if (existing.exists && !typeChanged && existing.data()!.revoked !== true && (alreadyReleased || !publish)) {
      base.existing += 1;
      continue;
    }

    const verifyUrl = `${appUrl}/verify/${certificateNumber}`;
    const note = noteFor(draft);

    let pdf: Uint8Array | null = null;
    try {
      pdf = await renderCertificatePdf({
        recipientName: draft.recipientName,
        type: draft.type as CertificateType,
        eventTitle: draft.eventTitle,
        festName: draft.festName,
        organizationName: String(fest.organizationName ?? ""),
        teamName: draft.teamName,
        position: draft.position,
        issuedOn: issuedAt,
        certificateNumber,
        verifyUrl,
        note,
        ...(template ? { template } : {}),
      });
    } catch (error) {
      console.error("[certificates] render failed", id, error);
    }

    // Always the on-demand route — stable forever, and it renders the exact
    // same PDF. The Supabase write below is a cache, never the link anyone
    // is given: `certificates` is a private bucket, so a link into it would
    // be a signed URL with an expiry, which a certificate cannot have.
    const fileUrl = publicPdfUrl(appUrl, certificateNumber);
    if (pdf) {
      try {
        const path = `users/${draft.userId}/${certificateNumber}.pdf`;
        await storeUpload(BUCKETS.certificates, path, Buffer.from(pdf), "application/pdf", { uploadedBy: options.actorId, kind: "certificatePdf" });
      } catch (error) {
        console.warn("[certificates] storage cache skipped:", (error as Error).message);
      }
    }

    await ref.set(
      compact({
        id,
        certificateNumber,
        userId: draft.userId,
        eventId: draft.eventId,
        festId: draft.festId,
        registrationId: draft.registrationId,
        type: draft.type,
        recipientName: draft.recipientName,
        recipientEmail: draft.recipientEmail,
        eventTitle: draft.eventTitle,
        festName: draft.festName,
        teamName: draft.teamName,
        position: draft.position,
        issuedAt: existing.exists ? existing.data()!.issuedAt : FieldValue.serverTimestamp(),
        issuedBy: actorId,
        fileUrl,
        published: publish,
        ...(publish ? { publishedAt: FieldValue.serverTimestamp(), publishedBy: actorId } : {}),
        ...(options.templateUrl ? { templateUrl: options.templateUrl } : {}),
        delivery: { status: "pending", attempts: 0 },
        revoked: false,
        createdAt: existing.exists ? existing.data()!.createdAt : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }),
      { merge: true },
    );
    if (existing.exists) base.existing += 1;
    else base.created += 1;

    // A prepared certificate is not announced: no email, no notification, and
    // the student's page filters it out. The release below is what tells
    // anyone it exists.
    if (!publish) continue;
    base.published += 1;

    // Email — with the PDF attached when we have it.
    const message = certificateIssuedEmail({
      to: draft.recipientEmail,
      recipientName: draft.recipientName,
      eventTitle: draft.eventTitle,
      festName: draft.festName,
      type: draft.type as CertificateType,
      certificateNumber,
      attachmentFilename: pdf ? `${certificateNumber}.pdf` : undefined,
      meta: { userId: draft.userId, festId: draft.festId, eventId: draft.eventId, subjectType: "certificate", subjectId: id },
    });
    if (pdf) message.attachments = [{ filename: `${certificateNumber}.pdf`, content: Buffer.from(pdf), contentType: "application/pdf" }];

    const delivery = await mailer.send(message);
    const status = !mailer.canSend ? "skipped" : delivery.ok ? "sent" : "failed";
    await ref.update(
      compact({
        "delivery.status": status,
        "delivery.attempts": FieldValue.increment(1),
        ...(status === "sent" ? { "delivery.sentAt": FieldValue.serverTimestamp() } : {}),
        ...(status === "failed" && !delivery.ok ? { "delivery.lastError": delivery.error.slice(0, 500) } : {}),
      }),
    );
    if (status === "sent") base.emailed += 1;
    else if (status === "skipped") base.skipped += 1;
    else base.failed += 1;

    await notify({
      userId: draft.userId,
      type: "certificate_issued",
      title: "Your certificate is ready",
      body: `${draft.eventTitle} · ${draft.festName}`,
      link: "/certificates",
      festId: draft.festId,
      eventId: draft.eventId,
    });
  }

  if (resultSnap.exists) {
    await resultSnap.ref.update({ certificatesGeneratedAt: FieldValue.serverTimestamp() });
  }

  return base;
};
