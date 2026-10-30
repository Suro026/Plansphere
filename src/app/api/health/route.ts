import { NextResponse } from "next/server";
import declaredIndexes from "../../../../firestore.indexes.json";
import { buildIndexProbe, describeIndex, isMissingIndexError, type DeclaredIndex } from "../../../../scripts/lib/index-probe.mjs";
import { inspectServiceAccount } from "../../../../scripts/lib/service-account.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health — step-by-step diagnostics for the server side.
 *
 * Every check is isolated: this module has no static import of the Firebase
 * Admin layer, so it still answers when that layer cannot even be loaded.
 * Each step reports `ok` or the error's name + message, never a secret — the
 * service account is described by project id and a masked client email.
 *
 * Public on purpose: it exposes nothing a caller could not learn from a
 * failing request, and it is the first URL to open when production misbehaves.
 */

interface Step {
  ok: boolean;
  ms: number;
  detail?: Record<string, unknown>;
  error?: { name: string; message: string };
}

const describe = (error: unknown) => ({
  name: error instanceof Error ? error.name : "Error",
  message: error instanceof Error ? error.message : String(error),
});

const step = async (run: () => Promise<Record<string, unknown> | void>): Promise<Step> => {
  const started = Date.now();
  try {
    const detail = await run();
    return { ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: describe(error) };
  }
};

const mask = (email: string) => {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 4)}…@${domain}`;
};

/**
 * Who may see details. Anonymous callers (uptime monitors) get pass/fail per
 * check; a verified super admin gets the messages and facts behind them.
 * Resolved defensively — this route must answer even when auth is broken.
 */
const detailAllowed = async (request: Request): Promise<boolean> => {
  if (!request.headers.get("authorization")) return false;
  try {
    const { authenticate } = await import("@/server/api");
    const { hasAtLeast } = await import("@/core/models/user");
    const caller = await authenticate(request);
    return hasAtLeast(caller.role, "super_admin");
  } catch {
    return false;
  }
};

/** Strip everything but pass/fail and timing. */
const redact = (checks: Record<string, Step>): Record<string, Pick<Step, "ok" | "ms">> =>
  Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, { ok: v.ok, ms: v.ms }]));

export async function GET(request: Request) {
  const checks: Record<string, Step> = {};
  const verbose = await detailAllowed(request);

  // 1. Runtime facts — the first thing to compare against a working machine.
  checks.runtime = await step(async () => ({
    node: process.version,
    platform: process.platform,
    vercel: Boolean(process.env.VERCEL),
    region: process.env.VERCEL_REGION ?? null,
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
  }));

  // 2. Environment variables present? (names only, never values)
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT ?? "";
  checks.env = await step(async () => ({
    FIREBASE_SERVICE_ACCOUNT: raw.trim().length > 0,
    serviceAccountLength: raw.trim().length,
    // Why the value is unusable, when it is: a code, never any part of it (scripts/lib/service-account.mjs).
    serviceAccountShape: (() => {
      const reading = inspectServiceAccount(raw);
      return reading.ok ? reading.shape : `unusable: ${reading.code}`;
    })(),
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: Boolean(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID),
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? null,
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER ?? "console (default)",
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  }));

  // 2b. The env schema: what is missing, what is degraded, which features are on.
  checks.envValidation = await step(async () => {
    const { validateEnv } = await import("@/server/env");
    const report = validateEnv();
    if (!report.ok) throw new Error(report.issues.filter((i) => i.level === "error").map((i) => `${i.key}: ${i.message}`).join("; "));
    return { features: report.features, warnings: report.issues.map((i) => `${i.key}: ${i.message}`) };
  });

  // 3. Can the service account be parsed? (project id + masked email only)
  checks.serviceAccountParse = await step(async () => {
    const reading = inspectServiceAccount(raw);
    if (!reading.ok) throw new Error(`FIREBASE_SERVICE_ACCOUNT cannot be used (${reading.code}): ${reading.message}`);
    return {
      shape: reading.shape,
      project_id: reading.projectId,
      client_email: mask(reading.account.client_email),
      privateKeyPresent: true,
    };
  });

  // 4. Can the Admin SDK modules even be loaded? (this is where a bundling or
  //    file-tracing problem on the host shows up)
  checks.importFirebaseAdmin = await step(async () => {
    const app = await import("firebase-admin/app");
    const firestore = await import("firebase-admin/firestore");
    await import("firebase-admin/auth");
    return { sdkVersion: (app as { SDK_VERSION?: string }).SDK_VERSION ?? null, hasFieldValue: typeof firestore.FieldValue === "function" };
  });

  // 5. Can our own server module load, and does it initialize?
  let admin: typeof import("@/server/firebase-admin") | null = null;
  checks.importServerModule = await step(async () => {
    admin = await import("@/server/firebase-admin");
    return { configured: admin.isAdminConfigured() };
  });

  checks.adminInit = await step(async () => {
    if (!admin) throw new Error("server module did not load");
    const app = admin.getAdminApp();
    return { appName: app.name, projectId: app.options.projectId ?? null };
  });

  // 6. A real Firestore read with the admin credential.
  checks.firestoreRead = await step(async () => {
    if (!admin) throw new Error("server module did not load");
    const snap = await admin.adminDb().collection(admin.COLLECTIONS.fests).limit(1).get();
    return { fests: snap.size };
  });

  // 7. Every composite index declared in firestore.indexes.json - the same list `npm run verify:infra` probes, built from
  //    the file, so a newly declared index is checked here without anyone remembering to add it.
  checks.firestoreIndexes = await step(async () => {
    if (!admin) throw new Error("server module did not load");
    const db = admin.adminDb();
    const declared = declaredIndexes.indexes as DeclaredIndex[];
    const missing: string[] = [];
    for (const index of declared) {
      try {
        await buildIndexProbe((name) => db.collection(name) as FirebaseFirestore.Query, index).get();
      } catch (error) {
        if (isMissingIndexError(error)) missing.push(describeIndex(index));
        else throw error;
      }
    }
    if (missing.length) throw new Error(`Missing composite indexes: ${missing.join("; ")}`);
    return { probed: declared.length };
  });

  // 8. Supabase Storage: reachable with the right key, every bucket there, and
  //    each one public or private as the app expects. Skipped (not an error)
  //    when neither variable is set - uploads then degrade to "paste a URL
  //    instead" - but ONE of the two being set is a misconfiguration and fails.
  //    The failure names its cause (wrong key, wrong project, unreachable,
  //    missing bucket, wrong visibility); the redacted view still shows only
  //    pass/fail, and no value from the environment is ever reported.
  checks.storage = await step(async () => {
    const { diagnoseStorage } = await import("@/server/storage/diagnose");
    const { supabaseAdmin } = await import("@/server/storage/client");
    const report = await diagnoseStorage({ env: process.env, client: supabaseAdmin });
    if (!report.configured) return { configured: false };
    if (!report.ok) throw new Error(report.problems.map((p) => `${p.code}${p.bucket ? ` (${p.bucket})` : ""}: ${p.message}`).join(" | "));
    return { configured: true, buckets: report.buckets.map((b) => ({ name: b.name, public: b.public })) };
  });

  // 9. Auth admin reachable (a metadata call that needs no user).
  checks.authAdmin = await step(async () => {
    if (!admin) throw new Error("server module did not load");
    const list = await admin.adminAuth().listUsers(1);
    return { reachable: true, sampled: list.users.length };
  });

  // 10. Observability and protection, as configured.
  checks.monitoring = await step(async () => {
    const { appCheckMode } = await import("@/server/app-check");
    const { validateEnv } = await import("@/server/env");
    const f = validateEnv().features;
    return {
      sentry: f.sentry ? "on" : "off (no NEXT_PUBLIC_SENTRY_DSN)",
      appCheck: f.appCheck === "off" ? "off (no site key)" : appCheckMode(),
      rateLimitStore: f.rateLimitStore,
      cron: f.cron ? "armed" : "off (no CRON_SECRET)",
      email: f.email,
    };
  });

  // 11. Paid registration keeping up: is the payments job running, are holds
  //     and refunds being cleared, has any refund given up? Reports "ok" with
  //     nothing to say while payments are off and nothing is waiting.
  checks.payments = await step(async () => {
    if (!admin) throw new Error("server module did not load");
    const { paymentsHealth } = await import("@/server/payments/housekeeping");
    const health = await paymentsHealth();
    if (!health.ok) throw new Error(health.problems.join("; "));
    return { ...health };
  });

  const healthy = Object.values(checks).every((c) => c.ok);
  const response = NextResponse.json(
    { ok: healthy, checkedAt: new Date().toISOString(), detail: verbose ? "full" : "redacted", checks: verbose ? checks : redact(checks) },
    { status: healthy ? 200 : 503 },
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}
