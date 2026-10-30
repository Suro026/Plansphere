import { NextResponse } from "next/server";
import { handler } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { processWebhook } from "@/server/payments/webhook";

/**
 * POST /api/payments/webhook/[provider] — where a payment provider reports.
 *
 * Public by necessity, so everything is decided by the signature: the body is
 * read raw (the signature is over the exact bytes), the merchant whose
 * credentials sign it is found from the order it names, and only a body that
 * verifies against *that merchant's* secret is acted on — and even then only as
 * a hint to re-read the order from the provider.
 *
 * Answers 200 for anything it has understood (including duplicates, so the
 * provider stops retrying), 401 for a bad signature, and 5xx when it could not
 * finish — which makes the provider retry.
 */
export const POST = handler(
  async (request, context) => {
    const { provider } = await context.params;
    const raw = await request.text();
    if (raw.length > 64 * 1024) return NextResponse.json({ error: "Payload too large." }, { status: 413 });

    const result = await processWebhook(String(provider), raw, request.headers);
    return NextResponse.json({ received: true, result: result.kind }, { status: result.status });
  },
  { rateLimit: RATE_LIMITS.public.webhook, appCheck: false },
);
