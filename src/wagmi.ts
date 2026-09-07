import { getConnectorClient, type Config } from "@wagmi/core";
import {
  createPublicClient,
  http,
  maxUint256,
  type Account,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type Transport,
} from "viem";
import { readContract, waitForTransactionReceipt, writeContract } from "viem/actions";
import { abortable, throwIfAborted } from "./internal/abort.js";
import { assertPaymentChainId } from "./internal/payment-network.js";
import type {
  PaymentNetwork,
  PaymentProvider,
  PaymentReceipt,
  VerifiedStorageQuote,
} from "./types.js";

const TOKEN_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const VAULT_ABI = [
  {
    type: "function",
    name: "payForQuotes",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "payments",
        type: "tuple[]",
        components: [
          { name: "rewardsAddress", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "quoteHash", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export interface WagmiPaymentOptions<config extends Config = Config> {
  /** Wagmi config containing the user's active connector and payment chain. */
  config: config;
  /** Defaults to unlimited, avoiding another approval on the next upload. */
  approval?: "exact" | "unlimited";
}

/** Create the optional Wagmi v3/Viem payment adapter used by paid uploads. */
export function createWagmiPaymentProvider<config extends Config>(
  options: WagmiPaymentOptions<config>,
): PaymentProvider {
  const approval = options.approval ?? "unlimited";

  return {
    async pay(network, quotes, context): Promise<PaymentReceipt> {
      throwIfAborted(context.signal);
      if (quotes.length === 0) return { totalAmount: "0" };
      assertPaymentChainId(network.chainId);

      const publicClient = createPublicClient({ transport: http(network.rpc_url) });
      const [chainId, connectorClient] = await abortable(Promise.all([
        publicClient.getChainId(),
        getConnectorClient(options.config),
      ]), context.signal);
      if (chainId !== network.chainId) {
        throw new Error(`Payment RPC is on chain ${chainId}; expected payment chain ${network.chainId}`);
      }
      const walletClient = connectorClient as Client<Transport, Chain, Account>;
      if (walletClient.chain.id !== network.chainId) {
        throw new Error(
          `Connected wallet is on chain ${walletClient.chain.id}; switch to payment chain ${network.chainId}`,
        );
      }

      const walletAddress = walletClient.account.address;
      const tokenAddress = network.payment_token_address as Address;
      const vaultAddress = network.payment_vault_address as Address;
      const totalAmount = quotes.reduce(
        (total, quote) => total + BigInt(quote.amount),
        0n,
      );
      throwIfAborted(context.signal);
      const allowance = await abortable(readContract(publicClient, {
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: "allowance",
        args: [walletAddress, vaultAddress],
      }), context.signal);

      if (allowance < totalAmount) {
        context.report(`Approving the payment vault from wallet ${walletAddress}`, { phase: "approval" });
        throwIfAborted(context.signal);
        const amount = approval === "exact" ? totalAmount : maxUint256;
        const transactionHash = await writeContract(walletClient, {
          address: tokenAddress,
          abi: TOKEN_ABI,
          functionName: "approve",
          args: [vaultAddress, amount],
        });
        await requireSuccessfulReceipt(
          publicClient,
          transactionHash,
          "Payment-token approval transaction reverted",
        );
      }

      const payments = quotePayments(quotes);
      throwIfAborted(context.signal);
      context.report(`Submitting one payment for ${payments.length} storage quote(s)`, { phase: "payment", total: payments.length, unit: "quotes" });
      throwIfAborted(context.signal);
      const transactionHash = await writeContract(walletClient, {
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: "payForQuotes",
        args: [payments],
      });
      const confirmedTransactionHash = await requireSuccessfulReceipt(
        publicClient,
        transactionHash,
        "Storage payment transaction reverted",
      );
      try { if (!context.signal?.aborted) context.report(`Payment confirmed in ${confirmedTransactionHash}`); } catch { /* The receipt is already confirmed. */ }
      return {
        transactionHash: confirmedTransactionHash,
        walletAddress,
        totalAmount: totalAmount.toString(),
      };
    },
  };
}

async function requireSuccessfulReceipt(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hex,
  errorMessage: string,
): Promise<Hex> {
  let replaced = false;
  const receipt = await waitForTransactionReceipt(publicClient, {
    hash,
    onReplaced: ({ reason }) => {
      if (reason !== "repriced") replaced = true;
    },
  });
  if (replaced) throw new Error("Wallet transaction was cancelled or replaced with a different transaction");
  if (receipt.status !== "success") throw new Error(errorMessage);
  return receipt.transactionHash;
}

function quotePayments(quotes: readonly VerifiedStorageQuote[]): Array<{
  rewardsAddress: Address;
  amount: bigint;
  quoteHash: Hex;
}> {
  return quotes.map((quote) => ({
    rewardsAddress: quote.rewardsAddress as Address,
    amount: BigInt(quote.amount),
    quoteHash: `0x${quote.quoteHash.replace(/^0x/iu, "")}` as Hex,
  }));
}
