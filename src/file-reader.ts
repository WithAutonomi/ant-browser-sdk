import { AutonomiError, wrapError } from "./errors.js";
import type { RawFileReader } from "./internal/runtime.js";
import type { StreamOptions } from "./types.js";

const MAX_RANGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_STREAM_CHUNK_BYTES = 1024 * 1024;

/** Bounded random-access reader backed by direct WebRTC record fetches. */
export class PublicFileReader {
  readonly address: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string;

  #raw: RawFileReader;
  #closed = false;

  /** @internal Construct readers with `AutonomiClient.openFile`. */
  constructor(raw: RawFileReader, address: string) {
    this.#raw = raw;
    this.address = address;
    this.name = raw.name;
    this.size = raw.size;
    this.contentType = raw.contentType;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Read one plaintext range. Reads past end-of-file are truncated. */
  async read(start: number, length: number): Promise<Uint8Array> {
    this.#assertOpen();
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new AutonomiError("OPEN_FILE_FAILED", "Range start must be a non-negative integer");
    }
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RANGE_BYTES) {
      throw new AutonomiError(
        "OPEN_FILE_FAILED",
        `Range length must be an integer from 0 through ${MAX_RANGE_BYTES}`,
      );
    }
    try {
      return await this.#raw.readRange(start, length);
    } catch (error) {
      throw wrapError("OPEN_FILE_FAILED", "Could not read the public file range", error);
    }
  }

  /** Stream a sequential plaintext range while keeping memory use bounded. */
  stream(options: StreamOptions = {}): ReadableStream<Uint8Array> {
    this.#assertOpen();
    const start = options.start ?? 0;
    const end = options.end ?? this.size;
    const chunkSize = options.chunkSize ?? DEFAULT_STREAM_CHUNK_BYTES;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.size
    ) {
      throw new AutonomiError(
        "OPEN_FILE_FAILED",
        "Stream bounds must describe a valid half-open file range",
      );
    }
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_RANGE_BYTES) {
      throw new AutonomiError(
        "OPEN_FILE_FAILED",
        `Stream chunkSize must be an integer from 1 through ${MAX_RANGE_BYTES}`,
      );
    }

    let offset = start;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (this.#closed) {
          controller.error(new AutonomiError("CLIENT_CLOSED", "Public file reader is closed"));
          return;
        }
        if (offset >= end) {
          controller.close();
          return;
        }
        try {
          const bytes = await this.read(offset, Math.min(chunkSize, end - offset));
          if (bytes.byteLength === 0) {
            controller.close();
            return;
          }
          offset += bytes.byteLength;
          controller.enqueue(bytes);
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  /** Release range caches. The reader cannot be reused after this call. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#raw.close();
    this.#raw.free();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AutonomiError("CLIENT_CLOSED", "Public file reader is closed");
    }
  }
}
