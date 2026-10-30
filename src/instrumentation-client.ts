/**
 * Browser-side Sentry. Loaded by Next before hydration. Disabled without a
 * DSN — and because the SDK is imported lazily, below, a deployment without
 * one never downloads it at all (it was ~80 kB gzipped on every page for a
 * monitor that could not send anything). With a DSN it loads as a separate
 * chunk right after this file runs, so only an error thrown in the first few
 * milliseconds of a page load could escape it.
 *
 * Replays are off — a fest app handles personal data and the value of session
 * replay does not justify recording students' screens.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  void import("@sentry/nextjs").then((Sentry) => {
    Sentry.init({
      dsn,
      enabled: true,
      environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
      // Errors only. Performance tracing is excluded from the bundle (see
      // next.config bundleSizeOptimizations); Vercel Speed Insights covers vitals.
      sendDefaultPii: false,
      ignoreErrors: [
        // Browser noise, not application errors.
        "ResizeObserver loop",
        "AbortError",
        /Loading chunk \d+ failed/,
        /NotAllowedError/, // camera permission refused on the scanner
      ],
    });
  });
}
