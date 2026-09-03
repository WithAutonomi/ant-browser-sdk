import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStagedRecord, putStagedRecord } from "../src/internal/record-store.js";
import { stageBlob, type StagedFile } from "../src/internal/staging.js";

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  #listeners = new Map<string, Array<(event: any) => void>>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  message(data: unknown): void {
    for (const listener of this.#listeners.get("message") ?? []) listener({ data });
  }
}

beforeEach(() => {
  FakeWorker.instances.length = 0;
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Blob upload staging", () => {
  it("passes the connection's custom WASM bytes to the upload worker", async () => {
    const wasm = Uint8Array.of(0, 97, 115, 109).buffer;
    const staging = stageBlob(
      new Blob([Uint8Array.of(1, 2, 3)]),
      "three.bin",
      "application/octet-stream",
      vi.fn(),
      wasm,
    );
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const worker = FakeWorker.instances[0]!;
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "stage-file", wasm }),
    );

    const staged: StagedFile = {
      name: "three.bin",
      content_type: "application/octet-stream",
      address: "11".repeat(32),
      blake3: "22".repeat(32),
      size: 3,
      data_map_size: 1,
      chunks: [],
      records: [],
    };
    worker.message({ type: "complete", staged });

    await expect(staging).resolves.toMatchObject({ staged });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates the worker and clears its whole session when aborted", async () => {
    const controller = new AbortController();
    const staging = stageBlob(
      new Blob([Uint8Array.of(1, 2, 3)]),
      "three.bin",
      "application/octet-stream",
      vi.fn(),
      undefined,
      controller.signal,
    );
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const worker = FakeWorker.instances[0]!;
    const message = worker.postMessage.mock.calls[0]![0] as { sessionId: string };
    await putStagedRecord(message.sessionId, 7, Uint8Array.of(9));

    controller.abort();

    await expect(staging).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(getStagedRecord(message.sessionId, 7)).rejects.toThrow(/is missing/);
  });
});
