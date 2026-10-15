import { describe, expect, it, vi } from "vitest";
import { resumePointer, writePointer } from "../src/pointers.js";
import type { RawNetworkClient } from "../src/internal/runtime.js";
import type { PaymentProvider } from "../src/types.js";

const proof = vi.hoisted(() => vi.fn(() => ({ record: Uint8Array.of(1, 2), proof: Uint8Array.of(3, 4) })));
vi.mock("../src/internal/runtime.js", () => ({ getBindings: () => ({ recoverPointerPayment: proof }) }));
const network = { chainId: 31337, paymentTokenAddress: "0x11", paymentVaultAddress: "0x22" };
const wire = { chain_id: 31337, payment_token_address: "0x11", payment_vault_address: "0x22" };
const quotes = [{ quote: {}, quoteHash: "aa", rewardsAddress: "0xbb", amount: "1" }];
const receipt = { transactionHash: `0x${"ab".repeat(32)}`, totalAmount: "1" };
const pointer = { address: "ab".repeat(32), counter: "18446744073709551615", kind: "pointer", kindTag: 1, target: "cd".repeat(32), stateId: "ef".repeat(32) };
function fixture() {
  let stored = false;
  const raw = {
    createPointer: vi.fn(async (_seed, _target, _kind, _network, pay, paid, prepared) => {
      await prepared("original signed state and plan");
      await pay(wire, quotes);
      try { await paid({ record: Uint8Array.of(1, 2), proof: Uint8Array.of(3, 4) }); } catch { /* Rust stores paid states anyway. */ }
      stored = true;
      return { pointer, transactionHash: receipt.transactionHash, storageCostAtto: "1" };
    }),
    storePaidPointer: vi.fn(async () => pointer),
  };
  const payment: PaymentProvider = { pay: vi.fn(async (_network, _quotes, context) => {
    context.submitted({ ...receipt, wait: async () => ({ status: "confirmed", receipt }) });
    return receipt;
  }), recover: vi.fn(async () => receipt) };
  const checkpoints: string[] = [];
  const options = { ownerSeed: new Uint8Array(32).fill(19), target: pointer.target, kind: "chunk" as const,
    payment, onCheckpoint: async (value: string) => { checkpoints.push(value); } };
  return { raw: raw as unknown as RawNetworkClient, mocks: raw, payment, options, checkpoints, stored: () => stored };
}

describe("pointer payment recovery", () => {
  it("persists intent before payment and retains receipt and paid proof without the seed", async () => {
    const f = fixture();
    f.payment.pay = vi.fn(async (_n, _q, context) => {
      expect(JSON.parse(f.checkpoints.at(-1)!).quotes).toEqual(quotes);
      context.submitted({ ...receipt, wait: async () => ({ status: "confirmed", receipt }) });
      return receipt;
    });
    const result = await writePointer(f.raw, network, "createPointer", f.options, vi.fn());
    expect(result.pointer.counter).toBe("18446744073709551615");
    expect(JSON.parse(f.checkpoints.at(-1)!)).toMatchObject({ receipt, paid: { record: [1, 2], proof: [3, 4] } });
    expect(f.checkpoints.join()).not.toContain("ownerSeed");
    expect(f.options.ownerSeed.every(n => n === 19)).toBe(true);
    expect(f.mocks.createPointer.mock.calls[0]![0].every((n: number) => n === 0)).toBe(true);
  });

  it("blocks payment if durable intent persistence fails", async () => {
    const f = fixture();
    f.options.onCheckpoint = async () => { throw new Error("disk full"); };
    await expect(writePointer(f.raw, network, "createPointer", f.options, vi.fn())).rejects.toMatchObject({ code: "POINTER_FAILED", checkpoint: expect.any(String) });
    expect(f.payment.pay).not.toHaveBeenCalled();
  });

  it("keeps storing after a paid checkpoint fails and exposes the proof in the error", async () => {
    const f = fixture();
    f.options.onCheckpoint = async value => { if (JSON.parse(value).paid) throw new Error("disk full"); };
    await expect(writePointer(f.raw, network, "createPointer", f.options, vi.fn())).rejects.toMatchObject({ checkpoint: expect.stringContaining('"proof":[3,4]') });
    expect(f.stored()).toBe(true);
  });

  it("recovers a broadcast whose confirmation failed without another payment", async () => {
    const f = fixture();
    f.payment.pay = vi.fn(async (_n, _q, context) => {
      context.submitted({ ...receipt, wait: async () => ({ status: "confirmed", receipt }) });
      throw new Error("RPC disconnected after broadcast");
    });
    await expect(writePointer(f.raw, network, "createPointer", f.options, vi.fn())).rejects.toMatchObject({ checkpoint: expect.stringContaining(receipt.transactionHash) });
    const checkpoint = f.checkpoints.at(-1)!;
    expect(await resumePointer(f.raw, network, checkpoint, f.options, vi.fn())).toEqual(pointer);
    expect(f.payment.pay).toHaveBeenCalledTimes(1);
    expect(f.payment.recover).toHaveBeenCalledTimes(1);
    expect(f.mocks.storePaidPointer).toHaveBeenCalledWith(Uint8Array.of(1, 2), Uint8Array.of(3, 4), wire);
    expect(JSON.parse(f.checkpoints.at(-1)!).paid).toBeDefined();
  });

  it("reuses paid proofs without a wallet and refuses a different network", async () => {
    const f = fixture();
    await writePointer(f.raw, network, "createPointer", f.options, vi.fn());
    const checkpoint = f.checkpoints.at(-1)!;
    await resumePointer(f.raw, network, checkpoint, { onCheckpoint: vi.fn() }, vi.fn());
    await expect(resumePointer(f.raw, { ...network, chainId: 1 }, checkpoint, f.options, vi.fn())).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(f.payment.recover).not.toHaveBeenCalled();
    expect(f.payment.pay).toHaveBeenCalledTimes(1);
  });

  it("does not treat cancellation after submission as payment failure", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.payment.pay = vi.fn(async (_n, _q, context) => {
      context.submitted({ ...receipt, wait: async () => ({ status: "confirmed", receipt }) });
      controller.abort();
      return receipt;
    });
    await expect(writePointer(f.raw, network, "createPointer", { ...f.options, signal: controller.signal }, vi.fn())).resolves.toMatchObject({ pointer });
    expect(f.stored()).toBe(true);
    expect(JSON.parse(f.checkpoints.at(-1)!).paid).toBeDefined();
  });
});


it("cancels a pending pre-payment checkpoint without invoking the wallet", async () => {
  const f = fixture();
  const controller = new AbortController();
  let release!: () => void;
  f.options.onCheckpoint = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = writePointer(f.raw, network, "createPointer", { ...f.options, signal: controller.signal }, vi.fn());
  await vi.waitFor(() => expect(f.options.onCheckpoint).toHaveBeenCalledOnce());
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError", checkpoint: expect.any(String) });
  expect(f.payment.pay).not.toHaveBeenCalled();
  release();
});

it("does not let a stalled paid checkpoint prevent storing an already paid state", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.options.onCheckpoint = async value => { if (JSON.parse(value).paid) await new Promise(() => undefined); };
    const pending = writePointer(f.raw, network, "createPointer", f.options, vi.fn());
    const result = expect(pending).rejects.toMatchObject({ checkpoint: expect.stringContaining('"proof":[3,4]'), message: expect.stringContaining("timed out") });
    await vi.advanceTimersByTimeAsync(30_001);
    await result;
    expect(f.stored()).toBe(true);
  } finally { vi.useRealTimers(); }
});
