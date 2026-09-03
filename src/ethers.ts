import {
  Contract,
  JsonRpcProvider,
  MaxUint256,
  NonceManager,
  Wallet,
  type Signer,
} from "ethers";
import { abortable, throwIfAborted } from "./internal/abort.js";
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
    return abortable(payment, signal);
  };

  return {
    async pay(network, quotes, context): Promise<PaymentReceipt> {
      if (quotes.length === 0) return { totalAmount: "0" };
      if (options.getSigner) {
        throwIfAborted(context.signal);
        const signer = await abortable(options.getSigner(network), context.signal);
        return abortable(
          submitPayment(signer, network, quotes, context, approval),
          context.signal,
        );
      }
      return serializePrivateKeyPayment(
        () => submitPayment(
          privateKeySigner(network),
          network,
          quotes,
          context,
          approval,
        ),
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
    context.report(`Approving the payment vault from wallet ${walletAddress}`);
    const amount = approval === "exact" ? totalAmount : MaxUint256;
    // Once a transaction submission starts it cannot be cancelled. Keep this
    // task queued until its receipt settles so a later private-key payment
    // cannot race ahead with another signer or provider instance.
    const transaction = await token.getFunction("approve")(
      network.payment_vault_address,
      amount,
    );
    const receipt = (await transaction.wait()) as { status: number } | null;
    if (!receipt || receipt.status !== 1) {
      throw new Error("Payment-token approval transaction reverted");
    }
  }

  throwIfAborted(context.signal);
  const payments = quotePayments(quotes);
  context.report(`Submitting one payment for ${payments.length} storage quote(s)`);
  const transaction = await vault.getFunction("payForQuotes")(payments);
  const receipt = (await transaction.wait()) as { status: number } | null;
  if (!receipt || receipt.status !== 1) {
    throw new Error("Storage payment transaction reverted");
  }
  context.report(`Payment confirmed in ${transaction.hash}`);
  return {
    transactionHash: transaction.hash,
    walletAddress,
    totalAmount: totalAmount.toString(),
  };
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
