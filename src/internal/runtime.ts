import initAntCore, {
  BrowserNetworkClient,
  BrowserNodeClient,
  parseWebRtcDirectMultiaddr,
  decodeMerklePaymentReceipt,
  encryptPublicFile,
  mainnetNetworkDefaults,
} from "../wasm/ant_core.js";
import { AutonomiError } from "../errors.js";
import type { WasmSource } from "../types.js";

export interface RawFileReader {
  readonly size: number;
  readonly contentType: string;
  readonly name: string;
  readRange(start: number, length: number): Promise<Uint8Array>;
  close(): void;
  free(): void;
}

export interface RawNetworkClient {
  reconcileFailedUploadPayment(
    checkpoint: string,
    verifyFailure: (attempt: unknown, scope: string) => unknown,
    onCheckpoint: (checkpoint: string) => void | Promise<void>,
  ): Promise<string>;
  findClosest(target: string, onProgress?: (message: string) => void): Promise<unknown>;
  downloadPublicFile(
    file: unknown,
    concurrency: number | undefined,
    onProgress?: (message: string) => void,
  ): Promise<unknown>;
  openPublicFile(
    file: unknown,
    onProgress?: (message: string) => void,
  ): Promise<RawFileReader>;
  /** Quote, pay for, and store one batch; `loadRecord` receives the batch-local index. */
  uploadRecords(
    batch: unknown,
    paymentNetwork: unknown,
    loadRecord: (index: number, address: string, size: number) => Promise<Uint8Array> | Uint8Array,
    payForQuotes: (...args: unknown[]) => Promise<unknown>,
    onProgress?: (message: string) => void,
    checkpoint?: string,
    onCheckpoint?: (checkpoint: string) => void | Promise<void>,
    paymentMode?: string,
    payForMerkle?: (...args: unknown[]) => Promise<unknown>,
  ): Promise<unknown>;
  close(): void;
  free(): void;
}

export interface RawNodeClient {
  connect(): Promise<RawNodeSession>;
  free(): void;
}

export interface RawNodeSession {
  hello(): Promise<unknown>;
  close(): void;
  free(): void;
}

export interface WasmBindings {
  mainnetNetworkDefaults(): unknown;
  BrowserNetworkClient: new (endpoints: unknown) => RawNetworkClient;
  BrowserNodeClient: new (endpoint: unknown) => RawNodeClient;
  parseWebRtcDirectMultiaddr(value: unknown): { multiaddr: string };
  decodeMerklePaymentReceipt?(request: unknown, vault: string, logs: unknown): unknown;
  encryptPublicFile(content: Uint8Array): unknown;
}

type LoadedSource = ArrayBuffer | WebAssembly.Module;
interface Initialization {
  requested: WasmSource | Promise<WasmSource> | undefined;
  loaded?: LoadedSource;
  promise: Promise<WebAssembly.Module>;
}
let initialization: Initialization | undefined;

/** Initialize the page's shared WASM module. Later explicit sources must match. */
export async function initializeWasm(source?: WasmSource | Promise<WasmSource>): Promise<void> {
  await initializeClientWasm(source);
}

/** The very same compiled module is used by the page and every upload worker. */
export async function initializeClientWasm(
  source?: WasmSource | Promise<WasmSource>,
): Promise<WebAssembly.Module> {
  try {
    if (!initialization) {
      const state: Initialization = {
        requested: source,
        promise: Promise.resolve().then(async () => {
          const loaded = await loadSource(source);
          state.loaded = loaded;
          const module = loaded instanceof WebAssembly.Module
            ? loaded : await WebAssembly.compile(loaded);
          await initAntCore({ module_or_path: module });
          return module;
        }),
      };
      initialization = state;
      void state.promise.catch(() => {
        if (initialization === state) initialization = undefined;
      });
      return await state.promise;
    }
    const state = initialization;
    if (source === undefined || source === state.requested) return await state.promise;
    const [module, requested] = await Promise.all([state.promise, loadSource(source)]);
    if (requested === module || sameSource(state.loaded!, requested)) return module;
    throw new AutonomiError(
      "INITIALIZATION_FAILED",
      "WASM is already initialized with a different source; omit wasm to reuse it or reload the page",
    );
  } catch (error) {
    if (error instanceof AutonomiError) throw error;
    throw new AutonomiError("INITIALIZATION_FAILED", "Could not initialize the Autonomi WASM core", error);
  }
}

async function loadSource(source: WasmSource | Promise<WasmSource> | undefined): Promise<LoadedSource> {
  const resolved = await (source ?? new URL("../wasm/ant_core_bg.wasm", import.meta.url));
  if (resolved instanceof WebAssembly.Module) return resolved;
  if (resolved instanceof ArrayBuffer) return resolved.slice(0);
  if (ArrayBuffer.isView(resolved)) {
    return new Uint8Array(resolved.buffer, resolved.byteOffset, resolved.byteLength).slice().buffer;
  }
  const response = resolved instanceof Response ? resolved : await fetch(resolved);
  if (!response.ok) throw new Error(`Could not load Autonomi WASM (${response.status} ${response.statusText})`);
  return response.arrayBuffer();
}

function sameSource(left: LoadedSource, right: LoadedSource): boolean {
  if (left === right) return true;
  if (!(left instanceof ArrayBuffer) || !(right instanceof ArrayBuffer)) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function getBindings(): WasmBindings {
  return {
    BrowserNetworkClient,
    BrowserNodeClient,
    parseWebRtcDirectMultiaddr,
    decodeMerklePaymentReceipt,
    encryptPublicFile,
    mainnetNetworkDefaults,
  };
}
