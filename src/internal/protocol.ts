import { AutonomiError } from "../errors.js";
import type { HelloInfo, LookupFailure, LookupResult, NetworkNode, PaymentNetwork, PrivateFile, PublicFile } from "../types.js";

/** Rust/WASM wire representations stay private to the SDK. */
export interface CorePublicFile {
  name: string;
  address: string;
  size: number;
  content_type: string;
  blake3: string;
  data_map_size: number;
  chunks: { index: number; dst_hash: string; src_hash: string; src_size: number }[];
  replicas: number;
}

export interface CoreHelloInfo {
  type: string;
  protocol: string;
  peer_id: string;
  endpoint: { multiaddr: string };
  max_chunk_size: number;
  capabilities: string[];
  payment: unknown;
}

export interface CoreNetworkNode {
  peer_id: string;
  native_addresses: string[];
  reliability: number;
  webrtc_direct?: { multiaddr: string } | null;
}

export interface CoreLookupResult {
  nodes: CoreNetworkNode[];
  queried: string[];
  failures: LookupFailure[];
}

export type CoreChunkInfo = CorePublicFile["chunks"][number];

export interface CoreRecordInfo {
  address: string;
  size: number;
}

/** Records paid and stored together; positions only affect progress text. */
export interface CoreRecordBatch {
  records: CoreRecordInfo[];
  first_index?: number;
  total_records?: number;
}

export interface CoreRecordBatchResult {
  transactionHash?: string;
  storageCostAtto: string;
  records: number;
  replicas: number;
  paymentMode: string;
}

/** Native self-encryption output: data records, then the canonical DataMap record. */
export interface CoreEncryptedFile {
  address: string;
  blake3: string;
  data_map_size: number;
  chunks: CoreChunkInfo[];
  records: { address: string; content: Uint8Array }[];
}

export function chunksFromCore(chunks: readonly CoreChunkInfo[]): PublicFile["chunks"] {
  return chunks.map((chunk) => ({ index: chunk.index, dstHash: chunk.dst_hash, srcHash: chunk.src_hash, srcSize: chunk.src_size }));
}

export function publicFileFromCore(file: CorePublicFile): PublicFile {
  return {
    name: file.name, address: file.address, size: file.size, contentType: file.content_type,
    blake3: file.blake3, dataMapSize: file.data_map_size, replicas: file.replicas,
    chunks: chunksFromCore(file.chunks),
  };
}

export function corePublicFile(file: PublicFile): CorePublicFile {
  return {
    name: file.name, address: file.address, size: file.size, content_type: file.contentType,
    blake3: file.blake3, data_map_size: file.dataMapSize, replicas: file.replicas,
    chunks: file.chunks.map((chunk) => ({ index: chunk.index, dst_hash: chunk.dstHash, src_hash: chunk.srcHash, src_size: chunk.srcSize })),
  };
}

export function isPrivateFile(file: string | PublicFile | PrivateFile): file is PrivateFile {
  return typeof file === "object" && file !== null && "dataMap" in file;
}

/** Private reads pass the caller-held DataMap; Rust fetches its nested records. */
export function corePrivateFile(file: PrivateFile): { data_map: Uint8Array; name: string; content_type: string } {
  if (!(file.dataMap instanceof Uint8Array) || file.dataMap.byteLength === 0) {
    throw new AutonomiError("INVALID_SOURCE", "A private file requires its DataMap bytes");
  }
  return { data_map: file.dataMap, name: file.name, content_type: file.contentType };
}

/** Rust describes a private file like a public one; the SDK keeps the caller's DataMap instead of an address. */
export function privateFileFromCore(file: CorePublicFile, dataMap: Uint8Array): PrivateFile {
  return {
    name: file.name, size: file.size, contentType: file.content_type, blake3: file.blake3,
    dataMap: dataMap.slice(), dataMapSize: file.data_map_size, chunks: chunksFromCore(file.chunks), replicas: file.replicas,
  };
}

/** Read APIs identify content solely by its DataMap address. */
export function coreFileReference(file: Pick<PublicFile, "address" | "name" | "contentType">): Pick<CorePublicFile, "address" | "name" | "content_type"> {
  return { address: file.address, name: file.name, content_type: file.contentType };
}

export function helloFromCore(hello: CoreHelloInfo, payment: PaymentNetwork): HelloInfo {
  return {
    type: hello.type, protocol: hello.protocol, peerId: hello.peer_id,
    endpoint: { ...hello.endpoint }, maxChunkSize: hello.max_chunk_size,
    capabilities: [...hello.capabilities], payment,
  };
}

export function nodeFromCore(node: CoreNetworkNode): NetworkNode {
  return {
    peerId: node.peer_id, nativeAddresses: [...node.native_addresses], reliability: node.reliability,
    ...(node.webrtc_direct ? { webrtcDirect: { ...node.webrtc_direct } } : {}),
  };
}

export function lookupFromCore(result: CoreLookupResult): LookupResult {
  return { nodes: result.nodes.map(nodeFromCore), queried: [...result.queried], failures: result.failures.map((failure) => ({ ...failure })) };
}
