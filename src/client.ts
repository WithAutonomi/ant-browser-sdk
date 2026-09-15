import { snapshotNetworkProfile, type NetworkProfile } from "./network-profile.js";
import { saveUploadCheckpoint } from "./internal/record-store.js";
import { assertFileSize, SDK_LIMITS } from "./limits.js";
import {
  coreFileReference, helloFromCore, lookupFromCore, nodeFromCore, publicFileFromCore,
  type CoreHelloInfo, type CoreLookupResult, type CoreNetworkNode, type CorePublicFile,
} from "./internal/protocol.js";
import { AutonomiError, UploadError, wrapError } from "./errors.js";
import { createPublicFileReader, type PublicFileReader } from "./file-reader.js";
import { abortable, isAbort, throwIfAborted } from "./internal/abort.js";
import { getBindings, initializeClientWasm, type RawNetworkClient } from "./internal/runtime.js";
import { MediaBridge } from "./internal/media.js";
import {
  loadStagedRecord,
  stageBlob,
  type WorkerWasmSource,
} from "./internal/staging.js";
import { operationId, progressReporter, type Reporter, type OperationOutcome } from "./internal/progress.js";
import {
  awaitUploadSettlement, claimUpload, paidReceipt, releaseUpload, retainUpload,
  uploadResult, uploadSettlement, recordPayment, reconcilePayments, trackPayment, type RetainedUpload, type TrackedPayment,
} from "./internal/upload-recovery.js";
import { snapshot } from "./internal/snapshot.js";
import {
  corePaymentNetwork, paymentNetworkFromCore, assertPaymentChainId, type CorePaymentNetwork,
} from "./internal/payment-network.js";
import { requestSaveFileHandle, saveDownload } from "./save.js";
import type {
  MerklePaymentRequest, MerklePaymentReceipt,
  ClientOptions,
  ConnectionInfo,
  FailedUploadPaymentOptions,
  DownloadOptions,
  DownloadResult,
  LookupResult,
  MediaOptions,
  MediaSource,
  Operation,
  OperationOptions,
  PaymentProvider,
  PaymentNetwork,
  PendingPayment,
  ProgressEvent,
  ProgressListener,
  PublicFile,
  SaveOptions,
  SaveResult,
  ResumeUploadOptions,
  UploadRecovery,
  UploadOptions,
  UploadResult,
  VerifiedStorageQuote,
} from "./types.js";

interface RawDownloadResult {
  content: Uint8Array;
  hash: string;
  file: CorePublicFile;
  dataMapNode: CoreNetworkNode;
}

interface OperationScope {
  id: string;
  reporters: Reporter[];
  signal: AbortSignal;
  parentOperationId?: string;
  recovery?: UploadRecovery;
  fail(error: unknown): void;
  finish(): void;
}

/** High-level, stateful browser client for direct Autonomi applications. */
export class AutonomiClient {
  #connection: Omit<ConnectionInfo, "files">;
  #files: PublicFile[] = [];
  #pendingUploads = new Set<UploadRecovery>();

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

  /** Connect using application-bundled seeds and payment identity, with seed failover. */
  static async connectNetwork(profile: NetworkProfile, options: Omit<ClientOptions, "expectedPaymentNetwork"> = {}): Promise<AutonomiClient> {
    const trusted = snapshotNetworkProfile(profile);
    let lastError: unknown;
    for (const seed of trusted.seeds) {
      throwIfAborted(options.signal);
      try {
        const client = await this.connect(seed, { ...options, expectedPaymentNetwork: trusted.payment });
        try {
          const { BrowserNetworkClient } = getBindings();
          const network = new BrowserNetworkClient(trusted.seeds.map(parseBootstrapMultiaddr));
          client.#network.close(); client.#network.free(); client.#network = network;
          return client;
        } catch (error) { client.close(); throw error; }
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new AutonomiError("CONNECTION_FAILED", "No trusted seed was reachable");
  }

  /**
   * Initialize WASM, authenticate the bootstrap node, and read its payment identity.
   *
   * Pass one complete, certificate-pinned WebRTC Direct multiaddress.
   */
  static async connect(
    bootstrapMultiaddr: string,
    options: ClientOptions = {},
  ): Promise<AutonomiClient> {
    const report = progressReporter("connect", operationId(), "initializing", (event) => {
      if (options.onProgress) safelyNotify(options.onProgress, event);
    }, options.signal, options.parentOperationId);
    let network: RawNetworkClient | undefined;
    try {
      throwIfAborted(options.signal);
      // Copy policy before asynchronous setup or application callbacks can mutate it.
      const expected = options.expectedPaymentNetwork === undefined
        ? undefined : normalizeExpectedNetwork(options.expectedPaymentNetwork);
      report("Initializing the Autonomi browser core");
      const workerWasm = await abortable(initializeClientWasm(options.wasm), options.signal);
      const { BrowserNodeClient, BrowserNetworkClient } = getBindings();
      const endpoint = parseBootstrapMultiaddr(bootstrapMultiaddr);
      report(`Authenticating bootstrap node from ${endpoint.multiaddr}`, { phase: "connecting" });

      const probe = new BrowserNodeClient(endpoint);
      let hello: CoreHelloInfo;
      // Dispose a session even if connection completed after caller cancellation.
      const connecting = probe.connect();
      let session: Awaited<typeof connecting> | undefined;
      try {
        session = await abortable(connecting, options.signal);
        hello = await abortable(session.hello(), options.signal) as CoreHelloInfo;
      } finally {
        if (session) { session.close(); session.free(); probe.free(); }
        else void connecting.then(
          late => { late.close(); late.free(); probe.free(); },
          () => probe.free(),
        );
      }
      if (!hello.capabilities.includes("chunk_protocol")) {
        throw new AutonomiError("CONNECTION_FAILED", "Bootstrap node does not support the shared storage protocol; upgrade ant-node to a version advertising chunk_protocol");
      }
      const identity = normalizePaymentNetwork(hello.payment);
      const paymentNetwork = {
        chainId: identity.chain_id,
        paymentTokenAddress: identity.payment_token_address,
        paymentVaultAddress: identity.payment_vault_address,
      };
      if (expected && (expected.chainId !== paymentNetwork.chainId ||
          expected.paymentTokenAddress !== paymentNetwork.paymentTokenAddress ||
          expected.paymentVaultAddress !== paymentNetwork.paymentVaultAddress)) {
        throw new AutonomiError("NETWORK_MISMATCH", "Authenticated payment network does not match expectedPaymentNetwork");
      }
      const endpoints = [endpoint];
      throwIfAborted(options.signal);
      network = new BrowserNetworkClient(endpoints);
      const connection: ConnectionInfo = {
        bootstrapMultiaddr: endpoint.multiaddr,
        paymentNetwork,
        bootstrap: helloFromCore(hello, paymentNetwork),
        files: [],
      };
      report(`Connected to authenticated peer ${hello.peer_id}`, { phase: "complete" });
      throwIfAborted(options.signal);
      const client = new AutonomiClient(network, connection, options, workerWasm);
      report.finish();
      return client;
    } catch (error) {
      if (network) closeNetwork(network);
      const failure = isAbort(error, options.signal) ? error : wrapError("CONNECTION_FAILED", "Could not connect to Autonomi", error);
      report.finish({ status: isAbort(failure, options.signal) ? "cancelled" : "failed", error: failure });
      throw failure;
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

  /** Failed/cancelled uploads whose retained input still needs resume or discard. */
  get pendingUploads(): readonly UploadRecovery[] {
    for (const recovery of this.#pendingUploads) {
      if (recovery.status === "completed" || recovery.status === "discarded") this.#pendingUploads.delete(recovery);
    }
    return Object.freeze([...this.#pendingUploads]);
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
    const operation = this.#startOperation(options);
    const report = this.#reporter("lookup", options.onProgress, operation);
    try {
      this.#assertOpen();
      report(`Finding nodes closest to ${target}`);
      const result = (await abortable(
        this.#network.findClosest(target, report),
        operation.signal,
      )) as CoreLookupResult;
      report("Closest-node lookup complete", { phase: "complete" });
      return lookupFromCore(result);
    } catch (error) {
      const failure = isAbort(error, operation.signal) ? error : wrapError("LOOKUP_FAILED", "Closest-node lookup failed", error);
      operation.fail(failure);
      throw failure;
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
    const operation = this.#startOperation(options);
    const report = this.#reporter("upload", options.onProgress, operation);
    try {
      this.#assertOpen();
      const payment = options.payment ?? this.#payment;
      if (!payment && !options.checkpoint) {
        throw new AutonomiError(
          "PAYMENT_REQUIRED", "Uploading requires a PaymentProvider; pass one to connect() or upload()",
        );
      }
      throwIfAborted(operation.signal);
      let retained: RetainedUpload;
      if (input instanceof Uint8Array) {
        assertFileSize(input.byteLength);
        const name = options.name ?? "public-file.bin";
        report(`Preparing ${name}`);
        retained = retainUpload(this.#connection.paymentNetwork, {
          bytes: input.slice(), name, contentType: options.contentType ?? "application/octet-stream",
        }, operation.id);
      } else if (typeof Blob === "function" && input instanceof Blob) {
        assertFileSize(input.size);
        const isFile = typeof File === "function" && input instanceof File;
        const staged = await stageBlob(
          input, options.name ?? (isFile ? input.name : "public-file.bin"),
          options.contentType || input.type || "application/octet-stream",
          report, this.#workerWasm, operation.signal,
        );
        retained = retainUpload(this.#connection.paymentNetwork, { staged }, operation.id);
      } else {
        throw new TypeError("upload input must be a File, Blob, or Uint8Array");
      }
      if (options.paymentMode !== undefined) retained.paymentMode = options.paymentMode;
      if (options.checkpoint !== undefined) retained.coreCheckpoint = options.checkpoint;
      if (options.onCheckpoint !== undefined) retained.onCheckpoint = options.onCheckpoint;
      return await this.#runUpload(
        retained, payment, false, options.retainOnFailure !== false, operation, report, options.onPaymentSubmitted,
      );
    } catch (error) {
      const failure = isAbort(error, operation.signal) ? error : wrapError("UPLOAD_FAILED", "Public file upload failed", error);
      operation.fail(failure);
      throw failure;
    } finally {
      operation.finish();
    }
  }

  /**
   * Resolve a definitively failed payment using the native journal validator.
   * Wait for the original upload and wallet work to settle before calling this.
   * Resume with upload(input, { checkpoint: returnedCheckpoint, ... }); this does
   * not mutate an existing in-memory recovery handle or submit another payment.
   */
  async reconcileFailedUploadPayment(
    checkpoint: string,
    options: FailedUploadPaymentOptions,
  ): Promise<string> {
    this.#assertOpen();
    if (typeof options?.verifyFailure !== "function" || typeof options.onCheckpoint !== "function") {
      throw new TypeError("Failed payment reconciliation requires verification and durable checkpoint callbacks");
    }
    try {
      return await this.#network.reconcileFailedUploadPayment(
        checkpoint,
        (attempt, scope) => options.verifyFailure(attempt, scope),
        value => options.onCheckpoint(value),
      );
    } catch (error) {
      throw wrapError("PAYMENT_FAILED", "Could not reconcile failed storage payment", error);
    }
  }

  /** Retry retained input. New payments require an explicit provider on this call. */
  async resumeUpload(
    recovery: UploadRecovery,
    options: ResumeUploadOptions = {},
  ): Promise<UploadResult> {
    const operation = this.#startOperation(options);
    const report = this.#reporter("upload", options.onProgress, operation);
    try {
      this.#assertOpen();
      const settled = uploadSettlement(recovery);
      operation.recovery = recovery;
      await abortable(settled, operation.signal);
      throwIfAborted(operation.signal);
      const state = claimUpload(recovery, this.#connection.paymentNetwork);
      if (options.onCheckpoint) state.onCheckpoint = options.onCheckpoint;
      return await this.#runUpload(state, options.payment, true, true, operation, report, options.onPaymentSubmitted);
    } catch (error) {
      operation.fail(error);
      throw error;
    } finally {
      operation.finish();
    }
  }

  async #runUpload(
    state: RetainedUpload,
    payment: PaymentProvider | undefined,
    resuming: boolean,
    retainOnFailure: boolean,
    operation: OperationScope,
    report: Reporter,
    onPaymentSubmitted?: (payment: PendingPayment) => void,
  ): Promise<UploadResult> {
    operation.recovery = state.handle;
    let paymentFailure: unknown;
    const payForQuotes = async (networkValue: unknown, quoteValue: unknown, persistValue?: unknown) => {
      const persistSubmission = typeof persistValue === "function" ? persistValue as (value: unknown) => Promise<void> : undefined;
      try {
        throwIfAborted(operation.signal);
        const network = paymentNetworkFromCore(networkValue, state.network);
        const quotes = snapshot(quoteValue as VerifiedStorageQuote[]);
        const previous = resuming ? paidReceipt(state, network, quotes) : undefined;
        if (previous) {
          report("Reusing a confirmed storage payment", { phase: "uploading" });
          return previous;
        }
        if (!payment) {
          throw new AutonomiError(
            "RECOVERY_PAYMENT_REQUIRED",
            "Fresh quotes are not covered by a retained receipt; pass payment to resumeUpload() to authorize another payment",
          );
        }
        report("Waiting for storage payment", { phase: "payment", total: quotes.length, unit: "quotes" });
        throwIfAborted(operation.signal);
        // Observe the actual provider promise, even after the upload stops waiting.
        const submitted: TrackedPayment[] = [];
        const journalWrites: Promise<void>[] = [];
        const pending = Promise.resolve(payment.pay(network, quotes, {
          report, signal: operation.signal,
          submitted: (submission) => {
            // Journal broadcast evidence before validating provider metadata.
            if (persistSubmission) {
              const write = persistSubmission({ transactionHash: submission.transactionHash,
                totalAmount: submission.totalAmount, walletAddress: submission.walletAddress });
              void write.catch(() => undefined);
              journalWrites.push(write);
            }
            const tracked = trackPayment(state, network, quotes, submission);
            submitted.push(tracked);
            try { onPaymentSubmitted?.(tracked.handle); } catch { /* Receipt observation must survive UI failures. */ }
          },
        })).then(async (receipt) => {
          // A malformed receipt may still identify a transaction that spent funds.
          if (persistSubmission) await persistSubmission(receipt);
          await Promise.all(journalWrites);
          const recorded = recordPayment(state, network, quotes, receipt);
          for (const tracked of submitted) tracked.confirm(receipt);
          return recorded.receipt;
        });
        state.paymentTasks.push(pending);
        const receipt = await abortable(pending, operation.signal);
        report("Storage payment confirmed", { phase: "uploading" });
        return receipt;
      } catch (error) {
        paymentFailure = isAbort(error, operation.signal)
          ? error : wrapError("PAYMENT_FAILED", "Storage payment failed", error);
        throw paymentFailure;
      }
    };
    const payForMerkle = async (networkValue: unknown, requestValue: unknown, persistValue?: unknown) => {
      const persistSubmission = typeof persistValue === "function" ? persistValue as (value: unknown) => Promise<void> : undefined;
      try {
        throwIfAborted(operation.signal);
        const network = paymentNetworkFromCore(networkValue, state.network);
        const request = snapshot(requestValue as MerklePaymentRequest);
        const previous = state.payments.find((paid) => paid.merkle?.calldata === request.calldata);
        if (previous) return previous.receipt;
        if (!payment?.payMerkle) throw new AutonomiError("PAYMENT_FAILED", "PaymentProvider must implement payMerkle for this upload, or select paymentMode: single");
        const submitted: TrackedPayment[] = [];
        const journalWrites: Promise<void>[] = [];
        const pending = Promise.resolve(payment.payMerkle(network, request, {
          report, signal: operation.signal,
          decodeReceipt: (logs) => {
            const decode = getBindings().decodeMerklePaymentReceipt;
            if (!decode) throw new Error("WASM does not support Merkle receipt decoding");
            return decode(request, network.paymentVaultAddress, logs) as Pick<MerklePaymentReceipt, "winnerPoolHash" | "totalAmount">;
          },
          submitted: (submission) => {
            // Journal broadcast evidence before validating provider metadata.
            if (persistSubmission) {
              const write = persistSubmission({ transactionHash: submission.transactionHash,
                totalAmount: submission.totalAmount, walletAddress: submission.walletAddress });
              void write.catch(() => undefined);
              journalWrites.push(write);
            }
            const tracked = trackPayment(state, network, [], submission, request);
            submitted.push(tracked);
            try { onPaymentSubmitted?.(tracked.handle); } catch { /* Preserve settlement observation. */ }
          },
        })).then(async (receipt) => {
          // A malformed receipt may still identify a transaction that spent funds.
          if (persistSubmission) await persistSubmission(receipt);
          await Promise.all(journalWrites);
          const recorded = recordPayment(state, network, [], receipt, request);
          for (const tracked of submitted) tracked.confirm(receipt);
          return recorded.receipt;
        });
        state.paymentTasks.push(pending);
        return await abortable(pending, operation.signal);
      } catch (error) {
        paymentFailure = isAbort(error, operation.signal) ? error : wrapError("PAYMENT_FAILED", "Merkle payment failed", error);
        throw paymentFailure;
      }
    };
    // Recovery callbacks observe retained/chain receipts; they never call pay().
    payForQuotes.recover = async (networkValue: unknown, quoteValue: unknown, _persist: unknown, attempt: unknown) => {
      const network = paymentNetworkFromCore(networkValue, state.network);
      const quotes = snapshot(quoteValue as VerifiedStorageQuote[]);
      await reconcilePayments(state, operation.signal);
      const previous = paidReceipt(state, network, quotes);
      if (previous) return previous;
      if (payment?.recover) {
        const receipt = await payment.recover(network, quotes, attempt, { report, signal: operation.signal });
        return recordPayment(state, network, quotes, receipt).receipt;
      }
      throw new AutonomiError("PAYMENT_FAILED", "Payment outcome unknown; reconcile the original payment before retrying");
    };
    payForMerkle.recover = async (networkValue: unknown, requestValue: unknown, _persist: unknown, attempt: unknown) => {
      const network = paymentNetworkFromCore(networkValue, state.network);
      const request = snapshot(requestValue as MerklePaymentRequest);
      await reconcilePayments(state, operation.signal);
      const previous = state.payments.find(paid => paid.merkle?.calldata === request.calldata);
      if (previous) return previous.receipt;
      if (payment?.recoverMerkle) {
        const receipt = await payment.recoverMerkle(network, request, attempt, { report, signal: operation.signal });
        return recordPayment(state, network, [], receipt, request).receipt;
      }
      throw new AutonomiError("PAYMENT_FAILED", "Merkle payment outcome unknown; reconcile the original payment before retrying");
    };
    try {
      throwIfAborted(operation.signal);
      if (resuming) await reconcilePayments(state, operation.signal);
      if (!state.result) {
        report(`Preparing storage for ${state.name}`, { phase: "preparing" });
        const checkpoint = async (value: string) => {
          state.coreCheckpoint = value;
          if (state.onCheckpoint) await state.onCheckpoint(value);
          else { await saveUploadCheckpoint(state.handle.id, value); state.checkpointStoredLocally = true; }
        };
        const raw = state.staged
          ? this.#network.uploadStagedPublicFile(
              state.staged.staged, corePaymentNetwork(state.network),
              (index: unknown, address: unknown, size: unknown) => loadStagedRecord(
                state.staged!.sessionId, Number(index), String(address), Number(size), operation.signal,
              ), payForQuotes, report, state.coreCheckpoint, checkpoint, state.paymentMode ?? "auto", payForMerkle,
            )
          : this.#network.uploadPublicFile(
              state.bytes!, state.name, state.contentType, corePaymentNetwork(state.network), payForQuotes, report, state.coreCheckpoint, checkpoint, state.paymentMode ?? "auto", payForMerkle,
            );
        state.work = Promise.resolve(raw).then((result) => {
          const rawResult = result as Omit<UploadResult, "file" | "payments"> & { file: CorePublicFile };
          state.result = uploadResult(state, { ...rawResult, file: publicFileFromCore(rawResult.file) });
          return state.result;
        });
        await abortable(state.work, operation.signal);
      }
      throwIfAborted(operation.signal);
      const result = state.result!;
      this.#rememberFile(result.file);
      report(`Uploaded ${result.file.name}`, {
        phase: "complete", completed: result.file.size, total: result.file.size, unit: "bytes",
      });
      try {
        await releaseUpload(state, "completed");
        this.#pendingUploads.delete(state.handle);
      } catch {
        // The upload is complete. Retain cleanup ownership without paying again.
        awaitUploadSettlement(state);
        this.#pendingUploads.add(state.handle);
      }
      return result;
    } catch (error) {
      awaitUploadSettlement(state);
      this.#pendingUploads.add(state.handle);
      if (!retainOnFailure) void state.handle.discard().catch(() => undefined);
      if (isAbort(error, operation.signal)) throw error;
      const failure = wrapError("UPLOAD_FAILED", "Public file upload failed", paymentFailure ?? error);
      throw new UploadError(failure, state.handle);
    }
  }

  /** Download, reconstruct, and BLAKE3-verify a complete public file. */
  async download(
    file: string | PublicFile,
    options: DownloadOptions = {},
  ): Promise<DownloadResult> {
    const operation = this.#startOperation(options);
    const report = this.#reporter("download", options.onProgress, operation);
    try {
      this.#assertOpen();
      const limits = SDK_LIMITS.downloadConcurrency;
      const concurrency = options.concurrency ?? limits.default;
      if (!Number.isInteger(concurrency) || concurrency < limits.min || concurrency > limits.max) {
        throw new AutonomiError(
          "DOWNLOAD_FAILED",
          `Download concurrency must be an integer from ${limits.min} through ${limits.max}`,
        );
      }
      throwIfAborted(operation.signal);
      const raw = (await abortable(
        this.#network.downloadPublicFile(typeof file === "string" ? file : coreFileReference(file), concurrency, report),
        operation.signal,
      )) as RawDownloadResult;
      throwIfAborted(operation.signal);
      const publicFile = publicFileFromCore(raw.file);
      this.#rememberFile(publicFile);
      report(`Downloaded ${raw.file.name}`, { phase: "complete", completed: raw.content.byteLength, total: raw.content.byteLength, unit: "bytes" });
      const blobBytes = new Uint8Array(raw.content.byteLength);
      blobBytes.set(raw.content);
      return {
        bytes: raw.content,
        blob: new Blob([blobBytes], {
          type: raw.file.content_type || "application/octet-stream",
        }),
        hash: raw.hash,
        file: publicFile,
        dataMapNode: nodeFromCore(raw.dataMapNode),
      };
    } catch (error) {
      const failure = isAbort(error, operation.signal) ? error : wrapError("DOWNLOAD_FAILED", "Public file download failed", error);
      operation.fail(failure);
      throw failure;
    } finally {
      operation.finish();
    }
  }

  /** Choose a destination, then download, verify, and save a public file. */
  async downloadAndSave(
    file: string | PublicFile,
    options: DownloadOptions & SaveOptions = {},
  ): Promise<{ download: DownloadResult; save: SaveResult }> {
    const operation = this.#startOperation(options);
    const report = this.#reporter("download-and-save", options.onProgress, operation);
    try {
      this.#assertOpen();
      report("Choosing a download destination", { phase: "saving" });
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
        parentOperationId: operation.id,
        signal: operation.signal,
      });
      report(`Saving ${download.file.name}`, { phase: "saving" });
      const save = await saveDownload(
        download,
        {
          ...options,
          ...(fileHandle ? { fileHandle } : { useFilePicker: false }),
          parentOperationId: operation.id,
          onProgress: (event) => this.#notify(options.onProgress, event),
          signal: operation.signal,
        },
      );
      report(`Saved ${download.file.name}`, { phase: "complete" });
      return { download, save };
    } catch (error) {
      operation.fail(error);
      throw error;
    } finally {
      operation.finish();
    }
  }

  /** Open a bounded random-access reader without reconstructing the whole file. */
  async openFile(
    file: string | PublicFile,
    options: OperationOptions = {},
  ): Promise<PublicFileReader> {
    const operation = this.#startOperation(options);
    const report = this.#reporter("open-file", options.onProgress, operation);
    let raw: Awaited<ReturnType<RawNetworkClient["openPublicFile"]>> | undefined;
    try {
      this.#assertOpen();
      throwIfAborted(operation.signal);
      raw = await abortable(
        this.#network.openPublicFile(typeof file === "string" ? file : coreFileReference(file), report),
        operation.signal,
        undefined,
        closeReader,
      );
      throwIfAborted(operation.signal);
      const address = typeof file === "string" ? normalizeAddress(file) : file.address;
      const reader = createPublicFileReader(raw, address);
      report(`Opened ${reader.name}`, { phase: "complete" });
      raw = undefined;
      return reader;
    } catch (error) {
      if (raw) closeReader(raw);
      const failure = isAbort(error, operation.signal) ? error : wrapError("OPEN_FILE_FAILED", "Could not open the public file", error);
      operation.fail(failure);
      throw failure;
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
    const operation = this.#startOperation(options);
    const report = this.#reporter("media", options.onProgress, operation);
    let reader: PublicFileReader | undefined;
    let source: MediaSource | undefined;
    try {
      this.#assertOpen();
      report("Opening an Autonomi random-access media reader");
      reader = await this.openFile(file, {
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        parentOperationId: operation.id,
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
      const failure = isAbort(error, operation.signal) ? error : wrapError("MEDIA_FAILED", "Could not create the media source", error);
      operation.fail(failure);
      throw failure;
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
    try {
      this.#media?.close();
    } catch {
      // Continue closing the network if a media reader cleanup failed.
    } finally {
      closeNetwork(this.#network);
      if (this.#operations.size === 0) this.#listeners.clear();
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
      download: "downloading", "open-file": "opening", media: "media", "download-and-save": "downloading", save: "saving",
    } as const;
    const report = progressReporter(operation, scope.id, phases[operation], (event) => {
      this.#notify(local, event);
    }, cancellable ? scope.signal : undefined, scope.parentOperationId);
    scope.reporters.push(report);
    return report;
  }

  #notify(local: ProgressListener | undefined, event: ProgressEvent): void {
    for (const listener of this.#listeners) safelyNotify(listener, event);
    if (local && !this.#listeners.has(local)) safelyNotify(local, event);
  }

  #startOperation(options: OperationOptions): OperationScope {
    const externalSignal = options.signal;
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) forwardAbort();
    else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    this.#operations.add(controller);
    let finished = false;
    let outcome: OperationOutcome = { status: "succeeded" };
    const reporters: Reporter[] = [];
    const scope: OperationScope = {
      id: operationId(),
      ...(options.parentOperationId === undefined ? {} : { parentOperationId: options.parentOperationId }),
      reporters,
      signal: controller.signal,
      fail: (error) => { outcome = {
        status: isAbort(error, controller.signal) ? "cancelled" : "failed", error,
        ...(scope.recovery === undefined ? {} : { recovery: scope.recovery }),
      }; },
      finish: () => {
        if (finished) return;
        finished = true;
        reporters.forEach((reporter) => reporter.finish(outcome));
        externalSignal?.removeEventListener("abort", forwardAbort);
        this.#operations.delete(controller);
        if (this.#closed && this.#operations.size === 0) this.#listeners.clear();
      },
    };
    return scope;
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

function normalizePaymentNetwork(value: unknown): CorePaymentNetwork {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("bootstrap node advertises invalid payment configuration");
  }
  const payment = value as Record<string, unknown>;
  const chainId = payment.chain_id;
  if (typeof chainId !== "number") {
    throw new TypeError("bootstrap node advertises an invalid payment chain ID");
  }
  assertPaymentChainId(chainId);
  return {
    chain_id: chainId,
    payment_token_address: normalizeEvmAddress(
      requiredString(payment.payment_token_address, "payment token address"),
    ),
    payment_vault_address: normalizeEvmAddress(
      requiredString(payment.payment_vault_address, "payment vault address"),
    ),
  };
}

function normalizeExpectedNetwork(value: PaymentNetwork): PaymentNetwork {
  try {
    assertPaymentChainId(value.chainId);
    return {
      chainId: value.chainId,
      paymentTokenAddress: normalizeEvmAddress(value.paymentTokenAddress),
      paymentVaultAddress: normalizeEvmAddress(value.paymentVaultAddress),
    };
  } catch (error) {
    throw new AutonomiError("INVALID_SOURCE", "expectedPaymentNetwork requires a valid chain ID and both EVM contract addresses", error);
  }
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
