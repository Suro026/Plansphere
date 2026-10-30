import { authenticate, handler, ok } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { docToJson } from "@/server/serialize";
import { teammateView, type RegistrationWire } from "@/core/models/registration";

/**
 * GET /api/registrations/mine — the team entries that name the caller but were made by someone else.
 *
 * A teammate holds the shared ticket, so they must be able to open it. They may not read the entry document itself:
 * the leader typed every member's email (and optionally phone, college and ID) into it so the organiser could run the
 * event, and Firestore rules cannot hide a field. So Firestore denies teammates the document and this route serves
 * them a view with the other members' contact details, the leader's address, the registration answers and the join
 * code removed (`teammateView`). The caller is identified by the verified email on their token, never by anything in
 * the request. Entries the caller made themselves are read directly from Firestore and are not repeated here.
 */
export const GET = handler(async (request) => {
  const caller = await authenticate(request);

  const snapshot = await adminDb()
    .collection(COLLECTIONS.registrations)
    .where("memberEmails", "array-contains", caller.email.toLowerCase())
    .limit(200)
    .get();

  const registrations = snapshot.docs
    .map((doc) => docToJson<RegistrationWire>(doc)!)
    .filter((registration) => registration.userId !== caller.uid)
    .map((registration) => teammateView(registration, caller.email));

  return ok({ registrations });
}, { rateLimit: RATE_LIMITS.authenticated.default });
