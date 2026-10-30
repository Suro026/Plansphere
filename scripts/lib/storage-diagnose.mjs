/**
 * Why is file storage unhealthy? One answer per cause, never a secret.
 *
 * Shared by `GET /api/health` (through `src/server/storage/diagnose.ts`) and `npm run verify:infra`, so the two cannot
 * disagree. It is plain ESM with no imports because the script runs under bare `node`.
 *
 * The old check asked Supabase for each bucket and reported "missing bucket" for ANY error, so a wrong key, a key from
 * another project, a paused project, a network failure and a genuinely missing bucket all looked the same. This lists the
 * buckets once and reports which of those it actually is. It also checks each bucket's visibility, because the cost of a
 * private bucket (identity documents, certificates) being created public is a leak, while the cost of the reverse is
 * only broken images.
 *
 * Nothing returned contains the URL, the key, or any part of either: only fixed codes, bucket names and booleans.
 */

/** Bucket name -> whether it must be public. Mirrors `BUCKETS` / `PUBLIC_BUCKETS` in src/server/storage/client.ts (a unit test pins them together). */
export const EXPECTED_BUCKETS = Object.freeze({
  "event-assets": true,
  avatars: true,
  certificates: false,
  uploads: false,
});

const PROBE_TIMEOUT_MS = 8000;

/** @param {string} token */
const jwtPayload = (token) => {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const parsed = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

/** A pasted value often carries a trailing newline or wrapping quotes; strip exactly that, nothing else. */
export const cleanEnvValue = (value) => (value ?? "").trim().replace(/^(['"])(.*)\1$/s, "$2").trim();

/**
 * Supabase variables set under names this app never reads. The Next.js / Supabase quick-start names the pair
 * `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (browser-side, anon-level); this app does no storage
 * from the browser and reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` on the server only. With only the quick-start names
 * set, storage reads as "not configured" - uploads are silently off - so say which names are present and unused.
 * Returns the names (never the values), and only when the real pair is entirely absent.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export const misnamedStorageVariables = (env) => {
  if (cleanEnvValue(env.SUPABASE_URL) || cleanEnvValue(env.SUPABASE_SERVICE_ROLE_KEY)) return [];
  return ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY"].filter((name) => cleanEnvValue(env[name]));
};

/**
 * What the two variables look like, without calling anything and without echoing them.
 * @param {Record<string, string | undefined>} env
 */
export const inspectStorageEnv = (env) => {
  const url = cleanEnvValue(env.SUPABASE_URL);
  const key = cleanEnvValue(env.SUPABASE_SERVICE_ROLE_KEY);

  /** @type {"missing" | "invalid" | "not-https" | "has-path" | "ok"} */
  let urlState = "ok";
  let host = "";
  if (!url) urlState = "missing";
  else {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      if (parsed.protocol !== "https:" && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname)) urlState = "not-https";
      else if (parsed.pathname.replace(/\/+$/, "") !== "") urlState = "has-path";
    } catch {
      urlState = "invalid";
    }
  }

  /** @type {"missing" | "malformed" | "publishable" | "service-role" | "unrecognized"} */
  let keyState = "unrecognized";
  /** @type {string | null} */
  let keyRef = null;
  if (!key) keyState = "missing";
  else if (/\s/.test(key)) keyState = "malformed";
  else {
    if (key.startsWith("sb_secret_")) keyState = "service-role";
    else if (key.startsWith("sb_publishable_")) keyState = "publishable";
    else {
      const payload = key.split(".").length === 3 ? jwtPayload(key) : null;
      if (payload?.role === "service_role") keyState = "service-role";
      else if (payload?.role === "anon") keyState = "publishable";
      if (payload && typeof payload.ref === "string") keyRef = payload.ref;
    }
  }

  // A hosted project is https://<ref>.supabase.co, and a legacy JWT key carries the same <ref>.
  const projectMismatch = Boolean(keyRef && host.endsWith(".supabase.co") && host.split(".")[0] !== keyRef);

  return { url: urlState, key: keyState, projectMismatch, hostedProject: host.endsWith(".supabase.co") };
};

/**
 * Maps whatever the Supabase client threw or returned onto one fixed cause.
 * @param {unknown} error
 * @returns {"bucket-missing" | "key-malformed" | "unauthorized" | "unreachable" | "wrong-url" | "upstream" | "unknown"}
 */
export const classifyStorageError = (error) => {
  const e = /** @type {{ message?: unknown; status?: unknown; statusCode?: unknown; originalError?: { message?: unknown } } | null} */ (error ?? {});
  const message = `${e?.message ?? ""} ${e?.originalError?.message ?? ""}`;
  const status = Number(e?.status) || Number(e?.statusCode) || 0;

  if (/bucket (not found|does not exist)/i.test(message)) return "bucket-missing";
  if (/not a valid http header|invalid header|invalid character in header/i.test(message)) return "key-malformed";
  if (status === 401 || status === 403 || /invalid (api )?key|invalid jwt|compact jws|jwt|signature|unauthori[sz]ed|forbidden|apikey/i.test(message)) return "unauthorized";
  if (/fetch failed|enotfound|econnrefused|econnreset|etimedout|eai_again|getaddrinfo|socket|network|timed? ?out|certificate|und_err/i.test(message)) return "unreachable";
  if (status === 404 || /requested path is invalid|not found/i.test(message)) return "wrong-url";
  if (status >= 500 || /paus|unavailable|upstream|bad gateway/i.test(message)) return "upstream";
  return "unknown";
};

const FIX = {
  "half-configured": "Only one of SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is set. Set both, or neither, on this deployment.",
  "url-invalid": "SUPABASE_URL is not a usable URL. It must be the project URL, https://<project-ref>.supabase.co (Project settings -> API).",
  "url-has-path": "SUPABASE_URL has a path after the host. Use only https://<project-ref>.supabase.co, with no /rest/v1 or other suffix.",
  "url-not-https": "SUPABASE_URL is not https. Use the project's https URL.",
  "key-missing": "SUPABASE_SERVICE_ROLE_KEY is empty.",
  "key-malformed": "SUPABASE_SERVICE_ROLE_KEY contains whitespace or a line break inside it. Re-paste it as one line with no quotes.",
  "key-publishable": "SUPABASE_SERVICE_ROLE_KEY holds the publishable / anon key. Storage administration needs the secret (service_role) key from Project settings -> API.",
  "key-unrecognized": "SUPABASE_SERVICE_ROLE_KEY is not in a format Supabase issues (a JWT, or sb_secret_...). Check it was copied whole.",
  "project-mismatch": "The key belongs to a different Supabase project than SUPABASE_URL. Copy both from the same project.",
  unauthorized: "Supabase rejected the key. It is wrong, revoked or rotated, or belongs to another project. Re-copy the secret (service_role) key for the project in SUPABASE_URL.",
  unreachable: "Could not reach Supabase from this server (network, DNS or timeout). Check SUPABASE_URL and that the project is running.",
  "wrong-url": "Supabase answered but not as a storage endpoint. SUPABASE_URL is probably not the project URL.",
  upstream: "Supabase returned a server error. Check the project is not paused (Project settings) and the Supabase status page.",
  unknown: "Supabase returned an error this check does not recognise. Run `npm run verify:infra` locally for the full message.",
  "bucket-missing": "The bucket does not exist. Create it with exactly this name (Storage -> New bucket).",
  "bucket-should-be-private": "This bucket is PUBLIC but holds private files. Make it private now (Storage -> the bucket -> Edit bucket -> turn Public off).",
  "bucket-should-be-public": "This bucket is private but the app serves its files by permanent public URL. Make it public (Storage -> the bucket -> Edit bucket -> Public).",
};

/** @param {keyof typeof FIX} code @param {string} [bucket] */
const problem = (code, bucket) => ({ code, ...(bucket ? { bucket } : {}), message: FIX[code] });

const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { status: 0 })), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/**
 * @param {{ env: Record<string, string | undefined>, client: () => { storage: { listBuckets: () => Promise<{ data: Array<{ name: string; public?: boolean; file_size_limit?: number | null }> | null; error: unknown }> } }, timeoutMs?: number }} input
 */
export const diagnoseStorage = async ({ env, client, timeoutMs = PROBE_TIMEOUT_MS }) => {
  const shape = inspectStorageEnv(env);
  const urlSet = shape.url !== "missing";
  const keySet = shape.key !== "missing";

  if (!urlSet && !keySet) return { configured: false, ok: true, problems: [], buckets: [], env: shape };

  /** @type {Array<ReturnType<typeof problem>>} */
  const problems = [];
  if (urlSet !== keySet) problems.push(problem("half-configured"));
  if (shape.url === "invalid") problems.push(problem("url-invalid"));
  if (shape.url === "has-path") problems.push(problem("url-has-path"));
  if (shape.url === "not-https") problems.push(problem("url-not-https"));
  if (shape.key === "malformed") problems.push(problem("key-malformed"));
  if (shape.key === "publishable") problems.push(problem("key-publishable"));
  if (shape.key === "unrecognized") problems.push(problem("key-unrecognized"));
  if (shape.projectMismatch) problems.push(problem("project-mismatch"));

  // With the variables unusable there is nothing to ask Supabase; the problems above are the answer.
  const unusable = !urlSet || !keySet || shape.url === "invalid" || shape.key === "malformed" || shape.key === "publishable";
  if (unusable) return { configured: true, ok: false, problems, buckets: [], env: shape };

  /** @type {Array<{ name: string; exists: boolean; public: boolean | null; expectedPublic: boolean }>} */
  const buckets = [];
  try {
    const { data, error } = await withTimeout(client().storage.listBuckets(), timeoutMs);
    if (error || !data) throw error ?? new Error("no data");
    for (const [name, expectedPublic] of Object.entries(EXPECTED_BUCKETS)) {
      const found = data.find((bucket) => bucket.name === name);
      buckets.push({ name, exists: Boolean(found), public: found ? Boolean(found.public) : null, expectedPublic });
      if (!found) problems.push(problem("bucket-missing", name));
      else if (!expectedPublic && found.public) problems.push(problem("bucket-should-be-private", name));
      else if (expectedPublic && !found.public) problems.push(problem("bucket-should-be-public", name));
    }
  } catch (error) {
    const code = classifyStorageError(error);
    // A list that fails with "bucket not found" has no bucket to blame; it is an unrecognised answer.
    problems.push(problem(code === "bucket-missing" ? "unknown" : code));
  }

  return { configured: true, ok: problems.length === 0, problems, buckets, env: shape };
};
