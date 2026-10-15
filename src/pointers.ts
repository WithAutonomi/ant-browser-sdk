import { AutonomiError, wrapError } from "./errors.js";
import { abortable, isAbort, throwIfAborted } from "./internal/abort.js";
import { corePaymentNetwork, paymentNetworkFromCore } from "./internal/payment-network.js";
import { getBindings, initializeClientWasm, type RawNetworkClient } from "./internal/runtime.js";
import { snapshot } from "./internal/snapshot.js";
import type { ManifestOptions } from "./manifest.js";
import type { OperationOptions, PaymentNetwork, PaymentProvider, PaymentReceipt, PaymentSubmissionInfo, VerifiedStorageQuote } from "./types.js";

export interface PointerTarget {
  readonly kind: "chunk" | "pointer" | "unknown";
  readonly kindTag: number;
  readonly target: string;
}
export interface Pointer extends PointerTarget {
  readonly address: string;
  /** Decimal u64; never convert to Number. */
  readonly counter: string;
  readonly stateId: string;
}
export interface PointerFinalState extends PointerTarget {
  readonly stateId: string;
  readonly holders: number;
  readonly transferredTo?: string;
}
export interface PointerFinality {
  readonly address: string;
  readonly group: number;
  readonly answered: number;
  readonly status: "open" | "settling" | "unconfirmed" | "final" | "forked";
  readonly counter?: string;
  readonly states: readonly PointerFinalState[];
  readonly majority?: PointerFinalState;
}
export interface PointerWriteResult {
  readonly pointer: Pointer;
  readonly transactionHash?: string;
  readonly storageCostAtto: string;
}
export interface PointerRecoveryOptions extends OperationOptions {
  /** Observe an unresolved payment through recover(); resume never calls pay(). */
  payment?: PaymentProvider | undefined;
  /** Persist each opaque checkpoint durably before resolving. Never discard a pending payment. */
  onCheckpoint(checkpoint: string): void | Promise<void>;
}
export interface PointerWriteOptions extends PointerRecoveryOptions {
  /** Application-owned 32-byte FIPS 204 seed. Never persisted by the SDK. */
  ownerSeed: Uint8Array;
  target: string;
  kind: "chunk" | "pointer";
}
export interface PointerTransferOptions extends PointerRecoveryOptions {
  ownerSeed: Uint8Array;
  /** Recipient pointer address. Transfer is permanent; inspect pointerFinality afterwards. */
  recipient: string;
}

/** Failure retaining the latest checkpoint, even when durable persistence itself failed. */
export class PointerError extends AutonomiError {
  readonly checkpoint: string | undefined;
  constructor(error: unknown, checkpoint?: string) {
    const failure = wrapError("POINTER_FAILED", "Pointer operation failed", error);
    super(failure.code, failure.message, error);
    this.name = isAbort(error) ? "AbortError" : "PointerError";
    this.checkpoint = checkpoint;
  }
}

/** Compute an address offline without exposing the derived secret key. */
export async function pointerAddress(ownerSeed: Uint8Array, options: ManifestOptions = {}): Promise<string> {
  const seed = ownerSeed.slice();
  try {
    throwIfAborted(options.signal);
    await abortable(initializeClientWasm(options.wasm), options.signal);
    throwIfAborted(options.signal);
    return getBindings().pointerAddress(seed);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw wrapError("INVALID_SOURCE", "Invalid pointer owner seed", error);
  } finally { seed.fill(0); }
}

interface Journal {
  version: 1;
  network: PaymentNetwork;
  prepared: string;
  quotes?: readonly VerifiedStorageQuote[];
  submissions: PaymentSubmissionInfo[];
  receipt?: PaymentReceipt;
  paid?: { record: number[]; proof: number[] };
}

/** Internal orchestration. Rust owns signing, quote policy, record validation and proofs. */
export async function writePointer(
  raw: RawNetworkClient,
  network: PaymentNetwork,
  method: "createPointer" | "updatePointer" | "transferPointer",
  options: PointerWriteOptions | PointerTransferOptions,
  report: (message: string) => void,
): Promise<PointerWriteResult> {
  if (typeof options.onCheckpoint !== "function") throw new AutonomiError("INVALID_SOURCE", "Pointer writes require durable onCheckpoint persistence");
  if (!options.payment) throw new AutonomiError("PAYMENT_REQUIRED", "Pointer writes require a PaymentProvider");
  const seed = options.ownerSeed.slice();
  const persist = options.onCheckpoint;
  const payment = options.payment;
  const signal = options.signal;
  let journal: Journal | undefined;
  let persistenceFailure: unknown;
  let callbackFailure: unknown;
  const observe = <A extends unknown[], R>(callback: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try { return await callback(...args); }
    catch (error) { callbackFailure = error; throw error; }
  };
  let writes = Promise.resolve();
  let latestWrite = Promise.resolve();
  const checkpoint = (): Promise<void> => {
    const serialized = JSON.stringify(journal);
    const next = writes.then(() => persist(serialized));
    writes = next.catch((error: unknown) => { persistenceFailure = error; });
    latestWrite = checkpointDeadline(next);
    void latestWrite.catch((error: unknown) => { persistenceFailure = error; });
    return latestWrite;
  };
  const prepared = async (value: string): Promise<void> => {
    throwIfAborted(signal);
    journal = { version: 1, network: snapshot(network), prepared: value, submissions: [] };
    await abortable(checkpoint(), signal);
    throwIfAborted(signal);
  };
  const pay = async (networkValue: unknown, quoteValue: unknown): Promise<PaymentReceipt> => {
    if (!journal) throw new AutonomiError("POINTER_FAILED", "Core did not checkpoint the pointer before requesting payment");
    paymentNetworkFromCore(networkValue, network);
    journal.quotes = snapshot(quoteValue as VerifiedStorageQuote[]);
    // Persist the intent before invoking a wallet: an empty submission list is NOT proof of no broadcast.
    await abortable(checkpoint(), signal);
    throwIfAborted(signal);
    report("Waiting for pointer payment");
    throwIfAborted(signal);
    const receipt = await payment.pay(network, journal.quotes, {
      report, ...(signal ? { signal } : {}),
      submitted: (submission) => {
        journal!.submissions.push(snapshot({ transactionHash: submission.transactionHash, totalAmount: submission.totalAmount,
          ...(submission.walletAddress ? { walletAddress: submission.walletAddress } : {}) }));
        void checkpoint().catch(() => undefined);
      },
    });
    // Once money may have been spent, continue to proof creation and storage even if cancelled or persistence fails.
    journal.receipt = snapshot(receipt);
    await checkpoint().catch(() => undefined);
    return receipt;
  };
  const paid = async (value: { record: Uint8Array; proof: Uint8Array }): Promise<void> => {
    journal!.paid = { record: Array.from(value.record), proof: Array.from(value.proof) };
    await checkpoint();
  };
  try {
    throwIfAborted(signal);
    const result = method === "transferPointer"
      ? await raw.transferPointer(seed, (options as PointerTransferOptions).recipient, corePaymentNetwork(network), observe(pay), paid, observe(prepared))
      : await raw[method](seed, (options as PointerWriteOptions).target, (options as PointerWriteOptions).kind, corePaymentNetwork(network), observe(pay), paid, observe(prepared));
    await latestWrite;
    if (persistenceFailure !== undefined) throw persistenceFailure;
    return snapshot(result as PointerWriteResult);
  } catch (error) {
    await abortable(latestWrite, signal).catch(() => undefined);
    throw new PointerError(callbackFailure ?? error, journal ? JSON.stringify(journal) : undefined);
  } finally { seed.fill(0); }
}

export async function resumePointer(
  raw: RawNetworkClient,
  network: PaymentNetwork,
  checkpoint: string,
  options: PointerRecoveryOptions,
  report: (message: string) => void,
): Promise<Pointer> {
  let journal: Journal;
  try {
    if (checkpoint.length > 16 * 1024 * 1024) throw new Error("Pointer checkpoint exceeds 16 MiB");
    journal = JSON.parse(checkpoint) as Journal;
    if (journal.version !== 1 || typeof journal.prepared !== "string" || !Array.isArray(journal.submissions)) throw new Error("Invalid pointer checkpoint");
    paymentNetworkFromCore(corePaymentNetwork(journal.network), network);
    if (typeof options.onCheckpoint !== "function") throw new Error("Pointer recovery requires durable onCheckpoint persistence");
  } catch (error) { throw wrapError("INVALID_SOURCE", "Invalid pointer checkpoint or payment network", error); }
  const persist = async (): Promise<void> => { await abortable(checkpointDeadline(Promise.resolve().then(() => options.onCheckpoint(JSON.stringify(journal)))), options.signal); };
  try {
    throwIfAborted(options.signal);
    if (!journal.paid) {
      if (!journal.receipt) {
        if (!options.payment?.recover || !journal.quotes) throw new AutonomiError("PAYMENT_UNRESOLVED", "Observe the original pointer payment with a recovery provider; do not submit a fresh payment");
        journal.receipt = snapshot(await options.payment.recover(network, snapshot(journal.quotes), snapshot({ submissions: journal.submissions }), { report, ...(options.signal ? { signal: options.signal } : {}) }));
        await persist();
      }
      const paid = getBindings().recoverPointerPayment(journal.prepared, journal.receipt) as { record: Uint8Array; proof: Uint8Array };
      journal.paid = { record: Array.from(paid.record), proof: Array.from(paid.proof) };
    }
    const validBytes = (bytes: number[]): boolean => Array.isArray(bytes) && bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
    if (!validBytes(journal.paid.record) || !validBytes(journal.paid.proof)) throw new Error("Invalid paid pointer bytes");
    await persist();
    throwIfAborted(options.signal);
    return snapshot(await raw.storePaidPointer(Uint8Array.from(journal.paid.record), Uint8Array.from(journal.paid.proof), corePaymentNetwork(network)) as Pointer);
  } catch (error) { throw new PointerError(error, JSON.stringify(journal)); }
}


// As in Rust's onPaid timeout, an unresponsive persistence adapter cannot keep
// a paid state from storage. Keep the underlying write queue ordered even after
// observation times out; expose the latest full checkpoint to the caller.
function checkpointDeadline(pending: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AutonomiError("POINTER_FAILED", "Durable pointer checkpoint callback timed out; retain the error checkpoint")), 30_000);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}
