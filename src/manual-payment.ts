import type {
  MerklePaymentContext,
  MerklePaymentRequest,
  PaymentContext,
  PaymentNetwork,
  PaymentProvider,
  PaymentReceipt,
  VerifiedStorageQuote,
} from "./types.js";
import { snapshot } from "./internal/snapshot.js";

export type ManualPaymentStatus =
  | "pending"
  | "paying"
  | "paid"
  | "cancelled"
  | "failed";

/** A verified storage price waiting for an explicit user payment action. */
export interface ManualPaymentRequest {
  readonly network: Readonly<PaymentNetwork>;
  readonly quotes: readonly Readonly<VerifiedStorageQuote>[];
  /** Native Merkle plan, when present; quotes is empty for this payment mode. */
  readonly merkle?: Readonly<MerklePaymentRequest>;
  /** Exact single-quote total, or the maximum Merkle charge, in decimal atto-tokens. */
  readonly totalAmountAtto: string;
  readonly status: ManualPaymentStatus;
  /**
   * Pay with the supplied provider, or the configured default, and wait for its
   * confirmed receipt. The wallet choice is locked once payment begins.
   */
  pay(payment?: PaymentProvider): Promise<PaymentReceipt>;
  /** Cancel before payment begins, causing the paused upload to fail. */
  cancel(reason?: unknown): boolean;
}

export interface ManualPaymentOptions {
  /** Optional default. Omit when the application selects a wallet after quoting. */
  payment?: PaymentProvider;
  /** Present the verified quotes and retain the request for a later button click. */
  onRequest(request: ManualPaymentRequest): void | Promise<void>;
}

/**
 * Pause a paid upload after quote verification until the application explicitly
 * calls `request.pay()`. The provider selected at that point owns wallet submission.
 */
export function createManualPaymentProvider(
  options: ManualPaymentOptions,
): PaymentProvider {
  if (!options || typeof options.onRequest !== "function") {
    throw new TypeError("Manual payment requires an onRequest callback");
  }
  if (options.payment && typeof options.payment.pay !== "function") {
    throw new TypeError("The default wallet must be a PaymentProvider");
  }

  let recoveryPayment = options.payment;

  function recoveryProvider(): PaymentProvider {
    if (!recoveryPayment) throw new Error("Select a wallet provider with payment recovery support");
    return recoveryPayment;
  }

  async function review<T extends PaymentReceipt>(
    network: PaymentNetwork,
    quotes: readonly VerifiedStorageQuote[],
    context: PaymentContext,
    merkle: MerklePaymentRequest | undefined,
    submit: (payment: PaymentProvider) => Promise<T>,
  ): Promise<T> {
    const paymentNetwork = snapshot(network);
    const paymentQuotes = snapshot(quotes);
    const totalAmountAtto = merkle ? merkle.maximumAmount : quoteTotal(paymentQuotes);
    if (!/^\d+$/u.test(totalAmountAtto)) throw new TypeError("Storage payment has a non-decimal amount");

    let status: ManualPaymentStatus = "pending";
    let walletPayment: Promise<T> | undefined;
    let resolveUpload!: (receipt: T) => void;
    let rejectUpload!: (error: unknown) => void;
    const uploadPayment = new Promise<T>((resolve, reject) => {
      resolveUpload = resolve;
      rejectUpload = reject;
    });

    const request: ManualPaymentRequest = {
      network: paymentNetwork,
      quotes: paymentQuotes,
      totalAmountAtto,
      ...(merkle ? { merkle } : {}),
      get status() {
        return status;
      },
      pay(payment = options.payment): Promise<PaymentReceipt> {
        if (walletPayment) return walletPayment;
        if (status !== "pending") {
          return Promise.reject(
            new Error(`Storage payment cannot start while request is ${status}`),
          );
        }
        if (!payment || typeof payment.pay !== "function") {
          return Promise.reject(
            new Error("Select a wallet PaymentProvider before paying"),
          );
        }
        if (merkle && typeof payment.payMerkle !== "function") {
          return Promise.reject(new Error("Select a wallet PaymentProvider with payMerkle support"));
        }
        recoveryPayment = payment;
        status = "paying";
        walletPayment = Promise.resolve().then(() => submit(payment));
        void walletPayment.then(
          (receipt) => {
            status = "paid";
            resolveUpload(receipt);
          },
          (error: unknown) => {
            status = "failed";
            rejectUpload(error);
          },
        );
        return walletPayment;
      },
      cancel(reason?: unknown): boolean {
        if (status !== "pending") return false;
        status = "cancelled";
        rejectUpload(cancellationError(reason));
        return true;
      },
    };
    Object.freeze(request);

    const abort = (): void => {
      if (context.signal) request.cancel(context.signal.reason);
    };
    if (context.signal?.aborted) abort();
    else context.signal?.addEventListener("abort", abort, { once: true });

    try {
      if (status === "pending") {
        const notified = options.onRequest(request);
        void Promise.resolve(notified).catch((error: unknown) => request.cancel(error));
      }
    } catch (error) {
      request.cancel(error);
    }
    try {
      return await uploadPayment;
    } finally {
      context.signal?.removeEventListener("abort", abort);
    }
  }

  return {
    async pay(network, quotes, context) {
      if (quotes.length === 0) return { totalAmount: "0" };
      const savedNetwork = snapshot(network);
      const savedQuotes = snapshot(quotes);
      return review(savedNetwork, savedQuotes, context, undefined,
        payment => payment.pay(savedNetwork, savedQuotes, context));
    },
    async payMerkle(network, request, context: MerklePaymentContext) {
      const savedNetwork = snapshot(network);
      const savedRequest = snapshot(request);
      return review(savedNetwork, [], context, savedRequest,
        payment => payment.payMerkle!(savedNetwork, savedRequest, context));
    },
    async recover(network, quotes, attempt, context) {
      const payment = recoveryProvider();
      if (!payment.recover) throw new Error("Wallet PaymentProvider does not support journal recovery; no new payment was requested");
      return payment.recover(network, quotes, attempt, context);
    },
    async recoverMerkle(network, request, attempt, context) {
      const payment = recoveryProvider();
      if (!payment.recoverMerkle) throw new Error("Wallet PaymentProvider does not support Merkle journal recovery; no new payment was requested");
      return payment.recoverMerkle(network, request, attempt, context);
    },
  };
}

function quoteTotal(quotes: readonly VerifiedStorageQuote[]): string {
  let total = 0n;
  for (const quote of quotes) {
    if (!/^\d+$/u.test(quote.amount)) {
      throw new TypeError("Verified storage quote has a non-decimal amount");
    }
    total += BigInt(quote.amount);
  }
  return total.toString();
}

function cancellationError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason !== "") return new Error(reason);
  return new Error("Storage payment was cancelled");
}
