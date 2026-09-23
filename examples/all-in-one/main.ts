import {
  AutonomiClient, type ClientOptions, type MediaSource, type PrivateFileReference, type UploadOptions,
} from "@withautonomi/browser-sdk";
import { createEthersPaymentProvider } from "@withautonomi/browser-sdk/ethers";
import "../shared/style.css";

const bootstrap = element<HTMLInputElement>("bootstrap");
const paymentRpc = element<HTMLInputElement>("payment-rpc");
const wallet = element<HTMLInputElement>("wallet");
const uploadInput = element<HTMLInputElement>("upload-input");
const visibility = element<HTMLSelectElement>("visibility");
const paymentMode = element<HTMLSelectElement>("payment-mode");
const address = element<HTMLInputElement>("address");
const dataMapInput = element<HTMLInputElement>("datamap-input");
const connection = element<HTMLOutputElement>("connection");
const log = element<HTMLPreElement>("log");
const connectButton = element<HTMLButtonElement>("connect");
const uploadButton = element<HTMLButtonElement>("upload");
const saveDataMapButton = element<HTMLButtonElement>("save-datamap");
const downloadButton = element<HTMLButtonElement>("download");
const streamButton = element<HTMLButtonElement>("stream");
const media = element<HTMLVideoElement>("media");

let client: AutonomiClient | undefined;
let mediaSource: MediaSource | undefined;
// A private file is read through its DataMap; the page keeps it only in memory.
let privateFile: PrivateFileReference | undefined;

connectButton.addEventListener("click", async () => {
  setBusy(connectButton, true);
  try {
    client?.close();
    const options: ClientOptions = {
      onProgress: ({ operation, message }) => write(`[${operation}] ${message}`),
    };
    const seed = bootstrap.value.trim();
    client = seed ? await AutonomiClient.connect(seed, options) : await AutonomiClient.connect(options);
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
      visibility: visibility.value as NonNullable<UploadOptions["visibility"]>,
      paymentMode: paymentMode.value as NonNullable<UploadOptions["paymentMode"]>,
    });
    write(`Stored ${result.records} records using ${result.paymentMode} payment for ${result.storageCostAtto} atto-tokens`);
    if ("address" in result.file) {
      privateFile = undefined;
      address.value = result.file.address;
      write(`Uploaded ${result.file.name} as ${result.file.address}`);
    } else {
      privateFile = result.file;
      address.value = "";
      write(`Uploaded private ${result.file.name}; save its DataMap to read it after leaving this page.`);
    }
    saveDataMapButton.hidden = privateFile === undefined;
  } catch (error) {
    writeError(error);
  } finally {
    setBusy(uploadButton, false);
  }
});

saveDataMapButton.addEventListener("click", () => {
  if (!privateFile) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([privateFile.dataMap.slice()], { type: "application/octet-stream" }));
  link.download = `${privateFile.name ?? "private-file"}.datamap`;
  link.click();
  URL.revokeObjectURL(link.href);
});

dataMapInput.addEventListener("change", async () => {
  const selected = dataMapInput.files?.[0];
  if (!selected) return;
  privateFile = { dataMap: new Uint8Array(await selected.arrayBuffer()), name: selected.name.replace(/\.datamap$/u, "") };
  address.value = "";
  write(`Loaded the private DataMap for ${privateFile.name}`);
});

address.addEventListener("input", () => {
  privateFile = undefined;
  saveDataMapButton.hidden = true;
});

/** A typed address reads a public file; otherwise the loaded private DataMap is used. */
function readTarget(): string | PrivateFileReference {
  return privateFile ?? address.value.trim();
}

downloadButton.addEventListener("click", async () => {
  if (!client) return;
  setBusy(downloadButton, true);
  try {
    const { download } = await client.downloadAndSave(readTarget());
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
    mediaSource = await client.createMediaSource(readTarget());
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
