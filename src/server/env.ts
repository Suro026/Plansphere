import { z } from "zod";

/**
 * Server-side environment validation.
 *
 * Run once at startup (instrumentation.ts) and again by /api/health. It never
 * throws in production — a misconfigured optional feature must not take the
 * whole site down — but every problem is logged as one structured line and
 * surfaced on the health dashboard, so nothing is silently off.
 *
 * Two tiers:
 *   required  — the site does not work without these in production
 *   optional  — a feature is degraded or disabled without them
 */

const nonEmpty = z.string().trim().min(1);
const url = z.string().trim().url();

const publicSchema = z.object({
  NEXT_PUBLIC_FIREBASE_API_KEY: nonEmpty,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: nonEmpty,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: nonEmpty,
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: nonEmpty,
  NEXT_PUBLIC_FIREBASE_APP_ID: nonEmpty,
  NEXT_PUBLIC_APP_URL: url,
});

const serverRequiredSchema = z.object({
  FIREBASE_SERVICE_ACCOUNT: nonEmpty,
});

const optionalSchema = z.object({
  EMAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  CRON_SECRET: z.string().min(16).optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY: z.string().optional(),
  APP_CHECK_ENFORCE: z.enum(["true", "false"]).optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  // File storage — Supabase. Optional in the schema the same way Resend is:
  // uploads degrade to "paste a URL instead" without it (see
  // server/storage/client.ts), rather than the whole site refusing to run.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  // Online payment for registration. Every one is off/absent by default; see
  // docs/payments-implementation.md before setting any of them.
  PAYMENTS_ENABLED: z.enum(["0", "1"]).optional(),
  PAYMENTS_LIVE_ENABLED: z.enum(["0", "1"]).optional(),
  PAYMENTS_ALLOW_TEST_PROVIDER: z.enum(["0", "1"]).optional(),
  PAYMENT_HOLD_MINUTES: z.coerce.number().int().min(5).max(60).optional(),
  PAYMENT_SECRET_KEY: z.string().optional(),
  // Older encryption keys, comma-separated, kept only so existing credentials still open during a rotation.
  PAYMENT_SECRET_KEYS_PREVIOUS: z.string().optional(),
});

export interface EnvIssue {
  key: string;
  level: "error" | "warning";
  message: string;
}

export interface EnvReport {
  ok: boolean;
  production: boolean;
  issues: EnvIssue[];
  features: {
    email: "resend" | "console";
    cron: boolean;
    sentry: boolean;
    appCheck: "enforced" | "monitor" | "off";
    rateLimitStore: "upstash" | "memory";
    payments: "off" | "sandbox" | "live";
  };
}

const collect = (result: z.ZodSafeParseResult<unknown>, level: EnvIssue["level"]): EnvIssue[] =>
  result.success
    ? []
    : result.error.issues.map((i) => ({ key: String(i.path[0] ?? "_"), level, message: i.message === "Required" ? "missing" : i.message }));

export const validateEnv = (env: NodeJS.ProcessEnv = process.env): EnvReport => {
  const production = env.VERCEL_ENV === "production" || (env.NODE_ENV === "production" && !env.VERCEL_ENV);
  const issues: EnvIssue[] = [];

  // Public config and the service account are errors in production, warnings
  // elsewhere (a fresh checkout without .env.local should still build).
  issues.push(...collect(publicSchema.safeParse(env), production ? "error" : "warning"));
  if (!env.FIRESTORE_EMULATOR_HOST) issues.push(...collect(serverRequiredSchema.safeParse(env), production ? "error" : "warning"));

  const optional = optionalSchema.safeParse(env);
  issues.push(...collect(optional, "warning"));
  const opt = optional.success ? optional.data : optionalSchema.parse({});

  if (opt.EMAIL_PROVIDER === "resend" && !opt.RESEND_API_KEY) {
    issues.push({ key: "RESEND_API_KEY", level: "warning", message: "EMAIL_PROVIDER=resend but no key — falling back to console (no email is sent)" });
  }
  if (production && opt.EMAIL_PROVIDER !== "resend") {
    issues.push({ key: "EMAIL_PROVIDER", level: "warning", message: "console provider in production — registrations, invites and certificates are not emailed" });
  }
  if (production && !opt.CRON_SECRET) {
    issues.push({ key: "CRON_SECRET", level: "warning", message: "missing — /api/cron/event-reminders refuses every call, so no day-before reminders go out" });
  }
  if (production && !opt.NEXT_PUBLIC_SENTRY_DSN) {
    issues.push({ key: "NEXT_PUBLIC_SENTRY_DSN", level: "warning", message: "missing — errors are only in Vercel logs" });
  }
  if (opt.APP_CHECK_ENFORCE === "true" && !opt.NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY) {
    issues.push({ key: "NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY", level: "error", message: "APP_CHECK_ENFORCE=true but the client has no site key — every API call would be refused" });
  }
  if ((opt.UPSTASH_REDIS_REST_URL && !opt.UPSTASH_REDIS_REST_TOKEN) || (!opt.UPSTASH_REDIS_REST_URL && opt.UPSTASH_REDIS_REST_TOKEN)) {
    issues.push({ key: "UPSTASH_REDIS_REST_URL", level: "warning", message: "set both URL and token, or neither — falling back to per-instance rate limiting" });
  }

  // Payments: nothing here can switch money on; it only reports a half-configured state.
  const paymentsOn = opt.PAYMENTS_ENABLED === "1";
  if (paymentsOn) {
    const keyBytes = opt.PAYMENT_SECRET_KEY ? Buffer.from(opt.PAYMENT_SECRET_KEY, "base64").length : 0;
    if (keyBytes !== 32) {
      issues.push({ key: "PAYMENT_SECRET_KEY", level: production ? "error" : "warning", message: "PAYMENTS_ENABLED=1 but the key is missing or is not base64 of 32 bytes — merchant credentials cannot be stored or read" });
    }
    const previous = (opt.PAYMENT_SECRET_KEYS_PREVIOUS ?? "").split(/[,\s]+/).filter(Boolean);
    if (previous.some((k) => Buffer.from(k, "base64").length !== 32)) {
      issues.push({ key: "PAYMENT_SECRET_KEYS_PREVIOUS", level: production ? "error" : "warning", message: "an entry is not base64 of 32 bytes — stored credentials could not be opened" });
    }
    if (!opt.CRON_SECRET) {
      issues.push({ key: "CRON_SECRET", level: "warning", message: "PAYMENTS_ENABLED=1 without it — unpaid seat holds are never released and lost webhooks are never reconciled" });
    }
  }
  if (opt.PAYMENTS_LIVE_ENABLED === "1" && !paymentsOn) {
    issues.push({ key: "PAYMENTS_LIVE_ENABLED", level: "warning", message: "set without PAYMENTS_ENABLED=1 — it has no effect" });
  }
  if (production && opt.PAYMENTS_ALLOW_TEST_PROVIDER === "1") {
    issues.push({ key: "PAYMENTS_ALLOW_TEST_PROVIDER", level: "warning", message: "set in production — the test provider is never registered there, remove it" });
  }

  const emailLive = opt.EMAIL_PROVIDER === "resend" && Boolean(opt.RESEND_API_KEY);
  return {
    ok: !issues.some((i) => i.level === "error"),
    production,
    issues,
    features: {
      email: emailLive ? "resend" : "console",
      cron: Boolean(opt.CRON_SECRET),
      sentry: Boolean(opt.NEXT_PUBLIC_SENTRY_DSN),
      appCheck: opt.APP_CHECK_ENFORCE === "true" ? "enforced" : opt.NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY ? "monitor" : "off",
      rateLimitStore: opt.UPSTASH_REDIS_REST_URL && opt.UPSTASH_REDIS_REST_TOKEN ? "upstash" : "memory",
      payments: !paymentsOn ? "off" : opt.PAYMENTS_LIVE_ENABLED === "1" ? "live" : "sandbox",
    },
  };
};

let reported = false;

/** Logs the report once per process. Called from instrumentation.ts. */
export const reportEnvOnce = (): EnvReport => {
  const report = validateEnv();
  if (reported) return report;
  reported = true;
  const line = {
    at: "startup",
    ok: report.ok,
    production: report.production,
    features: report.features,
    errors: report.issues.filter((i) => i.level === "error").map((i) => `${i.key}: ${i.message}`),
    warnings: report.issues.filter((i) => i.level === "warning").map((i) => `${i.key}: ${i.message}`),
  };
  if (!report.ok) console.error("[env]", JSON.stringify(line));
  else if (line.warnings.length) console.warn("[env]", JSON.stringify(line));
  else console.info("[env]", JSON.stringify(line));

  // ENV_STRICT=1 turns a misconfigured production deploy into a failed
  // start rather than a running site that cannot register anyone. Off by
  // default so a preview deployment without secrets still boots.
  if (!report.ok && process.env.ENV_STRICT === "1") {
    throw new Error(`Refusing to start: ${line.errors.join("; ")}`);
  }
  return report;
};
