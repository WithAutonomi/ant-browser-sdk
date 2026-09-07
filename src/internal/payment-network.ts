import type { PaymentNetwork } from "../types.js";

/** Public payment identity in the shared node/WASM protocol. */
export type CorePaymentNetwork = Omit<PaymentNetwork, "chainId"> & { chain_id: number };

export function corePaymentNetwork(network: PaymentNetwork): CorePaymentNetwork {
  return {
    chain_id: network.chainId,
    payment_token_address: network.payment_token_address,
    payment_vault_address: network.payment_vault_address,
  };
}

/** Restore the pinned identity only for the configuration passed to the core. */
export function paymentNetworkFromCore(value: unknown, expected: PaymentNetwork): PaymentNetwork {
  if (typeof value !== "object" || value === null) {
    throw new Error("The core requested payment with an invalid network configuration");
  }
  const network = value as Record<string, unknown>;
  for (const [key, configuredValue] of Object.entries(corePaymentNetwork(expected))) {
    if (network[key] !== configuredValue) {
      throw new Error("The core requested payment on a different network configuration");
    }
  }
  return expected;
}

export function assertPaymentChainId(chainId: number): void {
  if (!Number.isSafeInteger(chainId) || chainId < 0) {
    throw new TypeError("Payment chainId must be a non-negative safe integer");
  }
}
