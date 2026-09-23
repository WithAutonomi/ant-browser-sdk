import type { PublicFile } from "../types.js";
import {
  chunksFromCore,
  type CoreEncryptedFile, type CoreRecordBatch, type CoreRecordBatchResult, type CoreRecordInfo,
} from "./protocol.js";
import type { Reporter } from "./progress.js";
import { getBindings } from "./runtime.js";
import { loadStagedRecord } from "./staging.js";
import type { RetainedUpload } from "./upload-recovery.js";

/** Supplies record bytes by batch-local index; Rust verifies them against their address. */
export type RecordLoader = (index: number, address: string, size: number) => Promise<Uint8Array> | Uint8Array;

/** Uploads one batch with the current attempt's wallet, progress, and checkpoint callbacks. */
export type RecordBatchUploader = (batch: CoreRecordBatch, load: RecordLoader) => Promise<CoreRecordBatchResult>;

/** A stored file, before the SDK adds the payment history retained across attempts. */
export interface UploadedFile {
  file: PublicFile;
  records: number;
  paymentMode: string;
  transactionHash?: string;
}

/** Self-encrypt retained bytes with the native encryptor and upload every record as one batch. */
export async function uploadBytes(
  state: RetainedUpload,
  upload: RecordBatchUploader,
  report: Reporter,
): Promise<UploadedFile> {
  report(`Self-encrypting ${state.name} (${state.size} bytes)`, { phase: "preparing" });
  const encrypted = getBindings().encryptPublicFile(state.bytes!) as CoreEncryptedFile;
  const { records } = encrypted;
  const result = await upload(
    { records: records.map(({ address, content }) => ({ address, size: content.byteLength })), total_records: records.length },
    (index) => records[index]!.content,
  );
  return uploadedFile(result, records.length, {
    name: state.name, address: encrypted.address, size: state.size, contentType: state.contentType,
    blake3: encrypted.blake3, dataMapSize: encrypted.data_map_size, chunks: chunksFromCore(encrypted.chunks),
  });
}

/** Upload every record a worker staged in IndexedDB as one batch. */
export async function uploadStaged(
  state: RetainedUpload,
  upload: RecordBatchUploader,
  signal: AbortSignal,
): Promise<UploadedFile> {
  const { sessionId, staged } = state.staged!;
  const records: CoreRecordInfo[] = staged.records;
  const result = await upload(
    { records, total_records: records.length },
    (index, _address, size) => loadStagedRecord(sessionId, index, size, signal),
  );
  return uploadedFile(result, records.length, {
    name: staged.name, address: staged.address, size: staged.size, contentType: staged.content_type,
    blake3: staged.blake3, dataMapSize: staged.data_map_size, chunks: chunksFromCore(staged.chunks),
  });
}

function uploadedFile(
  result: CoreRecordBatchResult,
  records: number,
  file: Omit<PublicFile, "replicas">,
): UploadedFile {
  return {
    file: { ...file, replicas: result.replicas },
    records,
    paymentMode: result.paymentMode,
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}
