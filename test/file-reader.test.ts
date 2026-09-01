import { describe, expect, it, vi } from "vitest";
import { PublicFileReader } from "../src/file-reader.js";

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
      close: vi.fn(),
      free: vi.fn(),
    };
    const reader = new PublicFileReader(raw, "11".repeat(32));
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
      close: vi.fn(),
      free: vi.fn(),
    };
    const reader = new PublicFileReader(raw, "11".repeat(32));
    await expect(reader.read(0, 4 * 1024 * 1024 + 1)).rejects.toMatchObject({
      code: "OPEN_FILE_FAILED",
    });
    expect(raw.readRange).not.toHaveBeenCalled();
    reader.close();
  });
});
