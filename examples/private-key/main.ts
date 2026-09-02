import { AutonomiClient } from "@autonomi/browser-sdk";
import { createEthersPaymentProvider } from "@autonomi/browser-sdk/ethers";
import "../shared/style.css";
import { createLogger, element } from "../shared/ui.js";

const bootstrap = element<HTMLInputElement>("bootstrap");
const privateKey = element<HTMLInputElement>("private-key");
const fileInput = element<HTMLInputElement>("file");
const connection = element<HTMLOutputElement>("connection");
const result = element<HTMLOutputElement>("result");
const connectButton = element<HTMLButtonElement>("connect");
const uploadButton = element<HTMLButtonElement>("upload");
const { write, writeError } = createLogger(element<HTMLPreElement>("log"));

let client: AutonomiClient | undefined;

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  try {
    client?.close();
    client = await AutonomiClient.connect(bootstrap.value.trim(), {
      onProgress: ({ operation, message }) => write(`[${operation}] ${message}`),
    });
    connection.value = `Connected to ${client.connection.bootstrap.peer_id.slice(0, 16)}…`;
    uploadButton.disabled = false;
  } catch (error) {
    client = undefined;
    connection.value = "Connection failed";
    uploadButton.disabled = true;
    writeError(error);
  } finally {
    connectButton.disabled = false;
  }
});

uploadButton.addEventListener("click", async () => {
  const file = fileInput.files?.[0];
  const key = privateKey.value.trim();
  if (!client || !file || !key) {
    write("Connect, choose a file, and enter a disposable funded private key.");
    return;
  }
  uploadButton.disabled = true;
  result.value = "";
  try {
    const uploaded = await client.upload(file, {
      payment: createEthersPaymentProvider({ privateKey: key }),
    });
    result.value = `Uploaded as ${uploaded.file.address}`;
  } catch (error) {
    writeError(error);
  } finally {
    uploadButton.disabled = false;
  }
});

window.addEventListener("beforeunload", () => client?.close());
