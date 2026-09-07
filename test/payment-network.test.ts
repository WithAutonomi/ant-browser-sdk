import { expect, it } from "vitest";
import {
  assertPaymentChainId, corePaymentNetwork, paymentNetworkFromCore,
} from "../src/internal/payment-network.js";

const network = Object.freeze({
  chainId: 31337,
  payment_token_address: `0x${"11".repeat(20)}`,
  payment_vault_address: `0x${"22".repeat(20)}`,
});

it.each([0, 42161, Number.MAX_SAFE_INTEGER])("accepts precise chain ID %s", (chainId) => {
  expect(() => assertPaymentChainId(chainId)).not.toThrow();
});
it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])("rejects invalid chain ID %s", (chainId) => {
  expect(() => assertPaymentChainId(chainId)).toThrow();
});
it("passes only chain identity and contracts to the core and restores the SDK representation", () => {
  const core = corePaymentNetwork(network);
  expect(core).toEqual({
    chain_id: 31337,
    payment_token_address: network.payment_token_address,
    payment_vault_address: network.payment_vault_address,
  });
  expect(core).not.toHaveProperty("rpc_url");
  expect(paymentNetworkFromCore(core, network)).toBe(network);
  expect(() => paymentNetworkFromCore(null, network)).toThrow("invalid network");
  for (const changed of [
    { ...core, chain_id: 1 },
    { ...core, payment_token_address: `0x${"33".repeat(20)}` },
    { ...core, payment_vault_address: `0x${"44".repeat(20)}` },
  ]) {
    expect(() => paymentNetworkFromCore(changed, network)).toThrow("different network");
  }
});
