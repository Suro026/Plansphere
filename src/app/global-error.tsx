"use client";

import * as React from "react";

/**
 * Last-resort boundary: rendered when the root layout itself fails, so it
 * carries its own <html>/<body> and no app dependencies at all. Reports to
 * Sentry and offers the one action that is always safe — reload.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    void import("@sentry/nextjs").then((Sentry) => Sentry.captureException(error));
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#101010", color: "#f3f1ea", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <main style={{ maxWidth: 560, margin: "0 auto", padding: "96px 24px" }}>
          <div style={{ fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: "#9a9992", marginBottom: 10 }}>Something broke</div>
          <h1 style={{ fontSize: 32, lineHeight: 1.05, letterSpacing: "-.03em", margin: "0 0 12px", fontWeight: 500 }}>Plansphere couldn’t load this page</h1>
          <p style={{ color: "#d8d6d0", fontSize: 15, lineHeight: 1.55, margin: "0 0 8px" }}>
            Nothing you did caused it and nothing was lost — registrations and scans are saved on the server. Reloading usually fixes it.
          </p>
          {error.digest ? <p style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#9a9992", margin: "0 0 24px" }}>ref {error.digest}</p> : <div style={{ height: 24 }} />}
          <button
            type="button"
            onClick={reset}
            style={{ color: "#101010", border: "1.5px solid #cbf6df", backgroundColor: "#cbf6df", borderRadius: 3, padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
