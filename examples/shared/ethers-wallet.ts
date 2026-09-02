import type { PaymentProvider } from "@autonomi/browser-sdk";
import { createEthersPaymentProvider } from "@autonomi/browser-sdk/ethers";
import {
  BrowserProvider,
  JsonRpcProvider,
  type Eip1193Provider,
} from "ethers";

export function injectedWallet(): Eip1193Provider {
  const provider = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
  if (!provider) throw new Error("No injected EVM wallet is available");
  return provider;
}

export async function connectInjectedWallet(): Promise<string> {
  const signer = await new BrowserProvider(injectedWallet()).getSigner();
  return signer.getAddress();
}

/** Resolve the active account only when payment starts, allowing wallet switches. */
export function connectedEthersPaymentProvider(): PaymentProvider {
  return createEthersPaymentProvider({
    getSigner: async (network) => {
      const walletProvider = new BrowserProvider(injectedWallet());
      const paymentProvider = new JsonRpcProvider(network.rpc_url);
      const [walletNetwork, paymentNetwork] = await Promise.all([
        walletProvider.getNetwork(),
        paymentProvider.getNetwork(),
      ]);
      if (walletNetwork.chainId !== paymentNetwork.chainId) {
        throw new Error(
          `Switch the connected wallet to payment chain ${paymentNetwork.chainId}`,
        );
      }
      return walletProvider.getSigner();
    },
    approval: "exact",
  });
}
