import { describe, expect, it } from "vitest";
import { validateEnv } from "@/server/env";

// A partial env is what the function actually receives in every path that
// matters; Node's ProcessEnv type insists on NODE_ENV, hence the cast.
const env = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;

const complete = {
  VERCEL_ENV: "production",
  NEXT_PUBLIC_FIREBASE_API_KEY: "k",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "p.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "p",
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "1",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:1:web:x",
  NEXT_PUBLIC_APP_URL: "https://plansphere.in",
  FIREBASE_SERVICE_ACCOUNT: "eyJ...",
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_x",
  CRON_SECRET: "0123456789abcdef0123",
  NEXT_PUBLIC_SENTRY_DSN: "https://abc@o1.ingest.sentry.io/1",
} as Record<string, string | undefined>;

describe("validateEnv", () => {
  it("passes a complete production environment with every feature on", () => {
    const r = validateEnv(env(complete));
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    expect(r.features).toEqual({ email: "resend", cron: true, sentry: true, appCheck: "off", rateLimitStore: "memory", payments: "off" });
  });

  it("treats missing required variables as errors in production, warnings elsewhere", () => {
    const missing = { ...complete } as Record<string, string | undefined>;
    delete missing.FIREBASE_SERVICE_ACCOUNT;
    delete missing.NEXT_PUBLIC_APP_URL;
    const prod = validateEnv(env(missing));
    expect(prod.ok).toBe(false);
    expect(prod.issues.filter((i) => i.level === "error").map((i) => i.key).sort()).toEqual(["FIREBASE_SERVICE_ACCOUNT", "NEXT_PUBLIC_APP_URL"]);

    const dev = validateEnv(env({ ...missing, VERCEL_ENV: "preview" }));
    expect(dev.ok).toBe(true);
    expect(dev.issues.every((i) => i.level === "warning")).toBe(true);
  });

  it("warns about degraded features without failing", () => {
    const r = validateEnv(env({ ...complete, EMAIL_PROVIDER: "console", CRON_SECRET: undefined, NEXT_PUBLIC_SENTRY_DSN: undefined }));
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.key).sort()).toEqual(["CRON_SECRET", "EMAIL_PROVIDER", "NEXT_PUBLIC_SENTRY_DSN"]);
    expect(r.features.email).toBe("console");
  });

  it("refuses App Check enforcement without a site key", () => {
    const r = validateEnv(env({ ...complete, APP_CHECK_ENFORCE: "true" }));
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.level === "error")?.key).toBe("NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY");
    expect(validateEnv(env({ ...complete, APP_CHECK_ENFORCE: "true", NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY: "site" })).features.appCheck).toBe("enforced");
  });

  it("reports payments as off unless explicitly enabled, and flags a half-configured setup", () => {
    expect(validateEnv(env(complete)).features.payments).toBe("off");

    const noKey = validateEnv(env({ ...complete, PAYMENTS_ENABLED: "1" }));
    expect(noKey.ok).toBe(false);
    expect(noKey.issues.find((i) => i.key === "PAYMENT_SECRET_KEY")?.level).toBe("error");

    const key = Buffer.alloc(32, 3).toString("base64");
    const sandbox = validateEnv(env({ ...complete, PAYMENTS_ENABLED: "1", PAYMENT_SECRET_KEY: key }));
    expect(sandbox.ok).toBe(true);
    expect(sandbox.features.payments).toBe("sandbox");
    expect(validateEnv(env({ ...complete, PAYMENTS_ENABLED: "1", PAYMENTS_LIVE_ENABLED: "1", PAYMENT_SECRET_KEY: key })).features.payments).toBe("live");

    // Live without the platform switch does nothing, and says so; the test provider is flagged in production.
    expect(validateEnv(env({ ...complete, PAYMENTS_LIVE_ENABLED: "1" })).issues.map((i) => i.key)).toContain("PAYMENTS_LIVE_ENABLED");
    expect(validateEnv(env({ ...complete, PAYMENTS_ALLOW_TEST_PROVIDER: "1" })).issues.map((i) => i.key)).toContain("PAYMENTS_ALLOW_TEST_PROVIDER");
    expect(validateEnv(env({ ...complete, PAYMENTS_ENABLED: "1", PAYMENT_SECRET_KEY: key, CRON_SECRET: undefined })).issues.map((i) => i.key)).toContain("CRON_SECRET");
  });

  it("checks the previous payment keys used during a rotation", () => {
    const key = Buffer.alloc(32, 3).toString("base64");
    const on = { ...complete, PAYMENTS_ENABLED: "1", PAYMENT_SECRET_KEY: key };
    expect(validateEnv(env({ ...on, PAYMENT_SECRET_KEYS_PREVIOUS: `${Buffer.alloc(32, 4).toString("base64")}, ${Buffer.alloc(32, 5).toString("base64")}` })).ok).toBe(true);
    const bad = validateEnv(env({ ...on, PAYMENT_SECRET_KEYS_PREVIOUS: "not-a-key" }));
    expect(bad.ok).toBe(false);
    expect(bad.issues.find((i) => i.key === "PAYMENT_SECRET_KEYS_PREVIOUS")?.level).toBe("error");
  });

  it("does not require the service account when running against the emulator", () => {
    const r = validateEnv(env({ ...complete, FIREBASE_SERVICE_ACCOUNT: undefined, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }));
    expect(r.ok).toBe(true);
  });
});
