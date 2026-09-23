import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentProvider } from "../src/types.js";
import type { StagingSessionOptions } from "../src/internal/staging.js";
import type { WindowLimit } from "../src/internal/window-stager.js";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  reconcile: vi.fn(),
  stage: vi.fn(),
  budget: vi.fn(),
  network: {
    chain_id: 31337, payment_token_address: `0x${"11".repeat(20)}`, payment_vault_address: `0x${"22".repeat(20)}`,
  },
}));
vi.mock("../src/internal/runtime.js", () => ({
  initializeClientWasm: async () => undefined,
  getBindings: () => ({
    BrowserNodeClient: class {
      async connect() { return this; }
      async hello() {
        return { type: "hello", protocol: "autonomi.web.poc.v5", peer_id: "ab".repeat(32), endpoint: { multiaddr: "/mock" },
          max_chunk_size: 4194304, capabilities: ["chunk_protocol"], payment: mocks.network };
      }
      close() {} free() {}
    },
    BrowserNetworkClient: class {
      uploadRecords = mocks.upload;
      reconcileFailedUploadPayment = mocks.reconcile;
      close() {} free() {}
    },
    parseWebRtcDirectMultiaddr: (multiaddr: string) => ({ multiaddr }),
  }),
}));
vi.mock("../src/internal/staging.js", async (original) => ({
  ...await original<typeof import("../src/internal/staging.js")>(),
  assertStagingSupported: () => undefined,
  openStagingSession: mocks.stage,
  stagingBudget: mocks.budget,
}));
import { AutonomiClient, UploadError } from "../src/index.js";
import { getStagedRecord, putStagedRecord } from "../src/internal/record-store.js";
import { WindowStager } from "../src/internal/window-stager.js";
import { wrapWindowCheckpoint } from "../src/internal/window-checkpoint.js";

// Five encrypted records of three bytes; the last is the public DataMap record.
const RECORD_COUNT = 5;
const RECORD_BYTES = 3;
const TWO_RECORD_BUDGET = 2 * RECORD_BYTES + 1;
const encrypted = Array.from({ length: RECORD_COUNT }, (_, index) => ({
  address: String(index).repeat(64), content: new Uint8Array(RECORD_BYTES).fill(index),
}));
const dataMap = encrypted.at(-1)!;
/** Each window is quoted and paid separately. */
const windowQuotes = (firstIndex: number) =>
  [{ quote: {}, quoteHash: String(firstIndex).repeat(64), rewardsAddress: `0x${"dd".repeat(20)}`, amount: "42" }];
const clients: AutonomiClient[] = [];
const opened: StagingSessionOptions[] = [];
const limits: WindowLimit[] = [];

type Batch = { records: Array<{ address: string; size: number }>; first_index: number; total_records?: number };
type Load = (index: number, address: string, size: number) => Promise<Uint8Array>;
type Pay = (network: unknown, quotes: unknown) => Promise<unknown>;
type Save = (checkpoint: string) => Promise<void>;

async function client(payment: PaymentProvider = wallet()) {
  const value = await AutonomiClient.connect("/mock", { payment });
  clients.push(value);
  return value;
}
function wallet(): PaymentProvider {
  return { pay: vi.fn(async (_network, quotes) => ({ transactionHash: `0x${quotes[0]!.quoteHash}`, totalAmount: "42" })) };
}
function batchResult(batch: Batch, paymentMode = "single") {
  return { transactionHash: "0xpaid", storageCostAtto: "42", records: batch.records.length, replicas: 4, paymentMode };
}
/** Pay for the batch, check its staged bytes, and persist one checkpoint named after the window. */
async function payAndStore(batch: Batch, network: unknown, load: Load, pay: Pay, save: Save, paymentMode = "single") {
  await save(`core-${batch.first_index}`);
  await pay(network, windowQuotes(batch.first_index));
  for (const [index, record] of batch.records.entries()) {
    expect(await load(index, record.address, record.size)).toEqual(encrypted[batch.first_index + index]!.content);
  }
  return batchResult(batch, paymentMode);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: "0x7a69" })));
  mocks.upload.mockReset(); mocks.stage.mockReset(); mocks.reconcile.mockReset();
  mocks.budget.mockReset().mockResolvedValue(TWO_RECORD_BUDGET);
  opened.length = 0; limits.length = 0;
  // A worker stand-in that runs the real window stager over pre-encrypted records.
  mocks.stage.mockImplementation((options: StagingSessionOptions) => {
    opened.push(options);
    const source = [...encrypted];
    const stager = new WindowStager(() => source.shift(), (index, content) => putStagedRecord(options.sessionId, index, content));
    stager.skip(options.skip);
    return {
      async next(limit: WindowLimit) {
        limits.push(limit);
        const window = await stager.stage(limit);
        return {
          firstIndex: window.firstIndex, records: window.records,
          ...(window.complete ? { file: {
            name: "large.bin", content_type: "application/octet-stream", address: dataMap.address, blake3: "ee".repeat(32),
            size: 12, data_map_size: RECORD_BYTES, chunks: [], records: encrypted.map(({ address }) => ({ address, size: RECORD_BYTES })),
          } } : {}),
        };
      },
      close: vi.fn(),
    };
  });
});
afterEach(async () => {
  for (const value of clients.splice(0)) {
    value.close();
    for (const recovery of value.pendingUploads) await recovery.discard();
  }
  vi.unstubAllGlobals();
});

describe("windowed File and Blob uploads", () => {
  it("uploads a file larger than the staging budget as consecutive paid windows", async () => {
    const payment = wallet();
    const value = await client(payment);
    const saved: string[] = [];
    const batches: Batch[] = [];
    mocks.upload.mockImplementation(async (batch: Batch, network, load: Load, pay: Pay, _report, checkpoint, save: Save) => {
      expect(checkpoint).toBeUndefined();
      if (batches.length > 0) {
        const previous = batches.at(-1)!;
        await expect(getStagedRecord(opened[0]!.sessionId, previous.first_index)).rejects.toThrow("is missing");
      }
      batches.push(batch);
      return payAndStore(batch, network, load, pay, save);
    });
    const uploaded = await value.upload(new Blob(["large file"]), { name: "large.bin", onCheckpoint: (checkpoint) => { saved.push(checkpoint); } });
    expect(batches.map(({ records, first_index, total_records }) => [records.length, first_index, total_records]))
      .toEqual([[2, 0, undefined], [2, 2, undefined], [1, 4, RECORD_COUNT]]);
    expect(saved.map((checkpoint) => JSON.parse(checkpoint))).toEqual([
      expect.objectContaining({ firstIndex: 0, records: 2, checkpoint: "core-0" }),
      expect.objectContaining({ firstIndex: 2, records: 2, checkpoint: "core-2" }),
      expect.objectContaining({ firstIndex: 4, records: 1, checkpoint: "core-4" }),
    ]);
    expect(payment.pay).toHaveBeenCalledTimes(3);
    expect(uploaded).toMatchObject({ records: RECORD_COUNT, storageCostAtto: "126", paymentMode: "single",
      file: { address: dataMap.address, name: "large.bin", blake3: "ee".repeat(32), replicas: 4 } });
    expect(opened).toHaveLength(1);
    await expect(getStagedRecord(opened[0]!.sessionId, 4)).rejects.toThrow("is missing");
  });

  it("keeps plain Rust checkpoints when the whole file fits in one window", async () => {
    mocks.budget.mockResolvedValue(Number.POSITIVE_INFINITY);
    const value = await client();
    const saved: string[] = [];
    mocks.upload.mockImplementation(async (batch: Batch, network, load: Load, pay: Pay, _report, _checkpoint, save: Save) =>
      payAndStore(batch, network, load, pay, save));
    const phases: string[] = [];
    mocks.upload.mockImplementationOnce(async (batch: Batch, network, load: Load, pay: Pay, report, _checkpoint, save: Save) => {
      report("A native progress diagnostic");
      return payAndStore(batch, network, load, pay, save);
    });
    await expect(value.upload(new Blob(["small"]), {
      onCheckpoint: (checkpoint) => { saved.push(checkpoint); },
      onProgress: (event) => { if (event.message === "A native progress diagnostic") phases.push(event.phase); },
    })).resolves.toMatchObject({ records: RECORD_COUNT });
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(saved).toEqual(["core-0"]);
    // Native progress after staging belongs to the upload, not to staging.
    expect(phases).toEqual(["preparing"]);
  });

  it("reports Merkle when any window was paid through a Merkle batch", async () => {
    const value = await client();
    const modes = ["merkle", "single", "single"];
    mocks.upload.mockImplementation(async (batch: Batch, network, load: Load, pay: Pay, _report, _checkpoint, save: Save, mode) => {
      expect(mode).toBe("auto");
      return payAndStore(batch, network, load, pay, save, modes.shift());
    });
    await expect(value.upload(new Blob(["large file"]))).resolves.toMatchObject({ paymentMode: "merkle" });
  });

  it("resumes a failed window from its staged records before encrypting the rest", async () => {
    const payment = wallet();
    const value = await client(payment);
    mocks.upload
      .mockImplementationOnce(async (batch: Batch, network, load: Load, pay: Pay, _report, _checkpoint, save: Save) =>
        payAndStore(batch, network, load, pay, save))
      .mockImplementationOnce(async (batch: Batch, network, _load, pay: Pay, _report, _checkpoint, save: Save) => {
        await save(`core-${batch.first_index}`);
        await pay(network, windowQuotes(batch.first_index));
        throw new Error("storage quorum failed after payment");
      });
    const failure = await value.upload(new Blob(["large file"])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UploadError);
    const recovery = (failure as UploadError).recovery;
    const { sessionId } = opened[0]!;
    // The failed window stays staged; the completed window was already released.
    expect(await getStagedRecord(sessionId, 2)).toEqual(encrypted[2]!.content);
    await expect(getStagedRecord(sessionId, 0)).rejects.toThrow("is missing");

    mocks.upload.mockImplementation(async (batch: Batch, network, load: Load, _pay, _report, checkpoint, save: Save) => {
      if (batch.first_index === 2) expect(checkpoint).toBe("core-2");
      else expect(checkpoint).toBeUndefined();
      await save(`core-${batch.first_index}`);
      for (const [index, record] of batch.records.entries()) expect(await load(index, record.address, record.size)).toHaveLength(RECORD_BYTES);
      return batchResult(batch);
    });
    await expect(value.resumeUpload(recovery)).resolves.toMatchObject({ records: RECORD_COUNT, storageCostAtto: "84" });
    expect(mocks.upload.mock.calls.slice(2).map(([batch]) => (batch as Batch).first_index)).toEqual([2, 4]);
    // Resume encrypts only what is left: the retained window needs no worker.
    expect(opened.map(({ skip }) => skip)).toEqual([0, 4]);
    expect(payment.pay).toHaveBeenCalledTimes(2);
    expect(recovery.status).toBe("completed");
    await expect(getStagedRecord(sessionId, 2)).rejects.toThrow("is missing");
  });

  it("restarts from a windowed checkpoint by staging exactly its window", async () => {
    const value = await client();
    mocks.upload.mockImplementation(async (batch: Batch, network, load: Load, pay: Pay, _report, checkpoint, save: Save) => {
      expect(checkpoint).toBe(batch.first_index === 2 ? "core-2" : undefined);
      return payAndStore(batch, network, load, pay, save);
    });
    const checkpoint = wrapWindowCheckpoint("core-2", { firstIndex: 2, records: 2 });
    await expect(value.upload(new Blob(["large file"]), { checkpoint })).resolves.toMatchObject({ records: RECORD_COUNT });
    expect(opened.map(({ skip }) => skip)).toEqual([2]);
    expect(limits).toEqual([{ records: 2 }, { bytes: TWO_RECORD_BUDGET }]);
    expect(mocks.upload.mock.calls.map(([batch]) => (batch as Batch).first_index)).toEqual([2, 4]);
  });

  it("restages the whole file as one window for a plain Rust checkpoint", async () => {
    const value = await client();
    mocks.upload.mockImplementation(async (batch: Batch, network, load: Load, pay: Pay, _report, checkpoint, save: Save) => {
      expect(checkpoint).toBe("whole-file");
      return payAndStore(batch, network, load, pay, save);
    });
    await expect(value.upload(new Blob(["large file"]), { checkpoint: "whole-file" })).resolves.toMatchObject({ records: RECORD_COUNT });
    expect(limits).toEqual([{}]);
    expect(mocks.upload).toHaveBeenCalledOnce();
  });

  it("drops a partially staged window when staging fails and stages it again on resume", async () => {
    const value = await client();
    const quotaError = Object.assign(new Error("disk full"), { name: "QuotaExceededError" });
    mocks.stage.mockImplementationOnce((options: StagingSessionOptions) => {
      opened.push(options);
      return {
        async next() {
          await putStagedRecord(options.sessionId, 0, encrypted[0]!.content);
          throw quotaError;
        },
        close: vi.fn(),
      };
    });
    const failure = await value.upload(new Blob(["large file"])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UploadError);
    await expect(getStagedRecord(opened[0]!.sessionId, 0)).rejects.toThrow("is missing");
    mocks.upload.mockImplementation(async (batch: Batch, network, load: Load, pay: Pay, _report, _checkpoint, save: Save) =>
      payAndStore(batch, network, load, pay, save));
    // Nothing was paid before staging failed, so resuming needs an explicitly authorized wallet.
    await expect(value.resumeUpload((failure as UploadError).recovery, { payment: wallet() }))
      .resolves.toMatchObject({ records: RECORD_COUNT });
    expect(opened.map(({ skip }) => skip)).toEqual([0, 0]);
  });

  it("rejects a windowed checkpoint for in-memory bytes", async () => {
    const value = await client();
    const checkpoint = wrapWindowCheckpoint("core-2", { firstIndex: 2, records: 2 });
    await expect(value.upload(new Uint8Array(3_072), { checkpoint })).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("reconciles a windowed checkpoint and keeps naming its window", async () => {
    const value = await client();
    const window = { firstIndex: 2, records: 2 };
    mocks.reconcile.mockImplementation(async (checkpoint: string, _verify, save: Save) => {
      expect(checkpoint).toBe("core-2");
      await save("reconciled-2");
      return "reconciled-2";
    });
    const onCheckpoint = vi.fn();
    const reconciled = await value.reconcileFailedUploadPayment(wrapWindowCheckpoint("core-2", window), {
      verifyFailure: () => ({ status: "notSubmitted", evidence: { walletRequest: "never started" } }), onCheckpoint,
    });
    expect(reconciled).toBe(wrapWindowCheckpoint("reconciled-2", window));
    expect(onCheckpoint).toHaveBeenCalledExactlyOnceWith(reconciled);
  });
});
