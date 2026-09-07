import { AutonomiClient } from "@autonomi/browser-sdk";
import { createWagmiPaymentProvider } from "@autonomi/browser-sdk/wagmi";
import {
  connect,
  createConfig,
  disconnect,
  injected,
  switchChain,
  type Config,
} from "@wagmi/core";
import { defineChain, http } from "viem";
import "../shared/style.css";
import { createLogger, element } from "../shared/ui.js";

const bootstrap = element<HTMLInputElement>("bootstrap");
const paymentRpc = element<HTMLInputElement>("payment-rpc");
const fileInput = element<HTMLInputElement>("file");
const nodeState = element<HTMLOutputElement>("node-state");
const walletState = element<HTMLOutputElement>("wallet-state");
const result = element<HTMLOutputElement>("result");
const connectNodeButton = element<HTMLButtonElement>("connect-node");
const connectWalletButton = element<HTMLButtonElement>("connect-wallet");
const uploadButton = element<HTMLButtonElement>("upload");
const { write, writeError } = createLogger(element<HTMLPreElement>("log"));

let client: AutonomiClient | undefined;
let wagmiConfig: Config | undefined;
let paymentChainId: number | undefined;

connectNodeButton.addEventListener("click", async () => {
  connectNodeButton.disabled = true;
  try {
    client?.close();
    client = await AutonomiClient.connect(bootstrap.value.trim(), {
      onProgress: ({ operation, message }) => write(`[${operation}] ${message}`),
    });
    const rpcUrl = new URL(paymentRpc.value.trim()).toString();
    paymentChainId = client.connection.paymentNetwork.chainId;
    const paymentChain = defineChain({
      id: paymentChainId,
      name: `Autonomi payment chain ${paymentChainId}`,
      nativeCurrency: { name: "Gas token", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    wagmiConfig = createConfig({
      chains: [paymentChain],
      connectors: [injected()],
      transports: { [paymentChain.id]: http(rpcUrl) },
    });
    nodeState.value = `Connected; payment chain ${paymentChainId}`;
    walletState.value = "Ready to connect a wallet";
    connectWalletButton.disabled = false;
    uploadButton.disabled = true;
  } catch (error) {
    client = undefined;
    wagmiConfig = undefined;
    paymentChainId = undefined;
    nodeState.value = "Connection failed";
    connectWalletButton.disabled = true;
    uploadButton.disabled = true;
    writeError(error);
  } finally {
    connectNodeButton.disabled = false;
  }
});

connectWalletButton.addEventListener("click", async () => {
  if (!wagmiConfig || paymentChainId === undefined) return;
  connectWalletButton.disabled = true;
  try {
    if (wagmiConfig.state.status === "connected") await disconnect(wagmiConfig);
    const connector = wagmiConfig.connectors[0];
    if (!connector) throw new Error("No injected Wagmi connector is available");
    const connection = await connect(wagmiConfig, { connector });
    if (connection.chainId !== paymentChainId) {
      await switchChain(wagmiConfig, { chainId: paymentChainId });
    }
    walletState.value = `Connected as ${connection.accounts[0]}`;
    uploadButton.disabled = false;
  } catch (error) {
    walletState.value = "Wallet connection failed";
    uploadButton.disabled = true;
    writeError(error);
  } finally {
    connectWalletButton.disabled = false;
  }
});

uploadButton.addEventListener("click", async () => {
  const file = fileInput.files?.[0];
  if (!client || !wagmiConfig || !file) {
    write("Connect the node and wallet, then choose a file.");
    return;
  }
  uploadButton.disabled = true;
  result.value = "";
  try {
    const uploaded = await client.upload(file, {
      payment: createWagmiPaymentProvider({ config: wagmiConfig, approval: "exact" }),
    });
    result.value = `Uploaded as ${uploaded.file.address}`;
  } catch (error) {
    writeError(error);
  } finally {
    uploadButton.disabled = false;
  }
});

window.addEventListener("beforeunload", () => client?.close());
