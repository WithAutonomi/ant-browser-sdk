import { describe, expect, it, vi } from "vitest";
import { createPublicFileReader, PublicFileReader } from "../src/file-reader.js";
import type { PipeOptions } from "../src/types.js";

describe("PublicFileReader", () => {
  it("turns bounded range reads into a sequential ReadableStream", async () => {
    const content = Uint8Array.from({ length: 10 }, (_, index) => index);
    const raw = {
      name: "numbers.bin",
      size: content.length,
      contentType: "application/octet-stream",
      readRange: vi.fn(async (start: number, length: number) =>
        content.slice(start, start + length),
      ),
      pipeTo: vi.fn(), close: vi.fn(),
      free: vi.fn(),
    };
    const reader = createPublicFileReader(raw, "11".repeat(32));
    expect(reader).toBeInstanceOf(PublicFileReader);
    const stream = reader.stream({ start: 2, end: 9, chunkSize: 3 });
    const chunks: number[] = [];
    for await (const chunk of stream) chunks.push(...chunk);

    expect(chunks).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(raw.readRange).toHaveBeenCalledTimes(3);
    reader.close();
    expect(raw.close).toHaveBeenCalledOnce();
    expect(raw.free).toHaveBeenCalledOnce();
  });

  it("rejects oversized ranges before calling WASM", async () => {
    const raw = {
      name: "large.bin",
      size: 8_000_000,
      contentType: "application/octet-stream",
      readRange: vi.fn(),
      pipeTo: vi.fn(), close: vi.fn(),
      free: vi.fn(),
    };
    const reader = createPublicFileReader(raw, "11".repeat(32));
    await expect(reader.read(0, 4 * 1024 * 1024 + 1)).rejects.toMatchObject({
      code: "OPEN_FILE_FAILED",
    });
    expect(raw.readRange).not.toHaveBeenCalled();
    reader.close();
  });

  it("cancels an individual pending range read", async () => {
    const raw = {
      name: "pending.bin",
      size: 100,
      contentType: "application/octet-stream",
      readRange: vi.fn(() => new Promise<Uint8Array>(() => undefined)),
      pipeTo: vi.fn(), close: vi.fn(),
      free: vi.fn(),
    };
    const reader = createPublicFileReader(raw, "11".repeat(32));
    const controller = new AbortController();

    const read = reader.read(0, 100, { signal: controller.signal });
    controller.abort();

    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(reader.closed).toBe(false);
    reader.close();
  });

  it("preserves offsets across 4 GiB for reads and writable ranges", async () => {
    const start = 2 ** 32 - 8;
    const raw = {
      name: "large.bin", size: 2 ** 32 + 123, contentType: "application/octet-stream",
      readRange: vi.fn(async () => new Uint8Array(16)),
      pipeTo: vi.fn(async (_destination: WritableStream<Uint8Array>, options?: PipeOptions) => {
        options?.onProgress?.(16, 16);
        return { bytesWritten: 16, hash: "ab".repeat(32) };
      }),
      close: vi.fn(), free: vi.fn(),
    };
    const reader = createPublicFileReader(raw, "ab".repeat(32));
    await reader.read(start, 16);
    expect(raw.readRange).toHaveBeenCalledWith(start, 16);
    const writable = new WritableStream<Uint8Array>();
    const progress = vi.fn();
    await expect(reader.pipeTo(writable, { start, end: start + 16, onProgress: progress }))
      .resolves.toEqual({ bytesWritten: 16, hash: "ab".repeat(32) });
    expect(raw.pipeTo).toHaveBeenCalledWith(expect.any(WritableStream), expect.objectContaining({ start, end: start + 16 }));
    expect(progress).toHaveBeenCalledWith(16, 16);
    reader.close();
  });

  it.each(["signal", "close"])("cancels a pending pipe via %s and frees only after the core settles", async (method) => {
    let finish!: () => void;
    let pipeSignal!: AbortSignal;
    const raw = {
      name: "file", size: 12, contentType: "application/octet-stream", readRange: vi.fn(),
      pipeTo: vi.fn((_destination: WritableStream<Uint8Array>, options?: PipeOptions) => {
        pipeSignal = options!.signal!;
        return new Promise<never>((_resolve, reject) => { finish = () => reject(pipeSignal.reason); });
      }),
      close: vi.fn(), free: vi.fn(),
    };
    const reader = createPublicFileReader(raw, "ab".repeat(32));
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const pipe = reader.pipeTo(new WritableStream(), options);
    // Later caller edits must not redirect the abort listener or its cleanup.
    options.signal = new AbortController().signal;
    if (method === "signal") controller.abort("caller cancellation");
    reader.close();
    expect(pipeSignal.aborted).toBe(true);
    expect(raw.free).not.toHaveBeenCalled();
    finish();
    await expect(pipe).rejects.toBe(pipeSignal.reason);
    if (method === "signal") expect(pipeSignal.reason).toBe("caller cancellation");
    expect(raw.free).toHaveBeenCalledOnce();
    await expect(reader.read(0, 1)).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });

  it("does not touch a destination for a pre-aborted pipe and preserves reader errors", async () => {
    const failure = new Error("disk full");
    const raw = {
      name: "file", size: 12, contentType: "application/octet-stream", readRange: vi.fn(),
      pipeTo: vi.fn(async () => { throw failure; }), close: vi.fn(), free: vi.fn(),
    };
    const reader = createPublicFileReader(raw, "ab".repeat(32));
    const controller = new AbortController(); controller.abort("stop");
    await expect(reader.pipeTo(new WritableStream(), { signal: controller.signal })).rejects.toBe("stop");
    expect(raw.pipeTo).not.toHaveBeenCalled();
    await expect(reader.pipeTo(new WritableStream())).rejects.toMatchObject({ code: "OPEN_FILE_FAILED", cause: failure });
    expect(reader.closed).toBe(false);
    reader.close();
  });

  it("tells destination failures apart from read failures and forwards to the caller's stream", async () => {
    const full = new DOMException("The disk is full", "QuotaExceededError");
    const written: Uint8Array[] = [];
    const raw = {
      name: "file", size: 3, contentType: "application/octet-stream", readRange: vi.fn(),
      pipeTo: vi.fn(async (destination: WritableStream<Uint8Array>) => {
        const writer = destination.getWriter();
        try {
          await writer.write(Uint8Array.of(1, 2, 3));
          await writer.close();
        } catch (error) {
          void writer.abort(error).catch(() => undefined);
          throw error;
        } finally { writer.releaseLock(); }
        return { bytesWritten: 3, hash: "ab".repeat(32) };
      }),
      close: vi.fn(), free: vi.fn(),
    };
    const reader = createPublicFileReader(raw, "ab".repeat(32));
    const close = vi.fn();
    const destination = new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk); }, close });
    await expect(reader.pipeTo(destination)).resolves.toEqual({ bytesWritten: 3, hash: "ab".repeat(32) });
    expect(written).toEqual([Uint8Array.of(1, 2, 3)]);
    expect(close).toHaveBeenCalledOnce();
    expect(destination.locked).toBe(false);
    const failing = new WritableStream<Uint8Array>({ write: () => { throw full; } });
    await expect(reader.pipeTo(failing)).rejects.toMatchObject({ code: "SAVE_FAILED", cause: full });
    expect(failing.locked).toBe(false);
    const locked = new WritableStream<Uint8Array>();
    const owner = locked.getWriter();
    await expect(reader.pipeTo(locked)).rejects.toMatchObject({ code: "OPEN_FILE_FAILED" });
    owner.releaseLock();
    expect(raw.pipeTo).toHaveBeenCalledTimes(2);
    reader.close();
  });

  it("keeps a cancelled range's reader alive until the raw call settles", async () => {
    let finish!: (bytes: Uint8Array) => void;
    const raw = {
      name: "file", size: 12, contentType: "application/octet-stream",
      readRange: vi.fn(() => new Promise<Uint8Array>(resolve => { finish = resolve; })),
      pipeTo: vi.fn(), close: vi.fn(), free: vi.fn(),
    };
    const reader = createPublicFileReader(raw, "ab".repeat(32));
    const controller = new AbortController();
    const read = reader.read(0, 1, { signal: controller.signal });
    controller.abort("stop");
    await expect(read).rejects.toBe("stop");
    reader.close();
    expect(raw.free).not.toHaveBeenCalled();
    finish(Uint8Array.of(1));
    await vi.waitFor(() => expect(raw.free).toHaveBeenCalledOnce());
  });
});
