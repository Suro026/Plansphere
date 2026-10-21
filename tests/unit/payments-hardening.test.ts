// @vitest-environment node
import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindingProblem, accountBinding, type StoredAccount } from "@/server/payments/account";
import { guardAdapter, isAllowedRedirect, ProviderError, redactSecrets } from "@/server/payments/providers/safe";
import { testProvider, testProviderControl } from "@/server/payments/providers/test-provider";
import { OrderTerminalError, type PaymentProviderAdapter } from "@/server/payments/providers/types";
import { PaymentConfigError, currentKeyId, decryptCredentials, encryptCredentials, isCurrentBlob, rewrapBlob, type EncryptedBlobV1 } from "@/server/payments/secrets";

/* ───────────── safe error handling ───────────── */

describe("redactSecrets", () => {
  const credentials = { clientSecret: "fake_credential_abcdef123456", webhookSecret: "whsec_9f8e7d6c5b4a" };

  it("removes every credential value wherever it appears", () => {
    const text = `POST https://api.example.test/pay?key=fake_credential_abcdef123456 failed; body={"secret":"whsec_9f8e7d6c5b4a"} header Authorization: Bearer fake_credential_abcdef123456`;
    const out = redactSecrets(text, credentials);
    expect(out).not.toContain("fake_credential_abcdef123456");
    expect(out).not.toContain("whsec_9f8e7d6c5b4a");
    expect(out).toContain("[redacted]");
  });

  it("removes secret-shaped text it was never told about", () => {
    const out = redactSecrets("token=abc123XYZ and Authorization: Basic dXNlcjpwYXNzd29yZA== and api_key: zzz999 and ?signature=deadbeef", {});
    for (const leaked of ["abc123XYZ", "dXNlcjpwYXNzd29yZA==", "zzz999", "deadbeef"]) expect(out, leaked).not.toContain(leaked);
  });

  it("removes a private key block, ignores very short values, and truncates", () => {
    expect(redactSecrets("x -----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY----- y", {})).not.toContain("MIIabc");
    expect(redactSecrets("the id is ab", { short: "ab" })).toContain("ab");
    expect(redactSecrets("a".repeat(1000), {}).length).toBeLessThanOrEqual(301);
  });
});

describe("guardAdapter", () => {
  const credentials = { webhookSecret: "whsec_guard_test_value", merchantId: "m-guard" };
  const ctx = { mode: "sandbox" as const, credentials };
  const guarded = guardAdapter(testProvider);
  const order = { orderId: "g1", amountPaise: 1000, currency: "INR" as const, customer: { id: "u", name: "N", email: "n@x.test" }, returnUrl: "r", notifyUrl: "n", expiresAt: new Date() };

  beforeEach(() => testProviderControl.reset());

  it("turns a leaky provider error into a ProviderError without the credentials, the cause or the stack frames", async () => {
    testProviderControl.failWith(`401 from https://api.example.test/orders?token=${credentials.webhookSecret} using secret ${credentials.webhookSecret}`);
    for (const call of [
      () => guarded.createOrder(ctx, order),
      () => guarded.fetchOrder(ctx, "g1"),
      () => guarded.refund(ctx, { orderId: "g1", refundId: "r", amountPaise: 1 }),
      () => guarded.fetchRefund(ctx, { orderId: "g1", refundId: "r" }),
    ]) {
      const error = await call().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      const e = error as ProviderError;
      expect(e.message).not.toContain(credentials.webhookSecret);
      expect(JSON.stringify({ message: e.message, name: e.name, operation: e.operation })).not.toContain("whsec_guard");
      expect((e as { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it("answers { ok: false } — scrubbed — when a credential check blows up, and never throws", async () => {
    testProviderControl.failWith(`bad credentials ${credentials.webhookSecret}`);
    const check = await guarded.verifyCredentials(ctx);
    expect(check.ok).toBe(false);
    expect(JSON.stringify(check)).not.toContain(credentials.webhookSecret);
  });

  it("lets the contract's own OrderTerminalError through untouched", async () => {
    await guarded.createOrder(ctx, order);
    testProviderControl.settle("g1", "paid");
    await expect(guarded.createOrder(ctx, order)).rejects.toBeInstanceOf(OrderTerminalError);
  });

  it("turns a throwing webhook parser into a rejection (null), not a crash", () => {
    const hostile: PaymentProviderAdapter = {
      ...testProvider,
      peekWebhook: () => {
        throw new Error("boom");
      },
      verifyWebhook: () => {
        throw new Error("boom");
      },
    };
    const safe = guardAdapter(hostile);
    expect(safe.peekWebhook("{}")).toBeNull();
    expect(safe.verifyWebhook(ctx, "{}", new Headers())).toBeNull();
  });

  it("refuses a checkout address that is not https on one of the adapter's hosts", async () => {
    const withUrl = (redirectUrl: string): PaymentProviderAdapter => ({ ...testProvider, createOrder: async () => ({ providerOrderId: "p", redirectUrl }) });
    for (const bad of ["http://test-provider.invalid/pay", "https://evil.example/pay", "javascript:alert(1)", "data:text/html,<script>1</script>", "https://test-provider.invalid.evil.example/pay", "https://user:pw@test-provider.invalid/pay", "//test-provider.invalid/pay", "not a url"]) {
      await expect(guardAdapter(withUrl(bad)).createOrder(ctx, order), bad).rejects.toBeInstanceOf(ProviderError);
    }
    await expect(guardAdapter(withUrl("https://test-provider.invalid/pay?o=1")).createOrder(ctx, order)).resolves.toMatchObject({ redirectUrl: "https://test-provider.invalid/pay?o=1" });
    // A drop-in session with no redirect is fine.
    const session: PaymentProviderAdapter = { ...testProvider, createOrder: async () => ({ providerOrderId: "p", sessionId: "s" }) };
    await expect(guardAdapter(session).createOrder(ctx, order)).resolves.toMatchObject({ sessionId: "s" });
  });
});

describe("guardAdapter — a provider that never answers", () => {
  const ctx = { mode: "sandbox" as const, credentials: { webhookSecret: "whsec_timeout_test_1" } };
  const never = <T,>() => new Promise<T>(() => undefined);
  const hung: PaymentProviderAdapter = { ...testProvider, createOrder: () => never(), fetchOrder: () => never(), refund: () => never(), fetchRefund: () => never(), verifyCredentials: () => never() };
  const order = { orderId: "t1", amountPaise: 1000, currency: "INR" as const, customer: { id: "u", name: "N", email: "n@x.test" }, returnUrl: "r", notifyUrl: "n", expiresAt: new Date() };

  it("gives up after the time limit, so a time budget means something", async () => {
    const guarded = guardAdapter(hung, { timeoutMs: 30 });
    const started = Date.now();
    for (const call of [
      () => guarded.createOrder(ctx, order),
      () => guarded.fetchOrder(ctx, "t1"),
      () => guarded.refund(ctx, { orderId: "t1", refundId: "r", amountPaise: 1 }),
      () => guarded.fetchRefund(ctx, { orderId: "t1", refundId: "r" }),
    ]) {
      const error = await call().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).message).toMatch(/no answer from the provider/);
    }
    expect(Date.now() - started).toBeLessThan(2000);
    // A credential check that hangs is "not accepted", not a hang and not a throw.
    expect(await guarded.verifyCredentials(ctx)).toMatchObject({ ok: false });
  });

  it("does not delay an adapter that answers in time", async () => {
    testProviderControl.reset();
    const guarded = guardAdapter(testProvider, { timeoutMs: 5000 });
    await expect(guarded.createOrder(ctx, order)).resolves.toMatchObject({ providerOrderId: "test_t1" });
  });
});

describe("isAllowedRedirect", () => {
  it("matches exact hosts and wildcard subdomains only, on https, on the default port", () => {
    const hosts = ["pay.example.com", "*.checkout.example.org"];
    expect(isAllowedRedirect("https://pay.example.com/x", hosts)).toBe(true);
    expect(isAllowedRedirect("https://PAY.example.com./x", hosts)).toBe(true);
    expect(isAllowedRedirect("https://a.checkout.example.org/x", hosts)).toBe(true);
    expect(isAllowedRedirect("https://a.b.checkout.example.org/x", hosts)).toBe(true);
    expect(isAllowedRedirect("https://checkout.example.org/x", hosts)).toBe(false); // bare domain is not a subdomain
    expect(isAllowedRedirect("https://evilcheckout.example.org/x", hosts)).toBe(false);
    expect(isAllowedRedirect("https://pay.example.com.evil.test/x", hosts)).toBe(false);
    expect(isAllowedRedirect("http://pay.example.com/x", hosts)).toBe(false);
    expect(isAllowedRedirect("https://pay.example.com:8443/x", hosts)).toBe(false);
    expect(isAllowedRedirect("https://pay.example.com:443/x", hosts)).toBe(true);
    expect(isAllowedRedirect("https://pay.example.com/x", [])).toBe(false);
  });
});

/* ───────────── versioned credential encryption ───────────── */

describe("credential encryption — versions and rotation", () => {
  const keyA = Buffer.alloc(32, 11).toString("base64");
  const keyB = Buffer.alloc(32, 22).toString("base64");
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["PAYMENT_SECRET_KEY", "PAYMENT_SECRET_KEYS_PREVIOUS"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** A blob exactly as the first version of this code wrote it: no key id, AAD = fest id. */
  const legacyBlob = (credentials: Record<string, string>, festId: string, base64Key: string): EncryptedBlobV1 => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(base64Key, "base64"), iv);
    cipher.setAAD(Buffer.from(festId, "utf8"));
    const data = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
    return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  };

  it("seals new blobs as v2 with the id of the current key, and the id reveals nothing usable", () => {
    process.env.PAYMENT_SECRET_KEY = keyA;
    const blob = encryptCredentials({ a: "secret-value" }, "fest1");
    expect(blob.v).toBe(2);
    expect(blob.kid).toBe(currentKeyId());
    expect(blob.kid).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(blob)).not.toContain("secret-value");
    expect(isCurrentBlob(blob)).toBe(true);
  });

  it("still opens a legacy v1 blob (no key id), and migrates it to v2 under the current key", () => {
    process.env.PAYMENT_SECRET_KEY = keyA;
    const old = legacyBlob({ webhookSecret: "legacy-secret" }, "fest1", keyA);
    expect(decryptCredentials(old, "fest1")).toEqual({ webhookSecret: "legacy-secret" });
    expect(isCurrentBlob(old)).toBe(false);
    const moved = rewrapBlob(old, "fest1");
    expect(moved.v).toBe(2);
    expect(decryptCredentials(moved, "fest1")).toEqual({ webhookSecret: "legacy-secret" });
    expect(isCurrentBlob(moved)).toBe(true);
  });

  it("rotates: blobs sealed under the old key open while it is on the previous list, and re-seal under the new one", () => {
    process.env.PAYMENT_SECRET_KEY = keyA;
    const sealedUnderA = encryptCredentials({ k: "v-rotating" }, "fest1");
    const legacyUnderA = legacyBlob({ k: "v-legacy" }, "fest2", keyA);

    process.env.PAYMENT_SECRET_KEY = keyB;
    // Rotated but the old key was forgotten: fails closed, with a message that names no key.
    expect(() => decryptCredentials(sealedUnderA, "fest1")).toThrow(PaymentConfigError);
    expect(() => decryptCredentials(legacyUnderA, "fest2")).toThrow(PaymentConfigError);

    process.env.PAYMENT_SECRET_KEYS_PREVIOUS = keyA;
    expect(decryptCredentials(sealedUnderA, "fest1")).toEqual({ k: "v-rotating" });
    expect(decryptCredentials(legacyUnderA, "fest2")).toEqual({ k: "v-legacy" });
    expect(isCurrentBlob(sealedUnderA)).toBe(false);

    const moved = rewrapBlob(sealedUnderA, "fest1");
    expect(isCurrentBlob(moved)).toBe(true);
    // Once re-sealed, the old key is no longer needed.
    delete process.env.PAYMENT_SECRET_KEYS_PREVIOUS;
    expect(decryptCredentials(moved, "fest1")).toEqual({ k: "v-rotating" });
  });

  it("fails closed for the wrong fest, a relabelled key id, tampering, and a missing or malformed key ring", () => {
    process.env.PAYMENT_SECRET_KEY = keyA;
    process.env.PAYMENT_SECRET_KEYS_PREVIOUS = keyB;
    const blob = encryptCredentials({ k: "v" }, "fest1");
    expect(() => decryptCredentials(blob, "fest2")).toThrow(PaymentConfigError);
    // Claiming it was sealed under the other (valid) key must not make it open, and must not be accepted by AAD.
    const relabelled = { ...blob, kid: decryptKidOf(keyB) };
    expect(() => decryptCredentials(relabelled, "fest1")).toThrow(PaymentConfigError);
    expect(() => decryptCredentials({ ...blob, data: Buffer.from("tampered").toString("base64") }, "fest1")).toThrow(PaymentConfigError);
    expect(() => decryptCredentials({ ...blob, v: 3 } as never, "fest1")).toThrow(/Unsupported/);

    process.env.PAYMENT_SECRET_KEYS_PREVIOUS = "not-a-valid-key";
    expect(() => decryptCredentials(blob, "fest1")).toThrow(/32 bytes/);
    delete process.env.PAYMENT_SECRET_KEY;
    expect(() => decryptCredentials(blob, "fest1")).toThrow(/not set/);
  });

  it("never puts a key, a credential or a ciphertext in an error", () => {
    process.env.PAYMENT_SECRET_KEY = keyA;
    const blob = encryptCredentials({ k: "do-not-leak-me" }, "fest1");
    process.env.PAYMENT_SECRET_KEY = keyB;
    try {
      decryptCredentials(blob, "fest1");
    } catch (error) {
      const text = String((error as Error).message) + String((error as Error).stack);
      for (const forbidden of [keyA, keyB, "do-not-leak-me", blob.data, blob.iv, blob.tag]) expect(text).not.toContain(forbidden);
    }
  });
});

// The key id is the first 8 hex of SHA-256 of the key bytes; spelled out here so the test does not import the private helper.
import { createHash } from "node:crypto";
const decryptKidOf = (base64Key: string): string => createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex").slice(0, 8);

/* ───────────── binding a payment to the merchant account ───────────── */

describe("bindingProblem", () => {
  const account: StoredAccount = { festId: "f", provider: "test", mode: "sandbox", status: "active", credentialsVersion: 3, merchantId: "m-1" };
  const pay = { provider: "test", mode: "sandbox", credentialsVersion: 3, merchantId: "m-1" };

  it("records provider, mode, version and merchant when a payment is created", () => {
    expect(accountBinding(account)).toEqual({ provider: "test", mode: "sandbox", credentialsVersion: 3, merchantId: "m-1" });
    expect(accountBinding({ ...account, credentialsVersion: undefined, merchantId: undefined })).toEqual({ provider: "test", mode: "sandbox", credentialsVersion: 0 });
  });

  it("is fine when nothing changed", () => {
    expect(bindingProblem(pay, account)).toBeNull();
  });

  it("is fine when credentials were rotated within the same merchant", () => {
    expect(bindingProblem({ ...pay, credentialsVersion: 1 }, account)).toBeNull();
  });

  it("is a problem when the merchant changed, or cannot be shown to be the same", () => {
    expect(bindingProblem({ ...pay, credentialsVersion: 1, merchantId: "m-OTHER" }, account)).toBe("credentials_changed");
    expect(bindingProblem({ provider: "test", mode: "sandbox", credentialsVersion: 1 }, account)).toBe("credentials_changed"); // payment has no merchant on record
    expect(bindingProblem({ ...pay, credentialsVersion: 1 }, { ...account, merchantId: undefined })).toBe("credentials_changed"); // account has none
  });

  it("is a problem whenever provider or mode differs, even at the same version", () => {
    expect(bindingProblem({ ...pay, mode: "live" }, account)).toBe("mode_changed");
    expect(bindingProblem({ ...pay, provider: "other" }, account)).toBe("provider_changed");
  });

  it("treats payments and accounts that predate versioning as version 0", () => {
    expect(bindingProblem({ provider: "test", mode: "sandbox" }, { ...account, credentialsVersion: undefined, merchantId: undefined })).toBeNull();
    expect(bindingProblem({ provider: "test", mode: "sandbox" }, account)).toBe("credentials_changed");
  });
});
