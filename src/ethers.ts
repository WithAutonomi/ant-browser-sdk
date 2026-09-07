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

export interface EthersPaymentOptions {
  /** Convenient for local/dev wallets. Prefer getSigner for user-managed production wallets. */
  privateKey?: string;
  /** Resolve an ethers signer connected to the advertised payment network. */
  getSigner?: (network: PaymentNetwork) => Signer | Promise<Signer>;
  /** Defaults to unlimited, avoiding another approval on the next upload. */
  approval?: "exact" | "unlimited";
}

/** Create the optional Ethers v6 payment adapter used by paid uploads. */
export function createEthersPaymentProvider(
  options: EthersPaymentOptions,
): PaymentProvider {
  if (Boolean(options.privateKey) === Boolean(options.getSigner)) {
    throw new TypeError("Provide exactly one of privateKey or getSigner");
  }
  const approval = options.approval ?? "unlimited";
  const privateKeySigners = new Map<string, NonceManager>();
  let privateKeyPayments: Promise<void> = Promise.resolve();

  const privateKeySigner = (network: PaymentNetwork): NonceManager => {
    let signer = privateKeySigners.get(network.rpc_url);
    if (!signer) {
      signer = new NonceManager(
        new Wallet(options.privateKey!, new JsonRpcProvider(network.rpc_url)),
      );
      privateKeySigners.set(network.rpc_url, signer);
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
  const token = new Contract(network.payment_token_address, TOKEN_ABI, signer);
  const vault = new Contract(network.payment_vault_address, VAULT_ABI, signer);
  const allowance = (await abortable(
    token.getFunction("allowance")(walletAddress, network.payment_vault_address),
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
      network.payment_vault_address,
      amount,
    );
    await confirmedHash(transaction, "Payment-token approval transaction reverted");
  }

  throwIfAborted(context.signal);
  const payments = quotePayments(quotes);
  context.report(`Submitting one payment for ${payments.length} storage quote(s)`, { phase: "payment", total: payments.length, unit: "quotes" });
  throwIfAborted(context.signal);
  const transaction = await vault.getFunction("payForQuotes")(payments);
  const transactionHash = await confirmedHash(transaction, "Storage payment transaction reverted");
  try { if (!context.signal?.aborted) context.report(`Payment confirmed in ${transactionHash}`); } catch { /* The receipt is already confirmed. */ }
  return {
    transactionHash,
    walletAddress,
    totalAmount: totalAmount.toString(),
  };
}

async function confirmedHash(transaction: TransactionResponse, failure: string): Promise<string> {
  try {
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) throw new Error(failure);
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
