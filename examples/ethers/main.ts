import { AutonomiClient } from "@autonomi/browser-sdk";
import {
  connectInjectedWallet,
  connectedEthersPaymentProvider,
} from "../shared/ethers-wallet.js";
import "../shared/style.css";
import { createLogger, element } from "../shared/ui.js";

const bootstrap = element<HTMLInputElement>("bootstrap");
const fileInput = element<HTMLInputElement>("file");
const nodeState = element<HTMLOutputElement>("node-state");
const walletState = element<HTMLOutputElement>("wallet-state");
const result = element<HTMLOutputElement>("result");
const connectNodeButton = element<HTMLButtonElement>("connect-node");
const connectWalletButton = element<HTMLButtonElement>("connect-wallet");
const uploadButton = element<HTMLButtonElement>("upload");
const { write, writeError } = createLogger(element<HTMLPreElement>("log"));

let client: AutonomiClient | undefined;

connectNodeButton.addEventListener("click", async () => {
  connectNodeButton.disabled = true;
  try {
    client?.close();
    client = await AutonomiClient.connect(bootstrap.value.trim(), {
      onProgress: ({ operation, message }) => write(`[${operation}] ${message}`),
    });
    nodeState.value = `Connected to ${client.connection.bootstrap.peerId.slice(0, 16)}…`;
    uploadButton.disabled = false;
  } catch (error) {
    client = undefined;
    nodeState.value = "Connection failed";
    uploadButton.disabled = true;
    writeError(error);
  } finally {
    connectNodeButton.disabled = false;
  }
});

connectWalletButton.addEventListener("click", async () => {
  connectWalletButton.disabled = true;
  try {
    const address = await connectInjectedWallet();
    walletState.value = `Connected as ${address}`;
  } catch (error) {
    walletState.value = "Wallet connection failed";
    writeError(error);
  } finally {
    connectWalletButton.disabled = false;
  }
});

uploadButton.addEventListener("click", async () => {
  const file = fileInput.files?.[0];
  if (!client || !file) {
    write("Connect to a node and choose a file first.");
    return;
  }
  uploadButton.disabled = true;
  result.value = "";
  try {
    const uploaded = await client.upload(file, {
      payment: connectedEthersPaymentProvider(),
    });
    result.value = `Uploaded as ${uploaded.file.address}`;
  } catch (error) {
    writeError(error);
  } finally {
    uploadButton.disabled = false;
  }
});

window.addEventListener("beforeunload", () => client?.close());
