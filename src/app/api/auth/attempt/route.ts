import { z } from "zod";
import { emailSchema } from "@/core/models/common";
import { handler, ok, readBody } from "@/server/api";
import { accountSubject, clearRateLimit, ipSubject, logRateLimited, RATE_LIMITS, rateLimitAll, rateLimitHeaders, recordAuthFailure, retryMessage } from "@/server/rate-limit";
import { NextResponse } from "next/server";

const bodySchema = z.object({
  kind: z.enum(["login", "signup"]),
  email: emailSchema,
  /**
   * before    — about to call Firebase Auth: consume one attempt, or be told to wait
   * failed    — Firebase refused the credentials: add a strike so the backoff grows
   * succeeded — signed in: clear this account's counters
   */
  phase: z.enum(["before", "failed", "succeeded"]),
});

/**
 * POST /api/auth/attempt — the application's own throttle on sign-in and
 * sign-up.
 *
 * Passwords never touch our server (Firebase Auth handles them in the
 * browser), so the limit is applied around the call: the client asks here
 * first, reports failures, and reports success. Limits are per IP *and* per
 * account with exponential backoff, so a credential-stuffing run against one
 * address, or one machine trying many addresses, both slow to a crawl —
 * while a legitimate user is never locked out for good. Firebase's own
 * per-account throttling and App Check remain underneath.
 */
export const POST = handler(async (request) => {
  const { kind, email, phase } = await readBody(request, bodySchema);
  const rule = kind === "login" ? RATE_LIMITS.auth.login : RATE_LIMITS.auth.signup;
  const subjects = [ipSubject(request), accountSubject(email)];

  if (phase === "succeeded") {
    await clearRateLimit(rule, subjects);
    return ok({ ok: true });
  }

  if (phase === "failed") {
    // A failure is worth a full attempt on both keys; the response tells the
    // client how long to wait if that pushed it over.
    let refused = null;
    for (const subject of subjects) {
      const result = await recordAuthFailure(rule, subject);
      if (!result.allowed) refused = refused ?? result;
    }
    if (refused) {
      logRateLimited(refused, request, request.headers.get("x-request-id") ?? "-");
      return NextResponse.json({ ok: false, retryAfter: refused.retryAfter, message: retryMessage(refused) }, { status: 200, headers: rateLimitHeaders(refused) });
    }
    return ok({ ok: true });
  }

  // phase === "before": peek without double-counting — the attempt itself is
  // the hit; a following "failed" report adds the strike.
  const budget = await rateLimitAll(subjects.map((subject) => ({ rule, subject })));
  if (budget && !budget.allowed) {
    logRateLimited(budget, request, request.headers.get("x-request-id") ?? "-");
    return NextResponse.json({ error: retryMessage(budget), code: "rate-limited", retryAfter: budget.retryAfter }, { status: 429, headers: rateLimitHeaders(budget) });
  }
  return ok({ ok: true, remaining: budget?.remaining ?? rule.limit });
}, { rateLimit: [{ rule: RATE_LIMITS.auth.attempt, by: "ip" }] });
