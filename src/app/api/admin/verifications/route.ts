import { z } from "zod";
import { VERIFICATION_STATUSES } from "@/core/models/fest";
import { ApiError, handler, ok, requirePermission } from "@/server/api";
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";

/**
 * GET /api/admin/verifications?status=pending — the review queue.
 *
 * For `fest:verify` holders only. Lists what a reviewer needs to decide: the event, the organization, who applied and
 * whether an identity document was attached. Not the document, its path or the applicant's phone number; the document
 * opens through its own audited route.
 */
const querySchema = z.object({ status: z.enum(VERIFICATION_STATUSES).default("pending") });

export const GET = handler(async (request) => {
  await requirePermission(request, "fest:verify");
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw ApiError.badRequest("Unknown status.");

  const db = adminDb();
  const snapshot = await db.collection(COLLECTIONS.fests).where("verification.status", "==", parsed.data.status).limit(100).get();

  // Whether each applicant has proved they own the address on their account - read from the sign-in account, not the
  // profile, whose copy of the flag the user can write themselves. Approval is refused until it is true.
  const applicantIds = Array.from(new Set(snapshot.docs.map((doc) => doc.data().createdBy).filter((id): id is string => typeof id === "string" && id.length > 0)));
  const verifiedEmail = new Map<string, boolean>();
  if (applicantIds.length > 0) {
    const accounts = await adminAuth().getUsers(applicantIds.map((uid) => ({ uid })));
    for (const account of accounts.users) verifiedEmail.set(account.uid, account.emailVerified === true);
  }

  const items = await Promise.all(
    snapshot.docs.map(async (doc) => {
      const data = doc.data();
      const applicantId = typeof data.createdBy === "string" ? data.createdBy : "";
      const [applicant, priv] = await Promise.all([
        applicantId ? db.collection(COLLECTIONS.users).doc(applicantId).get() : Promise.resolve(null),
        db.collection(COLLECTIONS.festPrivate).doc(doc.id).get(),
      ]);
      const documents = priv.data()?.verification?.documents as unknown[] | undefined;
      const submitted = data.verification?.submittedAt?.toDate?.() as Date | undefined;
      return {
        festId: doc.id,
        name: String(data.name ?? ""),
        slug: String(data.slug ?? ""),
        festType: data.festType ?? null,
        organizationName: String(data.organizationName ?? ""),
        organizationType: data.organizationType ?? null,
        city: data.city ?? null,
        state: data.state ?? null,
        submittedAt: submitted?.toISOString() ?? null,
        applicant: {
          id: applicantId,
          emailVerified: verifiedEmail.get(applicantId) ?? false,
          ...(applicant?.exists ? { name: String(applicant.data()?.name ?? ""), email: String(applicant.data()?.email ?? "") } : {}),
        },
        hasIdentityDocument: Array.isArray(documents) && documents.length > 0,
      };
    }),
  );

  items.sort((a, b) => String(a.submittedAt ?? "").localeCompare(String(b.submittedAt ?? "")));
  return ok({ status: parsed.data.status, applications: items });
});
