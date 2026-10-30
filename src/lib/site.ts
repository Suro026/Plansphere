/**
 * One place for the facts every page, email and crawler needs to agree on.
 *
 * `SITE_URL` is the canonical origin: the apex, https, no trailing slash.
 * `NEXT_PUBLIC_APP_URL` may be set to the www host or with a slash by
 * accident; both are normalised here so canonical tags, sitemaps and
 * Open Graph URLs never disagree with the redirect in next.config.
 */

const raw = (process.env.NEXT_PUBLIC_APP_URL ?? "https://plansphere.in").trim();

export const SITE_URL = raw.replace(/\/+$/, "").replace("://www.", "://") || "https://plansphere.in";

export const SITE = {
  name: "Plansphere",
  legalName: "Plansphere",
  tagline: "Every fest. One pass.",
  description:
    "Find college fests near you, register with your team in one go, and keep every ticket, meal slot and certificate in one place. Colleges run the whole thing from the other side of the same app.",
  locale: "en_IN",
  twitter: "@plansphere",
  contact: {
    hello: "hello@plansphere.in",
    support: "support@plansphere.in",
    privacy: "privacy@plansphere.in",
  },
  /** Effective date printed on the legal pages. Bump when they change. */
  legalUpdated: "22 Sep 2026",
} as const;

export const absoluteUrl = (path = "/"): string => new URL(path, `${SITE_URL}/`).toString();
