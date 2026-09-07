import type { ProgressDetails } from "../types.js";
import {
  deleteStagedRecords,
  deleteStagedSession,
  getStagedRecord,
} from "./record-store.js";
import { abortable, abortReason, throwIfAborted } from "./abort.js";

export type WorkerWasmSource = ArrayBuffer | WebAssembly.Module;

interface StagedRecord {
  address: string;
  size: number;
}

export interface StagedFile {
  name: string;
  content_type: string;
  address: string;
  blake3: string;
  size: number;
  data_map_size: number;
  chunks: unknown[];
  records: StagedRecord[];
}

export interface StagedUpload {
  sessionId: string;
  staged: StagedFile;
}

function uploadSessionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function ensureUploadStorage(fileSize: number): Promise<void> {
  if (!navigator.storage?.estimate) return;
  try {
    await navigator.storage.persist?.();
  } catch {
    // Persistence is an eviction hint. IndexedDB remains usable when denied.
  }
  const { quota, usage = 0 } = await navigator.storage.estimate();
  if (quota === undefined) return;
  const required = Math.ceil(fileSize * 1.05) + 16 * 1024 * 1024;
  const available = Math.max(0, quota - usage);
  if (available < required) {
    throw new Error(
      `Not enough browser storage to stage this upload: ${available.toLocaleString()} bytes available, approximately ${required.toLocaleString()} required`,
    );
  }
}

export async function stageBlob(
  blob: Blob,
  name: string,
  contentType: string,
  report: (message: string, progress?: ProgressDetails) => void,
  wasm?: WorkerWasmSource,
  signal?: AbortSignal,
): Promise<StagedUpload> {
  throwIfAborted(signal);
  if (typeof Worker !== "function" || typeof indexedDB !== "object") {
    throw new Error("File uploads require Web Workers and IndexedDB in this browser");
  }
  await abortable(ensureUploadStorage(blob.size), signal);
  throwIfAborted(signal);
  const sessionId = uploadSessionId();
  const worker = new Worker(new URL("../upload-worker.js", import.meta.url), {
    type: "module",
  });
  return new Promise((resolve, reject) => {
    let finished = false;
    const stop = (): boolean => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener("abort", cancel);
      worker.terminate();
      return true;
    };
    const fail = (error: unknown): void => {
      if (!stop()) return;
      void deleteStagedSession(sessionId).then(
        () => reject(error),
        () => reject(error),
      );
    };
    const cancel = (): void => {
      if (finished || !signal) return;
      const reason = abortReason(signal);
      fail(reason);
    };
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = event.data as
        | { type: "progress"; message: string; completed?: number }
        | { type: "complete"; staged: StagedFile }
        | { type: "error"; message: string };
      if (message?.type === "progress" && !finished) {
        try {
          report(message.message, { phase: "staging", unit: "records", ...(message.completed === undefined ? {} : { completed: message.completed }) });
        } catch (error) { fail(error); }
      }
      if (message?.type === "complete") {
        if (stop()) {
          resolve({ sessionId, staged: message.staged });
        }
      }
      if (message?.type === "error") fail(new Error(message.message));
    });
    worker.addEventListener("error", (event) => {
      fail(new Error(event.message || "Upload encryption worker failed"));
    });
    if (signal?.aborted) {
      cancel();
      return;
    }
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      worker.postMessage({ type: "stage-file", blob, name, contentType, sessionId, wasm });
    } catch (error) {
      fail(error);
    }
  });
}

export async function loadStagedRecord(
  sessionId: string,
  index: number,
  _address: string,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const content = await abortable(getStagedRecord(sessionId, index), signal);
  if (content.byteLength !== expectedSize) {
    throw new Error(
      `Staged upload record ${index + 1} has ${content.byteLength} bytes, expected ${expectedSize}`,
    );
  }
  return content;
}

export async function clearStagedUpload(upload: StagedUpload): Promise<void> {
  await deleteStagedRecords(upload.sessionId, upload.staged.records.length);
}
