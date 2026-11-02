/**
 * The pure parts of GET /api/health: running one check with a time limit, and reducing every check to an overall status
 * and one word per service. No imports, so the route can still answer when everything else in the app cannot load, and the
 * tests can drive it without a server.
 */

export interface Step {
  ok: boolean;
  ms: number;
  detail?: Record<string, unknown>;
  error?: { name: string; message: string };
}

const describe = (error: unknown) => ({
  name: error instanceof Error ? error.name : "Error",
  message: error instanceof Error ? error.message : String(error),
});

/** No single dependency may hold the endpoint: a step that has not answered by then fails, and the rest still report. */
export const STEP_TIMEOUT_MS = 20_000;

export const step = async (run: () => Promise<Record<string, unknown> | void>, timeoutMs: number = STEP_TIMEOUT_MS): Promise<Step> => {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`did not answer within ${Math.round(timeoutMs / 1000)} s`), { name: "TimeoutError" })), timeoutMs);
  });
  try {
    const detail = await Promise.race([run(), expired]);
    return { ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: describe(error) };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Which service each check belongs to, and which checks the app cannot serve without.
 *
 * A failing CRITICAL check means the application cannot do its job at all ("down"). Any other failing check means the
 * application is up and one capability is not ("degraded"): storage failing stops uploads, not sign-in or registration.
 * Both still answer 503, so a monitor keyed on the status code alerts on either; `status` says which it is.
 */
const SERVICE_OF: Record<string, "application" | "firebase" | "storage" | "payments"> = {
  runtime: "application",
  env: "application",
  envValidation: "application",
  monitoring: "application",
  serviceAccountParse: "firebase",
  importFirebaseAdmin: "firebase",
  importServerModule: "firebase",
  adminInit: "firebase",
  firestoreRead: "firebase",
  firestoreIndexes: "firebase",
  authAdmin: "firebase",
  storage: "storage",
  payments: "payments",
};
const CRITICAL = new Set(["runtime", "env", "envValidation", "serviceAccountParse", "importFirebaseAdmin", "importServerModule", "adminInit", "firestoreRead", "authAdmin"]);

export type ServiceState = "ok" | "failing" | "disabled";

/** One word per service. Storage that is deliberately not configured is "disabled", not "ok": uploads are off there. */
export const summarise = (checks: Record<string, Step>) => {
  const services: Record<string, ServiceState> = { application: "ok", firebase: "ok", storage: "ok", payments: "ok" };
  for (const [name, check] of Object.entries(checks)) {
    const service = SERVICE_OF[name] ?? "application";
    if (!check.ok) services[service] = "failing";
  }
  if (services.storage === "ok" && checks.storage?.detail?.configured === false) services.storage = "disabled";
  const failing = Object.entries(checks).filter(([, check]) => !check.ok);
  const status: "ok" | "degraded" | "down" = failing.length === 0 ? "ok" : failing.some(([name]) => CRITICAL.has(name) || !(name in SERVICE_OF)) ? "down" : "degraded";
  return { status, services };
};
