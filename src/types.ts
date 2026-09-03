/** Public EVM contracts advertised by authenticated Autonomi nodes. */
export interface PaymentNetwork {
  rpc_url: string;
  payment_token_address: string;
  payment_vault_address: string;
}

export interface ChunkInfo {
  index: number;
  dst_hash: string;
  src_hash: string;
  src_size: number;
}

/** Metadata needed to retrieve and verify a public file. */
export interface PublicFile {
  name: string;
  address: string;
  size: number;
  content_type: string;
  blake3: string;
  data_map_size: number;
  chunks: ChunkInfo[];
  replicas: number;
}

export interface HelloInfo {
  type: string;
  protocol: string;
  peer_id: string;
  endpoint: { multiaddr: string };
  max_chunk_size: number;
  capabilities: string[];
  payment: PaymentNetwork;
}

export interface NetworkNode {
  peer_id: string;
  native_addresses: string[];
  reliability: number;
  webrtc_direct?: { multiaddr: string };
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

export interface PaymentReceipt {
  transactionHash?: string;
  walletAddress?: string;
  /** Decimal sum of every quote paid by this transaction. */
  totalAmount: string;
}

export interface PaymentContext {
  report(message: string): void;
  /** Aborts the upload waiting on this payment, when cancellation is supported. */
  readonly signal?: AbortSignal;
}

/** Wallet-independent payment boundary used by uploads. */
export interface PaymentProvider {
  pay(
    network: PaymentNetwork,
    quotes: readonly VerifiedStorageQuote[],
    context: PaymentContext,
  ): Promise<PaymentReceipt>;
}

export type Operation =
  | "connect"
  | "lookup"
  | "upload"
  | "download"
  | "open-file"
  | "media";

export interface ProgressEvent {
  operation: Operation;
  message: string;
}

export type ProgressListener = (event: ProgressEvent) => void;

export type WasmSource =
  | RequestInfo
  | URL
  | Response
  | BufferSource
  | WebAssembly.Module;

export interface ClientOptions {
  payment?: PaymentProvider;
  onProgress?: ProgressListener;
  /** Override where the bundled WASM module is loaded from. */
  wasm?: WasmSource | Promise<WasmSource>;
  /** Cancel connection setup. A connected client is unaffected by later aborts. */
  signal?: AbortSignal;
}

export interface ConnectionInfo {
  bootstrapMultiaddr: string;
  paymentNetwork: PaymentNetwork;
  bootstrap: HelloInfo;
  files: PublicFile[];
}

export interface OperationOptions {
  onProgress?: ProgressListener;
  /** Cancel only this operation. */
  signal?: AbortSignal;
}

export interface UploadOptions extends OperationOptions {
  /** Required for a Blob or byte array; a File supplies its own name. */
  name?: string;
  /** Defaults to the File/Blob type, then application/octet-stream. */
  contentType?: string;
  payment?: PaymentProvider;
}

export interface UploadResult {
  file: PublicFile;
  transactionHash?: string;
  storageCostAtto: string;
  records: number;
}

export interface DownloadOptions extends OperationOptions {
  /** Parallel record fetches, from 1 through 6. Defaults to 3. */
  concurrency?: number;
}

export interface DownloadResult {
  bytes: Uint8Array;
  blob: Blob;
  hash: string;
  file: PublicFile;
  dataMapNode: NetworkNode;
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

export interface SaveOptions {
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
  file: Pick<PublicFile, "name" | "size" | "content_type" | "address">;
  close(): void;
}
