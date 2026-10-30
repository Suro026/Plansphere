/**
 * Reading FIREBASE_SERVICE_ACCOUNT, and saying precisely what is wrong with it when it cannot be read.
 *
 * The value is a Google service-account key: raw JSON, or that JSON base64-encoded (what the setup writes, because a PEM key
 * holds newlines and an `.env` file keeps them only inside quotes). Everything that needs it - the app, `/api/health`, the
 * migration and rollout scripts - used to repeat "trim, strip quotes, JSON.parse", and a wrong value (the private key alone,
 * a truncated paste, the wrong file) surfaced as a bare `SyntaxError` or "invalid PEM" long after the real mistake. This is
 * the one reading, shared by plain node and the app (`src/server/firebase-admin.ts` re-exports its types).
 *
 * Nothing here ever puts any part of the value into a message or a report: only a code, a sentence, the field names that are
 * missing and, for a usable key, the project id (public) and the client e-mail's domain.
 */

import { createPrivateKey } from "node:crypto";

const REQUIRED = ["project_id", "client_email", "private_key"];

const MESSAGES = {
  missing: "FIREBASE_SERVICE_ACCOUNT is empty.",
  "private-key-only":
    "the value looks like the private key alone, not the whole service-account file. Use the complete JSON file from Firebase console → Project settings → Service accounts → Generate new private key, base64-encoded.",
  "not-json-or-base64": "the value is neither JSON nor base64. Use the complete service-account JSON file, base64-encoded.",
  "not-json": "the value did not decode to JSON. Use the complete service-account JSON file (base64-encoded, or raw JSON on one line).",
  "not-an-object": "the value decoded, but not to a JSON object.",
  "wrong-type": 'the JSON is not a service-account key (its "type" is not "service_account").',
  "missing-fields": "the JSON is missing {fields}.",
  "private-key-malformed": "private_key is not a PEM private key (no BEGIN/END PRIVATE KEY lines after newlines are restored).",
};

/** Strips whitespace and wrapping quotes a dashboard paste tends to add. */
export const cleanServiceAccountValue = (raw) => String(raw ?? "").trim().replace(/^['"]|['"]$/g, "").trim();

const fail = (code, extra = {}) => ({
  ok: false,
  code,
  message: MESSAGES[code].replace("{fields}", (extra.fields ?? []).join(", ")),
  ...extra,
});

/**
 * @returns {{ok: true, account: {project_id: string, client_email: string, private_key: string}, shape: "json"|"base64", projectId: string, clientEmailDomain: string}
 *   | {ok: false, code: string, message: string, fields?: string[]}}
 */
export const inspectServiceAccount = (raw) => {
  const value = cleanServiceAccountValue(raw);
  if (!value) return fail("missing");

  let text = value;
  let shape = "json";
  if (!value.startsWith("{")) {
    shape = "base64";
    // A bare PEM body (or a PEM with its header) carries literal "\n" sequences or dashes; base64 never does.
    if (/BEGIN [A-Z ]*PRIVATE KEY/.test(value) || (/\\n/.test(value) && !/"/.test(value))) return fail("private-key-only");
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value.replace(/\s+/g, ""))) return fail("not-json-or-base64");
    text = Buffer.from(value.replace(/\s+/g, ""), "base64").toString("utf8");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("not-json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("not-an-object");

  if (parsed.type !== undefined && parsed.type !== "service_account") return fail("wrong-type");
  const missing = REQUIRED.filter((field) => typeof parsed[field] !== "string" || !parsed[field].trim());
  if (missing.length) return fail("missing-fields", { fields: missing });

  // A key whose newlines survived as the two characters \n is tolerated (and restored), as it always was.
  const privateKey = parsed.private_key.replace(/\\n/g, "\n");
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey) || !/-----END [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    return fail("private-key-malformed");
  }

  return {
    ok: true,
    shape,
    projectId: parsed.project_id,
    clientEmailDomain: parsed.client_email.split("@")[1] ?? "",
    account: { project_id: parsed.project_id, client_email: parsed.client_email, private_key: privateKey },
  };
};

/**
 * For scripts: the account, or exit 1 with the cause. Never prints the value.
 * @param {string | undefined} raw
 */
export const loadServiceAccountOrExit = (raw) => {
  const result = inspectServiceAccount(raw);
  if (!result.ok) {
    console.error(`\n  FIREBASE_SERVICE_ACCOUNT cannot be used: ${result.message}\n  (It is read from .env.local; see .env.example. Nothing was changed.)\n`);
    process.exit(1);
  }
  return result.account;
};

/**
 * An offline, deeper check than `inspectServiceAccount`: the private key must actually parse as a key (not merely carry
 * BEGIN/END lines), the e-mail must belong to the same project as `project_id`, and `project_id` must be the project the web
 * config points at. No network call, nothing printed from the value. Used by `npm run check:credential`.
 *
 * @param {unknown} raw  FIREBASE_SERVICE_ACCOUNT
 * @param {{ webProjectId?: string }} [options]
 * @returns {{ ok: boolean, steps: Array<{ ok: boolean, label: string, detail?: string }> }}
 */
export const checkServiceAccount = (raw, options = {}) => {
  const steps = [];
  const reading = inspectServiceAccount(raw);
  if (!reading.ok) {
    steps.push({ ok: false, label: "format", detail: `${reading.code}: ${reading.message}` });
    return { ok: false, steps };
  }
  steps.push({ ok: true, label: "format", detail: `${reading.shape === "base64" ? "base64-encoded" : "raw"} service-account JSON, all three fields present` });

  let keyOk = false;
  try {
    const key = createPrivateKey(reading.account.private_key);
    keyOk = key.asymmetricKeyType === "rsa";
    steps.push(keyOk ? { ok: true, label: "private key", detail: "parses as an RSA private key" } : { ok: false, label: "private key", detail: `parses, but is a ${key.asymmetricKeyType} key; Google service accounts use RSA` });
  } catch {
    steps.push({ ok: false, label: "private key", detail: "has PEM lines but is not a valid private key (truncated or altered). Generate a new key." });
  }

  const emailDomain = reading.clientEmailDomain;
  const expectedDomain = `${reading.projectId}.iam.gserviceaccount.com`;
  steps.push(
    emailDomain === expectedDomain
      ? { ok: true, label: "client e-mail", detail: "belongs to the same project as project_id" }
      : { ok: false, label: "client e-mail", detail: `is not a service account of project "${reading.projectId}" (expected the domain ${expectedDomain})` },
  );

  if (options.webProjectId) {
    steps.push(
      options.webProjectId === reading.projectId
        ? { ok: true, label: "project", detail: `${reading.projectId} (matches NEXT_PUBLIC_FIREBASE_PROJECT_ID)` }
        : { ok: false, label: "project", detail: `service account is for "${reading.projectId}" but NEXT_PUBLIC_FIREBASE_PROJECT_ID is "${options.webProjectId}"` },
    );
  } else {
    steps.push({ ok: true, label: "project", detail: `${reading.projectId} (NEXT_PUBLIC_FIREBASE_PROJECT_ID not set, so not compared)` });
  }
  return { ok: steps.every((s) => s.ok), steps };
};
