// @vitest-environment node
import { afterAll, beforeAll } from "vitest";
import { guardAdapter } from "@/server/payments/providers/safe";
import { testProvider, testProviderControl } from "@/server/payments/providers/test-provider";
import { adapterContract } from "./support/adapter-contract";

/**
 * The contract every adapter must pass, run against the test provider — both
 * bare and wrapped in the safe layer the application actually uses — so that
 * the wrapper is proven not to change a conforming adapter's behaviour.
 *
 * A real adapter is added here with a harness that targets that provider's
 * sandbox (and nothing else) once its documentation has been checked.
 */

const WEBHOOK_SECRET = "whsec_contract_suite";
const good = { webhookSecret: WEBHOOK_SECRET, merchantId: "contract-merchant" };
const bad = { webhookSecret: "x1y2z3" };

const harness = (name: string, adapter = testProvider) => ({
  name,
  adapter,
  mode: "sandbox" as const,
  goodCredentials: good,
  badCredentials: bad,
  reset: () => testProviderControl.reset(),
  pay: (orderId: string) => testProviderControl.settle(orderId, "paid"),
  signedWebhook: (body: Record<string, unknown>) => testProviderControl.signedWebhook(body, WEBHOOK_SECRET),
});

let saved: string | undefined;
beforeAll(() => {
  saved = process.env.PAYMENTS_ALLOW_TEST_PROVIDER;
});
afterAll(() => {
  if (saved === undefined) delete process.env.PAYMENTS_ALLOW_TEST_PROVIDER;
  else process.env.PAYMENTS_ALLOW_TEST_PROVIDER = saved;
});

adapterContract(harness("test provider (bare)"));
adapterContract(harness("test provider (through the safe layer)", guardAdapter(testProvider)));
