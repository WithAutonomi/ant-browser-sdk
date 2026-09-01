/** A certificate-pinned WebRTC Direct multiaddress or its manifest form. */
export type Endpoint = string | { multiaddr: string };

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

/** Validated bootstrap document produced by an Autonomi deployment. */
export interface BrowserManifest {
  version: number;
  network_id: string;
  created_at?: string;
  endpoints: Array<{ multiaddr: string }>;
  payment: PaymentNetwork;
  files: PublicFile[];
}

export interface HelloInfo {
  type: string;
  protocol: string;
  peer_id: string;
  challenge: string;
  public_key: string;
  signature: string;
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

/** A URL is treated as a manifest; a string beginning with `/` is a multiaddress. */
export type ConnectionSource =
  | string
  | URL
  | Endpoint
  | readonly Endpoint[]
  | BrowserManifest;

export type WasmSource =
  | RequestInfo
  | URL
  | Response
  | BufferSource
  | WebAssembly.Module;

export interface ClientOptions {
  payment?: PaymentProvider;
  onProgress?: ProgressListener;
  fetch?: typeof globalThis.fetch;
  /** Override where the bundled WASM module is loaded from. */
  wasm?: WasmSource | Promise<WasmSource>;
}

export interface ConnectionInfo {
  networkId: string;
  endpoints: Array<{ multiaddr: string }>;
  paymentNetwork: PaymentNetwork;
  bootstrap: HelloInfo;
  files: PublicFile[];
}

export interface OperationOptions {
  onProgress?: ProgressListener;
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

export interface SaveOptions {
  suggestedName?: string;
  /** Set false to always use an ordinary browser download. */
  useFilePicker?: boolean;
}

export interface SaveResult {
  method: "file-picker" | "download";
  name: string;
}

export interface StreamOptions {
  start?: number;
  end?: number;
  /** Defaults to 1 MiB and cannot exceed the protocol's 4 MiB range limit. */
  chunkSize?: number;
}

export interface MediaOptions extends OperationOptions {
  /** Must be served from the same origin. Defaults to /autonomi-stream-sw.js. */
  serviceWorkerUrl?: string | URL;
  /** Defaults to `/`; change only when both the page and stream URL share a narrower scope. */
  scope?: string;
}

export interface MediaSource {
  url: string;
  file: Pick<PublicFile, "name" | "size" | "content_type" | "address">;
  close(): void;
}
