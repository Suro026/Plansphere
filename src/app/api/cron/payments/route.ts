import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { handler, ok } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { runPaymentsHousekeeping } from "@/server/payments/housekeeping";

export const maxDuration = 300;

const authorised = (header: string, secret: string | undefined): boolean => {
  if (!secret) return false;
  const given = Buffer.from(header);
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
};

/**
 * GET /api/cron/payments — housekeeping for paid registration.
 *
 *  1. cancelled events: unpaid holds released and every payment refunded
 *     (resumes whatever a cut-short cancellation left behind),
 *  2. owed refunds that are due are retried, oldest first, on a back-off,
 *  3. unpaid seat holds whose time is up are released — after one last look at
 *     the provider, in case the payment went through and its webhook did not,
 *  4. payments still "pending" after a while are re-read from the provider.
 *
 * Every step is idempotent, isolated (a failure in one never stops the rest),
 * time-boxed, and safe to run concurrently or repeatedly. Each run leaves a
 * heartbeat that `/api/health` reads. Called with `Authorization: Bearer
 * $CRON_SECRET`. While payments are off only steps 1–3 do anything, since
 * there is nothing else to reconcile.
 *
 * Not scheduled in vercel.json: scheduling it is a deployment step
 * (docs/payments-implementation.md).
 */
export const GET = handler(
  async (request) => {
    if (!authorised(request.headers.get("authorization") ?? "", process.env.CRON_SECRET)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return ok(await runPaymentsHousekeeping());
  },
  { rateLimit: RATE_LIMITS.public.cron },
);
