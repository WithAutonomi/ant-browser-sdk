import { AutonomiError, wrapError } from "./errors.js";
import { PublicFileReader } from "./file-reader.js";
import { getBindings, initializeWasm, type RawNetworkClient } from "./internal/runtime.js";
import { MediaBridge } from "./internal/media.js";
import {
  clearStagedUpload,
  loadStagedRecord,
  stageBlob,
  type StagedUpload,
} from "./internal/staging.js";
import { requestSaveFileHandle, saveDownload } from "./save.js";
import type {
  ClientOptions,
  ConnectionInfo,
  DownloadOptions,
  DownloadResult,
  HelloInfo,
  LookupResult,
  MediaOptions,
  MediaSource,
  Operation,
  OperationOptions,
  PaymentNetwork,
  PaymentProvider,
  ProgressEvent,
  ProgressListener,
  PublicFile,
  SaveOptions,
  SaveResult,
  UploadOptions,
  UploadResult,
  VerifiedStorageQuote,
} from "./types.js";

interface RawDownloadResult {
  content: Uint8Array;
  hash: string;
  file: PublicFile;
  dataMapNode: DownloadResult["dataMapNode"];
}

/** High-level, stateful browser client for direct Autonomi applications. */
export class AutonomiClient {
  readonly connection: ConnectionInfo;

  #network: RawNetworkClient;
  #payment: PaymentProvider | undefined;
  #listeners = new Set<ProgressListener>();
  #closed = false;
  #media?: MediaBridge;

  private constructor(
    network: RawNetworkClient,
    connection: ConnectionInfo,
    options: ClientOptions,
  ) {
    this.#network = network;
    this.connection = connection;
    this.#payment = options.payment;
    if (options.onProgress) this.#listeners.add(options.onProgress);
  }

  /**
   * Initialize WASM, validate a WebRTC Direct bootstrap address, and authenticate the node.
   *
   * Pass one complete, certificate-pinned WebRTC Direct multiaddress.
   */
  static async connect(
    bootstrapMultiaddr: string,
    options: ClientOptions = {},
  ): Promise<AutonomiClient> {
    const report = (message: string): void => {
      options.onProgress?.({ operation: "connect", message });
    };
    try {
      report("Initializing the Autonomi browser core");
      await initializeWasm(options.wasm);
      const { BrowserNodeClient, BrowserNetworkClient } = getBindings();
      const endpoint = parseBootstrapMultiaddr(bootstrapMultiaddr);
      report(`Authenticating bootstrap node from ${endpoint.multiaddr}`);

      const probe = new BrowserNodeClient(endpoint);
      let hello: HelloInfo;
      try {
        hello = (await probe.hello()) as HelloInfo;
      } finally {
        probe.close();
        probe.free();
      }
      const paymentNetwork = normalizePaymentNetwork(hello.payment);
      hello = { ...hello, payment: paymentNetwork };
      const endpoints = [endpoint];
      const network = new BrowserNetworkClient(endpoints);
      const connection: ConnectionInfo = {
        bootstrapMultiaddr: endpoint.multiaddr,
        paymentNetwork,
        bootstrap: hello,
        files: [],
      };
      report(`Connected to authenticated peer ${hello.peer_id}`);
      return new AutonomiClient(network, connection, options);
    } catch (error) {
      throw wrapError("CONNECTION_FAILED", "Could not connect to Autonomi", error);
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  get files(): readonly PublicFile[] {
    return this.connection.files;
  }

  /** Install or replace the wallet/payment adapter used by future uploads. */
  setPaymentProvider(payment?: PaymentProvider): void {
    this.#payment = payment;
  }

  /** Subscribe to progress from all subsequent operations. */
  onProgress(listener: ProgressListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Find the closest known storage nodes to a 32-byte hex address. */
  async findClosest(
    target: string = randomHex(32),
    options: OperationOptions = {},
  ): Promise<LookupResult> {
    this.#assertOpen();
    const report = this.#reporter("lookup", options.onProgress);
    try {
      report(`Finding nodes closest to ${target}`);
      return (await this.#network.findClosest(target, report)) as LookupResult;
    } catch (error) {
      throw wrapError("LOOKUP_FAILED", "Closest-node lookup failed", error);
    }
  }

  /**
   * Self-encrypt, pay, and store a public file.
   *
   * Files and Blobs are encrypted in a worker and staged in IndexedDB. A
   * Uint8Array uses the lower-latency in-memory path.
   */
  async upload(
    input: File | Blob | Uint8Array,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    this.#assertOpen();
    const payment = options.payment ?? this.#payment;
    if (!payment) {
      throw new AutonomiError(
        "PAYMENT_REQUIRED",
        "Uploading requires a PaymentProvider; pass one to connect() or upload()",
      );
    }
    const report = this.#reporter("upload", options.onProgress);
    const payForQuotes = async (
      network: unknown,
      quotes: unknown,
    ): Promise<{ transactionHash?: string; totalAmount: string }> => {
      try {
        const receipt = await payment.pay(
          network as PaymentNetwork,
          quotes as VerifiedStorageQuote[],
          { report },
        );
        if (!/^\d+$/u.test(receipt.totalAmount)) {
          throw new Error("payment provider returned a non-decimal totalAmount");
        }
        return receipt.transactionHash
          ? { transactionHash: receipt.transactionHash, totalAmount: receipt.totalAmount }
          : { totalAmount: receipt.totalAmount };
      } catch (error) {
        throw wrapError("PAYMENT_FAILED", "Storage payment failed", error);
      }
    };

    let staged: StagedUpload | undefined;
    try {
      let result: unknown;
      if (input instanceof Uint8Array) {
        const name = options.name ?? "public-file.bin";
        const contentType = options.contentType ?? "application/octet-stream";
        report(`Self-encrypting ${name}`);
        result = await this.#network.uploadPublicFile(
          input,
          name,
          contentType,
          this.connection.paymentNetwork,
          payForQuotes,
          report,
        );
      } else if (input instanceof Blob) {
        const isFile = typeof File === "function" && input instanceof File;
        const name = options.name ?? (isFile ? input.name : "public-file.bin");
        const contentType =
          options.contentType || input.type || "application/octet-stream";
        staged = await stageBlob(input, name, contentType, report);
        result = await this.#network.uploadStagedPublicFile(
          staged.staged,
          this.connection.paymentNetwork,
          (index: unknown, address: unknown, size: unknown) =>
            loadStagedRecord(
              staged!.sessionId,
              Number(index),
              String(address),
              Number(size),
            ),
          payForQuotes,
          report,
        );
      } else {
        throw new TypeError("upload input must be a File, Blob, or Uint8Array");
      }
      const upload = result as UploadResult;
      this.#rememberFile(upload.file);
      return upload;
    } catch (error) {
      throw wrapError("UPLOAD_FAILED", "Public file upload failed", error);
    } finally {
      if (staged) {
        try {
          await clearStagedUpload(staged);
        } catch (error) {
          report(`Could not clear temporary upload records: ${String(error)}`);
        }
      }
    }
  }

  /** Download, reconstruct, and BLAKE3-verify a complete public file. */
  async download(
    file: string | PublicFile,
    options: DownloadOptions = {},
  ): Promise<DownloadResult> {
    this.#assertOpen();
    const concurrency = options.concurrency ?? 3;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) {
      throw new AutonomiError(
        "DOWNLOAD_FAILED",
        "Download concurrency must be an integer from 1 through 6",
      );
    }
    const report = this.#reporter("download", options.onProgress);
    try {
      const raw = (await this.#network.downloadPublicFile(
        file,
        concurrency,
        report,
      )) as RawDownloadResult;
      this.#rememberFile(raw.file);
      const blobBytes = new Uint8Array(raw.content.byteLength);
      blobBytes.set(raw.content);
      return {
        bytes: raw.content,
        blob: new Blob([blobBytes], {
          type: raw.file.content_type || "application/octet-stream",
        }),
        hash: raw.hash,
        file: raw.file,
        dataMapNode: raw.dataMapNode,
      };
    } catch (error) {
      throw wrapError("DOWNLOAD_FAILED", "Public file download failed", error);
    }
  }

  /** Choose a destination, then download, verify, and save a public file. */
  async downloadAndSave(
    file: string | PublicFile,
    options: DownloadOptions & SaveOptions = {},
  ): Promise<{ download: DownloadResult; save: SaveResult }> {
    this.#assertOpen();
    const knownFile =
      typeof file === "string"
        ? this.files.find(
            (candidate) => normalizeAddress(candidate.address) === normalizeAddress(file),
          )
        : file;
    const suggestedName =
      options.suggestedName ?? knownFile?.name;
    const fileHandle =
      options.fileHandle ??
      (options.useFilePicker === false
        ? undefined
        : await requestSaveFileHandle(suggestedName));
    const download = await this.download(file, options);
    const save = await saveDownload(
      download,
      fileHandle
        ? { ...options, fileHandle }
        : { ...options, useFilePicker: false },
    );
    return { download, save };
  }

  /** Open a bounded random-access reader without reconstructing the whole file. */
  async openFile(
    file: string | PublicFile,
    options: OperationOptions = {},
  ): Promise<PublicFileReader> {
    this.#assertOpen();
    const report = this.#reporter("open-file", options.onProgress);
    try {
      const raw = await this.#network.openPublicFile(file, report);
      const address = typeof file === "string" ? normalizeAddress(file) : file.address;
      return new PublicFileReader(raw, address);
    } catch (error) {
      throw wrapError("OPEN_FILE_FAILED", "Could not open the public file", error);
    }
  }

  /**
   * Create a seekable URL suitable for `<video>` or `<audio>`.
   *
   * Copy `node_modules/@autonomi/browser-sdk/dist/autonomi-stream-sw.js` to
   * your site's public root before using the default serviceWorkerUrl.
   */
  async createMediaSource(
    file: string | PublicFile,
    options: MediaOptions = {},
  ): Promise<MediaSource> {
    this.#assertOpen();
    const report = this.#reporter("media", options.onProgress);
    report("Opening an Autonomi random-access media reader");
    const reader = await this.openFile(file, {
      onProgress: (event) => report(event.message),
    });
    try {
      this.#media ??= new MediaBridge();
      const source = await this.#media.attach(reader, options);
      report(`Media source ready for ${source.file.name}`);
      return source;
    } catch (error) {
      reader.close();
      throw wrapError("MEDIA_FAILED", "Could not create the media source", error);
    }
  }

  /** Close WebRTC associations, readers owned by media sources, and caches. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#media?.close();
    this.#network.close();
    this.#network.free();
    this.#listeners.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new AutonomiError("CLIENT_CLOSED", "Autonomi client is closed");
  }

  #reporter(operation: Operation, local?: ProgressListener): (message: string) => void {
    return (message: string): void => {
      const event: ProgressEvent = { operation, message };
      for (const listener of this.#listeners) safelyNotify(listener, event);
      if (local && !this.#listeners.has(local)) safelyNotify(local, event);
    };
  }

  #rememberFile(file: PublicFile): void {
    const index = this.connection.files.findIndex((known) => known.address === file.address);
    if (index === -1) this.connection.files.push(file);
    else this.connection.files[index] = file;
  }
}

function parseBootstrapMultiaddr(value: string): { multiaddr: string } {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AutonomiError(
      "INVALID_SOURCE",
      "A WebRTC Direct bootstrap multiaddress is required",
    );
  }
  try {
    return getBindings().parseWebRtcDirectMultiaddr(value);
  } catch (error) {
    throw new AutonomiError(
      "INVALID_SOURCE",
      "Invalid WebRTC Direct bootstrap multiaddress",
      error,
    );
  }
}

function normalizePaymentNetwork(value: unknown): PaymentNetwork {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("bootstrap node advertises invalid payment configuration");
  }
  const payment = value as Record<string, unknown>;
  const rpcValue = requiredString(payment.rpc_url, "payment RPC URL");
  let rpcUrl: URL;
  try {
    rpcUrl = new URL(rpcValue);
  } catch {
    throw new TypeError("bootstrap node advertises an invalid payment RPC URL");
  }
  if (!/^https?:$/u.test(rpcUrl.protocol)) {
    throw new TypeError("bootstrap node payment RPC URL must use HTTP or HTTPS");
  }
  if (rpcUrl.username !== "" || rpcUrl.password !== "") {
    throw new TypeError("bootstrap node payment RPC URL must not contain credentials");
  }
  return {
    rpc_url: rpcUrl.toString(),
    payment_token_address: normalizeEvmAddress(
      requiredString(payment.payment_token_address, "payment token address"),
    ),
    payment_vault_address: normalizeEvmAddress(
      requiredString(payment.payment_vault_address, "payment vault address"),
    ),
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`bootstrap node advertises an invalid ${name}`);
  }
  return value;
}

function normalizeEvmAddress(value: string): string {
  const normalized = value
    .trim()
    .replace(/^0x/iu, "")
    .replaceAll(":", "")
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new TypeError("bootstrap node advertises an invalid payment contract address");
  }
  return `0x${normalized}`;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function normalizeAddress(value: string): string {
  return value.trim().replace(/^0x/iu, "").replaceAll(":", "").toLowerCase();
}

function safelyNotify(listener: ProgressListener, event: ProgressEvent): void {
  try {
    listener(event);
  } catch {
    // UI progress callbacks must never change a network operation's result.
  }
}
