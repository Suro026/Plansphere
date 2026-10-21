/**
 * The environment every demo command runs under: a Firebase *demo* project on
 * the local emulators. `demo-` project ids can never be a real Firebase
 * project, and none of the production secrets are passed through.
 */
export const PROJECT = "demo-plansphere";

export const DEMO_ENV = {
  GCLOUD_PROJECT: PROJECT,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: PROJECT,
  NEXT_PUBLIC_FIREBASE_API_KEY: "demo-api-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${PROJECT}.firebaseapp.com`,
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "1",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:1:web:demo",
  NEXT_PUBLIC_FIREBASE_EMULATOR: "1",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  RATE_LIMIT_DISABLED: "1",
  EMAIL_PROVIDER: "console",
  // Present-but-empty so Next never falls back to the value in .env.local.
  FIREBASE_SERVICE_ACCOUNT: "",
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  SUPABASE_ANON_KEY: "",
  UPSTASH_REDIS_REST_URL: "",
  UPSTASH_REDIS_REST_TOKEN: "",
  NEXT_PUBLIC_SENTRY_DSN: "",
  NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY: "",
  APP_CHECK_ENFORCE: "false",
  CRON_SECRET: "",
  RESEND_API_KEY: "",
};

export const demoEnv = (extra = {}) => ({ ...process.env, ...DEMO_ENV, ...extra });
