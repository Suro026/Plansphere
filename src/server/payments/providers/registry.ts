import type { PaymentProviderId } from "@/core/models/payment";
import { testProviderAllowed } from "../config";
import { guardAdapter } from "./safe";
import { testProvider } from "./test-provider";
import type { PaymentProviderAdapter } from "./types";

/**
 * The gateways this deployment can talk to.
 *
 * No real gateway is registered. Adding one is deliberately a separate step
 * that happens only after its account model, KYC, fees and settlement have been
 * verified with the provider (docs/payments-implementation.md, "Before
 * activation"): write one adapter file, import it here, nothing else changes.
 *
 * In production the list is therefore empty, which is what keeps live payment
 * processing off.
 */
export const getAdapter = (id: string): PaymentProviderAdapter | null => {
  if (id === "test" && testProviderAllowed()) return testProvider;
  return null;
};

/**
 * The adapter wrapped in the safe layer (errors scrubbed of credentials,
 * checkout URLs validated). Application code uses this, never `getAdapter`.
 */
const guarded = new Map<string, PaymentProviderAdapter>();
export const getSafeAdapter = (id: string): PaymentProviderAdapter | null => {
  const raw = getAdapter(id);
  if (!raw) return null;
  let safe = guarded.get(raw.id);
  if (!safe) {
    safe = guardAdapter(raw);
    guarded.set(raw.id, safe);
  }
  return safe;
};

export const availableProviders = (): PaymentProviderAdapter[] => {
  const out: PaymentProviderAdapter[] = [];
  if (testProviderAllowed()) out.push(testProvider);
  return out;
};

export const isProviderId = (value: string): value is PaymentProviderId => value === "test";
