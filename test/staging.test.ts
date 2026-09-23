import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStagingSession, stagingBudget, type StagingSessionOptions } from "../src/internal/staging.js";

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

function session(overrides: Partial<StagingSessionOptions> = {}) {
  const report = vi.fn();
  const staging = openStagingSession({
    blob: new Blob([Uint8Array.of(1, 2, 3)]), name: "three.bin", contentType: "application/octet-stream",
    sessionId: "session", skip: 0, withholdDataMap: false, report, ...overrides,
  });
  return { staging, report, worker: FakeWorker.instances.at(-1)! };
}

const records = [{ address: "11".repeat(32), size: 3 }];

beforeEach(() => {
  FakeWorker.instances.length = 0;
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("windowed upload staging worker", () => {
  it("starts the worker with the connection's WASM and the records to skip", () => {
    const wasm = Uint8Array.of(0, 97, 115, 109).buffer;
    const { worker } = session({ wasm, skip: 64 });
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "start", wasm, skip: 64, sessionId: "session", name: "three.bin",
    }));
  });

  it("requests one window at a time and reports staged record counts", async () => {
    const { staging, report, worker } = session();
    const first = staging.next({ bytes: 7 });
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "stage", limit: { bytes: 7 } });
    await expect(staging.next({ bytes: 7 })).rejects.toThrow(/already being staged/);
    worker.message({ type: "progress", message: "Encrypted and staged record 1", completed: 1 });
    expect(report).toHaveBeenCalledWith("Encrypted and staged record 1", { phase: "staging", unit: "records", completed: 1 });
    worker.message({ type: "window", firstIndex: 0, records, complete: false });
    await expect(first).resolves.toEqual({ firstIndex: 0, records });

    const file = { name: "three.bin", address: "11".repeat(32), records };
    const last = staging.next({ records: 1 });
    worker.message({ type: "window", firstIndex: 1, records, complete: true, file });
    await expect(last).resolves.toEqual({ firstIndex: 1, records, file });
    staging.close();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates the worker when a window is cancelled", async () => {
    const controller = new AbortController();
    const { staging, worker } = session();
    const window = staging.next({ bytes: 7 }, controller.signal);
    controller.abort();
    await expect(window).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(staging.next({ bytes: 7 })).rejects.toThrow();
  });

  it("rejects the pending window with the worker's error and stops the session", async () => {
    const { staging, worker } = session();
    const window = staging.next({ bytes: 7 });
    worker.message({ type: "error", message: "Not enough browser storage to stage an upload window" });
    await expect(window).rejects.toThrow(/Not enough browser storage/);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("stops staging when a progress listener cancels the upload", async () => {
    const reason = new DOMException("stopped", "AbortError");
    const { staging, worker } = session({ report: () => { throw reason; } });
    const window = staging.next({ bytes: 7 });
    worker.message({ type: "progress", message: "Encrypted and staged record 1", completed: 1 });
    await expect(window).rejects.toBe(reason);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

describe("staging budget", () => {
  it("leaves a reserve and overhead margin within the remaining quota", async () => {
    const mebibyte = 1024 * 1024;
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: 121 * mebibyte, usage: 100 * mebibyte }) } });
    expect(await stagingBudget()).toBe(Math.floor(5 * mebibyte / 1.05));
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ quota: mebibyte, usage: 0 }) } });
    expect(await stagingBudget()).toBe(0);
  });

  it("does not bound windows when the browser gives no estimate", async () => {
    vi.stubGlobal("navigator", {});
    expect(await stagingBudget()).toBe(Number.POSITIVE_INFINITY);
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({}) } });
    expect(await stagingBudget()).toBe(Number.POSITIVE_INFINITY);
  });
});
