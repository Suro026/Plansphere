import { ADMISSION_MESSAGES, admissionBlock } from "@/core/models/admission";
import { WALLET_SUPPORT, buildWalletPass, walletAvailable, type WalletPlatform } from "@/core/services/wallet";
import { memberFor } from "@/core/models/registration";
import { ApiError, authenticate, handler, ok } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";

/**
 * GET /api/registrations/[id]/wallet/[platform]
 *
 * The wallet endpoint, wired end to end except for the signing.
 *
 * It authenticates, checks the caller is actually on the entry, and builds
 * the pass payload — everything a real implementation does — then answers 501
 * with what is missing, because a `.pkpass` needs an Apple certificate and a
 * Google pass needs an issuer key, and neither can be invented here.
 *
 * Returning the payload rather than an empty error is deliberate: the client
 * can show the pass it *would* issue, the tests can assert the contents, and
 * the day the certificate arrives only the last step changes.
 */
export const GET = handler(async (request, context) => {
  const caller = await authenticate(request);
  const { id, platform } = await context.params;

  if (!id) throw ApiError.badRequest("Missing registration id.");
  if (platform !== "apple" && platform !== "google") throw ApiError.badRequest("Unknown wallet platform.");

  const db = adminDb();
  const snapshot = await db.collection(COLLECTIONS.registrations).doc(id).get();
  if (!snapshot.exists) throw ApiError.notFound("That registration no longer exists.");
  const registration = snapshot.data()!;

  // A pass belongs to the person who holds the entry, or to a teammate named
  // on it — the team shares one QR, so they share the pass.
  const members = (registration.members ?? []) as { email: string; inviteStatus?: string }[];
  const onTeam = memberFor({ members: members as never }, caller.email) !== undefined;
  if (registration.userId !== caller.uid && !onTeam) {
    throw ApiError.forbidden("That pass isn't yours.");
  }

  // A wallet pass is a ticket: it is issued only to an entry the gate would admit.
  const block = admissionBlock({ status: registration.status, paymentStatus: registration.paymentStatus });
  if (block) throw ApiError.unprocessable(block === "cancelled" ? "That entry was cancelled." : `${ADMISSION_MESSAGES[block]} A wallet pass is issued once the entry is confirmed.`);

  const [eventSnap, festSnap] = await Promise.all([
    db.collection(COLLECTIONS.events).doc(String(registration.eventId)).get(),
    db.collection(COLLECTIONS.fests).doc(String(registration.festId)).get(),
  ]);
  const event = eventSnap.data() ?? {};
  const fest = festSnap.data() ?? {};

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");

  const pass = buildWalletPass({
    registration: {
      ticketCode: String(registration.ticketCode),
      eventTitle: String(registration.eventTitle ?? event.title ?? ""),
      userName: String(registration.userName ?? ""),
      teamName: registration.teamName ? String(registration.teamName) : undefined,
      status: registration.status ?? "confirmed",
    },
    barcodeValue: `${appUrl}/t/${registration.ticketCode}`,
    festName: String(fest.name ?? ""),
    organizationName: fest.organizationName ? String(fest.organizationName) : undefined,
    date: event.date ? String(event.date) : undefined,
    startTime: event.startTime ? String(event.startTime) : undefined,
    venue: event.venue ? String(event.venue) : undefined,
    accentColor: fest.themeColor ? String(fest.themeColor) : undefined,
  });

  const support = WALLET_SUPPORT[platform as WalletPlatform];

  if (!walletAvailable(platform as WalletPlatform)) {
    // 501, not 500: the request is fine and the server understood it; this
    // deployment cannot yet fulfil it.
    return ok({ available: false, platform, requires: support.requires, pass }, 501);
  }

  return ok({ available: true, platform, pass });
}, { rateLimit: RATE_LIMITS.authenticated.default });
