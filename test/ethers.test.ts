import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentNetwork, VerifiedStorageQuote } from "../src/types.js";

const state = vi.hoisted(() => ({
  chainId: 31337n,
  providers: 0,
  providerUrls: [] as string[],
  allowance: 1_000n,
  failPopulation: false,
  nonces: [] as number[],
  submissions: [] as string[],
  waits: [] as Array<{ resolve: (receipt: unknown) => void; reject: (error: unknown) => void }>,
}));

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  class JsonRpcProvider {
    constructor(url: string) { state.providers++; state.providerUrls.push(url); }
    async getNetwork() { return { chainId: state.chainId }; }
    async getTransactionReceipt() { return { status: 1, logs: [] }; }
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
  chainId: 31337,
  paymentTokenAddress: `0x${"11".repeat(20)}`,
  paymentVaultAddress: `0x${"22".repeat(20)}`,
};
const quotes: VerifiedStorageQuote[] = [{
  quote: {}, quoteHash: "33".repeat(32), rewardsAddress: `0x${"44".repeat(20)}`, amount: "1",
}];
const provider = () => createEthersPaymentProvider({ privateKey: `0x${"55".repeat(32)}`, rpcUrl: "http://127.0.0.1:8545/" });
const context = () => ({ submitted: vi.fn(), report: vi.fn() });
async function waiting() { await vi.waitFor(() => expect(state.waits.length).toBeGreaterThan(0)); }
function confirm(hash = "0xconfirmed") { state.waits.shift()!.resolve({ status: 1, hash }); }
function replace(reason: "repriced" | "cancelled" | "replaced", status = 1) {
  state.waits.shift()!.reject(Object.assign(new Error("transaction replaced"), {
    code: "TRANSACTION_REPLACED", reason, cancelled: reason !== "repriced",
    receipt: { status, hash: "0xreplacement" },
  }));
}
beforeEach(() => {
  state.chainId = 31337n;
  state.providers = 0; state.allowance = 1_000n; state.failPopulation = false;
  state.providerUrls.length = 0;
  state.nonces.length = 0; state.submissions.length = 0; state.waits.length = 0;
});

describe("Ethers payments", () => {
  it("requires an application-owned RPC for private-key payments", () => {
    // JavaScript consumers also receive a useful error for the removed default.
    // @ts-expect-error rpcUrl is required for private-key payments.
    expect(() => createEthersPaymentProvider({ privateKey: `0x${"55".repeat(32)}` }))
      .toThrow("Provide rpcUrl with privateKey");
    expect(state.providers).toBe(0);
  });

  it("uses the application's RPC endpoint for private-key payments", async () => {
    const rpcUrl = "https://application.example/rpc";
    const payment = createEthersPaymentProvider({ privateKey: `0x${"55".repeat(32)}`, rpcUrl });
    const pending = payment.pay(network, quotes, context());
    await waiting();
    expect(state.providerUrls).toEqual([rpcUrl]);
    confirm();
    await pending;
  });

  it("rejects a private-key provider on a different chain before submitting", async () => {
    state.chainId = 1n;
    await expect(provider().pay(network, quotes, context())).rejects.toThrow("switch to payment chain 31337");
    expect(state.submissions).toEqual([]);
  });

  it("checks a resolved signer's chain independently of the application", async () => {
    const payment = createEthersPaymentProvider({
      getSigner: () => ({ provider: { getNetwork: async () => ({ chainId: 1n }) } }) as unknown as import("ethers").Signer,
    });
    await expect(payment.pay(network, quotes, context())).rejects.toThrow("switch to payment chain 31337");
    expect(state.submissions).toEqual([]);
  });

  it("requires a provider on resolved signers to verify the chain", async () => {
    const payment = createEthersPaymentProvider({ getSigner: () => ({ provider: null }) as unknown as import("ethers").Signer });
    await expect(payment.pay(network, quotes, context())).rejects.toThrow("must be connected to a provider");
    expect(state.submissions).toEqual([]);
  });

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
      signal: controller.signal, submitted() {}, report: () => controller.abort(),
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

it("reports broadcast evidence and retries confirmation without another transaction", async () => {
  const ctx = context();
  const pending = provider().pay(network, quotes, ctx);
  const rejected = expect(pending).rejects.toThrow("RPC timeout");
  await waiting();
  const submission = ctx.submitted.mock.calls[0]![0] as import("../src/types.js").PaymentSubmission;
  expect(submission.transactionHash).toBe("0xtransaction1");
  state.waits.shift()!.reject(new Error("RPC timeout"));
  await rejected;
  const confirmation = submission.wait();
  await waiting(); confirm("0xtransaction1");
  await expect(confirmation).resolves.toMatchObject({ status: "confirmed", receipt: { transactionHash: "0xtransaction1" } });
  expect(state.submissions).toEqual(["payForQuotes"]);
});

it("submits native Merkle calldata and retains the decoded actual settlement", async () => {
  const request = { calldata: "0xabcdef", maximumAmount: "100", depth: 2, timestamp: 42, poolHashes: ["ab".repeat(32)] };
  const decodeReceipt = vi.fn(() => ({ winnerPoolHash: request.poolHashes[0]!, totalAmount: "70" }));
  const ctx = { ...context(), decodeReceipt };
  const pending = provider().payMerkle!(network, request, ctx);
  await waiting();
  expect(state.submissions).toEqual([request.calldata]);
  confirm();
  const receipt = await pending;
  expect(receipt.totalAmount).toBe("70");
  expect(receipt.winnerPoolHash).toBe(request.poolHashes[0]);
  expect(decodeReceipt).toHaveBeenCalledWith([]);
  const submission = ctx.submitted.mock.calls[0]![0];
  expect((await submission.wait()).receipt).toEqual(receipt);
});

it("recovers a persisted transaction by reading its calldata and receipt without sending", async () => {
  const { Interface } = await import("ethers");
  const abi = new Interface(["function payForQuotes((address rewardsAddress,uint256 amount,bytes32 quoteHash)[] payments)"]);
  const hash = `0x${"ab".repeat(32)}`;
  const reads = {
    getNetwork: vi.fn(async () => ({ chainId: BigInt(network.chainId) })),
    getTransaction: vi.fn(async () => ({ to: network.paymentVaultAddress, chainId: BigInt(network.chainId),
      data: abi.encodeFunctionData("payForQuotes", [quotes.map(quote => ({ ...quote, quoteHash: `0x${quote.quoteHash}` }))]) })),
    getTransactionReceipt: vi.fn(async () => ({ status: 1 })),
  };
  const sendTransaction = vi.fn(() => { throw new Error("must not broadcast"); });
  const payment = createEthersPaymentProvider({ getSigner: () => ({ provider: reads, sendTransaction }) as unknown as import("ethers").Signer });
  const result = await payment.recover!(network, quotes, { submissions: [{ transactionHash: hash }] }, { report: vi.fn() });
  expect(result).toMatchObject({ transactionHash: hash, totalAmount: "1" });
  expect(sendTransaction).not.toHaveBeenCalled();
  reads.getTransactionReceipt.mockResolvedValue({ status: 0 });
  await expect(payment.recover!(network, quotes, { submissions: [{ transactionHash: hash }] }, { report: vi.fn() })).rejects.toThrow(/unconfirmed/);
  expect(sendTransaction).not.toHaveBeenCalled();
});
