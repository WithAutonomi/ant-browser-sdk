import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PaymentProvider, PublicFile } from "../src/types.js";
import type { StagedUpload } from "../src/internal/staging.js";
const mocks = vi.hoisted(() => ({
  staged: undefined as StagedUpload | undefined,
  upload: vi.fn(),
  stage: vi.fn(),
  network: {
    rpc_url: "https://rpc.example/", payment_token_address: `0x${"11".repeat(20)}`, payment_vault_address: `0x${"22".repeat(20)}`,
  },
}));
vi.mock("../src/internal/runtime.js", () => ({
  initializeClientWasm: async () => undefined,
  getBindings: () => ({
    BrowserNodeClient: class {
      async hello() { return { peer_id: "ab".repeat(32), payment: mocks.network }; }
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
import { AutonomiClient, UploadError } from "../src/index.js";
import { getStagedRecord, putStagedRecord } from "../src/internal/record-store.js";
const file: PublicFile = {
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
  mocks.network = { ...mocks.network, rpc_url: "https://rpc.example/" };
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
  mocks.network = { ...mocks.network, rpc_url: "https://another.example/" };
  const replacement = await client();
  await expect(replacement.resumeUpload(recovery)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  expect(mocks.upload).toHaveBeenCalledOnce();
  expect(recovery.status).toBe("ready");
});

it("refuses recovery when the same RPC and contracts resolve to another chain", async () => {
  const original = await client(wallet());
  mocks.upload.mockRejectedValue(new Error("network unavailable"));
  await expect(original.upload(new Blob(["abc"]))).rejects.toBeInstanceOf(UploadError);
  const recovery = original.pendingUploads[0]!;
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }));
  const replacement = await client();
  await expect(replacement.resumeUpload(recovery)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  expect(mocks.upload).toHaveBeenCalledOnce();
  expect(recovery.status).toBe("ready");
});
