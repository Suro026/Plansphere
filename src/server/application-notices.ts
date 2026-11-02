import * as Sentry from "@sentry/nextjs";
import { COLLECTIONS, adminDb } from "./firebase-admin";
import { emailService } from "./email";
import { applicationApprovedEmail, applicationReceivedEmail, applicationRejectedEmail, applicationReviewRequestEmail, appUrl } from "./email/templates";

/**
 * The emails around a college-event application: received, waiting for review, approved, rejected.
 *
 * They are courtesy messages, never part of the decision. Every function here swallows its own failure (a bounced
 * address, a provider outage, a missing user document) and reports it to the log and Sentry instead of throwing, so
 * an application is never lost and an approval is never undone because an email did not go out. The applicant's
 * status page (`GET /api/register-event`) is always the source of truth.
 *
 * What is sent stays minimal: the reviewer is told an event and a college are waiting, not who applied or what they
 * uploaded; a rejection reason has already been screened (`checkReason`) for personal details.
 */

const safely = async (label: string, work: () => Promise<unknown>): Promise<void> => {
  try {
    await work();
  } catch (error) {
    console.warn(`[application-notices] ${label} failed:`, error instanceof Error ? error.message : error);
    Sentry.captureException(error, { tags: { kind: "application-notice", label }, level: "warning" });
  }
};

const applicantOf = async (uid: string): Promise<{ email: string; name: string } | null> => {
  const profile = (await adminDb().collection(COLLECTIONS.users).doc(uid).get()).data();
  const email = typeof profile?.email === "string" ? profile.email : "";
  if (!email) return null;
  return { email, name: typeof profile?.name === "string" ? profile.name : "" };
};

/** Platform accounts that decide applications: active global super admins with an address. At most a handful. */
export const reviewerEmails = async (): Promise<string[]> => {
  const snap = await adminDb().collection(COLLECTIONS.users).where("role", "==", "super_admin").limit(20).get();
  return snap.docs
    .map((doc) => doc.data())
    .filter((data) => data.disabled !== true && typeof data.email === "string" && data.email)
    .map((data) => String(data.email));
};

/** After submission: confirm to the applicant and tell the reviewers. */
export const noticeApplicationSubmitted = async (input: {
  festId: string;
  applicantId: string;
  applicantEmail: string;
  eventName: string;
  organizationName: string;
  city?: string | undefined;
}): Promise<void> => {
  const mailer = emailService();
  await safely("applicant confirmation", async () => {
    const applicant = (await applicantOf(input.applicantId)) ?? { email: input.applicantEmail, name: "" };
    await mailer.send(
      applicationReceivedEmail({
        to: applicant.email || input.applicantEmail,
        recipientName: applicant.name,
        eventName: input.eventName,
        meta: { userId: input.applicantId, festId: input.festId, subjectType: "fest", subjectId: input.festId },
      }),
    );
  });
  await safely("reviewer alert", async () => {
    const recipients = (await reviewerEmails()).filter((address) => address.toLowerCase() !== input.applicantEmail.toLowerCase());
    await Promise.all(
      recipients.map((to) =>
        mailer.send(
          applicationReviewRequestEmail({
            to,
            eventName: input.eventName,
            organizationName: input.organizationName,
            ...(input.city ? { city: input.city } : {}),
            meta: { festId: input.festId, subjectType: "fest", subjectId: input.festId },
          }),
        ),
      ),
    );
  });
};

/** After approval: tell the applicant, with a link straight into the event console. */
export const noticeApplicationApproved = async (festId: string, applicantId: string): Promise<void> => {
  await safely("approval notice", async () => {
    const fest = (await adminDb().collection(COLLECTIONS.fests).doc(festId).get()).data();
    const applicant = await applicantOf(applicantId);
    if (!fest || !applicant) return;
    const slug = typeof fest.slug === "string" ? fest.slug : "";
    await emailService().send(
      applicationApprovedEmail({
        to: applicant.email,
        recipientName: applicant.name,
        eventName: String(fest.name ?? "your event"),
        consoleLink: slug ? `${appUrl()}/admin/${slug}` : `${appUrl()}/admin`,
        meta: { userId: applicantId, festId, subjectType: "fest", subjectId: festId },
      }),
    );
  });
};

/** After rejection: tell the applicant the (already screened) reason. */
export const noticeApplicationRejected = async (festId: string, applicantId: string, reason: string): Promise<void> => {
  await safely("rejection notice", async () => {
    const fest = (await adminDb().collection(COLLECTIONS.fests).doc(festId).get()).data();
    const applicant = await applicantOf(applicantId);
    if (!fest || !applicant) return;
    await emailService().send(
      applicationRejectedEmail({
        to: applicant.email,
        recipientName: applicant.name,
        eventName: String(fest.name ?? "your event"),
        reason,
        meta: { userId: applicantId, festId, subjectType: "fest", subjectId: festId },
      }),
    );
  });
};
