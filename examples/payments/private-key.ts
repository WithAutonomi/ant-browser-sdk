import {
  AutonomiClient,
  type UploadResult,
} from "@autonomi/browser-sdk";
import { createEthersPaymentProvider } from "@autonomi/browser-sdk/ethers";

/**
 * Upload with a private key. Use only a disposable development wallet in a browser.
 * The adapter signs automatically but still waits for confirmed transaction receipts.
 */
export async function uploadWithPrivateKey(
  bootstrapMultiaddr: string,
  file: File,
  privateKey: string,
): Promise<UploadResult> {
  const payment = createEthersPaymentProvider({ privateKey });
  const client = await AutonomiClient.connect(bootstrapMultiaddr, { payment });
  try {
    return await client.upload(file);
  } finally {
    client.close();
  }
}
