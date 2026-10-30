import type { Registration } from "../models/registration";

/**
 * Wallet passes — the shape, not the signing.
 *
 * Apple Wallet needs a `.pkpass`: a zip of JSON plus images, signed with a
 * Pass Type ID certificate issued to a paid Apple Developer account. Google
 * Wallet needs a JWT signed with a service-account key and a pass class
 * registered in the Google Pay console. Neither can be faked, and neither
 * belongs in a browser bundle — both are server-side, and both wait on
 * credentials the college has to obtain.
 *
 * So this module does the half that does not need them: it turns a
 * registration into the neutral payload both formats are built from, and
 * states what each one still needs. When the certificates exist, the
 * generators slot in behind `buildApplePass` / `buildGooglePass` and nothing
 * above this file changes.
 *
 * The important thing meanwhile is that the pass in the app already works
 * offline, which is the actual reason people use a wallet at a gate.
 */

export type WalletPlatform = "apple" | "google";

/** The fields both formats need, named neutrally. */
export interface WalletPass {
  /** Unique within the organisation. The ticket code is exactly that. */
  serialNumber: string;
  /** What the QR encodes — the same public URL the gate scanner reads. */
  barcodeValue: string;
  organizationName: string;
  eventTitle: string;
  festName: string;
  holderName: string;
  teamName?: string | undefined;
  /** ISO date and clock time, as the event states them. */
  date?: string | undefined;
  startTime?: string | undefined;
  venue?: string | undefined;
  /** #rrggbb — the fest's colour when it has one. */
  accentColor: string;
  /** Shown on the back of the pass. */
  notes: string[];
}

export interface WalletSupport {
  platform: WalletPlatform;
  available: boolean;
  /** Why not, in words a person can act on. */
  requires: string;
}

/** What each platform still needs before a pass can be issued. */
export const WALLET_SUPPORT: Record<WalletPlatform, WalletSupport> = {
  apple: {
    platform: "apple",
    available: false,
    requires: "An Apple Developer Pass Type ID certificate, held server-side. Until then the in-app pass works offline and prints.",
  },
  google: {
    platform: "google",
    available: false,
    requires: "A Google Wallet issuer account and a service-account key, held server-side. Until then the in-app pass works offline and prints.",
  },
};

export const walletAvailable = (platform: WalletPlatform): boolean => WALLET_SUPPORT[platform].available;

/**
 * Builds the neutral payload from a registration.
 *
 * Pure and synchronous on purpose: it is the same data the printed pass and
 * the on-screen ticket draw, so all three can never disagree about what the
 * ticket says.
 */
export const buildWalletPass = (input: {
  registration: Pick<Registration, "ticketCode" | "eventTitle" | "userName" | "teamName" | "status">;
  barcodeValue: string;
  festName: string;
  organizationName?: string | undefined;
  date?: string | undefined;
  startTime?: string | undefined;
  venue?: string | undefined;
  accentColor?: string | undefined;
}): WalletPass => ({
  serialNumber: input.registration.ticketCode,
  barcodeValue: input.barcodeValue,
  organizationName: input.organizationName ?? input.festName,
  eventTitle: input.registration.eventTitle,
  festName: input.festName,
  holderName: input.registration.userName,
  teamName: input.registration.teamName,
  date: input.date,
  startTime: input.startTime,
  venue: input.venue,
  accentColor: input.accentColor ?? "#9184d9",
  notes: [
    input.registration.status === "waitlisted"
      ? "Waitlisted — this code activates if a seat opens."
      : input.registration.status === "draft"
        ? "Your team is not complete yet; the code activates when it is."
        : "Show this at the gate. It works with no network.",
    `Verify at the address the QR opens: ${input.barcodeValue}`,
  ],
});

/**
 * Where a pass would be fetched from once signing exists.
 *
 * Declared now so the button, the route and the tests already agree on it;
 * the route returns 501 until the credentials are in place.
 */
export const walletPassUrl = (platform: WalletPlatform, registrationId: string): string =>
  `/api/registrations/${registrationId}/wallet/${platform}`;
