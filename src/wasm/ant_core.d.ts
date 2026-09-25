/* tslint:disable */
/* eslint-disable */

/**
 * Incremental self-encryptor used from a worker with a synchronous file reader.
 *
 * Each call to `nextRecord` materializes at most one encrypted record. This
 * lets JavaScript persist the record before asking WASM for the next one,
 * keeping plaintext and ciphertext file-sized buffers out of the page.
 */
export class BrowserFileEncryptor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Return upload metadata after `nextRecord` has reached `undefined`.
     */
    finish(name: string, content_type: string): any;
    /**
     * Create an encryptor around a synchronous `(offset, length) => Uint8Array` reader.
     *
     * Browsers expose synchronous `File` reads only inside dedicated workers,
     * so page code should construct this class there rather than on the UI thread.
     */
    constructor(file_size: number, read_chunk: Function);
    /**
     * Produce the next encrypted record, or `undefined` once all records are staged.
     */
    nextRecord(): any;
}

/**
 * Random-access public-file reader for media playback and bounded downloads.
 */
export class BrowserFileReader {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Release cached encrypted records held for playback read-ahead and seeks.
     */
    close(): void;
    /**
     * Fetch and decrypt one plaintext byte range without reconstructing the file.
     */
    readRange(start: number, length: number): Promise<Uint8Array>;
    /**
     * Browser MIME type advertised by the file descriptor.
     */
    readonly contentType: string;
    /**
     * Display filename advertised by the file descriptor.
     */
    readonly name: string;
    /**
     * Plaintext file size in bytes.
     */
    readonly size: number;
}

/**
 * Shared Saorsa iterative lookup state driven by browser WebRtcDirect.
 */
export class BrowserIterativeLookup {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add validated bootstrap or FIND_NODE candidates.
     */
    addCandidates(nodes: any): void;
    /**
     * Construct a browser lookup using the same scheduler as native QUIC.
     */
    constructor(target: string, count: number, alpha: number, max_iterations: number);
    /**
     * Peer IDs selected for network queries, in query order.
     */
    queriedPeers(): any;
    /**
     * Successful responders in final closest-first order.
     */
    results(): any;
    /**
     * Run the complete shared Saorsa walk through a WebRtcDirect batch callback.
     */
    run(query_batch: Function): Promise<string>;
}

/**
 * Stateful Autonomi browser client sharing Rust lookup and data workflows.
 */
export class BrowserNetworkClient {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Close all pooled WebRTC associations.
     */
    close(): void;
    /**
     * Authenticate the first usable configured seed in this client's own pool.
     * Remaining seeds connect in the background within the bootstrap bound.
     */
    connect(expected_payment?: any | null): Promise<any>;
    /**
     * Download and reconstruct a private file from the DataMap its uploader kept.
     */
    downloadPrivateFile(file: any, concurrency?: number | null, on_progress?: Function | null): Promise<any>;
    /**
     * Download and reconstruct a complete public Autonomi file.
     */
    downloadPublicFile(file: any, concurrency?: number | null, on_progress?: Function | null): Promise<any>;
    /**
     * Run Saorsa's iterative closest-node lookup over Rust-owned DataChannels.
     */
    findClosest(target: string, on_progress?: Function | null): Promise<any>;
    /**
     * Construct a reusable client around stable WebRTC Direct seed addresses.
     */
    constructor(endpoints: any);
    /**
     * Resolve a private file from its DataMap for random-access range reads.
     */
    openPrivateFile(file: any, on_progress?: Function | null): Promise<BrowserFileReader>;
    /**
     * Resolve and validate a public file for random-access range reads.
     */
    openPublicFile(file: any, on_progress?: Function | null): Promise<BrowserFileReader>;
    /**
     * Resolve a definitively failed payment, persist the updated checkpoint, and return it.
     *
     * Call only after the original upload and wallet request have finished. The trusted
     * `verify_failure(attempt, scope)` callback must independently verify the entire
     * journal against the original wallet/payment network, without submitting payment.
     * It returns `{ status: "notSubmitted", evidence: {...} }` only when it can prove
     * the wallet never submitted and cannot still submit, or
     * `{ status: "reverted", transactionHashes: [...], evidence: {...} }` after verifying
     * final reverts for every transaction. A missing receipt or timeout is insufficient.
     *
     * Rust checks the result against the journal; the callback owns wallet/chain
     * verification, just as payment callbacks own confirmation. Failure evidence is
     * archived, confirmed proofs are retained, and persistence is awaited before return.
     * Resume the normal upload explicitly with the returned checkpoint.
     */
    reconcileFailedUploadPayment(snapshot: string, verify_failure: Function, on_checkpoint: Function): Promise<string>;
    /**
     * Self-encrypt, quote, pay through a wallet callback, and store a public file.
     */
    uploadPublicFile(content: Uint8Array, name: string, content_type: string, payment_network: any, pay_for_quotes: Function, on_progress?: Function | null, checkpoint?: string | null, on_checkpoint?: Function | null, payment_mode?: string | null, pay_for_merkle?: Function | null): Promise<any>;
    /**
     * Quote, pay for, and store one batch of caller-staged records.
     *
     * Callers that cannot hold a whole file's encrypted records at once stage
     * and upload consecutive batches. Each batch is its own payment and
     * checkpoint scope; the shared coordinator selects single-node or Merkle
     * payment for it exactly as for a complete file. Records are loaded
     * lazily and verified against their addresses on every load.
     */
    uploadRecords(batch: any, payment_network: any, load_record: Function, pay_for_quotes: Function, on_progress?: Function | null, checkpoint?: string | null, on_checkpoint?: Function | null, payment_mode?: string | null, pay_for_merkle?: Function | null): Promise<any>;
    /**
     * Quote, pay for, and upload records produced by `BrowserFileEncryptor`.
     *
     * Record bytes are requested lazily from the asynchronous JavaScript
     * callback, allowing the page to keep them in IndexedDB rather than WASM.
     */
    uploadStagedPublicFile(staged: any, payment_network: any, load_record: Function, pay_for_quotes: Function, on_progress?: Function | null, checkpoint?: string | null, on_checkpoint?: Function | null, payment_mode?: string | null, pay_for_merkle?: Function | null): Promise<any>;
}

/**
 * Native BLAKE3 content address.
 */
export function contentAddress(content: Uint8Array): string;

/**
 * Decode a confirmed vault event using the native ABI and prepared request.
 */
export function decodeMerklePaymentReceipt(request: any, vault: string, logs: any): any;

/**
 * Decode a native public DataMap for browser-side record retrieval.
 */
export function decodePublicDataMap(content: Uint8Array): any;

/**
 * Native public DataMap decoding and whole-file reconstruction.
 */
export function decryptPublicFile(data_map_content: Uint8Array, encrypted_contents: Array<any>): Uint8Array;

/**
 * Native `self_encryption` plus public DataMap generation.
 */
export function encryptPublicFile(content: Uint8Array): any;

/**
 * Read bundled mainnet WebRTC seeds and evmlib payment defaults without I/O.
 */
export function mainnetNetworkDefaults(): any;

/**
 * Validate and normalize browser bootstrap and public-file metadata.
 */
export function parseBrowserManifest(value: any): any;

/**
 * Decode and bound-check a complete WebRTC browser response frame.
 */
export function parseResponseFrame(frame: Uint8Array): any;

/**
 * Validate and normalize a WebRTC Direct multiaddress in shared Rust.
 */
export function parseWebRtcDirectMultiaddr(endpoint: any): any;

/**
 * Compute the native EVM `PaymentQuote` hash.
 */
export function paymentQuoteHash(signed_bytes: Uint8Array, public_key: Uint8Array, signature: Uint8Array): string;

/**
 * Build the ICE-lite answer pinned by a WebRTC Direct endpoint.
 */
export function serverAnswerFromEndpoint(endpoint: any, ice_credential: string): any;

/**
 * Install a readable panic hook for browser developer tools.
 */
export function start(): void;

/**
 * Verify one content-addressed record with native BLAKE3.
 */
export function verifyRecord(address: string, content: Uint8Array): string;

/**
 * Fully verify a storage quote before exposing it to a wallet signer.
 */
export function verifyStorageQuote(quote: any, expected_address: string, expected_peer_id: string): any;

/**
 * Derive the v2 server ufrag from an unchanged browser local description.
 */
export function webRtcDirectV2ServerCredential(local_sdp: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly browsernetworkclient_reconcileFailedUploadPayment: (a: number, b: number, c: number, d: any, e: any) => any;
    readonly __wbg_browserfilereader_free: (a: number, b: number) => void;
    readonly __wbg_browsernetworkclient_free: (a: number, b: number) => void;
    readonly browserfilereader_close: (a: number) => void;
    readonly browserfilereader_contentType: (a: number) => [number, number];
    readonly browserfilereader_name: (a: number) => [number, number];
    readonly browserfilereader_readRange: (a: number, b: number, c: number) => any;
    readonly browserfilereader_size: (a: number) => number;
    readonly browsernetworkclient_close: (a: number) => void;
    readonly browsernetworkclient_connect: (a: number, b: number) => any;
    readonly browsernetworkclient_downloadPrivateFile: (a: number, b: any, c: number, d: number) => any;
    readonly browsernetworkclient_downloadPublicFile: (a: number, b: any, c: number, d: number) => any;
    readonly browsernetworkclient_findClosest: (a: number, b: number, c: number, d: number) => any;
    readonly browsernetworkclient_new: (a: any) => [number, number, number];
    readonly browsernetworkclient_openPrivateFile: (a: number, b: any, c: number) => any;
    readonly browsernetworkclient_openPublicFile: (a: number, b: any, c: number) => any;
    readonly browsernetworkclient_uploadPublicFile: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: any, i: any, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => any;
    readonly browsernetworkclient_uploadRecords: (a: number, b: any, c: any, d: any, e: any, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => any;
    readonly browsernetworkclient_uploadStagedPublicFile: (a: number, b: any, c: any, d: any, e: any, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => any;
    readonly __wbg_browserfileencryptor_free: (a: number, b: number) => void;
    readonly __wbg_browseriterativelookup_free: (a: number, b: number) => void;
    readonly browserfileencryptor_finish: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly browserfileencryptor_new: (a: number, b: any) => [number, number, number];
    readonly browserfileencryptor_nextRecord: (a: number) => [number, number, number];
    readonly browseriterativelookup_addCandidates: (a: number, b: any) => [number, number];
    readonly browseriterativelookup_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly browseriterativelookup_queriedPeers: (a: number) => [number, number, number];
    readonly browseriterativelookup_results: (a: number) => [number, number, number];
    readonly browseriterativelookup_run: (a: number, b: any) => any;
    readonly contentAddress: (a: number, b: number) => [number, number];
    readonly decodeMerklePaymentReceipt: (a: any, b: number, c: number, d: any) => [number, number, number];
    readonly decodePublicDataMap: (a: number, b: number) => [number, number, number];
    readonly decryptPublicFile: (a: number, b: number, c: any) => [number, number, number];
    readonly encryptPublicFile: (a: number, b: number) => [number, number, number];
    readonly mainnetNetworkDefaults: () => [number, number, number];
    readonly parseBrowserManifest: (a: any) => [number, number, number];
    readonly parseResponseFrame: (a: number, b: number) => [number, number, number];
    readonly parseWebRtcDirectMultiaddr: (a: any) => [number, number, number];
    readonly paymentQuoteHash: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly serverAnswerFromEndpoint: (a: any, b: number, c: number) => [number, number, number];
    readonly start: () => void;
    readonly verifyRecord: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly verifyStorageQuote: (a: any, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly webRtcDirectV2ServerCredential: (a: number, b: number) => [number, number, number, number];
    readonly BrotliDecoderCreateInstance: (a: number, b: number, c: number) => number;
    readonly BrotliDecoderDecompress: (a: number, b: number, c: number, d: number) => number;
    readonly BrotliDecoderDecompressPrealloc: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly BrotliDecoderDecompressStream: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly BrotliDecoderDecompressStreaming: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly BrotliDecoderDecompressWithReturnInfo: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly BrotliDecoderDestroyInstance: (a: number) => void;
    readonly BrotliDecoderErrorString: (a: number) => number;
    readonly BrotliDecoderFreeU8: (a: number, b: number, c: number) => void;
    readonly BrotliDecoderFreeUsize: (a: number, b: number, c: number) => void;
    readonly BrotliDecoderGetErrorCode: (a: number) => number;
    readonly BrotliDecoderGetErrorString: (a: number) => number;
    readonly BrotliDecoderHasMoreOutput: (a: number) => number;
    readonly BrotliDecoderIsFinished: (a: number) => number;
    readonly BrotliDecoderIsUsed: (a: number) => number;
    readonly BrotliDecoderMallocU8: (a: number, b: number) => number;
    readonly BrotliDecoderMallocUsize: (a: number, b: number) => number;
    readonly BrotliDecoderSetParameter: (a: number, b: number, c: number) => void;
    readonly BrotliDecoderTakeOutput: (a: number, b: number) => number;
    readonly BrotliDecoderVersion: () => number;
    readonly wasm_bindgen__convert__closures_____invoke__h6c639ae6ac52cf17: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h1a72669c4838b5a0: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h0adb10753c7fca5a: (a: number, b: number, c: any) => any;
    readonly wasm_bindgen__convert__closures_____invoke__h5206e33babbdebc1: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h5206e33babbdebc1_3: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hc4b509476b4504c4: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
