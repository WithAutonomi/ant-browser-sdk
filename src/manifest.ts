import { AutonomiError, wrapError } from "./errors.js";
import { abortable, throwIfAborted } from "./internal/abort.js";
import { getBindings, initializeClientWasm } from "./internal/runtime.js";
import type { OperationOptions, PrivateFileReference, WasmSource } from "./types.js";

/**
 * One file described by a manifest (ant-client ADR-0006).
 *
 * An `embedded` entry carries the DataMap bytes a private download takes, so
 * reading it skips the DataMap fetch. A `public` entry carries only the
 * address of its public DataMap chunk.
 */
export interface ManifestEntry {
  /** The path, or the hex content address when the entry has no path. */
  readonly name: string;
  /** Relative path inside the manifest, when recorded. */
  readonly path?: string;
  /** Size hint recorded by the creator. Display only; nothing is decided by it. */
  readonly size?: number;
  readonly kind: "embedded" | "public";
  /** Hex content address: the public DataMap address of the file. */
  readonly address: string;
  /** Canonical DataMap bytes of an embedded entry. */
  readonly dataMap?: Uint8Array;
}

/** The BitTorrent identity of the same files, when the manifest's creator recorded one. */
export interface TorrentReference {
  /** Hex SHA-1 info hash of a v1 torrent (BEP 3). */
  readonly infoHashV1?: string;
  /** Hex SHA-256 info hash of a v2 or hybrid torrent (BEP 52). */
  readonly infoHashV2?: string;
}

/** A decoded manifest: a named set of files and how to fetch each one. */
export interface Manifest {
  /** Suggested root directory name. */
  readonly name?: string;
  /** Torrent identity of the same files. Informational; the SDK does nothing with it yet. */
  readonly torrent?: TorrentReference;
  readonly entries: readonly ManifestEntry[];
}

/** What an `ant://` link points at. */
export type ManifestLink =
  | { readonly kind: "file"; readonly address: string }
  | { readonly kind: "manifest"; readonly manifest: Manifest };

export interface ManifestOptions extends OperationOptions {
  /** WASM source, as for `initializeWasm()`; the module is initialized once. */
  wasm?: WasmSource | Promise<WasmSource>;
}

interface CoreManifestEntry {
  name: string; path?: string | null; size?: number | null; kind: "embedded" | "public"; address: string; dataMap?: Uint8Array;
}
interface CoreTorrent { infoHashV1?: string | null; infoHashV2?: string | null }
interface CoreManifest { name?: string | null; torrent?: CoreTorrent | null; entries: CoreManifestEntry[] }
type CoreLink = { kind: "file"; address: string } | { kind: "manifest"; manifest: CoreManifest };

/**
 * Parse an `ant://manifest/...` link, an `ant://<address>` file link, or a
 * bare 64-character hex address. Nothing is fetched: a manifest link carries
 * the manifest bytes, and a file link is only an address.
 */
export async function parseManifestLink(link: string, options: ManifestOptions = {}): Promise<ManifestLink> {
  throwIfAborted(options.signal);
  await abortable(initializeClientWasm(options.wasm), options.signal);
  throwIfAborted(options.signal);
  try {
    const raw = getBindings().parseManifestLink(link) as CoreLink;
    return raw.kind === "file"
      ? Object.freeze({ kind: "file", address: raw.address })
      : Object.freeze({ kind: "manifest", manifest: manifestFromCore(raw.manifest) });
  } catch (error) {
    throw wrapError("INVALID_SOURCE", "The link is not a valid Autonomi file or manifest link", error);
  }
}

/** Decode the bytes of a `.ant` manifest file. Nothing is fetched. */
export async function decodeManifest(bytes: Uint8Array, options: ManifestOptions = {}): Promise<Manifest> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new AutonomiError("INVALID_SOURCE", "A manifest requires its file bytes");
  }
  throwIfAborted(options.signal);
  await abortable(initializeClientWasm(options.wasm), options.signal);
  throwIfAborted(options.signal);
  try {
    return manifestFromCore(getBindings().decodeManifest(bytes) as CoreManifest);
  } catch (error) {
    throw wrapError("INVALID_SOURCE", "The bytes are not a valid manifest", error);
  }
}

/** Whether `value` is a manifest entry rather than an address, public file, or private reference. */
export function isManifestEntry(value: unknown): value is ManifestEntry {
  return (
    typeof value === "object" && value !== null &&
    "kind" in value && ((value as ManifestEntry).kind === "embedded" || (value as ManifestEntry).kind === "public") &&
    typeof (value as ManifestEntry).address === "string" && typeof (value as ManifestEntry).name === "string"
  );
}

/**
 * What the client reads for an entry: the embedded DataMap as a private file
 * reference, or the public address. The entry's name becomes the file name.
 */
export function manifestEntrySource(entry: ManifestEntry): string | PrivateFileReference {
  if (entry.kind === "embedded") {
    if (!(entry.dataMap instanceof Uint8Array) || entry.dataMap.byteLength === 0) {
      throw new AutonomiError("INVALID_SOURCE", `Manifest entry ${entry.name} is embedded but carries no DataMap`);
    }
    return { dataMap: entry.dataMap, name: fileName(entry) };
  }
  return entry.address;
}

/** The last path component, which is what a saved file should be called. */
export function fileName(entry: Pick<ManifestEntry, "name">): string {
  return entry.name.slice(entry.name.lastIndexOf("/") + 1) || entry.name;
}

function manifestFromCore(raw: CoreManifest): Manifest {
  const torrent = raw.torrent
    ? Object.freeze({
      ...(raw.torrent.infoHashV1 ? { infoHashV1: raw.torrent.infoHashV1 } : {}),
      ...(raw.torrent.infoHashV2 ? { infoHashV2: raw.torrent.infoHashV2 } : {}),
    })
    : undefined;
  return Object.freeze({
    ...(raw.name ? { name: raw.name } : {}),
    ...(torrent ? { torrent } : {}),
    entries: Object.freeze(raw.entries.map((entry) => Object.freeze({
      name: entry.name,
      ...(entry.path ? { path: entry.path } : {}),
      ...(typeof entry.size === "number" ? { size: entry.size } : {}),
      kind: entry.kind,
      address: entry.address,
      ...(entry.dataMap ? { dataMap: entry.dataMap } : {}),
    }))),
  });
}
