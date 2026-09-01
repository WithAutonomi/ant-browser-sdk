import { deleteStagedRecords, getStagedRecord } from "./record-store.js";

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
  report: (message: string) => void,
): Promise<StagedUpload> {
  if (typeof Worker !== "function" || typeof indexedDB !== "object") {
    throw new Error("File uploads require Web Workers and IndexedDB in this browser");
  }
  await ensureUploadStorage(blob.size);
  const sessionId = uploadSessionId();
  const worker = new Worker(new URL("../upload-worker.js", import.meta.url), {
    type: "module",
  });
  return new Promise((resolve, reject) => {
    const finish = <T>(callback: (value: T) => void, value: T): void => {
      worker.terminate();
      callback(value);
    };
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = event.data as
        | { type: "progress"; message: string }
        | { type: "complete"; staged: StagedFile }
        | { type: "error"; message: string };
      if (message?.type === "progress") report(message.message);
      if (message?.type === "complete") {
        finish(resolve, { sessionId, staged: message.staged });
      }
      if (message?.type === "error") finish(reject, new Error(message.message));
    });
    worker.addEventListener("error", (event) => {
      finish(reject, new Error(event.message || "Upload encryption worker failed"));
    });
    worker.postMessage({ type: "stage-file", blob, name, contentType, sessionId });
  });
}

export async function loadStagedRecord(
  sessionId: string,
  index: number,
  _address: string,
  expectedSize: number,
): Promise<Uint8Array> {
  const content = await getStagedRecord(sessionId, index);
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
