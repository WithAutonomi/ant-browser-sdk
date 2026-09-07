import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentNetwork, VerifiedStorageQuote } from "../src/types.js";

const state = vi.hoisted(() => ({
  providers: 0,
  allowance: 1_000n,
  failPopulation: false,
  nonces: [] as number[],
  submissions: [] as string[],
  waits: [] as Array<{ resolve: (receipt: unknown) => void; reject: (error: unknown) => void }>,
}));

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  class JsonRpcProvider {
    constructor() { state.providers++; }
    async getTransactionCount() { return state.nonces.length; }
  }
  class Wallet {
    constructor(_key: string, readonly provider: JsonRpcProvider) {}
    async getAddress() { return `0x${"aa".repeat(20)}`; }
    async populateTransaction(tx: unknown) {
      if (state.failPopulation) {
        state.failPopulation = false;
        throw new Error("gas estimation failed");
      }
      return tx;
    }
    async sendTransaction(tx: { nonce: number; data: string }) {
      state.nonces.push(tx.nonce);
      state.submissions.push(tx.data);
      const hash = `0xtransaction${state.submissions.length}`;
      return {
        hash,
        wait: () => new Promise((resolve, reject) => state.waits.push({ resolve, reject })),
      };
    }
  }
  class Contract {
    constructor(_address: string, _abi: unknown, private signer: import("ethers").NonceManager) {}
    getFunction(name: string) {
      if (name === "allowance") return async () => state.allowance;
      return async () => this.signer.sendTransaction({ data: name });
    }
  }
  return { ...actual, JsonRpcProvider, Wallet, Contract };
});

import { createEthersPaymentProvider } from "../src/ethers.js";

const network: PaymentNetwork = {
  rpc_url: "http://127.0.0.1:8545/",
  payment_token_address: `0x${"11".repeat(20)}`,
  payment_vault_address: `0x${"22".repeat(20)}`,
};
const quotes: VerifiedStorageQuote[] = [{
  quote: {}, quoteHash: "33".repeat(32), rewardsAddress: `0x${"44".repeat(20)}`, amount: "1",
}];
const provider = () => createEthersPaymentProvider({ privateKey: `0x${"55".repeat(32)}` });
const context = () => ({ report: vi.fn() });
async function waiting() { await vi.waitFor(() => expect(state.waits.length).toBeGreaterThan(0)); }
function confirm(hash = "0xconfirmed") { state.waits.shift()!.resolve({ status: 1, hash }); }
function replace(reason: "repriced" | "cancelled" | "replaced", status = 1) {
  state.waits.shift()!.reject(Object.assign(new Error("transaction replaced"), {
    code: "TRANSACTION_REPLACED", reason, cancelled: reason !== "repriced",
    receipt: { status, hash: "0xreplacement" },
  }));
}
beforeEach(() => {
  state.providers = 0; state.allowance = 1_000n; state.failPopulation = false;
  state.nonces.length = 0; state.submissions.length = 0; state.waits.length = 0;
});

describe("Ethers payments", () => {
  it("serializes private-key payments and reloads sequential nonces", async () => {
    const payment = provider();
    const first = payment.pay(network, quotes, context());
    const second = payment.pay(network, quotes, context());
    await waiting();
    expect(state.submissions).toEqual(["payForQuotes"]);
    confirm("0xfirst");
    await expect(first).resolves.toMatchObject({ transactionHash: "0xfirst" });
    await waiting();
    confirm("0xsecond");
    await expect(second).resolves.toMatchObject({ transactionHash: "0xsecond" });
    expect(state.providers).toBe(1);
    expect(state.nonces).toEqual([0, 1]);
  });
  it("retries nonce zero after a pre-broadcast estimation failure", async () => {
    const payment = provider();
    state.failPopulation = true;
    await expect(payment.pay(network, quotes, context())).rejects.toThrow("gas estimation failed");
    const retry = payment.pay(network, quotes, context());
    await waiting();
    expect(state.nonces).toEqual([0]);
    confirm();
    await retry;
  });
  it("accepts successful repricing for approval and storage payment", async () => {
    state.allowance = 0n;
    const pending = provider().pay(network, quotes, context());
    await waiting();
    replace("repriced");
    await waiting();
    replace("repriced");
    await expect(pending).resolves.toMatchObject({ transactionHash: "0xreplacement", totalAmount: "1" });
    expect(state.submissions).toEqual(["approve", "payForQuotes"]);
  });
  it.each(["cancelled", "replaced"] as const)("rejects a %s transaction", async (reason) => {
    const pending = provider().pay(network, quotes, context());
    const rejection = expect(pending).rejects.toMatchObject({ reason });
    await waiting();
    replace(reason);
    await rejection;
  });
  it("rejects a reverted replacement", async () => {
    const pending = provider().pay(network, quotes, context());
    const rejection = expect(pending).rejects.toMatchObject({ receipt: { status: 0 } });
    await waiting(); replace("repriced", 0); await rejection;
  });
  it.each([0n, 1_000n])("does not submit after a progress callback aborts (allowance %s)", async (allowance) => {
    state.allowance = allowance;
    const controller = new AbortController();
    await expect(provider().pay(network, quotes, {
      signal: controller.signal, report: () => controller.abort(),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(state.submissions).toEqual([]);
  });
  it("keeps an in-flight receipt and the queue after cancellation", async () => {
    const payment = provider();
    const controller = new AbortController();
    const first = payment.pay(network, quotes, { ...context(), signal: controller.signal });
    await waiting(); controller.abort();
    const second = payment.pay(network, quotes, context());
    expect(state.submissions).toHaveLength(1);
    confirm("0xpaid-after-abort");
    await expect(first).resolves.toMatchObject({ transactionHash: "0xpaid-after-abort" });
    await waiting(); confirm(); await second;
  });
  it("stops after approval confirms if cancelled while approval was pending", async () => {
    state.allowance = 0n;
    const controller = new AbortController();
    const pending = provider().pay(network, quotes, { ...context(), signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await waiting(); controller.abort(); confirm(); await rejection;
    expect(state.submissions).toEqual(["approve"]);
  });
});
