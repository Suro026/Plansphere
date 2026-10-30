// @vitest-environment node
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkServiceAccount, cleanServiceAccountValue, inspectServiceAccount } from "../../scripts/lib/service-account.mjs";
import { validateEnv } from "@/server/env";
import { AdminNotConfiguredError } from "@/server/firebase-admin";

/**
 * FIREBASE_SERVICE_ACCOUNT is read by the app, /api/health and every operational script. Found in the Phase 7 audit: the value
 * in .env.local was the PRIVATE KEY ALONE (a PEM body with literal \n separators), which is neither JSON nor base64. The old
 * reading base64-decoded it into garbage and failed with a bare JSON SyntaxError, `validateEnv` called it "ok" because it was
 * non-empty, and the health check said "base64". These tests pin the replacement: every mistake gets its own named cause, and
 * no part of the value ever appears in a message.
 */

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";
const key = (over: Record<string, unknown> = {}) => ({ type: "service_account", project_id: "demo-proj", client_email: "svc@demo-proj.iam.gserviceaccount.com", private_key: PEM, ...over });
const asBase64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

describe("a usable service account", () => {
  it("reads raw JSON and base64 JSON to the same account", () => {
    const json = inspectServiceAccount(JSON.stringify(key()));
    const b64 = inspectServiceAccount(asBase64(key()));
    expect(json.ok && b64.ok).toBe(true);
    if (json.ok && b64.ok) {
      expect(json.shape).toBe("json");
      expect(b64.shape).toBe("base64");
      expect(b64.account).toEqual(json.account);
      expect(b64.projectId).toBe("demo-proj");
      expect(b64.clientEmailDomain).toBe("demo-proj.iam.gserviceaccount.com");
    }
  });

  it("tolerates wrapping quotes, a trailing newline and base64 broken over lines (what a dashboard paste adds)", () => {
    const b64 = asBase64(key());
    const wrapped = `"${b64.slice(0, 40)}\n${b64.slice(40)}"\n`;
    expect(inspectServiceAccount(wrapped).ok).toBe(true);
    expect(cleanServiceAccountValue(`'abc'\n`)).toBe("abc");
  });

  it("restores a private key whose newlines arrived as the two characters \\n", () => {
    const reading = inspectServiceAccount(asBase64(key({ private_key: PEM.replace(/\n/g, "\\n") })));
    expect(reading.ok).toBe(true);
    if (reading.ok) expect(reading.account.private_key).toContain("\n");
  });

  it("accepts a key with no 'type' field, as the old reading did", () => {
    expect(inspectServiceAccount(asBase64(key({ type: undefined }))).ok).toBe(true);
  });
});

describe("an unusable service account names its cause", () => {
  const code = (raw: unknown) => {
    const reading = inspectServiceAccount(raw);
    return reading.ok ? "ok" : reading.code;
  };

  it("empty or whitespace", () => {
    expect(code(undefined)).toBe("missing");
    expect(code("   \n")).toBe("missing");
    expect(code('""')).toBe("missing");
  });

  it("the private key alone - the actual mistake found in .env.local", () => {
    // A PEM body with literal \n separators and no header, and a PEM with its header: both are "just the key".
    expect(code("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\nabcDEF+/123\\nxyz=\\n")).toBe("private-key-only");
    expect(code(PEM)).toBe("private-key-only");
  });

  it("neither JSON nor base64", () => {
    expect(code("this is not a key!")).toBe("not-json-or-base64");
    expect(code("abc.def.ghi")).toBe("not-json-or-base64");
  });

  it("valid base64 that is not JSON, and JSON that is not an object", () => {
    expect(code(Buffer.from("hello world, not json").toString("base64"))).toBe("not-json");
    expect(code("{ truncated")).toBe("not-json");
    expect(code(Buffer.from("[1,2,3]").toString("base64"))).toBe("not-an-object");
    expect(code(Buffer.from("null").toString("base64"))).toBe("not-an-object");
  });

  it("a different kind of Google credential", () => {
    expect(code(asBase64(key({ type: "authorized_user" })))).toBe("wrong-type");
  });

  it("missing fields are listed by name", () => {
    const reading = inspectServiceAccount(asBase64({ type: "service_account", project_id: "p" }));
    expect(reading.ok).toBe(false);
    if (!reading.ok) {
      expect(reading.code).toBe("missing-fields");
      expect(reading.fields).toEqual(["client_email", "private_key"]);
      expect(reading.message).toContain("client_email, private_key");
    }
  });

  it("a private_key that is not PEM", () => {
    expect(code(asBase64(key({ private_key: "not a pem" })))).toBe("private-key-malformed");
  });

  it("never puts any part of the value in a message", () => {
    const secret = "S3CR3T-MARKER-VALUE";
    for (const raw of [
      `${secret}\\n${secret}`,
      secret + "!",
      Buffer.from(secret).toString("base64"),
      asBase64(key({ private_key: secret })),
      JSON.stringify(key({ private_key: secret, client_email: undefined })),
    ]) {
      const reading = inspectServiceAccount(raw);
      expect(reading.ok).toBe(false);
      expect(JSON.stringify(reading)).not.toContain(secret);
    }
  });
});

describe("where the reading is used", () => {
  it("the Admin SDK loader refuses with the cause, not a SyntaxError", async () => {
    const saved = { sa: process.env.FIREBASE_SERVICE_ACCOUNT, emu: process.env.FIRESTORE_EMULATOR_HOST };
    delete process.env.FIRESTORE_EMULATOR_HOST;
    process.env.FIREBASE_SERVICE_ACCOUNT = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\nabc\\n";
    try {
      // A fresh module so its cached app is not reused.
      const { vi } = await import("vitest");
      vi.resetModules();
      const mod = await import("@/server/firebase-admin");
      expect(() => mod.getAdminApp()).toThrowError(/private key alone/);
      expect(mod.isAdminConfigured()).toBe(false);
      expect(() => mod.getAdminApp()).toThrowError(mod.AdminNotConfiguredError);
    } finally {
      if (saved.sa === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT;
      else process.env.FIREBASE_SERVICE_ACCOUNT = saved.sa;
      if (saved.emu !== undefined) process.env.FIRESTORE_EMULATOR_HOST = saved.emu;
    }
    expect(AdminNotConfiguredError).toBeDefined();
  });

  it("the environment report calls an unusable credential an error in production (and a warning elsewhere), not 'ok'", () => {
    const base = {
      NEXT_PUBLIC_FIREBASE_API_KEY: "k",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "p.firebaseapp.com",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "p",
      NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "1",
      NEXT_PUBLIC_FIREBASE_APP_ID: "1:1:web:x",
      NEXT_PUBLIC_APP_URL: "https://plansphere.in",
      FIREBASE_SERVICE_ACCOUNT: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\nabc\\n",
    };
    const prod = validateEnv({ ...base, VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv);
    expect(prod.ok).toBe(false);
    const issue = prod.issues.find((i) => i.key === "FIREBASE_SERVICE_ACCOUNT");
    expect(issue?.level).toBe("error");
    expect(issue?.message).toContain("private-key-only");
    expect(issue?.message).not.toContain("MIIEvQ");

    const preview = validateEnv({ ...base, VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv);
    expect(preview.issues.find((i) => i.key === "FIREBASE_SERVICE_ACCOUNT")?.level).toBe("warning");
  });
});

/**
 * `npm run check:credential` - the offline check the owner runs after preparing the credential. It must say what is wrong
 * without echoing any of the value, and must catch a key that has PEM lines but is not a key.
 */
describe("the offline credential check", () => {
  const realPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const good = (over: Record<string, unknown> = {}) => asBase64(key({ project_id: "demo-proj", private_key: realPem, ...over }));
  const failing = (raw: unknown, web?: string) => checkServiceAccount(raw, { webProjectId: web }).steps.filter((s) => !s.ok).map((s) => s.label);

  it("passes a complete credential for the project the web config points at", () => {
    const result = checkServiceAccount(good(), { webProjectId: "demo-proj" });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.label)).toEqual(["format", "private key", "client e-mail", "project"]);
  });

  it("passes with the web project unset, and says it did not compare", () => {
    const result = checkServiceAccount(good());
    expect(result.ok).toBe(true);
    expect(result.steps.at(-1)!.detail).toContain("not compared");
  });

  it("fails a credential for a different project than the web config", () => {
    expect(failing(good(), "another-proj")).toEqual(["project"]);
  });

  it("fails a key that has PEM lines but is not a key", () => {
    expect(failing(good({ private_key: PEM }))).toEqual(["private key"]);
  });

  it("fails an e-mail that belongs to another project", () => {
    expect(failing(good({ client_email: "svc@other-proj.iam.gserviceaccount.com" }))).toEqual(["client e-mail"]);
  });

  it("stops at the format when the value is unusable (the private key alone), naming the cause", () => {
    const result = checkServiceAccount("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\nabc\\n");
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.detail).toContain("private-key-only");
  });

  it("never puts any part of the value in a step", () => {
    const marker = "S3CR3T-MARKER-VALUE";
    for (const raw of [good({ private_key: marker }), good({ client_email: `${marker}@x.com` }), marker]) {
      const text = JSON.stringify(checkServiceAccount(raw, { webProjectId: "demo-proj" }));
      expect(text).not.toContain(marker);
      expect(text).not.toContain("BEGIN PRIVATE KEY");
    }
  });

  it("the script is offline and prints only step labels", () => {
    const script = readFileSync("scripts/check-credential.mjs", "utf8");
    expect(script).not.toMatch(/fetch\(|firebase-admin|getAuth|getFirestore/);
    expect(script).not.toMatch(/console\.\w+\([^)]*process\.env\.FIREBASE_SERVICE_ACCOUNT/);
  });
});
