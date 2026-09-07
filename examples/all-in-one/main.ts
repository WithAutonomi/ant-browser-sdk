import { AutonomiClient, type MediaSource } from "@autonomi/browser-sdk";
import { createEthersPaymentProvider } from "@autonomi/browser-sdk/ethers";
import "../shared/style.css";

const bootstrap = element<HTMLInputElement>("bootstrap");
const paymentRpc = element<HTMLInputElement>("payment-rpc");
const wallet = element<HTMLInputElement>("wallet");
const uploadInput = element<HTMLInputElement>("upload-input");
const address = element<HTMLInputElement>("address");
const connection = element<HTMLOutputElement>("connection");
const log = element<HTMLPreElement>("log");
const connectButton = element<HTMLButtonElement>("connect");
const uploadButton = element<HTMLButtonElement>("upload");
const downloadButton = element<HTMLButtonElement>("download");
const streamButton = element<HTMLButtonElement>("stream");
const media = element<HTMLVideoElement>("media");

let client: AutonomiClient | undefined;
let mediaSource: MediaSource | undefined;

connectButton.addEventListener("click", async () => {
  setBusy(connectButton, true);
  try {
    client?.close();
    client = await AutonomiClient.connect(bootstrap.value.trim(), {
      onProgress: ({ operation, message }) => write(`[${operation}] ${message}`),
    });
    connection.value = `Connected to ${client.connection.bootstrap.peerId.slice(0, 16)}…`;
    uploadButton.disabled = false;
    downloadButton.disabled = false;
    streamButton.disabled = false;
  } catch (error) {
    connection.value = "Connection failed";
    writeError(error);
  } finally {
    setBusy(connectButton, false);
  }
});

uploadButton.addEventListener("click", async () => {
  if (!client) return;
  const file = uploadInput.files?.[0];
  if (!file || !wallet.value.trim()) {
    write("Choose a file and enter the funded local-devnet wallet key.");
    return;
  }
  setBusy(uploadButton, true);
  try {
    const result = await client.upload(file, {
      payment: createEthersPaymentProvider({ privateKey: wallet.value.trim(), rpcUrl: paymentRpc.value.trim() }),
    });
    address.value = result.file.address;
    write(`Uploaded ${result.file.name} as ${result.file.address}`);
  } catch (error) {
    writeError(error);
  } finally {
    setBusy(uploadButton, false);
  }
});

downloadButton.addEventListener("click", async () => {
  if (!client) return;
  setBusy(downloadButton, true);
  try {
    const { download } = await client.downloadAndSave(address.value.trim());
    write(`Verified and saved ${download.file.name} (${download.bytes.byteLength} bytes)`);
  } catch (error) {
    writeError(error);
  } finally {
    setBusy(downloadButton, false);
  }
});

streamButton.addEventListener("click", async () => {
  if (!client) return;
  setBusy(streamButton, true);
  try {
    mediaSource?.close();
    mediaSource = await client.createMediaSource(address.value.trim());
    media.src = mediaSource.url;
    media.hidden = false;
    write(`Streaming ${mediaSource.file.name}; use the native media controls to seek.`);
  } catch (error) {
    writeError(error);
  } finally {
    setBusy(streamButton, false);
  }
});

window.addEventListener("beforeunload", () => {
  mediaSource?.close();
  client?.close();
});

function element<T extends HTMLElement>(id: string): T {
  const value = document.querySelector<T>(`#${id}`);
  if (!value) throw new Error(`Example is missing #${id}`);
  return value;
}

function setBusy(button: HTMLButtonElement, busy: boolean): void {
  button.disabled = busy;
}

function write(message: string): void {
  log.textContent += `\n${message}`;
  log.scrollTop = log.scrollHeight;
}

function writeError(error: unknown): void {
  write(error instanceof Error ? error.message : String(error));
  console.error(error);
}
