import { festVerificationState, registerEventSchema } from "@/core/models/fest";
import { defaultRegistrationFields } from "@/core/models/registration-fields";
import { ApiError, authenticate, handler, ok, readBody, requirePasswordChanged } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { compact, docToJson } from "@/server/serialize";
import { audit } from "@/server/audit";
import { BUCKETS } from "@/server/storage/client";

/**
 * Self-service event registration — the one route that lets any signed-in
 * account put an event forward without a super admin creating it.
 *
 * `POST /api/admin/fests` (super admin only) still exists for platform staff.
 * This route is an *application*: the three-step wizard (organization, event,
 * the person registering) creates the fest as a draft with
 * `verification.status = "pending"`, and then waits. Until a platform reviewer
 * approves it (`POST /api/admin/fests/[id]/verification`):
 *
 *  - the applicant holds no role over the event: their claims and profile are
 *    left exactly as they were, there is no `ownerId`, and nothing they upload
 *    changes that;
 *  - the fest stays a draft nobody can publish (the fest API and the rules
 *    both refuse), so it never appears in the explorer.
 *
 * Approval is what makes the applicant the event's one Event Head — `ownerId`
 * plus an `admin` claim scoped to this fest, see `src/server/fest-verification.ts`.
 * Rejection leaves them with nothing. Either way `GET /api/register-event`
 * tells them where the application stands.
 *
 * Existing staff are refused outright: a volunteer or admin's role and fest
 * scope belong to whoever gave it to them, and registering must never raise a
 * role or widen a scope. A platform `super_admin` is the platform itself, so
 * there is nobody to review them: their event is recorded as approved by the
 * platform and owned by them, and their role is untouched.
 */

/** What the applicant is told, per state. Kept short and free of anything about other people. */
const APPLICANT_MESSAGE = {
  pending: "Your application is with the Plansphere team. You will be able to manage this event once it is approved.",
  approved: "Approved. You now run this event. If the console does not open, sign out and back in once.",
  rejected: "This application was not approved.",
  legacy: "",
} as const;

/** URL-safe slug from a name. Mirrors `src/lib/utils.ts`'s `slugify`, kept separate so this server route has no reason to import a client-side styling helper. */
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export const POST = handler(async (request) => {
  const caller = await authenticate(request);
  requirePasswordChanged(caller);

  // Registering an event must never change what an existing staff account can do. A volunteer or admin's role and fest
  // scope belong to the people who gave it to them; folding a new fest into it would turn a volunteer into an admin of
  // the fest they work at, or widen an admin's reach. Such an account registers with a separate one.
  if (caller.role === "volunteer" || caller.role === "admin") {
    throw ApiError.forbidden("This account is already staff for another event. Register your event with a separate account, so the access you have now stays exactly as it is.");
  }

  const input = await readBody(request, registerEventSchema);

  // A reference to an uploaded identity document must point into the caller's own folder. Otherwise an applicant could
  // name somebody else's file and have a reviewer open it as theirs.
  const identityPath = input.eventHead.idDocumentPath;
  if (identityPath && !identityPath.startsWith(`users/${caller.uid}/identity/`)) {
    throw ApiError.unprocessable("That document was not uploaded by this account. Upload it again.");
  }

  const db = adminDb();
  const platform = caller.role === "super_admin";

  // The public address is derived, not typed by hand — a first-time visitor
  // is not asked to invent a URL slug. Collisions get a numeric suffix.
  const base = slugify(input.name) || "event";
  let slug = base;
  for (let suffix = 2; suffix <= 50; suffix += 1) {
    const clash = await db.collection(COLLECTIONS.fests).where("slug", "==", slug).limit(1).get();
    if (clash.empty) break;
    slug = `${base}-${suffix}`;
  }

  const ref = db.collection(COLLECTIONS.fests).doc();

  // The fest document is world-readable once published and rules cannot hide a field, so the Event Head's personal details
  // (phone, LinkedIn, ID-document reference) go to a server-only document, written in the same commit. The document itself
  // is never copied anywhere: only its path in the private bucket is kept, and a reviewer is handed a short-lived link.
  const { idDocumentPath, ...eventHead } = input.eventHead;
  const batch = db.batch();
  batch.set(
    ref,
    compact({
      id: ref.id,
      name: input.name,
      slug,
      description: input.description,
      organizationName: input.organizationName,
      organizationType: input.organizationType,
      organizationWebsite: input.organizationWebsite,
      contactEmail: input.contactEmail,
      venue: input.venue,
      city: input.city,
      state: input.state,
      startDate: input.startDate,
      endDate: input.endDate,
      festType: input.festType,
      expectedParticipants: input.expectedParticipants,
      status: "draft",
      visibility: "public",
      registrationState: "upcoming",
      stats: { events: 0, registrations: 0, checkIns: 0 },
      registrationFields: defaultRegistrationFields(),
      createdBy: caller.uid,
      // Only the platform's own registration has an owner from the start. Everyone else gets one when it is approved.
      ...(platform ? { ownerId: caller.uid } : {}),
      verification: platform
        ? { status: "approved", submittedAt: FieldValue.serverTimestamp(), decidedAt: FieldValue.serverTimestamp(), basis: "platform" }
        : { status: "pending", submittedAt: FieldValue.serverTimestamp() },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }),
  );
  batch.set(
    db.collection(COLLECTIONS.festPrivate).doc(ref.id),
    compact({
      festId: ref.id,
      registeredBy: caller.uid,
      // A signed link into the private bucket expires and is a bearer credential; when the file itself was uploaded,
      // keep only its path.
      eventHead: idDocumentPath ? { ...eventHead, idCardUrl: undefined } : eventHead,
      verification: { documents: idDocumentPath ? [{ kind: "identity", bucket: BUCKETS.uploads, path: idDocumentPath }] : [] },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }),
  );
  await batch.commit();

  await audit(caller, {
    action: "fest_registered",
    summary: `Registered "${input.name}" (${slug})${platform ? "" : " — pending verification"}`,
    festId: ref.id,
    subjectType: "fest",
    subjectId: ref.id,
    // Names the document's presence, never its path or contents.
    details: { slug, festType: input.festType, organizationName: input.organizationName, organizationType: input.organizationType, hasIdentityDocument: Boolean(idDocumentPath) },
  });

  const created = await ref.get();
  const fest = docToJson(created);
  if (!fest) throw ApiError.unavailable("The event was submitted but could not be read back. Refresh and it will be there.");

  const state = platform ? "approved" : "pending";
  return ok({ fest, application: { festId: ref.id, status: state, message: APPLICANT_MESSAGE[state] } }, 201);
}, { rateLimit: RATE_LIMITS.authenticated.registerEvent });

/**
 * GET /api/register-event — where the caller's own applications stand.
 *
 * The applicant is not staff, so they cannot read their draft event through Firestore; this is how they see it. Returns
 * only what they entered themselves plus the decision and, for a rejection, the reviewer's short reason.
 */
export const GET = handler(async (request) => {
  const caller = await authenticate(request);
  requirePasswordChanged(caller);

  const db = adminDb();
  const snapshot = await db.collection(COLLECTIONS.fests).where("createdBy", "==", caller.uid).limit(50).get();
  const reviewed = snapshot.docs.filter((doc) => festVerificationState(doc.data() as { verification?: { status: "pending" | "approved" | "rejected" } }) !== "legacy");

  const applications = await Promise.all(
    reviewed.map(async (doc) => {
      const data = doc.data();
      const verification = data.verification as { status: "pending" | "approved" | "rejected"; submittedAt?: { toDate?: () => Date }; decidedAt?: { toDate?: () => Date } };
      let reason: string | undefined;
      if (verification.status === "rejected") {
        const priv = await db.collection(COLLECTIONS.festPrivate).doc(doc.id).get();
        const stored = priv.data()?.verification?.reason;
        reason = typeof stored === "string" ? stored : undefined;
      }
      return compact({
        festId: doc.id,
        name: String(data.name ?? ""),
        slug: String(data.slug ?? ""),
        status: verification.status,
        submittedAt: verification.submittedAt?.toDate?.().toISOString(),
        decidedAt: verification.decidedAt?.toDate?.().toISOString(),
        message: APPLICANT_MESSAGE[verification.status],
        ...(reason ? { reason } : {}),
      });
    }),
  );

  applications.sort((a, b) => String(b.submittedAt ?? "").localeCompare(String(a.submittedAt ?? "")));
  // An application cannot be approved until the applicant's email address is verified; the status page says so.
  return ok({ applications, emailVerified: caller.emailVerified });
});
