import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Crawlers get the public catalogue and the legal pages. Everything behind
 * sign-in, the scanner, the API and the per-ticket pages is off limits —
 * a ticket page is public for the person holding the QR, not for an index.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/explore", "/f/", "/for-colleges", "/verify", "/privacy", "/terms"],
        disallow: [
          "/api/",
          "/admin",
          "/volunteer",
          "/scan",
          "/t/",
          "/my-events",
          "/my-pass",
          "/teams",
          "/certificates",
          "/profile",
          "/notifications",
          "/registered/",
          "/sign-in",
          "/create-account",
          "/forgot-password",
          "/set-password",
          "/verify-email",
          "/auth/",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
