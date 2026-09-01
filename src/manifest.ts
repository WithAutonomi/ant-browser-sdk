import { AutonomiError, wrapError } from "./errors.js";
import { getBindings, initializeWasm } from "./internal/runtime.js";
import type { BrowserManifest, WasmSource } from "./types.js";

export interface FetchManifestOptions {
  fetch?: typeof globalThis.fetch;
  wasm?: WasmSource | Promise<WasmSource>;
}

/** Fetch, structurally validate, and normalize an untrusted browser manifest. */
export async function fetchManifest(
  url: string | URL,
  options: FetchManifestOptions = {},
): Promise<BrowserManifest> {
  await initializeWasm(options.wasm);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new AutonomiError(
      "MANIFEST_FAILED",
      "No fetch implementation is available for the browser manifest",
    );
  }
  try {
    const response = await fetcher(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`manifest request returned HTTP ${response.status}`);
    }
    return await parseManifest(await response.json(), options);
  } catch (error) {
    throw wrapError("MANIFEST_FAILED", "Could not load the browser manifest", error);
  }
}

/** Validate and normalize a manifest value with the shared Rust protocol parser. */
export async function parseManifest(
  value: unknown,
  options: Pick<FetchManifestOptions, "wasm"> = {},
): Promise<BrowserManifest> {
  await initializeWasm(options.wasm);
  try {
    return getBindings().parseBrowserManifest(value) as BrowserManifest;
  } catch (error) {
    throw wrapError("MANIFEST_FAILED", "Invalid browser manifest", error);
  }
}
