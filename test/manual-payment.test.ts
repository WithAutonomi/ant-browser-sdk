import { beforeEach, describe, expect, it, vi } from "vitest";
import { createManualPaymentProvider } from "../src/manual-payment.js";
import type {
  ManualPaymentRequest,
} from "../src/manual-payment.js";
import type {
  PaymentNetwork,
  PaymentProvider,
  VerifiedStorageQuote,
} from "../src/types.js";

const network: PaymentNetwork = {
  chainId: 31337,
  paymentTokenAddress: `0x${"11".repeat(20)}`,
  paymentVaultAddress: `0x${"22".repeat(20)}`,
};
const quotes: VerifiedStorageQuote[] = [
  {
    quote: {},
    quoteHash: "33".repeat(32),
    rewardsAddress: `0x${"44".repeat(20)}`,
    amount: "40",
  },
  {
    quote: {},
    quoteHash: "55".repeat(32),
    rewardsAddress: `0x${"66".repeat(20)}`,
    amount: "2",
  },
];

let walletPayment: PaymentProvider;

beforeEach(() => {
  walletPayment = {
    pay: vi.fn(async () => ({
      transactionHash: `0x${"77".repeat(32)}`,
      walletAddress: `0x${"88".repeat(20)}`,
      totalAmount: "42",
    })),
  };
});

describe("createManualPaymentProvider", () => {
  it("exposes verified quotes and waits for an explicit pay call", async () => {
    let request!: ManualPaymentRequest;
    const onRequest = vi.fn((next: ManualPaymentRequest) => {
      request = next;
    });
    const payment = createManualPaymentProvider({ payment: walletPayment, onRequest });

    const uploadPayment = payment.pay(network, quotes, { submitted: vi.fn(), report: vi.fn() });

    expect(onRequest).toHaveBeenCalledOnce();
    expect(request.totalAmountAtto).toBe("42");
    expect(request.quotes).toEqual(quotes);
    expect(request.status).toBe("pending");
    expect(walletPayment.pay).not.toHaveBeenCalled();

    const buttonPayment = request.pay();
    expect(request.status).toBe("paying");
    expect(request.pay()).toBe(buttonPayment);
    await expect(buttonPayment).resolves.toMatchObject({ totalAmount: "42" });
    await expect(uploadPayment).resolves.toMatchObject({ totalAmount: "42" });
    expect(request.status).toBe("paid");
    expect(walletPayment.pay).toHaveBeenCalledOnce();
  });

  it("cancels a paused payment without invoking the wallet", async () => {
    let request!: ManualPaymentRequest;
    const payment = createManualPaymentProvider({
      payment: walletPayment,
      onRequest: (next) => {
        request = next;
      },
    });
    const uploadPayment = payment.pay(network, quotes, { submitted: vi.fn(), report: vi.fn() });

    expect(request.cancel("User declined the storage price")).toBe(true);
    expect(request.cancel()).toBe(false);
    await expect(uploadPayment).rejects.toThrow("User declined the storage price");
    expect(request.status).toBe("cancelled");
    expect(walletPayment.pay).not.toHaveBeenCalled();
  });

  it("cancels a paused payment when its upload signal aborts", async () => {
    let request!: ManualPaymentRequest;
    const controller = new AbortController();
    const payment = createManualPaymentProvider({
      payment: walletPayment,
      onRequest: (next) => {
        request = next;
      },
    });

    const uploadPayment = payment.pay(network, quotes, {
      submitted: vi.fn(), report: vi.fn(),
      signal: controller.signal,
    });
    controller.abort();

    await expect(uploadPayment).rejects.toMatchObject({ name: "AbortError" });
    expect(request.status).toBe("cancelled");
    expect(walletPayment.pay).not.toHaveBeenCalled();
  });

  it("fails the paused upload when wallet payment fails", async () => {
    const rejection = new Error("Wallet rejected the transaction");
    walletPayment.pay = vi.fn(async () => Promise.reject(rejection));
    let request!: ManualPaymentRequest;
    const payment = createManualPaymentProvider({
      payment: walletPayment,
      onRequest: (next) => {
        request = next;
      },
    });
    const uploadPayment = payment.pay(network, quotes, { submitted: vi.fn(), report: vi.fn() });

    await expect(request.pay()).rejects.toBe(rejection);
    await expect(uploadPayment).rejects.toBe(rejection);
    expect(request.status).toBe("failed");
  });

  it("bypasses presentation when there is nothing to pay", async () => {
    const onRequest = vi.fn();
    const payment = createManualPaymentProvider({ onRequest });

    await expect(payment.pay(network, [], { submitted: vi.fn(), report: vi.fn() })).resolves.toEqual({
      totalAmount: "0",
    });
    expect(onRequest).not.toHaveBeenCalled();
    expect(walletPayment.pay).not.toHaveBeenCalled();
  });

  it("lets the application select or switch the wallet before payment", async () => {
    let request!: ManualPaymentRequest;
    const selectedPayment: PaymentProvider = {
      pay: vi.fn(async () => ({
        transactionHash: `0x${"99".repeat(32)}`,
        walletAddress: `0x${"aa".repeat(20)}`,
        totalAmount: "42",
      })),
    };
    const payment = createManualPaymentProvider({
      onRequest: (next) => {
        request = next;
      },
    });
    const uploadPayment = payment.pay(network, quotes, { submitted: vi.fn(), report: vi.fn() });

    await expect(request.pay()).rejects.toThrow(
      "Select a wallet PaymentProvider before paying",
    );
    expect(request.status).toBe("pending");

    await expect(request.pay(selectedPayment)).resolves.toMatchObject({
      walletAddress: `0x${"aa".repeat(20)}`,
    });
    await expect(uploadPayment).resolves.toMatchObject({ totalAmount: "42" });
    expect(selectedPayment.pay).toHaveBeenCalledOnce();
  });
});

const merkle = {
  calldata: "0xabcd",
  maximumAmount: "100",
  depth: 2,
  timestamp: 123,
  poolHashes: ["aa".repeat(32), "bb".repeat(32)],
};

it("reviews the Merkle maximum and pays the immutable native plan only once", async () => {
  const receipt = { transactionHash: `0x${"77".repeat(32)}`, winnerPoolHash: merkle.poolHashes[0]!, totalAmount: "80" };
  walletPayment.payMerkle = vi.fn(async () => receipt);
  let request!: ManualPaymentRequest;
  const payment = createManualPaymentProvider({ payment: walletPayment, onRequest: next => { request = next; } });
  const context = { submitted: vi.fn(), report: vi.fn(), decodeReceipt: vi.fn() };
  const original = structuredClone(merkle);
  const pending = payment.payMerkle!(network, original, context);
  expect(request.totalAmountAtto).toBe("100");
  expect(request.quotes).toEqual([]);
  expect(request.merkle).toEqual(merkle);
  original.poolHashes[0] = "cc".repeat(32);
  original.calldata = "0xdead";
  expect(Object.isFrozen(request.merkle?.poolHashes)).toBe(true);
  expect(walletPayment.payMerkle).not.toHaveBeenCalled();
  const paying = request.pay();
  expect(request.pay()).toBe(paying);
  expect(request.cancel()).toBe(false);
  await expect(paying).resolves.toEqual(receipt);
  await expect(pending).resolves.toEqual(receipt);
  expect(walletPayment.payMerkle).toHaveBeenCalledExactlyOnceWith(network, merkle, context);
  expect(walletPayment.pay).not.toHaveBeenCalled();
});

it("keeps Merkle review pending if the selected wallet cannot pay it", async () => {
  let request!: ManualPaymentRequest;
  const payment = createManualPaymentProvider({ payment: walletPayment, onRequest: next => { request = next; } });
  const pending = payment.payMerkle!(network, merkle, { submitted: vi.fn(), report: vi.fn(), decodeReceipt: vi.fn() });
  await expect(request.pay()).rejects.toThrow("payMerkle support");
  expect(request.status).toBe("pending");
  request.cancel();
  await expect(pending).rejects.toThrow("cancelled");
  expect(walletPayment.pay).not.toHaveBeenCalled();
});

it("forwards both journal recovery methods without a payment prompt or submission", async () => {
  const receipt = { transactionHash: `0x${"77".repeat(32)}`, totalAmount: "42" };
  walletPayment.recover = vi.fn(async () => receipt);
  walletPayment.recoverMerkle = vi.fn(async () => ({ ...receipt, winnerPoolHash: merkle.poolHashes[0]! }));
  walletPayment.payMerkle = vi.fn();
  const onRequest = vi.fn();
  const payment = createManualPaymentProvider({ payment: walletPayment, onRequest });
  const attempt = { submissions: [{ transactionHash: receipt.transactionHash }] };
  const context = { report: vi.fn() };
  await expect(payment.recover!(network, quotes, attempt, context)).resolves.toEqual(receipt);
  await expect(payment.recoverMerkle!(network, merkle, attempt, context)).resolves.toMatchObject(receipt);
  expect(walletPayment.recover).toHaveBeenCalledExactlyOnceWith(network, quotes, attempt, context);
  expect(walletPayment.recoverMerkle).toHaveBeenCalledExactlyOnceWith(network, merkle, attempt, context);
  expect(walletPayment.pay).not.toHaveBeenCalled();
  expect(walletPayment.payMerkle).not.toHaveBeenCalled();
  expect(onRequest).not.toHaveBeenCalled();
});

it("recovers using the wallet selected at review even when there was no default", async () => {
  const failure = new Error("RPC unavailable after submission");
  walletPayment.pay = vi.fn(async () => { throw failure; });
  walletPayment.recover = vi.fn(async () => ({ transactionHash: `0x${"77".repeat(32)}`, totalAmount: "42" }));
  let request!: ManualPaymentRequest;
  const payment = createManualPaymentProvider({ onRequest: next => { request = next; } });
  const pending = payment.pay(network, quotes, { submitted: vi.fn(), report: vi.fn() });
  await expect(request.pay(walletPayment)).rejects.toBe(failure);
  await expect(pending).rejects.toBe(failure);
  await payment.recover!(network, quotes, {}, { report: vi.fn() });
  expect(walletPayment.recover).toHaveBeenCalledOnce();
  expect(walletPayment.pay).toHaveBeenCalledOnce();
});

it("does not replace missing or failed journal recovery with another payment", async () => {
  const onRequest = vi.fn();
  const payment = createManualPaymentProvider({ payment: walletPayment, onRequest });
  await expect(payment.recover!(network, quotes, {}, { report: vi.fn() })).rejects.toThrow("does not support journal recovery");
  await expect(payment.recoverMerkle!(network, merkle, {}, { report: vi.fn() })).rejects.toThrow("does not support Merkle journal recovery");
  const failure = new Error("receipt is still unavailable");
  walletPayment.recover = vi.fn(async () => { throw failure; });
  await expect(payment.recover!(network, quotes, {}, { report: vi.fn() })).rejects.toBe(failure);
  expect(walletPayment.pay).not.toHaveBeenCalled();
  expect(onRequest).not.toHaveBeenCalled();
});
