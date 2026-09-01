import {
  Contract,
  JsonRpcProvider,
  MaxUint256,
  NonceManager,
  Wallet,
  type Signer,
} from "ethers";
import type {
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

  return {
    async pay(network, quotes, context): Promise<PaymentReceipt> {
      if (quotes.length === 0) return { totalAmount: "0" };
      const signer = options.getSigner
        ? await options.getSigner(network)
        : new NonceManager(
            new Wallet(options.privateKey!, new JsonRpcProvider(network.rpc_url)),
          );
      const walletAddress = await signer.getAddress();
      const totalAmount = quotes.reduce(
        (total, quote) => total + BigInt(quote.amount),
        0n,
      );
      const token = new Contract(network.payment_token_address, TOKEN_ABI, signer);
      const vault = new Contract(network.payment_vault_address, VAULT_ABI, signer);
      const allowance = (await token.getFunction("allowance")(
        walletAddress,
        network.payment_vault_address,
      )) as bigint;
      if (allowance < totalAmount) {
        context.report(`Approving the payment vault from wallet ${walletAddress}`);
        const amount = approval === "exact" ? totalAmount : MaxUint256;
        const transaction = await token.getFunction("approve")(
          network.payment_vault_address,
          amount,
        );
        const receipt = await transaction.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error("Payment-token approval transaction reverted");
        }
      }

      const payments = quotePayments(quotes);
      context.report(`Submitting one payment for ${payments.length} storage quote(s)`);
      const transaction = await vault.getFunction("payForQuotes")(payments);
      const receipt = await transaction.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error("Storage payment transaction reverted");
      }
      context.report(`Payment confirmed in ${transaction.hash}`);
      return {
        transactionHash: transaction.hash,
        walletAddress,
        totalAmount: totalAmount.toString(),
      };
    },
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
