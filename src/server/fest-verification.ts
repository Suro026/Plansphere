import { ApiError, type Caller } from "./api";
import { membershipIdFor } from "@/core/models/membership";
import { syncMemberAccess } from "./membership";
import { COLLECTIONS, FieldValue, adminAuth, adminDb } from "./firebase-admin";
import { USER_ROLES, type UserRole } from "@/core/permissions";

/**
 * Deciding a self-service event application.
 *
 * Registering an event creates the fest as a draft with `verification.status = "pending"` and gives the applicant no
 * authority over it. Only the two functions here change that, and only for a caller the route has already checked
 * holds `fest:verify`:
 *
 *  - `approveApplication` makes the applicant the fest's one Event Head: `ownerId`, plus a `head` membership on this
 *    fest (see `core/models/membership.ts`). The membership is the whole of their authority here, so it never touches the
 *    role or fests they already have - a volunteer elsewhere is a head here - and it can never be `super_admin`.
 *  - `rejectApplication` records the decision and a short reason, and grants nothing.
 *
 * Both run inside a Firestore transaction that re-reads the fest, so two requests racing for the same application cannot
 * both succeed: the loser sees a decided application and is refused.
 */

const normaliseRole = (value: unknown): UserRole | undefined =>
  value === "organizer" ? "volunteer" : USER_ROLES.includes(value as UserRole) ? (value as UserRole) : undefined;

export interface Approval {
  applicantId: string;
  /** `head`: a membership was created. `null`: the applicant is the platform itself, which is unscoped already and needs none. */
  festRole: "head" | null;
}

/** The text a reviewer's reason must not contain: it is shown to the applicant and kept on file. */
const LOOKS_PERSONAL = /[^\s@]+@[^\s@]+\.[^\s@]+|\d[\d\s().-]{8,}\d/;

export const checkReason = (reason: string): string => {
  const trimmed = reason.trim();
  if (trimmed.length < 3) throw ApiError.unprocessable("Give a short reason the applicant can act on.");
  if (trimmed.length > 300) throw ApiError.unprocessable("Keep the reason under 300 characters.");
  if (LOOKS_PERSONAL.test(trimmed)) {
    throw ApiError.unprocessable("The reason is shown to the applicant and kept on file: leave out email addresses and phone numbers.");
  }
  return trimmed;
};

/**
 * An application is made in the name of an organization, and the address on the account is the only handle the platform
 * has on the person. It must be one they have proved they own. This reads the sign-in account's own flag, never the
 * `emailVerified` copy on the profile: the rules let a user write that copy themselves.
 */
const assertEmailVerified = async (uid: string): Promise<void> => {
  let verified: boolean;
  try {
    verified = (await adminAuth().getUser(uid)).emailVerified === true;
  } catch (error) {
    if ((error as { code?: string }).code === "auth/user-not-found") throw ApiError.unprocessable("The applicant's account no longer exists.");
    throw error;
  }
  if (!verified) {
    throw ApiError.unprocessable("The applicant has not verified their email address yet, so this cannot be approved. Ask them to verify it from their account, then try again.");
  }
};

export const approveApplication = async (festId: string, reviewer: Caller): Promise<Approval> => {
  const db = adminDb();
  const festRef = db.collection(COLLECTIONS.fests).doc(festId);
  const privateRef = db.collection(COLLECTIONS.festPrivate).doc(festId);

  // Only a pending application needs the check; anything else is answered by the transaction below (already decided, never
  // submitted). `createdBy` is fixed at creation and re-read inside the transaction.
  const preview = (await festRef.get()).data();
  if (preview?.verification?.status === "pending" && typeof preview.createdBy === "string" && preview.createdBy !== reviewer.uid) {
    await assertEmailVerified(preview.createdBy);
  }

  const approval = await db.runTransaction(async (tx): Promise<Approval> => {
    const fest = await tx.get(festRef);
    if (!fest.exists) throw ApiError.notFound("No such event.");
    const data = fest.data() ?? {};

    const state = (data.verification as { status?: string } | undefined)?.status;
    if (state !== "pending") {
      throw ApiError.conflict(state ? `This application is already ${state}.` : "This event was not submitted for review.");
    }
    // One Event Head per event. An application never has an owner yet; if it does, something else got there first.
    if (data.ownerId) throw ApiError.conflict("This event already has an Event Head.");

    const applicantId = typeof data.createdBy === "string" ? data.createdBy : "";
    if (!applicantId) throw ApiError.unprocessable("This application has no applicant.");
    if (applicantId === reviewer.uid) throw ApiError.forbidden("You cannot decide your own application.");

    const userRef = db.collection(COLLECTIONS.users).doc(applicantId);
    const user = await tx.get(userRef);
    const profile = user.data();
    if (!user.exists || !profile || profile.disabled === true) {
      throw ApiError.unprocessable("The applicant's account is missing or disabled.");
    }

    // The platform is unscoped already: it is recorded as the owner and needs no membership. Everyone else becomes the
    // head of this one fest by membership, whatever they already are elsewhere.
    const platform = normaliseRole(profile.role) === "super_admin";
    const memberRef = db.collection(COLLECTIONS.festMembers).doc(membershipIdFor(festId, applicantId));

    tx.update(festRef, {
      ownerId: applicantId,
      "verification.status": "approved",
      "verification.decidedAt": FieldValue.serverTimestamp(),
      "verification.basis": "review",
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(privateRef, { verification: { decidedBy: reviewer.uid, decidedAt: FieldValue.serverTimestamp() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (!platform) {
      tx.set(memberRef, {
        id: memberRef.id,
        festId,
        userId: applicantId,
        role: "head",
        eventIds: [],
        duties: [],
        status: "active",
        createdBy: reviewer.uid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(userRef, { memberOf: FieldValue.arrayUnion(festId), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }

    return { applicantId, festRole: platform ? null : "head" };
  });

  // The claims are what the rules read; they are written after the membership on purpose. If this step fails the API still
  // reads the membership live, so the applicant would already be the head here - which is why a failure rolls the whole
  // approval back rather than leaving it half done.
  if (approval.festRole) {
    try {
      await syncMemberAccess(approval.applicantId);
    } catch (error) {
      await rollbackApproval(festId, approval.applicantId);
      console.error("[verification] could not set the applicant's claims; approval rolled back", { festId });
      throw error instanceof ApiError ? error : ApiError.unavailable("The approval could not be completed, so nothing was changed. Try again.");
    }
  }

  return approval;
};

/**
 * Puts a half-finished approval back as it was: pending, unowned, no membership. Only touches the records if they still say
 * this approval happened, so it cannot undo someone else's later change.
 */
const rollbackApproval = async (festId: string, applicantId: string): Promise<void> => {
  const db = adminDb();
  const festRef = db.collection(COLLECTIONS.fests).doc(festId);
  await db.runTransaction(async (tx) => {
    const fest = await tx.get(festRef);
    const data = fest.data();
    if (!data || data.ownerId !== applicantId || data.verification?.status !== "approved") return;
    tx.update(festRef, {
      ownerId: FieldValue.delete(),
      "verification.status": "pending",
      "verification.decidedAt": FieldValue.delete(),
      "verification.basis": FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection(COLLECTIONS.festPrivate).doc(festId), { verification: { decidedBy: FieldValue.delete(), decidedAt: FieldValue.delete() } }, { merge: true });
    tx.delete(db.collection(COLLECTIONS.festMembers).doc(membershipIdFor(festId, applicantId)));
    tx.set(db.collection(COLLECTIONS.users).doc(applicantId), { memberOf: FieldValue.arrayRemove(festId), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
};

export const rejectApplication = async (festId: string, reviewer: Caller, reason: string): Promise<{ applicantId: string }> => {
  const cleaned = checkReason(reason);
  const db = adminDb();
  const festRef = db.collection(COLLECTIONS.fests).doc(festId);

  return db.runTransaction(async (tx) => {
    const fest = await tx.get(festRef);
    if (!fest.exists) throw ApiError.notFound("No such event.");
    const data = fest.data() ?? {};

    const state = (data.verification as { status?: string } | undefined)?.status;
    if (state !== "pending") {
      throw ApiError.conflict(state ? `This application is already ${state}.` : "This event was not submitted for review.");
    }
    const applicantId = typeof data.createdBy === "string" ? data.createdBy : "";
    if (applicantId && applicantId === reviewer.uid) throw ApiError.forbidden("You cannot decide your own application.");

    tx.update(festRef, {
      "verification.status": "rejected",
      "verification.decidedAt": FieldValue.serverTimestamp(),
      "verification.basis": "review",
      updatedAt: FieldValue.serverTimestamp(),
    });
    // The reason is for the applicant, not the public: the fest document is readable by staff, the private one is not.
    tx.set(
      db.collection(COLLECTIONS.festPrivate).doc(festId),
      { verification: { decidedBy: reviewer.uid, decidedAt: FieldValue.serverTimestamp(), reason: cleaned }, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { applicantId };
  });
};
