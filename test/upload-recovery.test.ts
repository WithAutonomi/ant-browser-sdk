import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PaymentProvider } from "../src/types.js";
import type { StagedUpload } from "../src/internal/staging.js";
const mocks = vi.hoisted(() => ({
  staged: undefined as StagedUpload | undefined,
  upload: vi.fn(),
  stage: vi.fn(),
  network: {
    chain_id: 31337, payment_token_address: `0x${"11".repeat(20)}`, payment_vault_address: `0x${"22".repeat(20)}`,
  },
}));
vi.mock("../src/internal/runtime.js", () => ({
  initializeClientWasm: async () => undefined,
  getBindings: () => ({
    BrowserNodeClient: class {
      async hello() { return { type: "hello", protocol: "autonomi.web.poc.v5", peer_id: "ab".repeat(32), endpoint: { multiaddr: "/mock" }, max_chunk_size: 4194304, capabilities: ["chunk_protocol"], payment: mocks.network }; }
      close() {} free() {}
    },
    BrowserNetworkClient: class { uploadStagedPublicFile = mocks.upload; close() {} free() {} },
    parseWebRtcDirectMultiaddr: (multiaddr: string) => ({ multiaddr }),
  }),
}));
vi.mock("../src/internal/staging.js", async (original) => ({
  ...await original<typeof import("../src/internal/staging.js")>(),
  stageBlob: mocks.stage,
}));
import { AutonomiClient, UploadError, createPaymentSubmission } from "../src/index.js";
import { getStagedRecord, putStagedRecord } from "../src/internal/record-store.js";
const file: import("../src/internal/protocol.js").CorePublicFile = {
  name: "file.bin", address: "aa".repeat(32), size: 3, content_type: "application/octet-stream", blake3: "bb".repeat(32), data_map_size: 1, chunks: [], replicas: 1,
};
const quotes = [{ quote: {}, quoteHash: "cc".repeat(32), rewardsAddress: `0x${"dd".repeat(20)}`, amount: "42" }];
const clients: AutonomiClient[] = [];
async function client(payment?: PaymentProvider) {
  const value = await AutonomiClient.connect("/mock", payment ? { payment } : {});
  clients.push(value); return value;
}
const wallet = (): PaymentProvider => ({ pay: vi.fn(async () => ({ transactionHash: "0xpaid", totalAmount: "42" })) });
const result = { file, transactionHash: "0xpaid", storageCostAtto: "42", records: 1 };
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: "0x7a69" })));
  mocks.upload.mockReset(); mocks.stage.mockReset();
  mocks.network = { ...mocks.network, chain_id: 31337, payment_vault_address: `0x${"22".repeat(20)}` };
  mocks.staged = {
    sessionId: crypto.randomUUID(),
    staged: { ...file, chunks: [], records: [{ address: file.address, size: 3 }] },
  };
  await putStagedRecord(mocks.staged.sessionId, 0, Uint8Array.of(1, 2, 3));
  mocks.stage.mockResolvedValue(mocks.staged);
});
afterEach(async () => {
  for (const value of clients.splice(0)) {
    value.close();
    for (const recovery of value.pendingUploads) await recovery.discard();
  }
  vi.unstubAllGlobals();
});
it("retains staged bytes after failure and cleans them only after a successful resume", async () => {
  const payment = wallet(); const value = await client(payment);
  mocks.upload.mockImplementationOnce(async (_staged, network, load, pay) => {
    expect(await load(0, file.address, 3)).toEqual(Uint8Array.of(1, 2, 3));
    await pay(network, quotes); throw new Error("quorum failed");
  });
  await expect(value.upload(new Blob(["abc"]))).rejects.toBeInstanceOf(UploadError);
  expect(await getStagedRecord(mocks.staged!.sessionId, 0)).toEqual(Uint8Array.of(1, 2, 3));
  const recovery = value.pendingUploads[0]!;
  mocks.upload.mockImplementationOnce(async (_staged, network, load, pay) => {
    expect(await load(0, file.address, 3)).toEqual(Uint8Array.of(1, 2, 3));
    await pay(network, quotes); return result;
  });
  await value.resumeUpload(recovery);
  expect(mocks.stage).toHaveBeenCalledOnce();
  expect(payment.pay).toHaveBeenCalledOnce();
  await expect(getStagedRecord(mocks.staged!.sessionId, 0)).rejects.toThrow("is missing");
});
it("lets applications opt out of retained input", async () => {
  const value = await client(wallet());
  mocks.upload.mockRejectedValue(new Error("quotes unavailable"));
  const error = await value.upload(new Blob(["abc"]), { retainOnFailure: false }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(UploadError);
  await (error as UploadError).recovery.discard();
  expect(value.pendingUploads).toEqual([]);
  await expect(getStagedRecord(mocks.staged!.sessionId, 0)).rejects.toThrow("is missing");
});
it("does not discard staged bytes while a submitted payment is still settling", async () => {
  let confirm!: (receipt: { transactionHash: string; totalAmount: string }) => void;
  const payment: PaymentProvider = { pay: vi.fn<PaymentProvider["pay"]>(() => new Promise((resolve) => { confirm = resolve; })) };
  const value = await client(payment);
  mocks.upload.mockImplementationOnce(async (_staged, network, _load, pay) => { await pay(network, quotes); return result; });
  const controller = new AbortController();
  const pending = value.upload(new Blob(["abc"]), { signal: controller.signal });
  const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(payment.pay).toHaveBeenCalledOnce());
  controller.abort(); await rejection;
  const recovery = value.pendingUploads[0]!;
  const discarded = recovery.discard();
  expect(recovery.status).toBe("discarding");
  expect(await getStagedRecord(mocks.staged!.sessionId, 0)).toHaveLength(3);
  confirm({ transactionHash: "0xpaid", totalAmount: "42" });
  await discarded;
  expect(recovery.payments[0]!.receipt.transactionHash).toBe("0xpaid");
  await expect(getStagedRecord(mocks.staged!.sessionId, 0)).rejects.toThrow("is missing");
});
it("refuses recovery against a different payment network", async () => {
  const original = await client(wallet());
  mocks.upload.mockRejectedValue(new Error("network unavailable"));
  await expect(original.upload(new Blob(["abc"]))).rejects.toBeInstanceOf(UploadError);
  const recovery = original.pendingUploads[0]!;
  mocks.network = { ...mocks.network, payment_vault_address: `0x${"77".repeat(20)}` };
  const replacement = await client();
  await expect(replacement.resumeUpload(recovery)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  expect(mocks.upload).toHaveBeenCalledOnce();
  expect(recovery.status).toBe("ready");
});

it("refuses recovery when the same contracts are advertised on another chain", async () => {
  const original = await client(wallet());
  mocks.upload.mockRejectedValue(new Error("network unavailable"));
  await expect(original.upload(new Blob(["abc"]))).rejects.toBeInstanceOf(UploadError);
  const recovery = original.pendingUploads[0]!;
  mocks.network = { ...mocks.network, chain_id: 1 };
  const replacement = await client();
  await expect(replacement.resumeUpload(recovery)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  expect(mocks.upload).toHaveBeenCalledOnce();
  expect(recovery.status).toBe("ready");
});

it("retains broadcast evidence and blocks new payment until its outcome is known", async () => {
  const observe = vi.fn().mockRejectedValue(new Error("RPC timeout"));
  const submission = createPaymentSubmission({ transactionHash: "0xpaid", totalAmount: "42" }, observe);
  const payment: PaymentProvider = { pay: vi.fn(async (_network, _quotes, context) => {
    context.submitted(submission);
    await submission.wait();
    throw new Error("observation failed");
  }) };
  const value = await client(payment);
  const submitted = vi.fn();
  mocks.upload.mockImplementation(async (_staged, network, _load, pay) => { await pay(network, quotes); return result; });
  await expect(value.upload(new Blob(["abc"]), { onPaymentSubmitted: submitted })).rejects.toBeInstanceOf(UploadError);
  const recovery = value.pendingUploads[0]!;
  const pending = recovery.pendingPayments[0]!;
  expect(submitted).toHaveBeenCalledWith(pending);
  expect(pending.submission.transactionHash).toBe("0xpaid");
  expect(Object.isFrozen(pending.submission)).toBe(true);
  const fresh = wallet();
  await expect(value.resumeUpload(recovery, { payment: fresh })).rejects.toMatchObject({ code: "PAYMENT_UNRESOLVED" });
  expect(fresh.pay).not.toHaveBeenCalled();
  expect(mocks.upload).toHaveBeenCalledOnce();
  observe.mockResolvedValue({ status: "confirmed", receipt: { transactionHash: "0xpaid", totalAmount: "42" } });
  const uploaded = await value.resumeUpload(recovery);
  expect(uploaded.payments).toHaveLength(1);
  expect(uploaded.storageCostAtto).toBe("42");
  expect(recovery.pendingPayments).toEqual([]);
  expect(pending.status).toBe("confirmed");
  expect(payment.pay).toHaveBeenCalledOnce();
});

it("permits explicitly authorized payment after a definitive failure", async () => {
  const submission = createPaymentSubmission({ transactionHash: "0xreverted", totalAmount: "42" },
    async () => ({ status: "failed", reason: "reverted" }));
  const value = await client({ pay: async (_network, _quotes, context) => {
    context.submitted(submission); throw new Error("reverted");
  } });
  mocks.upload.mockImplementation(async (_staged, network, _load, pay) => { await pay(network, quotes); return result; });
  await expect(value.upload(new Blob(["abc"]))).rejects.toBeInstanceOf(UploadError);
  const recovery = value.pendingUploads[0]!;
  const pending = recovery.pendingPayments[0]!;
  const fresh = wallet();
  const uploaded = await value.resumeUpload(recovery, { payment: fresh });
  expect(fresh.pay).toHaveBeenCalledOnce();
  expect(pending.status).toBe("failed");
  expect(uploaded.payments).toHaveLength(1);
});

it("delivers submission evidence even when broadcast resolves after cancellation", async () => {
  let broadcast!: () => void;
  const value = await client({ pay: async (_network, _quotes, context) => {
    await new Promise<void>((resolve) => { broadcast = resolve; });
    context.submitted(createPaymentSubmission({ transactionHash: "0xlate", totalAmount: "42" },
      async () => ({ status: "confirmed", receipt: { transactionHash: "0xlate", totalAmount: "42" } })));
    throw new Error("RPC disconnected");
  } });
  mocks.upload.mockImplementation(async (_staged, network, _load, pay) => { await pay(network, quotes); return result; });
  const controller = new AbortController();
  const submitted = vi.fn();
  const uploading = value.upload(new Blob(["abc"]), { signal: controller.signal, onPaymentSubmitted: submitted });
  const reason = new Error("stop");
  const rejected = expect(uploading).rejects.toBe(reason);
  await vi.waitFor(() => expect(broadcast).toBeTypeOf("function"));
  controller.abort(reason); await rejected;
  broadcast();
  const recovery = value.pendingUploads[0]!;
  await recovery.settled;
  expect(submitted).toHaveBeenCalledWith(recovery.pendingPayments[0]);
  await recovery.pendingPayments[0]!.reconcile();
  expect(recovery.payments[0]!.receipt.transactionHash).toBe("0xlate");
});

it("retains Rust checkpoints across retries and awaits the persistence hook", async () => {
  const payment = wallet(); const value = await client(payment);
  const saved: string[] = [];
  mocks.upload.mockImplementationOnce(async (_staged, _network, _load, _pay, _progress, checkpoint, save) => {
    expect(checkpoint).toBeUndefined();
    await save("paid-rust-checkpoint");
    throw new Error("storage interrupted after payment");
  });
  await expect(value.upload(new Blob(["abc"]), { onCheckpoint: async checkpoint => { saved.push(checkpoint); } })).rejects.toBeInstanceOf(UploadError);
  const recovery = value.pendingUploads[0]!;
  await recovery.settled;
  mocks.upload.mockImplementationOnce(async (_staged, _network, _load, _pay, _progress, checkpoint) => {
    expect(checkpoint).toBe("paid-rust-checkpoint");
    return { ...result, storageCostAtto: "0" };
  });
  await value.resumeUpload(recovery);
  expect(saved).toEqual(["paid-rust-checkpoint"]);
  expect(payment.pay).not.toHaveBeenCalled();
});

it("accepts a persisted checkpoint with restaged input without requiring a new wallet", async () => {
  const value = await client();
  mocks.upload.mockImplementationOnce(async (_staged, _network, _load, _pay, _progress, checkpoint) => {
    expect(checkpoint).toBe("restored-rust-checkpoint");
    return { ...result, storageCostAtto: "0" };
  });
  await expect(value.upload(new Blob(["abc"]), { checkpoint: "restored-rust-checkpoint" })).resolves.toMatchObject({ storageCostAtto: "0" });
});

it("retains a confirmed Merkle receipt and forwards native mode on resume", async () => {
  const request = { calldata: "0xabcdef", maximumAmount: "100", depth: 2, timestamp: 42, poolHashes: ["ab".repeat(32)] };
  const receipt = { transactionHash: "0xmerkle", winnerPoolHash: request.poolHashes[0]!, totalAmount: "70" };
  const payment: PaymentProvider = { pay: vi.fn(), payMerkle: vi.fn(async () => receipt) };
  const value = await client(payment);
  mocks.upload.mockImplementationOnce(async (_staged, network, _load, _pay, _progress, _checkpoint, _save, mode, merkle) => {
    expect(mode).toBe("merkle");
    await merkle(network, request);
    throw new Error("store interrupted");
  });
  let recovery;
  try { await value.upload(new Blob(["abc"]), { paymentMode: "merkle" }); }
  catch (error) { recovery = (error as UploadError).recovery; }
  expect(recovery).toBeDefined();
  mocks.upload.mockImplementationOnce(async (_staged, network, _load, _pay, _progress, _checkpoint, _save, mode, merkle) => {
    expect(mode).toBe("merkle");
    expect(await merkle(network, request)).toEqual(receipt);
    return { ...result, transactionHash: receipt.transactionHash, storageCostAtto: "0" };
  });
  await value.resumeUpload(recovery!);
  expect(payment.payMerkle).toHaveBeenCalledTimes(1);
  expect(payment.pay).not.toHaveBeenCalled();
});
