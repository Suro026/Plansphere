import * as Sentry from "@sentry/nextjs";

/**
 * Server-side Sentry. A missing DSN disables reporting entirely; nothing
 * else changes, so local development and CI never send events.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: process.env.VERCEL_ENV === "production" ? 0.1 : 0,
  sendDefaultPii: false,
  beforeSend(event) {
    // Never ship credentials that might sit in a request header or env dump.
    if (event.request?.headers) {
      delete event.request.headers.authorization;
      delete event.request.headers.cookie;
      delete event.request.headers["x-firebase-appcheck"];
    }
    return event;
  },
});
