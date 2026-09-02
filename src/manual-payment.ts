import type {
  PaymentNetwork,
  PaymentProvider,
  PaymentReceipt,
  VerifiedStorageQuote,
} from "./types.js";

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
  /** Decimal atto-token sum of every verified quote. */
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

  return {
    async pay(network, quotes, context): Promise<PaymentReceipt> {
      if (quotes.length === 0) return { totalAmount: "0" };

      const paymentNetwork = { ...network };
      Object.freeze(paymentNetwork);
      const paymentQuotes = quotes.map((quote) => {
        const snapshot = { ...quote };
        Object.freeze(snapshot);
        return snapshot;
      });
      Object.freeze(paymentQuotes);
      const totalAmountAtto = quoteTotal(paymentQuotes);

      let status: ManualPaymentStatus = "pending";
      let walletPayment: Promise<PaymentReceipt> | undefined;
      let resolveUpload!: (receipt: PaymentReceipt) => void;
      let rejectUpload!: (error: unknown) => void;
      const uploadPayment = new Promise<PaymentReceipt>((resolve, reject) => {
        resolveUpload = resolve;
        rejectUpload = reject;
      });

      const request: ManualPaymentRequest = {
        network: paymentNetwork,
        quotes: paymentQuotes,
        totalAmountAtto,
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
          status = "paying";
          walletPayment = Promise.resolve().then(() =>
            payment.pay(paymentNetwork, paymentQuotes, context),
          );
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

      try {
        const notified = options.onRequest(request);
        void Promise.resolve(notified).catch((error: unknown) => request.cancel(error));
      } catch (error) {
        request.cancel(error);
      }
      return uploadPayment;
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
