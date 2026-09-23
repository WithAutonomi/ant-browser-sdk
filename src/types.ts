/** Public payment identity advertised by the node; RPC providers belong to the application. */
export interface PaymentNetwork {
  /** Node-advertised EVM chain ID; payment adapters verify their provider uses this chain. */
  readonly chainId: number;
  readonly paymentTokenAddress: string;
  readonly paymentVaultAddress: string;
}

export interface ChunkInfo {
  readonly index: number;
  readonly dstHash: string;
  readonly srcHash: string;
  readonly srcSize: number;
}

/** Metadata needed to retrieve and verify a public file. */
export interface PublicFile {
  readonly name: string;
  readonly address: string;
  readonly size: number;
  readonly contentType: string;
  /** Whole-file plaintext hash, known once an upload or download has read all plaintext; otherwise empty. */
  readonly blake3: string;
  readonly dataMapSize: number;
  readonly chunks: readonly ChunkInfo[];
  readonly replicas: number;
}

/**
 * A file only holders of its DataMap can read, like a native private upload.
 * The DataMap grants read access: store and share it as carefully as the file.
 */
export interface PrivateFile {
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  /** Whole-file plaintext hash, known once an upload or download has read all plaintext; otherwise empty. */
  readonly blake3: string;
  /** Canonical MessagePack DataMap, byte-for-byte the content of a native `.datamap` file. */
  readonly dataMap: Uint8Array;
  readonly dataMapSize: number;
  readonly chunks: readonly ChunkInfo[];
  readonly replicas: number;
}

/**
 * Reads need only the DataMap, such as the content of a native `.datamap` file;
 * size and chunks come from the resolved DataMap.
 */
export type PrivateFileReference = Pick<PrivateFile, "dataMap"> & Partial<Pick<PrivateFile, "name" | "contentType">>;

/** Who can read an uploaded file, as in native `Visibility`. */
export type UploadVisibility = "public" | "private";

export interface HelloInfo {
  readonly type: string;
  readonly protocol: string;
  readonly peerId: string;
  readonly endpoint: { readonly multiaddr: string };
  readonly maxChunkSize: number;
  readonly capabilities: readonly string[];
  readonly payment: PaymentNetwork;
}

export interface NetworkNode {
  peerId: string;
  nativeAddresses: string[];
  reliability: number;
  webrtcDirect?: { multiaddr: string };
}

export interface LookupFailure {
  peerId: string;
  message: string;
}

export interface LookupResult {
  nodes: NetworkNode[];
  queried: string[];
  failures: LookupFailure[];
}

export interface VerifiedStorageQuote {
  quote: unknown;
  quoteHash: string;
  rewardsAddress: string;
  /** Decimal atto-token amount. Keep this as a string until converting to bigint. */
  amount: string;
}

/** A confirmed storage transaction, including transactions paying zero tokens. */
export interface PaidPaymentReceipt {
  /** Present for a confirmed Merkle payment. */
  winnerPoolHash?: string;
  /** Optional per-quote transaction mapping when a wallet splits a payment batch. */
  transactionHashes?: Readonly<Record<string, string>>;
  transactionHash: string;
  walletAddress?: string;
  /** Decimal sum of every quote paid by this transaction. */
  totalAmount: string;
}

/** No transaction was needed because the payment plan contained no quotes. */
export interface NoPaymentReceipt {
  transactionHash?: never;
  walletAddress?: string;
  totalAmount: "0";
}

/** A paid plan requires a transaction hash; only an empty plan may omit it. */
export type PaymentReceipt = PaidPaymentReceipt | NoPaymentReceipt;

/** Evidence of a broadcast storage transaction, before its outcome is known. */
export interface PaymentSubmissionInfo {
  readonly transactionHash: string;
  readonly walletAddress?: string;
  readonly totalAmount: string;
}

export type PaymentSettlement =
  | { readonly status: "confirmed"; readonly receipt: Readonly<PaidPaymentReceipt> }
  | { readonly status: "failed"; readonly reason: string; readonly cause?: unknown };

export interface PaymentSubmission extends PaymentSubmissionInfo {
  /** Observe the same transaction. Reject on observation failure; never broadcast. */
  wait(): Promise<PaymentSettlement>;
}

/** Retained submission evidence; confirmation can be retried after an RPC failure. */
export interface PendingPayment {
  readonly merkle?: MerklePaymentRequest;
  readonly network: PaymentNetwork;
  readonly quotes: readonly Readonly<VerifiedStorageQuote>[];
  readonly submission: Readonly<PaymentSubmissionInfo>;
  readonly status: "pending" | "confirmed" | "failed";
  /** Shares concurrent observations and caches a definitive outcome. */
  reconcile(): Promise<PaymentSettlement>;
}

export interface PaymentContext {
  report(message: string, progress?: ProgressDetails): void;
  /** Call immediately after broadcast, including if cancellation happened during submission. */
  submitted(submission: PaymentSubmission): void;
  /** Cancel before submission; submitted storage payments must still return their receipt. */
  readonly signal?: AbortSignal;
}

/** Merkle transaction prepared and validated by the native Rust client. */
export interface MerklePaymentRequest {
  readonly calldata: string;
  readonly maximumAmount: string;
  readonly depth: number;
  readonly timestamp: number;
  readonly poolHashes: readonly string[];
}

export interface PaymentLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface MerklePaymentReceipt extends PaidPaymentReceipt {
  readonly winnerPoolHash: string;
}

export interface MerklePaymentContext extends PaymentContext {
  /** Validate the vault event with the native ABI and prepared request. */
  decodeReceipt(logs: readonly PaymentLog[]): { winnerPoolHash: string; totalAmount: string };
}

/** Wallet-independent payment boundary used by uploads. */
export interface PaymentProvider {
  /** Observe an existing attempt from its persisted journal. Must never submit a transaction. */
  recover?(network: PaymentNetwork, quotes: readonly VerifiedStorageQuote[], attempt: unknown, context: Pick<PaymentContext, "report" | "signal">): Promise<PaymentReceipt>;
  /** Observe an existing Merkle attempt without submitting another payment. */
  recoverMerkle?(network: PaymentNetwork, request: MerklePaymentRequest, attempt: unknown, context: Pick<PaymentContext, "report" | "signal">): Promise<MerklePaymentReceipt>;
  payMerkle?(network: PaymentNetwork, request: MerklePaymentRequest, context: MerklePaymentContext): Promise<MerklePaymentReceipt>;
  pay(
    network: PaymentNetwork,
    quotes: readonly VerifiedStorageQuote[],
    context: PaymentContext,
  ): Promise<PaymentReceipt>;
}

/** Independently verified terminal failure; a timeout or missing receipt is insufficient. */
export type FailedPaymentResolution =
  | { readonly status: "notSubmitted"; readonly evidence: Readonly<Record<string, unknown>> }
  | { readonly status: "reverted"; readonly transactionHashes: readonly string[]; readonly evidence: Readonly<Record<string, unknown>> };

export interface FailedUploadPaymentOptions {
  /**
   * Verify the original wallet/network without submitting. Prove the wallet never
   * submitted and can no longer submit, or verify final reverts for every journaled
   * transaction. Rust checks coverage and retains all earlier confirmed proofs.
   */
  verifyFailure(attempt: unknown, scope: string): FailedPaymentResolution | Promise<FailedPaymentResolution>;
  /** Persist durably before returning; required so a failed write cannot enable repayment. */
  onCheckpoint(checkpoint: string): void | Promise<void>;
}

export type Operation =
  | "connect"
  | "lookup"
  | "upload"
  | "download"
  | "download-and-save"
  | "save"
  | "open-file"
  | "media";

/** Phases are SDK boundaries; core diagnostic messages do not imply byte completion. */
export type ProgressPhase =
  | "initializing" | "connecting" | "lookup" | "preparing" | "staging"
  | "approval" | "payment" | "uploading" | "downloading" | "opening"
  | "media" | "saving" | "complete" | "cleanup";

export interface ProgressDetails {
  readonly phase: ProgressPhase;
  /** Actual completed work in the indicated unit; omitted when unknown. */
  readonly completed?: number;
  readonly total?: number;
  readonly unit?: "bytes" | "records" | "quotes";
}

interface ProgressEventBase extends ProgressDetails {
  readonly operationId: string;
  readonly parentOperationId?: string;
  readonly operation: Operation;
  readonly message: string;
}

/** Exactly one terminal event follows running events, including for rejected operations. */
export type ProgressEvent = ProgressEventBase & (
  | { readonly status: "running" | "succeeded" }
  | { readonly status: "failed" | "cancelled"; readonly error: unknown; readonly recovery?: UploadRecovery }
);

export type ProgressListener = (event: ProgressEvent) => void;

export type WasmSource =
  | RequestInfo
  | URL
  | Response
  | BufferSource
  | WebAssembly.Module;

export interface ClientOptions {
  payment?: PaymentProvider;
  /** Reject authenticated metadata unless its chain and both contracts match this identity. */
  expectedPaymentNetwork?: PaymentNetwork;
  onProgress?: ProgressListener;
  parentOperationId?: string;
  /** First page-wide WASM source. Later explicit sources must match the shared module. */
  wasm?: WasmSource | Promise<WasmSource>;
  /** Cancel connection setup. A connected client is unaffected by later aborts. */
  signal?: AbortSignal;
}

export interface ConnectionInfo {
  readonly bootstrapMultiaddr: string;
  readonly paymentNetwork: PaymentNetwork;
  readonly bootstrap: HelloInfo;
  readonly files: readonly PublicFile[];
}

export interface OperationOptions {
  onProgress?: ProgressListener;
  /** Associate this operation with an application operation; composed SDK calls set child IDs automatically. */
  parentOperationId?: string;
  /** Cancel only this operation. */
  signal?: AbortSignal;
}

export interface UploadOptions extends OperationOptions {
  /**
   * Defaults to `public`, which stores the DataMap record so anyone with its
   * address can read the file. `private` keeps the DataMap out of the network
   * and returns it only in the result's `PrivateFile`.
   */
  visibility?: UploadVisibility;
  /** Native selection policy; defaults to auto. */
  paymentMode?: "auto" | "single" | "merkle";
  /**
   * Restore a checkpoint from `onCheckpoint` with the same input and payment network.
   * A File or Blob checkpoint may name the upload window whose scope it covers.
   */
  checkpoint?: string;
  /** Persist recovery state; awaited before requesting payment or storing records. */
  onCheckpoint?: (checkpoint: string) => void | Promise<void>;
  /** Receives submission evidence immediately; may run after cancellation during broadcast. */
  onPaymentSubmitted?: (payment: PendingPayment) => void;
  /** Retain prepared input after failure for resume/discard. Defaults to true. */
  retainOnFailure?: boolean;
  /** Defaults to the File name, otherwise public-file.bin. */
  name?: string;
  /** Defaults to the File/Blob type, then application/octet-stream. */
  contentType?: string;
  payment?: PaymentProvider;
}

export interface ResumeUploadOptions extends OperationOptions {
  /** Replace the persistence callback for subsequent Rust checkpoints. */
  onCheckpoint?: (checkpoint: string) => void | Promise<void>;
  onPaymentSubmitted?: (payment: PendingPayment) => void;
  /** Explicitly authorize payment for quotes not covered by a retained receipt. */
  payment?: PaymentProvider;
}

export interface UploadPayment {
  readonly merkle?: MerklePaymentRequest;
  readonly network: PaymentNetwork;
  readonly quotes: readonly Readonly<VerifiedStorageQuote>[];
  readonly receipt: Readonly<PaymentReceipt>;
}

/** Page-owned retry state. It survives client.close(), but not a page reload. */
export interface UploadRecovery {
  /** The initial upload's progress operationId. Resumed attempts receive new IDs. */
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly visibility: UploadVisibility;
  readonly status: "active" | "settling" | "ready" | "discarding" | "discarded" | "completed";
  readonly payments: readonly UploadPayment[];
  /** Submitted transactions without a definitive outcome. Resume reconciles these first. */
  readonly pendingPayments: readonly PendingPayment[];
  /** Wait for the previous attempt and any submitted payment to finish. Never rejects. */
  readonly settled: Promise<void>;
  /** Release retained input and its staged window once the attempt has settled. */
  discard(): Promise<void>;
}

/** A public upload returns a `PublicFile`; a private upload returns a `PrivateFile`. */
export interface UploadResult<F extends PublicFile | PrivateFile = PublicFile> {
  /** All confirmed payments made by this upload and its resumed attempts. */
  payments: readonly UploadPayment[];
  file: F;
  /** Final storage transaction, when present. See payments for the complete history. */
  transactionHash?: string;
  /** Total confirmed storage payments across this upload and its resumed attempts. */
  storageCostAtto: string;
  records: number;
  /** Mode the native coordinator used, like native `payment_mode_used`: `merkle` once any record was paid through a Merkle batch. */
  paymentMode: "single" | "merkle";
}

export interface DownloadOptions extends OperationOptions {
  /** Adaptive by default. An integer from 1 through 256 caps logical record fetches. */
  concurrency?: number | "auto";
}

export interface DownloadResult {
  bytes: Uint8Array;
  blob: Blob;
  hash: string;
  file: PublicFile;
  dataMapNode: NetworkNode;
}

/** No node serves a private file's DataMap, so no DataMap node is reported. */
export interface PrivateDownloadResult {
  bytes: Uint8Array;
  blob: Blob;
  hash: string;
  file: PrivateFile;
}

/** Minimal writable surface returned by a browser file-system handle. */
export interface SaveFileWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

/** A previously selected destination, such as a FileSystemFileHandle. */
export interface SaveFileHandle {
  readonly name?: string;
  createWritable(): Promise<SaveFileWritable>;
}

export interface SaveOptions extends OperationOptions {
  suggestedName?: string;
  /** Skip the picker and write to a destination selected by the application. */
  fileHandle?: SaveFileHandle;
  /** Set false to skip opening the picker; an explicit fileHandle still takes precedence. */
  useFilePicker?: boolean;
  /** Cancel destination selection or writing. */
  signal?: AbortSignal;
}

export interface SaveResult {
  method: "file-picker" | "download";
  name: string;
}

export interface ReadOptions {
  /** Cancel only this range read. */
  signal?: AbortSignal;
}

export interface StreamOptions extends ReadOptions {
  start?: number;
  end?: number;
  /** Defaults to 1 MiB and cannot exceed the protocol's 4 MiB range limit. */
  chunkSize?: number;
}

export interface MediaOptions extends OperationOptions {
  /**
   * Must be served from the same origin. Defaults to /autonomi-stream-sw.js.
   * If the scope already has a worker, integrate the media bridge and pass that worker's URL.
   */
  serviceWorkerUrl?: string | URL;
  /** Defaults to `/`; change only when both the page and stream URL share a narrower scope. */
  scope?: string;
}

export interface MediaSource {
  url: string;
  file: Pick<PublicFile, "name" | "size" | "contentType" | "address">;
  close(): void;
}
