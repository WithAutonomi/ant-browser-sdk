import initAntCore, {
  BrowserNetworkClient,
  BrowserNodeClient,
  parseWebRtcDirectMultiaddr,
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
  findClosest(target: string, onProgress?: (message: string) => void): Promise<unknown>;
  downloadPublicFile(
    file: unknown,
    concurrency: number,
    onProgress?: (message: string) => void,
  ): Promise<unknown>;
  openPublicFile(
    file: unknown,
    onProgress?: (message: string) => void,
  ): Promise<RawFileReader>;
  uploadPublicFile(
    content: Uint8Array,
    name: string,
    contentType: string,
    paymentNetwork: unknown,
    payForQuotes: (...args: unknown[]) => Promise<unknown>,
    onProgress?: (message: string) => void,
  ): Promise<unknown>;
  uploadStagedPublicFile(
    staged: unknown,
    paymentNetwork: unknown,
    loadRecord: (...args: unknown[]) => Promise<Uint8Array>,
    payForQuotes: (...args: unknown[]) => Promise<unknown>,
    onProgress?: (message: string) => void,
  ): Promise<unknown>;
  close(): void;
  free(): void;
}

export interface RawNodeClient {
  hello(): Promise<unknown>;
  close(): void;
  free(): void;
}

export interface WasmBindings {
  BrowserNetworkClient: new (endpoints: unknown) => RawNetworkClient;
  BrowserNodeClient: new (endpoint: unknown) => RawNodeClient;
  parseWebRtcDirectMultiaddr(value: unknown): { multiaddr: string };
}

let initialization: Promise<void> | undefined;

/** Initialize the bundled Rust/WASM core once. Usually called by `connect`. */
export async function initializeWasm(
  source?: WasmSource | Promise<WasmSource>,
): Promise<void> {
  initialization ??= initAntCore(
    source === undefined ? undefined : { module_or_path: source },
  )
    .then(() => undefined)
    .catch((error: unknown) => {
      initialization = undefined;
      throw new AutonomiError(
        "INITIALIZATION_FAILED",
        "Could not initialize the Autonomi WASM core",
        error,
      );
    });
  await initialization;
}

export function getBindings(): WasmBindings {
  return {
    BrowserNetworkClient,
    BrowserNodeClient,
    parseWebRtcDirectMultiaddr,
  };
}
