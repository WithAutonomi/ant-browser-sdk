import {
  AutonomiClient,
  type UploadResult,
} from "@autonomi/browser-sdk";
import { createEthersPaymentProvider } from "@autonomi/browser-sdk/ethers";
import {
  BrowserProvider,
  JsonRpcProvider,
  type Eip1193Provider,
} from "ethers";

/** Upload with the EIP-1193 wallet already connected to the page. */
export async function uploadWithEthersWallet(
  bootstrapMultiaddr: string,
  file: File,
): Promise<UploadResult> {
  const injected = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
  if (!injected) throw new Error("No injected EVM wallet is available");

  const payment = createEthersPaymentProvider({
    getSigner: async (network) => {
      const walletProvider = new BrowserProvider(injected);
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

  const client = await AutonomiClient.connect(bootstrapMultiaddr, { payment });
  try {
    return await client.upload(file);
  } finally {
    client.close();
  }
}
