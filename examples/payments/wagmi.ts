import {
  AutonomiClient,
  type UploadResult,
} from "@autonomi/browser-sdk";
import { createWagmiPaymentProvider } from "@autonomi/browser-sdk/wagmi";
import type { Config } from "@wagmi/core";

/** Upload with the wallet currently connected through the application's Wagmi config. */
export async function uploadWithWagmiWallet(
  bootstrapMultiaddr: string,
  file: File,
  config: Config,
): Promise<UploadResult> {
  const payment = createWagmiPaymentProvider({
    config,
    approval: "exact",
  });
  const client = await AutonomiClient.connect(bootstrapMultiaddr, { payment });
  try {
    return await client.upload(file);
  } finally {
    client.close();
  }
}
