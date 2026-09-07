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
  rpc_url: "http://127.0.0.1:8545/",
  payment_token_address: `0x${"11".repeat(20)}`,
  payment_vault_address: `0x${"22".repeat(20)}`,
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

    const uploadPayment = payment.pay(network, quotes, { report: vi.fn() });

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
    const uploadPayment = payment.pay(network, quotes, { report: vi.fn() });

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
      report: vi.fn(),
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
    const uploadPayment = payment.pay(network, quotes, { report: vi.fn() });

    await expect(request.pay()).rejects.toBe(rejection);
    await expect(uploadPayment).rejects.toBe(rejection);
    expect(request.status).toBe("failed");
  });

  it("bypasses presentation when there is nothing to pay", async () => {
    const onRequest = vi.fn();
    const payment = createManualPaymentProvider({ onRequest });

    await expect(payment.pay(network, [], { report: vi.fn() })).resolves.toEqual({
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
    const uploadPayment = payment.pay(network, quotes, { report: vi.fn() });

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
