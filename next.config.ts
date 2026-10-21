import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * Security headers on every response.
 *
 * HSTS is preload-grade (two years, subdomains). The CSP is enforcing:
 * every directive below already covers what the app actually loads — Next's
 * inline runtime, Firebase's endpoints, Supabase Storage, the
 * reCAPTCHA/Sentry/Vercel scripts — so a legitimate request is never
 * blocked. Widen this list (never with a wildcard host) before adding a new
 * third-party script or API, not after something breaks in production.
 */
/**
 * Only when the app is pointed at the local Firebase emulators (the video-demo
 * setup, `npm run demo:app`) the browser must be allowed to reach them.
 * NEXT_PUBLIC_FIREBASE_EMULATOR is never set on Vercel, so the production
 * policy below is unchanged.
 */
const emulatorConnect =
  process.env.NEXT_PUBLIC_FIREBASE_EMULATOR === "1"
    ? " http://127.0.0.1:8080 ws://127.0.0.1:8080 http://127.0.0.1:9099 http://localhost:8080 http://localhost:9099"
    : "";

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "object-src 'none'",
  // firebasestorage.googleapis.com stays allowed for images uploaded before
  // the Supabase Storage migration — their URLs are already persisted in
  // Firestore documents and are not backfilled.
  "img-src 'self' data: blob: https://firebasestorage.googleapis.com https://*.supabase.co https://lh3.googleusercontent.com https://www.gstatic.com",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' https://www.google.com https://www.gstatic.com https://va.vercel-scripts.com https://vercel.live",
  `connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://firebase.googleapis.com https://www.google.com https://*.sentry.io https://*.ingest.sentry.io https://vitals.vercel-insights.com https://va.vercel-scripts.com${emulatorConnect}`,
  "frame-src https://www.google.com https://*.firebaseapp.com",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "Content-Security-Policy", value: csp },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    dirs: ["src", "tests"],
  },
  experimental: {
    // 23 files import icons from the package's barrel ("@phosphor-icons/react"
    // itself, not a per-icon path) — this rewrites those to per-icon imports
    // at build time so only the icons actually used are bundled, without
    // touching any of those 23 files.
    optimizePackageImports: ["@phosphor-icons/react"],
  },
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      // Pre-migration uploads: URLs already stored in Firestore, not backfilled.
      { protocol: "https", hostname: "firebasestorage.googleapis.com" },
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Static, immutable assets and the icons.
      { source: "/(icon.svg|favicon.ico|apple-icon.png|manifest.webmanifest|opengraph-image.png)", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
    ];
  },
  async redirects() {
    return [
      // One canonical host. www → apex, permanently.
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.plansphere.in" }],
        destination: "https://plansphere.in/:path*",
        permanent: true,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // Source maps are uploaded only when a token is present (Vercel env); the
  // build never fails for want of Sentry.
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  widenClientFileUpload: true,
  disableLogger: true,
  /**
   * `autoInstrumentAppDirectory` defaults to true: Sentry's webpack plugin
   * wraps every `app/` Server Component (every page.tsx/layout.tsx) in its
   * own error-monitoring layer at build time. With no
   * NEXT_PUBLIC_SENTRY_DSN configured in this deployment (confirmed via
   * /api/health — "errors are only in Vercel logs"), that wrapper currently
   * has nowhere to send anything anyway, so turning it off loses no real
   * monitoring today. Disabled because it is the prime suspect for a
   * production-only crash on every dynamic `/f/[festSlug]` Server Component
   * page — "An error occurred in the Server Components render" — that
   * never reproduced locally under next dev, a genuine `next start`
   * production server, or a from-scratch `npm ci` install matching
   * Vercel's own build command, across several independent redeploys of
   * already-verified-correct application code. `autoInstrumentServerFunctions`
   * (API routes, data fetching) and `autoInstrumentMiddleware` are left at
   * their defaults — only the App Router component wrapper is disabled.
   */
  webpack: {
    autoInstrumentAppDirectory: false,
  },
  // Errors only on the client: tracing and replay are compiled out, which
  // takes the browser SDK from ~340 kB to a fraction of that.
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
    excludeTracing: true,
    excludeReplayIframe: true,
    excludeReplayShadowDom: true,
    excludeReplayWorker: true,
  },
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  telemetry: false,
});
