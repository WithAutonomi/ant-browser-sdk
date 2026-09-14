import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentNetwork, VerifiedStorageQuote } from "../src/types.js";

const mocks = vi.hoisted(() => ({
  getChainId: vi.fn(),
  getConnectorClient: vi.fn(),
  getPublicClient: vi.fn(),
  readContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  writeContract: vi.fn(),
  sendTransaction: vi.fn(),
}));

vi.mock("@wagmi/core", () => ({
  getConnectorClient: mocks.getConnectorClient,
  getPublicClient: mocks.getPublicClient,
}));

vi.mock("viem/actions", () => ({
  readContract: mocks.readContract,
  waitForTransactionReceipt: mocks.waitForTransactionReceipt,
  writeContract: mocks.writeContract,
  sendTransaction: mocks.sendTransaction,
}));

import { createWagmiPaymentProvider } from "../src/wagmi.js";

const walletAddress = `0x${"33".repeat(20)}`;
const network: PaymentNetwork = {
  chainId: 42161,
  paymentTokenAddress: `0x${"11".repeat(20)}`,
  paymentVaultAddress: `0x${"22".repeat(20)}`,
};
const quotes: VerifiedStorageQuote[] = [
  {
    quote: {},
    quoteHash: "44".repeat(32),
    rewardsAddress: `0x${"55".repeat(20)}`,
    amount: "42",
  },
];
const config = {} as Parameters<typeof createWagmiPaymentProvider>[0]["config"];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getChainId.mockResolvedValue(42161);
  mocks.getConnectorClient.mockResolvedValue({
    account: { address: walletAddress },
    chain: { id: 42161 },
  });
  mocks.getPublicClient.mockReturnValue({ getChainId: mocks.getChainId });
  mocks.readContract.mockResolvedValue(0n);
  mocks.writeContract
    .mockResolvedValueOnce(`0x${"66".repeat(32)}`)
    .mockResolvedValueOnce(`0x${"77".repeat(32)}`);
  mocks.waitForTransactionReceipt
    .mockResolvedValueOnce({
      status: "success",
      transactionHash: `0x${"66".repeat(32)}`,
    })
    .mockResolvedValueOnce({
      status: "success",
      transactionHash: `0x${"77".repeat(32)}`,
    });
});

describe("createWagmiPaymentProvider", () => {
  it("requires an application-configured public client for the advertised chain", async () => {
    mocks.getPublicClient.mockReturnValue(undefined);
    await expect(createWagmiPaymentProvider({ config }).pay(network, quotes, { submitted() {}, report() {} }))
      .rejects.toThrow("Configure a Wagmi public client for payment chain 42161");
    expect(mocks.getConnectorClient).not.toHaveBeenCalled();
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });

  it("rejects an RPC and wallet that moved together to a different chain", async () => {
    mocks.getChainId.mockResolvedValue(1);
    mocks.getConnectorClient.mockResolvedValue({ account: { address: walletAddress }, chain: { id: 1 } });
    await expect(createWagmiPaymentProvider({ config }).pay(network, quotes, { submitted() {}, report() {} }))
      .rejects.toThrow("expected payment chain 42161");
    expect(mocks.readContract).not.toHaveBeenCalled();
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });

  it("approves and pays verified quotes with the active Wagmi connector", async () => {
    const report = vi.fn();
    const payment = createWagmiPaymentProvider({ config, approval: "exact" });

    const receipt = await payment.pay(network, quotes, { submitted() {}, report });

    expect(mocks.getPublicClient).toHaveBeenCalledWith(config, { chainId: network.chainId });
    expect(mocks.getConnectorClient).toHaveBeenCalledWith(config);
    expect(mocks.readContract).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        address: network.paymentTokenAddress,
        functionName: "allowance",
        args: [walletAddress, network.paymentVaultAddress],
      }),
    );
    expect(mocks.writeContract).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        functionName: "approve",
        args: [network.paymentVaultAddress, 42n],
      }),
    );
    expect(mocks.writeContract).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        address: network.paymentVaultAddress,
        functionName: "payForQuotes",
        args: [
          [
            {
              rewardsAddress: quotes[0]!.rewardsAddress,
              amount: 42n,
              quoteHash: `0x${quotes[0]!.quoteHash}`,
            },
          ],
        ],
      }),
    );
    expect(receipt).toEqual({
      transactionHash: `0x${"77".repeat(32)}`,
      walletAddress,
      totalAmount: "42",
    });
    expect(report).toHaveBeenLastCalledWith(
      `Payment confirmed in 0x${"77".repeat(32)}`,
    );
  });

  it("skips approval when the existing allowance covers the payment", async () => {
    mocks.readContract.mockResolvedValue(100n);
    mocks.writeContract.mockReset().mockResolvedValue(`0x${"77".repeat(32)}`);
    mocks.waitForTransactionReceipt.mockReset().mockResolvedValue({
      status: "success",
      transactionHash: `0x${"77".repeat(32)}`,
    });
    const payment = createWagmiPaymentProvider({ config });

    await payment.pay(network, quotes, { submitted: vi.fn(), report: vi.fn() });

    expect(mocks.writeContract).toHaveBeenCalledOnce();
    expect(mocks.writeContract).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ functionName: "payForQuotes" }),
    );
  });

  it("rejects a connected wallet on a different payment chain", async () => {
    mocks.getConnectorClient.mockResolvedValue({
      account: { address: walletAddress },
      chain: { id: 1 },
    });
    const payment = createWagmiPaymentProvider({ config });

    await expect(payment.pay(network, quotes, { submitted: vi.fn(), report: vi.fn() })).rejects.toThrow(
      "switch to payment chain 42161",
    );
    expect(mocks.readContract).not.toHaveBeenCalled();
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });
});


describe("Wagmi replacement and cancellation handling", () => {
  it.each(["cancelled", "replaced"])("rejects a successful %s replacement receipt", async (reason) => {
    mocks.readContract.mockResolvedValue(100n);
    mocks.waitForTransactionReceipt.mockReset().mockImplementation(async (_client, options) => {
      options.onReplaced({ reason });
      return { status: "success", transactionHash: "0xcancellation" };
    });
    await expect(createWagmiPaymentProvider({ config }).pay(network, quotes, { submitted() {}, report() {} }))
      .rejects.toThrow("cancelled or replaced");
  });
  it("uses the replacement hash after repricing approval and payment", async () => {
    mocks.waitForTransactionReceipt.mockReset().mockImplementation(async (_client, options) => {
      options.onReplaced({ reason: "repriced" });
      return { status: "success", transactionHash: "0xrepriced" };
    });
    await expect(createWagmiPaymentProvider({ config }).pay(network, quotes, { submitted() {}, report() {} }))
      .resolves.toMatchObject({ transactionHash: "0xrepriced" });
    expect(mocks.writeContract).toHaveBeenCalledTimes(2);
  });
  it("does no work for an already aborted context", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createWagmiPaymentProvider({ config }).pay(network, quotes, {
      submitted() {}, report() {}, signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.getConnectorClient).not.toHaveBeenCalled();
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });
  it.each([0n, 100n])("checks cancellation after reporting (allowance %s)", async (allowance) => {
    mocks.readContract.mockResolvedValue(allowance);
    const controller = new AbortController();
    await expect(createWagmiPaymentProvider({ config }).pay(network, quotes, {
      submitted() {}, report: () => controller.abort(), signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });
  it("does not pay after cancellation during approval confirmation", async () => {
    const controller = new AbortController();
    mocks.waitForTransactionReceipt.mockReset().mockImplementation(async () => {
      controller.abort(); return { status: "success", transactionHash: "0xapproval" };
    });
    await expect(createWagmiPaymentProvider({ config }).pay(network, quotes, {
      submitted() {}, report() {}, signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.writeContract).toHaveBeenCalledOnce();
  });
});

it("retries a submitted storage transaction after an RPC timeout without rebroadcast", async () => {
  mocks.readContract.mockResolvedValue(100n);
  mocks.waitForTransactionReceipt.mockReset().mockRejectedValueOnce(new Error("RPC timeout"))
    .mockResolvedValue({ status: "success", transactionHash: "0xconfirmed" });
  const submitted = vi.fn();
  await expect(createWagmiPaymentProvider({ config }).pay(network, quotes, { submitted, report() {} }))
    .rejects.toThrow("RPC timeout");
  const submission = submitted.mock.calls[0]![0] as import("../src/types.js").PaymentSubmission;
  await expect(submission.wait()).resolves.toMatchObject({ status: "confirmed" });
  expect(mocks.writeContract).toHaveBeenCalledOnce();
  expect(mocks.waitForTransactionReceipt).toHaveBeenCalledTimes(2);
  expect(mocks.waitForTransactionReceipt.mock.calls[1]![1].hash).toBe(submission.transactionHash);
});

it("submits Rust Merkle calldata and decodes the confirmed vault receipt", async () => {
  const request = { calldata: "0xabcdef", maximumAmount: "100", depth: 2, timestamp: 42, poolHashes: ["ab".repeat(32)] };
  mocks.readContract.mockResolvedValue(100n);
  mocks.sendTransaction.mockResolvedValue(`0x${"77".repeat(32)}`);
  mocks.waitForTransactionReceipt.mockReset().mockResolvedValue({ status: "success", transactionHash: `0x${"77".repeat(32)}` });
  mocks.getPublicClient.mockReturnValue({ getChainId: mocks.getChainId, getTransactionReceipt: async () => ({ logs: [] }) });
  const decodeReceipt = vi.fn(() => ({ winnerPoolHash: request.poolHashes[0]!, totalAmount: "70" }));
  const receipt = await createWagmiPaymentProvider({ config }).payMerkle!(network, request, { report() {}, submitted() {}, decodeReceipt });
  expect(mocks.sendTransaction).toHaveBeenCalledWith(expect.anything(), { to: network.paymentVaultAddress, data: request.calldata });
  expect(mocks.writeContract).not.toHaveBeenCalled();
  expect(receipt.totalAmount).toBe("70");
  expect(receipt.winnerPoolHash).toBe(request.poolHashes[0]);
});

it("recovers confirmed quote payments from the journal without requesting a wallet", async () => {
  const { encodeFunctionData, parseAbi } = await import("viem");
  const abi = parseAbi(["function payForQuotes((address rewardsAddress,uint256 amount,bytes32 quoteHash)[] payments)"]);
  const transactionHash = `0x${"ab".repeat(32)}`;
  const receipt = vi.fn(async () => ({ status: "success" }));
  mocks.getPublicClient.mockReturnValue({ getChainId: mocks.getChainId,
    getTransactionReceipt: receipt,
    getTransaction: vi.fn(async () => ({ to: network.paymentVaultAddress,
      input: encodeFunctionData({ abi, functionName: "payForQuotes", args: [quotes.map(quote => ({
        rewardsAddress: quote.rewardsAddress as `0x${string}`, amount: BigInt(quote.amount), quoteHash: `0x${quote.quoteHash}` as `0x${string}`,
      }))] }),
    })),
  });
  const payment = createWagmiPaymentProvider({ config });
  const attempt = { submissions: [{ transactionHashes: { [quotes[0]!.quoteHash]: transactionHash }, totalAmount: "malformed" }] };
  await expect(payment.recover!(network, quotes, attempt, { report() {} })).resolves.toMatchObject({ transactionHash, totalAmount: "42" });
  receipt.mockResolvedValue({ status: "reverted" });
  await expect(payment.recover!(network, quotes, attempt, { report() {} })).rejects.toThrow(/outcome unknown/);
  expect(mocks.getConnectorClient).not.toHaveBeenCalled();
  expect(mocks.writeContract).not.toHaveBeenCalled();
  expect(mocks.sendTransaction).not.toHaveBeenCalled();
});
