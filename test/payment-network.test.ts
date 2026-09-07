import { afterEach, expect, it, vi } from "vitest";
import {
  corePaymentNetwork, paymentNetworkFromCore, resolvePaymentNetwork,
} from "../src/internal/payment-network.js";

const advertised = {
  rpc_url: "https://rpc.example/",
  payment_token_address: `0x${"11".repeat(20)}`,
  payment_vault_address: `0x${"22".repeat(20)}`,
};
afterEach(() => vi.unstubAllGlobals());

it.each([["0x0", 0], ["0xa4b1", 42161], ["0x1fffffffffffff", Number.MAX_SAFE_INTEGER]])(
  "resolves the RPC's hexadecimal chain ID %s",
  async (result, chainId) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result })));
    expect(await resolvePaymentNetwork(advertised)).toEqual({ ...advertised, chainId });
  },
);

it.each(["1", "0x", "0x01", "0x-1", "0x20000000000000", 1, null])(
  "rejects malformed or imprecise chain IDs: %s",
  async (result) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result })));
    await expect(resolvePaymentNetwork(advertised)).rejects.toThrow();
  },
);

it.each([
  { jsonrpc: "2.0", id: 1, error: { code: -32601 } },
  { jsonrpc: "2.0", id: 2, result: "0x1" },
  { id: 1, result: "0x1" },
  null,
])("rejects an unsuccessful or unrelated RPC response: %j", async (payload) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
  await expect(resolvePaymentNetwork(advertised)).rejects.toThrow("invalid eth_chainId response");
});

it("rejects HTTP failures even if their bodies contain a chain ID", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }, { status: 503 })));
  await expect(resolvePaymentNetwork(advertised)).rejects.toThrow("HTTP 503");
});

it("preserves the core wire format and restores the pinned chain for payment callbacks", () => {
  const network = Object.freeze({ ...advertised, chainId: 31337 });
  const core = corePaymentNetwork(network);
  expect(core).toEqual(advertised);
  expect(core).not.toHaveProperty("chainId");
  expect(paymentNetworkFromCore(core, network)).toBe(network);
  expect(() => paymentNetworkFromCore({ ...core, rpc_url: "https://another.example/" }, network)).toThrow("different network");
  expect(() => paymentNetworkFromCore(null, network)).toThrow("invalid network");
});
