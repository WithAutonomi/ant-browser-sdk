import { describe, expect, it, vi } from "vitest";
import { PointerError, resumePointer, writePointer } from "../src/pointers.js";
import type { RawNetworkClient } from "../src/internal/runtime.js";
import type { PaymentProvider, PaymentSettlement } from "../src/types.js";

const proof = vi.hoisted(() => vi.fn((_prepared: string, _receipt: unknown) => ({ record: Uint8Array.of(1, 2), proof: Uint8Array.of(3, 4) })));
vi.mock("../src/internal/runtime.js", () => ({ getBindings: () => ({ recoverPointerPayment: proof }) }));
const network = { chainId: 31337, paymentTokenAddress: "0x11", paymentVaultAddress: "0x22" };
const wire = { chain_id: 31337, payment_token_address: "0x11", payment_vault_address: "0x22" };
const quotes = [{ quote: {}, quoteHash: "aa", rewardsAddress: "0xbb", amount: "1" }];
const receipt = { transactionHash: `0x${"ab".repeat(32)}`, totalAmount: "1" };
const paidState = { receipt, record: "AQI=", proof: "AwQ=" };
const pointer = { address: "ab".repeat(32), counter: "18446744073709551615", kind: "pointer", kindTag: 1, target: "cd".repeat(32), stateId: "ef".repeat(32) };
const confirmed = async (): Promise<PaymentSettlement> => ({ status: "confirmed", receipt });

function fixture() {
  let stored = false;
  const raw = {
    createPointer: vi.fn(async (_seed, _target, _kind, _network, pay, { onPrepared, onPaid }) => {
      await onPrepared("original signed state and plan");
      await pay(wire, quotes);
      try { await onPaid({ record: Uint8Array.of(1, 2), proof: Uint8Array.of(3, 4) }); } catch { /* Rust stores paid states anyway. */ }
      stored = true;
      return { pointer, transactionHash: receipt.transactionHash, storageCostAtto: "1" };
    }),
    storePaidPointer: vi.fn(async () => pointer),
  };
  const payment: PaymentProvider = { pay: vi.fn(async (_network, _quotes, context) => {
    context.submitted({ ...receipt, wait: confirmed });
    return receipt;
  }), recover: vi.fn(async () => receipt) };
  const checkpoints: string[] = [];
  const options = { ownerSeed: new Uint8Array(32).fill(19), target: pointer.target, kind: "chunk" as const,
    payment, onCheckpoint: async (value: string) => { checkpoints.push(value); } };
  const release = vi.fn();
  const context = { report: vi.fn(), holdTransport: vi.fn(() => release) };
  return { raw: raw as unknown as RawNetworkClient, mocks: raw, payment, options, checkpoints, context, release, stored: () => stored };
}

describe("pointer payment recovery", () => {
  it("persists intent before payment and retains receipt and paid proof without the seed", async () => {
    const f = fixture();
    f.payment.pay = vi.fn(async (_n, _q, context) => {
      expect(JSON.parse(f.checkpoints.at(-1)!)).toMatchObject({ version: 1, prepared: "original signed state and plan", quotes, submissions: [] });
      expect(f.context.holdTransport).toHaveBeenCalledOnce();
      context.submitted({ ...receipt, wait: confirmed });
      return receipt;
    });
    const result = await writePointer(f.raw, network, "createPointer", f.options, f.context);
    expect(result.pointer.counter).toBe("18446744073709551615");
    expect(JSON.parse(f.checkpoints.at(-1)!)).toMatchObject({ submissions: [receipt], paid: paidState });
    expect(f.checkpoints.join()).not.toContain("ownerSeed");
    expect(f.options.ownerSeed.every(n => n === 19)).toBe(true);
    expect(f.mocks.createPointer.mock.calls[0]![0].every((n: number) => n === 0)).toBe(true);
    expect(f.release).toHaveBeenCalledOnce();
  });

  for (const outcome of ["kept", "failed"] as const) it(`has the wallet wait until its broadcast is journaled (write ${outcome})`, async () => {
    const f = fixture();
    let finishWrite!: () => void;
    const held = new Promise<void>((resolve) => { finishWrite = resolve; });
    const order: string[] = [];
    f.options.onCheckpoint = async (value: string) => {
      const journal = JSON.parse(value) as { submissions: unknown[]; paid?: unknown };
      if (journal.submissions.length > 0 && !journal.paid) {
        await held;
        if (outcome === "failed") throw new Error("storage full");
      }
      f.checkpoints.push(value);
    };
    f.payment.pay = vi.fn(async (_n, _q, context) => {
      const waiting = context.submitted({ ...receipt, wait: confirmed });
      order.push("broadcast reported");
      setTimeout(() => { order.push("write settled"); finishWrite(); }, 0);
      await waiting;
      order.push("wallet resumed");
      return receipt;
    });
    await expect(writePointer(f.raw, network, "createPointer", f.options, f.context)).resolves.toMatchObject({ pointer });
    expect(order).toEqual(["broadcast reported", "write settled", "wallet resumed"]);
  });

  it("hands Rust a single-hash or keyed receipt as the wallet returned it", async () => {
    const f = fixture();
    proof.mockClear();
    await writePointer(f.raw, network, "createPointer", f.options, f.context);
    expect(proof).toHaveBeenCalledWith("original signed state and plan", receipt);

    const keyed = { ...receipt, transactionHashes: { aa: `0x${"cd".repeat(32)}` } };
    f.payment.pay = vi.fn(async () => keyed);
    proof.mockClear();
    await writePointer(f.raw, network, "createPointer", f.options, f.context);
    expect(proof).toHaveBeenCalledWith("original signed state and plan", keyed);
  });

  it("blocks payment if durable intent persistence fails and reports that nothing was requested", async () => {
    const f = fixture();
    f.options.onCheckpoint = async () => { throw new Error("disk full"); };
    const error = await writePointer(f.raw, network, "createPointer", f.options, f.context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PointerError);
    expect(error).toMatchObject({ code: "POINTER_FAILED", checkpoint: undefined });
    expect(f.payment.pay).not.toHaveBeenCalled();
    expect(f.context.holdTransport).not.toHaveBeenCalled();
  });

  it("resolves a stored write even when a later checkpoint fails", async () => {
    const f = fixture();
    f.options.onCheckpoint = async value => { if (JSON.parse(value).paid) throw new Error("disk full"); };
    await expect(writePointer(f.raw, network, "createPointer", f.options, f.context)).resolves.toMatchObject({ pointer });
    expect(f.stored()).toBe(true);
  });

  it("does not let a timed-out checkpoint reject a write that was stored", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let writes = 0;
      // The intent persists; later writes outlast the 30-second deadline but succeed.
      f.options.onCheckpoint = async () => { if (writes++ > 0) await new Promise(resolve => setTimeout(resolve, 35_000)); };
      const pending = writePointer(f.raw, network, "createPointer", f.options, f.context);
      const result = expect(pending).resolves.toMatchObject({ pointer });
      await vi.advanceTimersByTimeAsync(70_001);
      await result;
      expect(f.stored()).toBe(true);
      expect(f.payment.pay).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("coalesces checkpoints requested while one is being written", async () => {
    const f = fixture();
    const persisted: string[] = [];
    let release!: () => void;
    f.options.onCheckpoint = async value => {
      persisted.push(value);
      if (persisted.length === 2) await new Promise<void>(resolve => { release = resolve; });
    };
    f.payment.pay = vi.fn(async (_n, _q, context) => {
      for (const byte of ["01", "02", "03"]) context.submitted({ transactionHash: `0x${byte.repeat(32)}`, totalAmount: "1", wait: confirmed });
      await vi.waitFor(() => expect(release).toBeDefined());
      release();
      return receipt;
    });
    await writePointer(f.raw, network, "createPointer", f.options, f.context);
    // Intent, the first submission, then one write covering the later submissions and the paid state.
    expect(persisted).toHaveLength(3);
    expect(JSON.parse(persisted.at(-1)!)).toMatchObject({ paid: paidState });
    expect(JSON.parse(persisted.at(-1)!).submissions).toHaveLength(3);
  });

  it("journals JSON-safe evidence from wallets that return bigint amounts and extra fields", async () => {
    const f = fixture();
    f.payment.pay = vi.fn(async (_n, _q, context) => {
      context.submitted({ ...receipt, totalAmount: 1n, gasUsed: 21_000n, wait: confirmed } as never);
      return { ...receipt, totalAmount: 1n, gasUsed: 21_000n } as never;
    });
    await expect(writePointer(f.raw, network, "createPointer", f.options, f.context)).resolves.toMatchObject({ pointer });
    const last = JSON.parse(f.checkpoints.at(-1)!);
    expect(last.submissions).toEqual([receipt]);
    expect(last.paid.receipt).toEqual(receipt);
  });

  it("keeps a rejected receipt out of the checkpoint so resume observes the payment again", async () => {
    const f = fixture();
    const split = { transactionHash: `0x${"cd".repeat(32)}`, transactionHashes: { other: `0x${"cd".repeat(32)}` }, totalAmount: "1" };
    f.payment.pay = vi.fn(async () => split);
    proof.mockImplementationOnce(() => { throw new Error("wallet returned no transaction for a paid quote"); });
    const error = await writePointer(f.raw, network, "createPointer", f.options, f.context).catch((e: unknown) => e) as PointerError;
    expect(error.message).toContain("no transaction for a paid quote");
    const checkpoint = JSON.parse(error.checkpoint!);
    expect(checkpoint.paid).toBeUndefined();
    expect(checkpoint.submissions).toEqual([split]);
    expect(f.stored()).toBe(false);
    expect(await resumePointer(f.raw, network, error.checkpoint!, f.options, vi.fn())).toEqual(pointer);
    expect(f.payment.recover).toHaveBeenCalledWith(network, quotes, { submissions: [split] }, expect.anything());
    expect(f.payment.pay).toHaveBeenCalledOnce();
  });

  it("confirms a broadcast through wait() when the wallet's receipt poll fails", async () => {
    const f = fixture();
    delete f.payment.recover;
    f.payment.pay = vi.fn(async (_n, _q, context) => {
      context.submitted({ ...receipt, wait: confirmed });
      throw new Error("RPC disconnected after broadcast");
    });
    await expect(writePointer(f.raw, network, "createPointer", f.options, f.context)).resolves.toMatchObject({ pointer });
    expect(JSON.parse(f.checkpoints.at(-1)!).paid).toEqual(paidState);
    expect(f.payment.pay).toHaveBeenCalledOnce();
  });

  it("resumes through this page's wait() observer when the provider cannot recover", async () => {
    const f = fixture();
    delete f.payment.recover;
    const hash = `0x${"77".repeat(32)}`;
    let online = false;
    const wait = vi.fn(async (): Promise<PaymentSettlement> => {
      if (!online) throw new Error("RPC unavailable");
      return { status: "confirmed", receipt: { transactionHash: hash, totalAmount: "1" } };
    });
    f.payment.pay = vi.fn(async (_n, _q, context) => {
      context.submitted({ transactionHash: hash, totalAmount: "1", wait });
      throw new Error("RPC disconnected after broadcast");
    });
    const error = await writePointer(f.raw, network, "createPointer", f.options, f.context).catch((e: unknown) => e) as PointerError;
    expect(error.checkpoint).toContain(hash);
    online = true;
    expect(await resumePointer(f.raw, network, error.checkpoint!, { onCheckpoint: f.options.onCheckpoint }, vi.fn())).toEqual(pointer);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(f.mocks.storePaidPointer).toHaveBeenCalledWith(Uint8Array.of(1, 2), Uint8Array.of(3, 4), wire);
    expect(f.payment.pay).toHaveBeenCalledOnce();
  });

  it("recovers a broadcast whose confirmation failed through recover() without another payment", async () => {
    const f = fixture();
    f.payment.pay = vi.fn(async (_n, _q, context) => {
      context.submitted({ ...receipt, wait: async () => { throw new Error("RPC unavailable"); } });
      throw new Error("RPC disconnected after broadcast");
    });
    await expect(writePointer(f.raw, network, "createPointer", f.options, f.context)).rejects.toMatchObject({ checkpoint: expect.stringContaining(receipt.transactionHash) });
    const checkpoint = f.checkpoints.at(-1)!;
    expect(await resumePointer(f.raw, network, checkpoint, f.options, vi.fn())).toEqual(pointer);
    expect(f.payment.pay).toHaveBeenCalledTimes(1);
    expect(f.payment.recover).toHaveBeenCalledTimes(1);
    expect(f.mocks.storePaidPointer).toHaveBeenCalledWith(Uint8Array.of(1, 2), Uint8Array.of(3, 4), wire);
    expect(JSON.parse(f.checkpoints.at(-1)!).paid).toEqual(paidState);
  });

  it("keeps an invalid recovered receipt out of the checkpoint", async () => {
    const f = fixture();
    const checkpoint = JSON.stringify({ version: 1, network, prepared: "plan", quotes, submissions: [receipt] });
    f.payment.recover = vi.fn(async () => ({ ...receipt, totalAmount: "2" }));
    const error = await resumePointer(f.raw, network, checkpoint, f.options, vi.fn()).catch((e: unknown) => e) as PointerError;
    expect(error).toBeInstanceOf(PointerError);
    expect(JSON.parse(error.checkpoint!).paid).toBeUndefined();
    expect(f.mocks.storePaidPointer).not.toHaveBeenCalled();
  });

  it("stores a recovered proof even when persisting it fails", async () => {
    const f = fixture();
    const checkpoint = JSON.stringify({ version: 1, network, prepared: "plan", quotes, submissions: [receipt] });
    await expect(resumePointer(f.raw, network, checkpoint, { ...f.options, onCheckpoint: async () => { throw new Error("disk full"); } }, vi.fn()))
      .resolves.toEqual(pointer);
  });

  it("reuses paid proofs without a wallet and refuses a different network or malformed checkpoint", async () => {
    const f = fixture();
    await writePointer(f.raw, network, "createPointer", f.options, f.context);
    const checkpoint = f.checkpoints.at(-1)!;
    await resumePointer(f.raw, network, checkpoint, { onCheckpoint: vi.fn() }, vi.fn());
    await expect(resumePointer(f.raw, { ...network, chainId: 1 }, checkpoint, f.options, vi.fn())).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    for (const value of [{ version: 2 }, { paid: { ...paidState, proof: [3, 4] } }, { quotes: undefined }]) {
      await expect(resumePointer(f.raw, network, JSON.stringify({ ...JSON.parse(checkpoint), ...value }), f.options, vi.fn()))
        .rejects.toMatchObject({ code: "INVALID_SOURCE" });
    }
    expect(f.payment.recover).not.toHaveBeenCalled();
    expect(f.payment.pay).toHaveBeenCalledTimes(1);
  });

  it("does not treat cancellation after submission as payment failure", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.payment.pay = vi.fn(async (_n, _q, context) => {
      context.submitted({ ...receipt, wait: confirmed });
      controller.abort();
      return receipt;
    });
    await expect(writePointer(f.raw, network, "createPointer", { ...f.options, signal: controller.signal }, f.context)).resolves.toMatchObject({ pointer });
    expect(f.stored()).toBe(true);
    expect(JSON.parse(f.checkpoints.at(-1)!).paid).toBeDefined();
  });
});

it("cancels a pending intent checkpoint without invoking the wallet or returning a checkpoint", async () => {
  const f = fixture();
  const controller = new AbortController();
  let release!: () => void;
  f.options.onCheckpoint = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = writePointer(f.raw, network, "createPointer", { ...f.options, signal: controller.signal }, f.context);
  await vi.waitFor(() => expect(f.options.onCheckpoint).toHaveBeenCalledOnce());
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError", checkpoint: undefined });
  expect(f.payment.pay).not.toHaveBeenCalled();
  release();
});

it("does not let a stalled paid checkpoint prevent storing an already paid state", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.options.onCheckpoint = async value => { if (JSON.parse(value).paid) await new Promise(() => undefined); };
    const pending = writePointer(f.raw, network, "createPointer", f.options, f.context);
    const result = expect(pending).resolves.toMatchObject({ pointer });
    await vi.advanceTimersByTimeAsync(30_001);
    await result;
    expect(f.stored()).toBe(true);
  } finally { vi.useRealTimers(); }
});
