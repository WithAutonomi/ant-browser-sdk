import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentNetwork, VerifiedStorageQuote } from "../src/types.js";

const state = vi.hoisted(() => ({
  providers: 0,
  nonceManagers: 0,
  paymentSubmissions: 0,
  paymentWaits: [] as Array<(receipt: { status: number }) => void>,
}));

vi.mock("ethers", () => {
  class JsonRpcProvider {
    constructor(_url: string) {
      state.providers += 1;
    }
  }

  class Wallet {
    constructor(_key: string, _provider: JsonRpcProvider) {}
    async getAddress(): Promise<string> {
      return `0x${"aa".repeat(20)}`;
    }
  }

  class NonceManager {
    constructor(private readonly signer: Wallet) {
      state.nonceManagers += 1;
    }
    getAddress(): Promise<string> {
      return this.signer.getAddress();
    }
  }

  class Contract {
    constructor(
      private readonly address: string,
      _abi: readonly string[],
      _signer: NonceManager,
    ) {}

    getFunction(name: string): (...args: unknown[]) => Promise<unknown> {
      if (name === "allowance") return async () => 1_000n;
      if (name === "approve") {
        return async () => ({
          hash: "0xapprove",
          wait: async () => ({ status: 1 }),
        });
      }
      if (name === "payForQuotes") {
        return async () => {
          state.paymentSubmissions += 1;
          return {
            hash: `0xpayment${state.paymentSubmissions}`,
            wait: () =>
              new Promise<{ status: number }>((resolve) => {
                state.paymentWaits.push(resolve);
              }),
          };
        };
      }
      throw new Error(`Unexpected contract function ${name} on ${this.address}`);
    }
  }

  return {
    Contract,
    JsonRpcProvider,
    MaxUint256: 2n ** 256n - 1n,
    NonceManager,
    Wallet,
  };
});

import { createEthersPaymentProvider } from "../src/ethers.js";

const network: PaymentNetwork = {
  rpc_url: "http://127.0.0.1:8545/",
  payment_token_address: `0x${"11".repeat(20)}`,
  payment_vault_address: `0x${"22".repeat(20)}`,
};
const quotes: VerifiedStorageQuote[] = [
  {
    quote: {},
    quoteHash: "33".repeat(32),
    rewardsAddress: `0x${"44".repeat(20)}`,
    amount: "1",
  },
];

beforeEach(() => {
  state.providers = 0;
  state.nonceManagers = 0;
  state.paymentSubmissions = 0;
  state.paymentWaits.length = 0;
});

describe("Ethers private-key payments", () => {
  it("reuses one nonce manager and serializes concurrent submissions", async () => {
    const provider = createEthersPaymentProvider({ privateKey: `0x${"55".repeat(32)}` });
    const context = { report: vi.fn() };

    const first = provider.pay(network, quotes, context);
    const second = provider.pay(network, quotes, context);
    await vi.waitFor(() => expect(state.paymentSubmissions).toBe(1));
    expect(state.providers).toBe(1);
    expect(state.nonceManagers).toBe(1);

    state.paymentWaits.shift()!({ status: 1 });
    await expect(first).resolves.toMatchObject({ transactionHash: "0xpayment1" });
    await vi.waitFor(() => expect(state.paymentSubmissions).toBe(2));
    expect(state.nonceManagers).toBe(1);

    state.paymentWaits.shift()!({ status: 1 });
    await expect(second).resolves.toMatchObject({ transactionHash: "0xpayment2" });
  });
});
