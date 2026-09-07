import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { SDK_LIMITS } from "../src/limits.js";
import { createPublicFileReader } from "../src/file-reader.js";

it("keeps standalone media-worker limits aligned with the exported SDK limits", async () => {
  const handlers = new Map<string, (event: unknown) => void>();
  const context = createContext({ URL, Response, Headers, ReadableStream,
    self: { location: { origin: "https://app.example" }, addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler) },
  });
  runInContext(await readFile(new URL("../public/autonomi-stream-sw.js", import.meta.url), "utf8"), context);
  expect(runInContext("MAX_STREAM_FILE_BYTES", context)).toBe(SDK_LIMITS.mediaMaxFileBytes);
  expect(runInContext("STREAM_BLOCK_BYTES", context)).toBe(SDK_LIMITS.defaultStreamChunkBytes);
  for (const [size, status] of [[SDK_LIMITS.mediaMaxFileBytes, 200], [SDK_LIMITS.mediaMaxFileBytes + 1, 400]] as const) {
    let response!: Promise<Response>;
    handlers.get("fetch")!({ request: new Request(`https://app.example/__autonomi_stream/${"ab".repeat(16)}/file?size=${size}`, { method: "HEAD" }),
      respondWith: (value: Promise<Response>) => { response = value; },
    });
    expect((await response).status).toBe(status);
  }
});

it("enforces the advertised range limit and stream default before calling the core", async () => {
  const raw = { name: "file", contentType: "application/octet-stream", size: SDK_LIMITS.maxFileBytes,
    readRange: vi.fn(async () => new Uint8Array()), close: vi.fn(), free: vi.fn() };
  const reader = createPublicFileReader(raw, "ab".repeat(32));
  await reader.read(0, SDK_LIMITS.maxRangeBytes);
  expect(raw.readRange).toHaveBeenCalledWith(0, SDK_LIMITS.maxRangeBytes);
  await expect(reader.read(0, SDK_LIMITS.maxRangeBytes + 1)).rejects.toMatchObject({ code: "OPEN_FILE_FAILED" });
  expect(raw.readRange).toHaveBeenCalledOnce();
  expect(() => reader.stream({ chunkSize: SDK_LIMITS.maxRangeBytes + 1 })).toThrow();
  await reader.stream().getReader().read();
  expect(raw.readRange).toHaveBeenLastCalledWith(0, SDK_LIMITS.defaultStreamChunkBytes);
  reader.close();
  expect(Object.isFrozen(SDK_LIMITS)).toBe(true);
  expect(Object.isFrozen(SDK_LIMITS.downloadConcurrency)).toBe(true);
});
