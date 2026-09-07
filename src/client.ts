import { AutonomiError, wrapError } from "./errors.js";
import { PublicFileReader } from "./file-reader.js";
import { abortable, isAbort, throwIfAborted } from "./internal/abort.js";
import { getBindings, initializeClientWasm, type RawNetworkClient } from "./internal/runtime.js";
import { MediaBridge } from "./internal/media.js";
import {
  clearStagedUpload,
  loadStagedRecord,
  stageBlob,
  type StagedUpload,
  type WorkerWasmSource,
} from "./internal/staging.js";
import { operationId, progressReporter, type Reporter } from "./internal/progress.js";
import { snapshot } from "./internal/snapshot.js";
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

interface OperationScope {
  id: string;
  reporters: Reporter[];
  signal: AbortSignal;
  finish(): void;
}

/** High-level, stateful browser client for direct Autonomi applications. */
export class AutonomiClient {
  #connection: Omit<ConnectionInfo, "files">;
  #files: PublicFile[] = [];

  #network: RawNetworkClient;
  #payment: PaymentProvider | undefined;
  #listeners = new Set<ProgressListener>();
  #operations = new Set<AbortController>();
  #closed = false;
  #media?: MediaBridge;
  #workerWasm: WorkerWasmSource | undefined;

  private constructor(
    network: RawNetworkClient,
    connection: ConnectionInfo,
    options: ClientOptions,
    workerWasm?: WorkerWasmSource,
  ) {
    this.#network = network;
    const { files, ...metadata } = connection;
    this.#connection = snapshot(metadata);
    this.#files = files.map((file) => snapshot(file));
    this.#payment = options.payment;
    this.#workerWasm = workerWasm;
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
    const report = progressReporter("connect", operationId(), "initializing", (event) => {
      if (options.onProgress) safelyNotify(options.onProgress, event);
    }, options.signal);
    let network: RawNetworkClient | undefined;
    try {
      throwIfAborted(options.signal);
      report("Initializing the Autonomi browser core");
      const workerWasm = await abortable(initializeClientWasm(options.wasm), options.signal);
      const { BrowserNodeClient, BrowserNetworkClient } = getBindings();
      const endpoint = parseBootstrapMultiaddr(bootstrapMultiaddr);
      report(`Authenticating bootstrap node from ${endpoint.multiaddr}`, { phase: "connecting" });

      const probe = new BrowserNodeClient(endpoint);
      let hello: HelloInfo;
      try {
        hello = (await abortable(probe.hello(), options.signal)) as HelloInfo;
      } finally {
        try {
          probe.close();
        } finally {
          probe.free();
        }
      }
      const paymentNetwork = normalizePaymentNetwork(hello.payment);
      hello = { ...hello, payment: paymentNetwork };
      const endpoints = [endpoint];
      throwIfAborted(options.signal);
      network = new BrowserNetworkClient(endpoints);
      const connection: ConnectionInfo = {
        bootstrapMultiaddr: endpoint.multiaddr,
        paymentNetwork,
        bootstrap: hello,
        files: [],
      };
      report(`Connected to authenticated peer ${hello.peer_id}`, { phase: "complete" });
      throwIfAborted(options.signal);
      report.finish();
      return new AutonomiClient(network, connection, options, workerWasm);
    } catch (error) {
      report.finish();
      if (network) closeNetwork(network);
      if (isAbort(error, options.signal)) throw error;
      throw wrapError("CONNECTION_FAILED", "Could not connect to Autonomi", error);
    }
  }

  /** A frozen snapshot; later operations produce new snapshots. */
  get connection(): ConnectionInfo {
    return Object.freeze({ ...this.#connection, files: this.files });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get files(): readonly PublicFile[] {
    return Object.freeze([...this.#files]);
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
    const operation = this.#startOperation(options.signal);
    const report = this.#reporter("lookup", options.onProgress, operation);
    try {
      report(`Finding nodes closest to ${target}`);
      const result = (await abortable(
        this.#network.findClosest(target, report),
        operation.signal,
      )) as LookupResult;
      report("Closest-node lookup complete", { phase: "complete" });
      return result;
    } catch (error) {
      if (isAbort(error, operation.signal)) throw error;
      throw wrapError("LOOKUP_FAILED", "Closest-node lookup failed", error);
    } finally {
      operation.finish();
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
    const operation = this.#startOperation(options.signal);
    const report = this.#reporter("upload", options.onProgress, operation);
    const cleanupReport = this.#reporter("upload", options.onProgress, operation, false);
    const payForQuotes = async (
      network: unknown,
      quotes: unknown,
    ): Promise<{ transactionHash?: string; totalAmount: string }> => {
      try {
        throwIfAborted(operation.signal);
        report("Waiting for storage payment", { phase: "payment", total: (quotes as VerifiedStorageQuote[]).length, unit: "quotes" });
        const receipt = await abortable(
          payment.pay(
            network as PaymentNetwork,
            quotes as VerifiedStorageQuote[],
            { report, signal: operation.signal },
          ),
          operation.signal,
        );
        if (!/^\d+$/u.test(receipt.totalAmount)) {
          throw new Error("payment provider returned a non-decimal totalAmount");
        }
        report("Storage payment confirmed", { phase: "uploading" });
        return receipt.transactionHash
          ? { transactionHash: receipt.transactionHash, totalAmount: receipt.totalAmount }
          : { totalAmount: receipt.totalAmount };
      } catch (error) {
        if (isAbort(error, operation.signal)) throw error;
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
        result = await abortable(
          this.#network.uploadPublicFile(
            input,
            name,
            contentType,
            this.#connection.paymentNetwork,
            payForQuotes,
            report,
          ),
          operation.signal,
        );
      } else if (input instanceof Blob) {
        const isFile = typeof File === "function" && input instanceof File;
        const name = options.name ?? (isFile ? input.name : "public-file.bin");
        const contentType =
          options.contentType || input.type || "application/octet-stream";
        staged = await stageBlob(
          input,
          name,
          contentType,
          report,
          this.#workerWasm,
          operation.signal,
        );
        throwIfAborted(operation.signal);
        result = await abortable(
          this.#network.uploadStagedPublicFile(
            staged.staged,
            this.#connection.paymentNetwork,
            (index: unknown, address: unknown, size: unknown) =>
              loadStagedRecord(
                staged!.sessionId,
                Number(index),
                String(address),
                Number(size),
                operation.signal,
              ),
            payForQuotes,
            report,
          ),
          operation.signal,
        );
      } else {
        throw new TypeError("upload input must be a File, Blob, or Uint8Array");
      }
      throwIfAborted(operation.signal);
      const upload = result as UploadResult;
      this.#rememberFile(upload.file);
      report(`Uploaded ${upload.file.name}`, { phase: "complete", completed: upload.file.size, total: upload.file.size, unit: "bytes" });
      return upload;
    } catch (error) {
      if (isAbort(error, operation.signal)) throw error;
      throw wrapError("UPLOAD_FAILED", "Public file upload failed", error);
    } finally {
      if (staged) {
        try {
          await clearStagedUpload(staged);
        } catch (error) {
          cleanupReport(`Could not clear temporary upload records: ${String(error)}`, { phase: "cleanup" });
        }
      }
      operation.finish();
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
    const operation = this.#startOperation(options.signal);
    const report = this.#reporter("download", options.onProgress, operation);
    try {
      throwIfAborted(operation.signal);
      const raw = (await abortable(
        this.#network.downloadPublicFile(file, concurrency, report),
        operation.signal,
      )) as RawDownloadResult;
      throwIfAborted(operation.signal);
      this.#rememberFile(raw.file);
      report(`Downloaded ${raw.file.name}`, { phase: "complete", completed: raw.content.byteLength, total: raw.content.byteLength, unit: "bytes" });
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
      if (isAbort(error, operation.signal)) throw error;
      throw wrapError("DOWNLOAD_FAILED", "Public file download failed", error);
    } finally {
      operation.finish();
    }
  }

  /** Choose a destination, then download, verify, and save a public file. */
  async downloadAndSave(
    file: string | PublicFile,
    options: DownloadOptions & SaveOptions = {},
  ): Promise<{ download: DownloadResult; save: SaveResult }> {
    const operation = this.#startOperation(options.signal);
    try {
      const knownFile =
        typeof file === "string"
          ? this.files.find(
              (candidate) => normalizeAddress(candidate.address) === normalizeAddress(file),
            )
          : file;
      const suggestedName = options.suggestedName ?? knownFile?.name;
      const fileHandle =
        options.fileHandle ??
        (options.useFilePicker === false
          ? undefined
          : await requestSaveFileHandle(suggestedName, operation.signal));
      const download = await this.download(file, {
        ...options,
        signal: operation.signal,
      });
      const save = await saveDownload(
        download,
        fileHandle
          ? { ...options, fileHandle, signal: operation.signal }
          : { ...options, useFilePicker: false, signal: operation.signal },
      );
      return { download, save };
    } finally {
      operation.finish();
    }
  }

  /** Open a bounded random-access reader without reconstructing the whole file. */
  async openFile(
    file: string | PublicFile,
    options: OperationOptions = {},
  ): Promise<PublicFileReader> {
    const operation = this.#startOperation(options.signal);
    const report = this.#reporter("open-file", options.onProgress, operation);
    let raw: Awaited<ReturnType<RawNetworkClient["openPublicFile"]>> | undefined;
    try {
      throwIfAborted(operation.signal);
      raw = await abortable(
        this.#network.openPublicFile(file, report),
        operation.signal,
        undefined,
        closeReader,
      );
      throwIfAborted(operation.signal);
      const address = typeof file === "string" ? normalizeAddress(file) : file.address;
      const reader = new PublicFileReader(raw, address);
      report(`Opened ${reader.name}`, { phase: "complete" });
      raw = undefined;
      return reader;
    } catch (error) {
      if (raw) closeReader(raw);
      if (isAbort(error, operation.signal)) throw error;
      throw wrapError("OPEN_FILE_FAILED", "Could not open the public file", error);
    } finally {
      operation.finish();
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
    const operation = this.#startOperation(options.signal);
    const report = this.#reporter("media", options.onProgress, operation);
    let reader: PublicFileReader | undefined;
    let source: MediaSource | undefined;
    try {
      report("Opening an Autonomi random-access media reader");
      reader = await this.openFile(file, {
        onProgress: (event) => report(event.message),
        signal: operation.signal,
      });
      this.#media ??= new MediaBridge();
      source = await this.#media.attach(reader, {
        ...options,
        signal: operation.signal,
      });
      report(`Media source ready for ${source.file.name}`, { phase: "complete" });
      return source;
    } catch (error) {
      try {
        if (source) source.close();
        else reader?.close();
      } catch {
        // Preserve the media setup or cancellation error.
      }
      if (isAbort(error, operation.signal)) throw error;
      throw wrapError("MEDIA_FAILED", "Could not create the media source", error);
    } finally {
      operation.finish();
    }
  }

  /** Close WebRTC associations, readers owned by media sources, and caches. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const reason = new DOMException("The Autonomi client was closed", "AbortError");
    for (const operation of this.#operations) operation.abort(reason);
    this.#operations.clear();
    try {
      this.#media?.close();
    } catch {
      // Continue closing the network if a media reader cleanup failed.
    } finally {
      closeNetwork(this.#network);
      this.#listeners.clear();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new AutonomiError("CLIENT_CLOSED", "Autonomi client is closed");
  }

  #reporter(
    operation: Operation,
    local: ProgressListener | undefined,
    scope: OperationScope,
    cancellable = true,
  ): Reporter {
    const phases = {
      connect: "connecting", lookup: "lookup", upload: "preparing",
      download: "downloading", "open-file": "opening", media: "media",
    } as const;
    const report = progressReporter(operation, scope.id, phases[operation], (event) => {
      for (const listener of this.#listeners) safelyNotify(listener, event);
      if (local && !this.#listeners.has(local)) safelyNotify(local, event);
    }, cancellable ? scope.signal : undefined);
    scope.reporters.push(report);
    return report;
  }

  #startOperation(externalSignal?: AbortSignal): OperationScope {
    this.#assertOpen();
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) forwardAbort();
    else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    this.#operations.add(controller);
    let finished = false;
    const reporters: Reporter[] = [];
    return {
      id: operationId(),
      reporters,
      signal: controller.signal,
      finish: () => {
        if (finished) return;
        finished = true;
        reporters.forEach((reporter) => reporter.finish());
        externalSignal?.removeEventListener("abort", forwardAbort);
        this.#operations.delete(controller);
      },
    };
  }

  #rememberFile(file: PublicFile): void {
    const index = this.#files.findIndex((known) => known.address === file.address);
    if (index === -1) this.#files.push(snapshot(file));
    else this.#files[index] = snapshot(file);
  }
}

function closeReader(reader: Awaited<ReturnType<RawNetworkClient["openPublicFile"]>>): void {
  try {
    reader.close();
  } catch {
    // Best-effort cleanup for a reader that resolved after its operation aborted.
  }
  try {
    reader.free();
  } catch {
    // Best-effort cleanup for a reader that resolved after its operation aborted.
  }
}

function closeNetwork(network: RawNetworkClient): void {
  try {
    network.close();
  } catch {
    // Continue releasing the WASM allocation even if transport shutdown failed.
  }
  try {
    network.free();
  } catch {
    // Closing is idempotent and best effort.
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
