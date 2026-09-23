import { AutonomiError } from "../errors.js";
import type { PrivateFile, PublicFile } from "../types.js";
import { throwIfAborted } from "./abort.js";
import {
  chunksFromCore,
  type CoreEncryptedFile, type CoreRecordBatch, type CoreRecordBatchResult,
} from "./protocol.js";
import type { Reporter } from "./progress.js";
import { deleteStagedRecordRange } from "./record-store.js";
import { getBindings } from "./runtime.js";
import {
  loadStagedRecord, openStagingSession, requestPersistentStaging, stagingBudget,
  type StagedWindow, type StagingSession, type WorkerWasmSource,
} from "./staging.js";
import type { RetainedUpload } from "./upload-recovery.js";
import { unwrapWindowCheckpoint, type WindowPlacement } from "./window-checkpoint.js";

/** Supplies record bytes by batch-local index; Rust verifies them against their address. */
export type RecordLoader = (index: number, address: string, size: number) => Promise<Uint8Array> | Uint8Array;

/**
 * Uploads one batch with the current attempt's wallet, progress, and checkpoint
 * callbacks. `window` is set when the file spans several windows, so persisted
 * checkpoints can name the window their scope covers.
 */
export type RecordBatchUploader = (
  batch: CoreRecordBatch,
  load: RecordLoader,
  window?: WindowPlacement,
) => Promise<CoreRecordBatchResult>;

/** Where a File or Blob upload stands; retained with the input across attempts. */
export interface StagingCursor {
  /** IndexedDB session holding this upload's staged records. */
  readonly sessionId: string;
  /** A staged window whose upload has not completed; its records stay staged for resume. */
  window?: StagedWindow;
  /** First record, by file-level index, that no window has staged yet. */
  nextRecord: number;
  /** The file spans several windows, so each checkpoint names its window. */
  windowed: boolean;
  /** Stage exactly this window next, restoring the scope of a persisted checkpoint. */
  pinned?: { readonly records?: number };
  /** Any completed window was paid through a Merkle batch. */
  usedMerkle: boolean;
}

export interface WindowedUploadContext {
  report: Reporter;
  signal: AbortSignal;
  wasm?: WorkerWasmSource | undefined;
}

/** A stored file, before the SDK adds the payment history retained across attempts. */
export interface UploadedFile {
  file: PublicFile | PrivateFile;
  records: number;
  paymentMode: string;
  transactionHash?: string;
}

/**
 * Restore a persisted checkpoint. A plain Rust checkpoint covers the whole file in
 * one window; a windowed one names the window whose scope it covers.
 */
export function restoreCheckpoint(state: RetainedUpload, value: string): void {
  const windowed = unwrapWindowCheckpoint(value);
  const { cursor } = state;
  if (!windowed) {
    state.coreCheckpoint = value;
    if (cursor) cursor.pinned = {};
    return;
  }
  if (!cursor) {
    throw new AutonomiError("INVALID_SOURCE", "A windowed upload checkpoint resumes only a File or Blob upload");
  }
  state.coreCheckpoint = windowed.checkpoint;
  cursor.nextRecord = windowed.window.firstIndex;
  cursor.pinned = { records: windowed.window.records };
  cursor.windowed = true;
}

/** Self-encrypt retained bytes with the native encryptor and upload every record as one batch. */
export async function uploadBytes(
  state: RetainedUpload,
  upload: RecordBatchUploader,
  report: Reporter,
): Promise<UploadedFile> {
  report(`Self-encrypting ${state.name} (${state.size} bytes)`, { phase: "preparing" });
  const encrypted = getBindings().encryptPublicFile(state.bytes!) as CoreEncryptedFile;
  // Native self-encryption always ends with the canonical DataMap record.
  const dataMap = encrypted.records.at(-1)!.content;
  const records = state.visibility === "private" ? encrypted.records.slice(0, -1) : encrypted.records;
  const result = await upload(
    { records: records.map(({ address, content }) => ({ address, size: content.byteLength })), total_records: records.length },
    (index) => records[index]!.content,
  );
  return uploadedFile(state, result, records.length, {
    address: encrypted.address, size: state.size, blake3: encrypted.blake3,
    dataMapSize: encrypted.data_map_size, chunks: chunksFromCore(encrypted.chunks), dataMap,
  });
}

/**
 * Self-encrypt a File or Blob in a worker and upload it window by window. Each
 * window stages as many records as the origin's storage quota allows, is paid and
 * stored as one batch, and is deleted before the next window is encrypted. A file
 * that fits in one window is uploaded exactly as one batch.
 */
export async function uploadFileInWindows(
  state: RetainedUpload,
  upload: RecordBatchUploader,
  { report, signal, wasm }: WindowedUploadContext,
): Promise<UploadedFile> {
  const cursor = state.cursor!;
  let session: StagingSession | undefined;
  try {
    await requestPersistentStaging();
    for (;;) {
      throwIfAborted(signal);
      if (!cursor.window) {
        session ??= openStagingSession({
          blob: state.blob!, name: state.name, contentType: state.contentType, sessionId: cursor.sessionId,
          skip: cursor.nextRecord, withholdDataMap: state.visibility === "private", wasm, report,
        });
        cursor.window = await stageWindow(session, cursor, signal);
      }
      const window = cursor.window;
      const end = window.firstIndex + window.records.length;
      report(cursor.windowed
        ? `Preparing storage for ${state.name} records ${window.firstIndex + 1}-${end}`
        : `Preparing storage for ${state.name}`, { phase: "preparing" });
      const result = await upload(
        { records: window.records, first_index: window.firstIndex, ...(window.file ? { total_records: end } : {}) },
        (index, _address, size) => loadStagedRecord(cursor.sessionId, window.firstIndex + index, size, signal),
        cursor.windowed ? { firstIndex: window.firstIndex, records: window.records.length } : undefined,
      );
      // The next window has its own checkpoint scope.
      delete state.coreCheckpoint;
      delete cursor.pinned;
      cursor.usedMerkle ||= result.paymentMode === "merkle";
      await deleteStagedRecordRange(cursor.sessionId, window.firstIndex, end);
      delete cursor.window;
      if (window.file) {
        const { file } = window;
        return uploadedFile(state, { ...result, paymentMode: cursor.usedMerkle ? "merkle" : result.paymentMode }, end, {
          address: file.address, size: file.size, blake3: file.blake3, dataMapSize: file.data_map_size,
          chunks: chunksFromCore(file.chunks), ...(window.dataMap ? { dataMap: window.dataMap } : {}),
        });
      }
    }
  } finally {
    session?.close();
  }
}

async function stageWindow(session: StagingSession, cursor: StagingCursor, signal: AbortSignal): Promise<StagedWindow> {
  try {
    const limit = cursor.pinned ? cursor.pinned : { bytes: await stagingBudget() };
    const window = await session.next(limit, signal);
    cursor.nextRecord = window.firstIndex + window.records.length;
    if (!window.file) cursor.windowed = true;
    return window;
  } catch (error) {
    // Drop a partially staged window; a resumed attempt stages it again.
    await deleteStagedRecordRange(cursor.sessionId, cursor.nextRecord).catch(() => undefined);
    throw error;
  }
}

/** Encryptor output describing a stored file; `dataMap` is its canonical DataMap record. */
interface EncryptedFileMetadata {
  address: string;
  size: number;
  blake3: string;
  dataMapSize: number;
  chunks: PublicFile["chunks"];
  dataMap?: Uint8Array;
}

function uploadedFile(
  state: RetainedUpload,
  result: CoreRecordBatchResult,
  records: number,
  { address, dataMap, ...metadata }: EncryptedFileMetadata,
): UploadedFile {
  const described = { ...metadata, name: state.name, contentType: state.contentType, replicas: result.replicas };
  if (state.visibility === "private" && !dataMap) throw new Error("Self-encryption did not return the private DataMap");
  return {
    // A private file is read through its DataMap; the address would only name an unstored record.
    file: state.visibility === "private" ? { ...described, dataMap: dataMap!.slice() } : { ...described, address },
    records,
    paymentMode: result.paymentMode,
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}
