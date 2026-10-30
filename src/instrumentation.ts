import * as Sentry from "@sentry/nextjs";

/**
 * Next.js server startup hook. Two jobs:
 *   1. load the right Sentry config for the runtime
 *   2. validate the environment once and log a single structured line
 *      (errors are also sent to Sentry so a bad deploy is visible even
 *      when nobody is watching the Vercel log)
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    const { reportEnvOnce } = await import("./server/env");
    const report = reportEnvOnce();
    if (!report.ok) {
      Sentry.captureMessage("Environment validation failed at startup", {
        level: "error",
        extra: { issues: report.issues },
      });
    }
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
