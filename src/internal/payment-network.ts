import type { PaymentNetwork } from "../types.js";
import { abortable, throwIfAborted } from "./abort.js";

/** The current node/WASM protocol does not carry the SDK's chain identity. */
export type CorePaymentNetwork = Omit<PaymentNetwork, "chainId">;

export function corePaymentNetwork(network: PaymentNetwork): CorePaymentNetwork {
  return {
    rpc_url: network.rpc_url,
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

/** Resolve chain identity without adding a wallet dependency to the core package. */
export async function resolvePaymentNetwork(
  network: CorePaymentNetwork,
  signal?: AbortSignal,
): Promise<PaymentNetwork> {
  throwIfAborted(signal);
  const response = await abortable(fetch(network.rpc_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    ...(signal ? { signal } : {}),
  }), signal);
  if (!response.ok) throw new Error(`Could not resolve the payment chain (HTTP ${response.status})`);
  const payload: unknown = await abortable(response.json(), signal);
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Payment RPC returned an invalid eth_chainId response");
  }
  const rpc = payload as Record<string, unknown>;
  if (rpc.jsonrpc !== "2.0" || rpc.id !== 1 || "error" in rpc ||
      typeof rpc.result !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(rpc.result)) {
    throw new Error("Payment RPC returned an invalid eth_chainId response");
  }
  const chainId = Number(BigInt(rpc.result));
  assertPaymentChainId(chainId);
  return { ...network, chainId };
}
