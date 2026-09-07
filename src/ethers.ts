import {
  Contract,
  JsonRpcProvider,
  MaxUint256,
  NonceManager,
  Wallet,
  isError,
  type Signer,
  type TransactionResponse,
} from "ethers";
import { abortable, throwIfAborted } from "./internal/abort.js";
import { assertPaymentChainId } from "./internal/payment-network.js";
import { createPaymentSubmission, confirmedPayment } from "./payment.js";
import { errorMessage } from "./errors.js";
import type {
  PaymentContext,
  PaymentNetwork,
  PaymentProvider,
  PaymentReceipt,
  VerifiedStorageQuote,
} from "./types.js";

const TOKEN_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];
const VAULT_ABI = [
  "function payForQuotes((address rewardsAddress,uint256 amount,bytes32 quoteHash)[] payments)",
];

export type EthersPaymentOptions = {
  /** Defaults to unlimited, avoiding another approval on the next upload. */
  approval?: "exact" | "unlimited";
} & ({
  /** Convenient for local/dev wallets. Prefer getSigner for user-managed wallets. */
  privateKey: string;
  /** Application-owned HTTP(S) endpoint; never received from a storage node. */
  rpcUrl: string;
  getSigner?: never;
} | {
  /** Resolve an ethers signer connected to the node's advertised payment chain. */
  getSigner: (network: PaymentNetwork) => Signer | Promise<Signer>;
  privateKey?: never;
  rpcUrl?: never;
});

/** Create the optional Ethers v6 payment adapter used by paid uploads. */
export function createEthersPaymentProvider(
  options: EthersPaymentOptions,
): PaymentProvider {
  if (Boolean(options.privateKey) === Boolean(options.getSigner)) {
    throw new TypeError("Provide exactly one of privateKey or getSigner");
  }
  if (options.privateKey) {
    if (!options.rpcUrl) throw new TypeError("Provide rpcUrl with privateKey");
    const rpc = new URL(options.rpcUrl);
    if (rpc.protocol !== "http:" && rpc.protocol !== "https:") {
      throw new TypeError("Payment rpcUrl must use HTTP or HTTPS");
    }
  }
  const approval = options.approval ?? "unlimited";
  const privateKeySigners = new Map<number, NonceManager>();
  let privateKeyPayments: Promise<void> = Promise.resolve();

  const privateKeySigner = (network: PaymentNetwork): NonceManager => {
    let signer = privateKeySigners.get(network.chainId);
    if (!signer) {
      signer = new NonceManager(
        new Wallet(options.privateKey!, new JsonRpcProvider(options.rpcUrl!)),
      );
      privateKeySigners.set(network.chainId, signer);
    }
    return signer;
  };

  const serializePrivateKeyPayment = <T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const payment = privateKeyPayments.then(async () => {
      throwIfAborted(signal);
      return task();
    });
    privateKeyPayments = payment.then(
      () => undefined,
      () => undefined,
    );
    // Once submission starts, retain its eventual receipt even if the caller
    // stops waiting. The SDK observes this promise for upload recovery.
    return payment;
  };

  return {
    async pay(network, quotes, context): Promise<PaymentReceipt> {
      throwIfAborted(context.signal);
      if (quotes.length === 0) return { totalAmount: "0" };
      assertPaymentChainId(network.chainId);
      if (options.getSigner) {
        throwIfAborted(context.signal);
        const signer = await abortable(options.getSigner(network), context.signal);
        return submitPayment(signer, network, quotes, context, approval);
      }
      return serializePrivateKeyPayment(
        async () => {
          const signer = privateKeySigner(network);
          try {
            return await submitPayment(signer, network, quotes, context, approval);
          } finally {
            // NonceManager increments before estimation/broadcast can fail.
            // The next queued attempt must reload the chain's pending nonce.
            signer.reset();
          }
        },
        context.signal,
      );
    },
  };
}

async function submitPayment(
  signer: Signer,
  network: PaymentNetwork,
  quotes: readonly VerifiedStorageQuote[],
  context: PaymentContext,
  approval: "exact" | "unlimited",
): Promise<PaymentReceipt> {
  throwIfAborted(context.signal);
  if (!signer.provider) throw new Error("Payment signer must be connected to a provider");
  const signerNetwork = await abortable(signer.provider.getNetwork(), context.signal);
  if (signerNetwork.chainId !== BigInt(network.chainId)) {
    throw new Error(`Payment signer is on chain ${signerNetwork.chainId}; switch to payment chain ${network.chainId}`);
  }
  const walletAddress = await abortable(signer.getAddress(), context.signal);
  const totalAmount = quotes.reduce(
    (total, quote) => total + BigInt(quote.amount),
    0n,
  );
  const token = new Contract(network.paymentTokenAddress, TOKEN_ABI, signer);
  const vault = new Contract(network.paymentVaultAddress, VAULT_ABI, signer);
  const allowance = (await abortable(
    token.getFunction("allowance")(walletAddress, network.paymentVaultAddress),
    context.signal,
  )) as bigint;
  if (allowance < totalAmount) {
    throwIfAborted(context.signal);
    context.report(`Approving the payment vault from wallet ${walletAddress}`, { phase: "approval" });
    throwIfAborted(context.signal);
    const amount = approval === "exact" ? totalAmount : MaxUint256;
    // Once a transaction submission starts it cannot be cancelled. Keep this
    // task queued until its receipt settles so a later private-key payment
    // cannot race ahead with another signer or provider instance.
    const transaction = await token.getFunction("approve")(
      network.paymentVaultAddress,
      amount,
    );
    await confirmedHash(transaction, "Payment-token approval transaction reverted");
  }

  throwIfAborted(context.signal);
  const payments = quotePayments(quotes);
  context.report(`Submitting one payment for ${payments.length} storage quote(s)`, { phase: "payment", total: payments.length, unit: "quotes" });
  throwIfAborted(context.signal);
  const transaction = await vault.getFunction("payForQuotes")(payments);
  const submission = createPaymentSubmission({ transactionHash: transaction.hash, walletAddress, totalAmount: totalAmount.toString() }, async () => {
    try {
      const transactionHash = await confirmedHash(transaction, "Storage payment transaction reverted");
      return { status: "confirmed", receipt: { transactionHash, walletAddress, totalAmount: totalAmount.toString() } };
    } catch (error) {
      if (error instanceof RevertedTransaction || isError(error, "TRANSACTION_REPLACED") ||
          (isError(error, "CALL_EXCEPTION") && error.receipt?.status === 0)) {
        return { status: "failed", reason: errorMessage(error), cause: error };
      }
      throw error;
    }
  });
  // A UI callback must not interrupt observation after funds have been broadcast.
  try { context.submitted(submission); } catch { /* Continue observing the transaction. */ }
  const receipt = await confirmedPayment(submission);
  const transactionHash = receipt.transactionHash;
  try { if (!context.signal?.aborted) context.report(`Payment confirmed in ${transactionHash}`); } catch { /* The receipt is already confirmed. */ }
  return {
    transactionHash,
    walletAddress,
    totalAmount: totalAmount.toString(),
  };
}

class RevertedTransaction extends Error {}

async function confirmedHash(transaction: TransactionResponse, failure: string): Promise<string> {
  try {
    const receipt = await transaction.wait();
    if (!receipt) throw new Error("Transaction receipt is not yet available");
    if (receipt.status !== 1) throw new RevertedTransaction(failure);
    return receipt.hash;
  } catch (error) {
    if (
      isError(error, "TRANSACTION_REPLACED") &&
      !error.cancelled && error.reason === "repriced" && error.receipt.status === 1
    ) {
      return error.receipt.hash;
    }
    throw error;
  }
}

function quotePayments(quotes: readonly VerifiedStorageQuote[]): Array<{
  rewardsAddress: string;
  amount: string;
  quoteHash: string;
}> {
  return quotes.map((quote) => ({
    rewardsAddress: quote.rewardsAddress,
    amount: quote.amount,
    quoteHash: `0x${quote.quoteHash.replace(/^0x/iu, "")}`,
  }));
}
