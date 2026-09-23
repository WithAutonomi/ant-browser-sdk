/** One content-addressed record produced by the native streaming encryptor. */
export interface EncryptedRecord {
  address: string;
  content: Uint8Array;
}

export interface WindowRecord {
  address: string;
  size: number;
}

/**
 * Bound one staging window by bytes, or restore a checkpoint's exact window by
 * record count. `records` is omitted when the window runs to the end of the file.
 */
export type WindowLimit = { readonly bytes: number } | { readonly records?: number };

export interface StagedWindowRecords {
  /** File-level index of the first record in this window. */
  firstIndex: number;
  records: WindowRecord[];
  /** The encryptor has produced every record, including the DataMap record. */
  complete: boolean;
}

/**
 * Stages consecutive encrypted records in bounded windows. A record that does not
 * fit is held back in memory and opens the next window, so the encryptor runs once.
 */
export class WindowStager {
  readonly #next: () => EncryptedRecord | undefined;
  readonly #put: (index: number, content: Uint8Array) => Promise<void>;
  #pending: EncryptedRecord | undefined;
  #produced = 0;

  constructor(
    next: () => EncryptedRecord | undefined,
    put: (index: number, content: Uint8Array) => Promise<void>,
  ) {
    this.#next = next;
    this.#put = put;
  }

  /** Re-encrypt and discard records that earlier windows already stored. */
  skip(count: number, onSkipped?: (produced: number) => void): void {
    while (this.#produced < count) {
      if (!this.#take()) throw new Error("The file ended before the resumed upload window; select the original file");
      this.#produced += 1;
      onSkipped?.(this.#produced);
    }
  }

  async stage(limit: WindowLimit, onStaged?: (produced: number) => void): Promise<StagedWindowRecords> {
    const firstIndex = this.#produced;
    const records: WindowRecord[] = [];
    let bytes = 0;
    for (;;) {
      const record = this.#take();
      if (!record) return { firstIndex, records, complete: true };
      const size = record.content.byteLength;
      if (windowIsFull(limit, records.length, bytes, size)) {
        this.#pending = record;
        return { firstIndex, records, complete: false };
      }
      try {
        await this.#put(this.#produced, record.content);
      } catch (error) {
        // Quota estimates are hints; end a byte-bounded window early rather than fail it.
        if ("bytes" in limit && records.length > 0 && isQuotaExceeded(error)) {
          this.#pending = record;
          return { firstIndex, records, complete: false };
        }
        throw error;
      }
      records.push({ address: record.address, size });
      bytes += size;
      this.#produced += 1;
      onStaged?.(this.#produced);
    }
  }

  #take(): EncryptedRecord | undefined {
    const record = this.#pending ?? this.#next();
    this.#pending = undefined;
    return record;
  }
}

function windowIsFull(limit: WindowLimit, count: number, bytes: number, size: number): boolean {
  if (!("bytes" in limit)) return limit.records !== undefined && count >= limit.records;
  if (bytes + size <= limit.bytes) return false;
  if (count > 0) return true;
  throw new Error(
    `Not enough browser storage to stage an upload window: ${Math.max(0, limit.bytes).toLocaleString()} bytes available, a record needs ${size.toLocaleString()}`,
  );
}

function isQuotaExceeded(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "QuotaExceededError";
}
