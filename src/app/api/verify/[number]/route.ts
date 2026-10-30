import { NextResponse } from "next/server";
import { handler, ok } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { lookupCertificate } from "@/server/public-lookup";

/**
 * GET /api/verify/[number] — public certificate lookup.
 *
 * No account needed: this is the page a recruiter lands on from a LinkedIn
 * post. It returns only what is printed on the certificate plus the gate
 * scan that backs it — never the holder's email, phone or college ID.
 * A revoked certificate is reported as revoked, not hidden; hiding it would
 * let the PDF keep circulating unchallenged.
 */
export const GET = handler(async (_request, context) => {
  const { number } = await context.params;
  const result = await lookupCertificate(number ?? "");
  if (!result.certificate) return ok(result);

  const response = NextResponse.json(result);
  response.headers.set("Cache-Control", "public, max-age=60, s-maxage=300");
  return response;
}, { rateLimit: RATE_LIMITS.public.verify });
