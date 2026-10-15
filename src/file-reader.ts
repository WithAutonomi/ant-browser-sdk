import { AutonomiError, wrapError } from "./errors.js";
import { abortable, abortReason, isAbort, throwIfAborted } from "./internal/abort.js";
import type { RawFileReader } from "./internal/runtime.js";
import type { PipeOptions, PipeResult, ReadOptions, StreamOptions } from "./types.js";
import { SDK_LIMITS } from "./limits.js";

/** @internal Only the SDK may wrap a WASM reader. Not exported by the package. */
export let createPublicFileReader: (raw: RawFileReader, address: string) => PublicFileReader;

/** Bounded random-access reader backed by direct WebRTC record fetches. */
export class PublicFileReader {
  /** DataMap address; empty for a private file, which has no network DataMap. */
  readonly address: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string;

  #raw: RawFileReader;
  #closed = false;
  #active = 0;
  #freed = false;
  #pipes = new Set<AbortController>();

  private constructor(raw: RawFileReader, address: string) {
    this.#raw = raw;
    this.address = address;
    this.name = raw.name;
    this.size = raw.size;
    this.contentType = raw.contentType;
  }

  static {
    createPublicFileReader = (raw, address) => new PublicFileReader(raw, address);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Read one plaintext range. Reads past end-of-file are truncated. */
  async read(
    start: number,
    length: number,
    options: ReadOptions = {},
  ): Promise<Uint8Array> {
    this.#assertOpen();
    throwIfAborted(options.signal);
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new AutonomiError("OPEN_FILE_FAILED", "Range start must be a non-negative integer");
    }
    if (!Number.isSafeInteger(length) || length < 0 || length > SDK_LIMITS.maxRangeBytes) {
      throw new AutonomiError(
        "OPEN_FILE_FAILED",
        `Range length must be an integer from 0 through ${SDK_LIMITS.maxRangeBytes}`,
      );
    }
    try {
      return await abortable(this.#call(() => this.#raw.readRange(start, length)), options.signal);
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      throw wrapError("OPEN_FILE_FAILED", "Could not read the public file range", error);
    }
  }

  /**
   * Write a verified range with the core's bounded, concurrent download pipeline.
   * Closes the destination on success and aborts it on transfer failure. Invalid
   * options leave it untouched. Cancellation during close may happen after the
   * destination has committed. The reader remains reusable until close().
   */
  async pipeTo(destination: WritableStream<Uint8Array>, options: PipeOptions = {}): Promise<PipeResult> {
    this.#assertOpen();
    const signal = options.signal;
    throwIfAborted(signal);
    const controller = new AbortController();
    const abort = (): void => controller.abort(abortReason(signal!));
    signal?.addEventListener("abort", abort, { once: true });
    this.#pipes.add(controller);
    try {
      return await this.#call(() => this.#raw.pipeTo(destination, { ...options, signal: controller.signal }));
    } catch (error) {
      if (isAbort(error, controller.signal)) throw error;
      throw wrapError("OPEN_FILE_FAILED", "Could not stream the file to its destination", error);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.#pipes.delete(controller);
    }
  }

  /** Stream a sequential plaintext range while keeping memory use bounded. */
  stream(options: StreamOptions = {}): ReadableStream<Uint8Array> {
    this.#assertOpen();
    throwIfAborted(options.signal);
    const start = options.start ?? 0;
    const end = options.end ?? this.size;
    const chunkSize = options.chunkSize ?? SDK_LIMITS.defaultStreamChunkBytes;
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
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > SDK_LIMITS.maxRangeBytes) {
      throw new AutonomiError(
        "OPEN_FILE_FAILED",
        `Stream chunkSize must be an integer from 1 through ${SDK_LIMITS.maxRangeBytes}`,
      );
    }

    let offset = start;
    let aborted = false;
    let removeAbortListener = (): void => {};
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (!options.signal) return;
        const abort = (): void => {
          aborted = true;
          removeAbortListener();
          controller.error(abortReason(options.signal!));
        };
        options.signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
      },
      pull: async (controller) => {
        if (aborted) return;
        if (this.#closed) {
          removeAbortListener();
          controller.error(new AutonomiError("CLIENT_CLOSED", "Public file reader is closed"));
          return;
        }
        if (offset >= end) {
          removeAbortListener();
          controller.close();
          return;
        }
        try {
          const bytes = await this.read(
            offset,
            Math.min(chunkSize, end - offset),
            options,
          );
          if (aborted) return;
          if (bytes.byteLength === 0) {
            removeAbortListener();
            controller.close();
            return;
          }
          offset += bytes.byteLength;
          controller.enqueue(bytes);
        } catch (error) {
          removeAbortListener();
          if (!aborted) controller.error(error);
        }
      },
      cancel: () => { aborted = true; removeAbortListener(); },
    });
  }

  /** Release range caches. The reader cannot be reused after this call. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pipe of this.#pipes) {
      pipe.abort(new DOMException("The file reader was closed", "AbortError"));
    }
    try {
      this.#raw.close();
    } finally {
      this.#freeWhenIdle();
    }
  }

  // A cancelled range can still be settling in WASM. Never free a reader while
  // a raw method holds it, including when close() interrupts a pending pipe.
  async #call<T>(run: () => Promise<T>): Promise<T> {
    this.#active++;
    try {
      return await run();
    } finally {
      this.#active--;
      this.#freeWhenIdle();
    }
  }

  #freeWhenIdle(): void {
    if (this.#closed && this.#active === 0 && !this.#freed) {
      this.#freed = true;
      this.#raw.free();
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AutonomiError("CLIENT_CLOSED", "Public file reader is closed");
    }
  }
}
