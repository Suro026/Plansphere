import { NextResponse } from "next/server";

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
    serviceAccountShape: !raw.trim() ? "missing" : raw.trim().startsWith("{") ? "json" : "base64",
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
    const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
    if (!trimmed) throw new Error("FIREBASE_SERVICE_ACCOUNT is empty");
    const text = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
    const parsed = JSON.parse(text) as { project_id?: string; client_email?: string; private_key?: string };
    return {
      project_id: parsed.project_id ?? null,
      client_email: parsed.client_email ? mask(parsed.client_email) : null,
      privateKeyPresent: Boolean(parsed.private_key),
      privateKeyHasNewlines: Boolean(parsed.private_key?.includes("\n")),
      privateKeyHasEscapedNewlines: Boolean(parsed.private_key?.includes("\\n")),
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

  // 7. The composite indexes the admin tables depend on.
  checks.firestoreIndexes = await step(async () => {
    if (!admin) throw new Error("server module did not load");
    const db = admin.adminDb();
    const probes: Array<[string, FirebaseFirestore.Query]> = [
      ["registrations festId+createdAt", db.collection("registrations").where("festId", "==", "_").orderBy("createdAt", "desc").limit(1)],
      ["registrations eventId+createdAt", db.collection("registrations").where("eventId", "==", "_").orderBy("createdAt", "desc").limit(1)],
      ["registrations festId+status+createdAt", db.collection("registrations").where("festId", "==", "_").where("status", "==", "confirmed").orderBy("createdAt", "desc").limit(1)],
      ["registrations eventId+status+createdAt", db.collection("registrations").where("eventId", "==", "_").where("status", "==", "confirmed").orderBy("createdAt", "desc").limit(1)],
      ["users role+createdAt", db.collection("users").where("role", "==", "student").orderBy("createdAt", "desc").limit(1)],
    ];
    const missing: string[] = [];
    for (const [label, q] of probes) {
      try {
        await q.get();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/index/i.test(message)) missing.push(label);
        else throw error;
      }
    }
    if (missing.length) throw new Error(`Missing composite indexes: ${missing.join("; ")}`);
    return { probed: probes.length };
  });

  // 8. Supabase Storage buckets reachable? Skipped (not an error) when the
  //    project has no Supabase env configured — uploads then degrade to
  //    "paste a URL instead" rather than the site being unhealthy.
  checks.storage = await step(async () => {
    const { isStorageConfigured, supabaseAdmin, BUCKETS } = await import("@/server/storage/client");
    if (!isStorageConfigured()) return { configured: false };
    const client = supabaseAdmin();
    const missing: string[] = [];
    for (const bucket of Object.values(BUCKETS)) {
      const { data, error } = await client.storage.getBucket(bucket);
      if (error || !data) missing.push(bucket);
    }
    if (missing.length) throw new Error(`Missing Supabase buckets: ${missing.join(", ")} — create them in the Supabase dashboard`);
    return { configured: true, buckets: Object.values(BUCKETS) };
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
