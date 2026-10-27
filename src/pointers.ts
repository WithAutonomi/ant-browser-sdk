import { AutonomiError, wrapError } from "./errors.js";
import { abortable, isAbort, throwIfAborted } from "./internal/abort.js";
import { corePaymentNetwork, paymentNetworkFromCore } from "./internal/payment-network.js";
import { getBindings, initializeClientWasm, type RawNetworkClient } from "./internal/runtime.js";
import { snapshot } from "./internal/snapshot.js";
import { validateReceipt } from "./internal/upload-recovery.js";
import type { ManifestOptions } from "./manifest.js";
import type {
  OperationOptions, PaymentNetwork, PaymentProvider, PaymentReceipt, PaymentSettlement, PaymentSubmission, VerifiedStorageQuote,
} from "./types.js";

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
  /**
   * Observe an unresolved payment through recover(); resume never calls pay().
   * Broadcasts reported earlier on this page are first observed through their wait().
   */
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

/**
 * A failed pointer operation. `checkpoint` is set once a wallet may have been asked
 * to pay; it holds the latest evidence, even when durable persistence itself failed.
 * Without one, no payment was requested: discard any checkpoint persisted for the
 * attempt and write again.
 */
export class PointerError extends AutonomiError {
  readonly checkpoint: string | undefined;
  constructor(error: unknown, checkpoint?: string) {
    const failure = wrapError("POINTER_FAILED", "Pointer operation failed", error);
    super(failure.code, failure.message, error);
    this.name = isAbort(error) ? "AbortError" : "PointerError";
    this.checkpoint = checkpoint;
  }
}

/**
 * A copy of the caller's seed for the SDK to zero once it is done. Never a
 * view: a Node `Buffer`'s `slice()` shares its bytes, so zeroing that would
 * clear the caller's seed too.
 */
function copySeed(seed: Uint8Array): Uint8Array {
  return new Uint8Array(seed);
}

/** Compute an address offline without exposing the derived secret key. */
export async function pointerAddress(ownerSeed: Uint8Array, options: ManifestOptions = {}): Promise<string> {
  const seed = copySeed(ownerSeed);
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

const JOURNAL_VERSION = 1;
/** Largest checkpoint accepted for recovery; the core's own part is at most 4 MiB. */
const MAX_CHECKPOINT_CHARS = 16 * 1024 * 1024;
/** As Rust's page-callback timeout: an unresponsive persistence adapter cannot stall a paid write or its wallet. */
const CHECKPOINT_TIMEOUT_MS = 30_000;
/** Bytes passed to one String.fromCharCode call while base64-encoding. */
const BASE64_BLOCK_BYTES = 0x8000;

/** What a recovery provider needs to find a broadcast transaction again. */
interface PaymentEvidence {
  transactionHash?: string;
  transactionHashes?: Record<string, string>;
  totalAmount?: string;
  walletAddress?: string;
}

/** A receipt Rust accepted for the plan, with the record and proof it rebuilt, in base64. */
interface PaidState {
  receipt: PaymentReceipt;
  record: string;
  proof: string;
}

/**
 * First persisted with the payment intent, immediately before a wallet is invoked,
 * so every durable checkpoint may have a payment. Never contains the owner seed.
 */
interface Journal {
  version: typeof JOURNAL_VERSION;
  network: PaymentNetwork;
  /** The core's opaque signed record and payment plan. */
  prepared: string;
  quotes: readonly VerifiedStorageQuote[];
  submissions: PaymentEvidence[];
  paid?: PaidState;
}

/** This page's broadcast observers by transaction hash, so recovery need not depend on recover(). */
const observers = new Map<string, PaymentSubmission>();

/** Context the client supplies for one write. */
export interface PointerWriteContext {
  report(message: string): void;
  /** Keep the transport open from wallet invocation until the write settles. Returns the release. */
  holdTransport(): () => void;
}

/** Internal orchestration. Rust owns signing, quote policy, record validation and proofs. */
export async function writePointer(
  raw: RawNetworkClient,
  network: PaymentNetwork,
  method: "createPointer" | "updatePointer" | "transferPointer",
  options: PointerWriteOptions | PointerTransferOptions,
  context: PointerWriteContext,
): Promise<PointerWriteResult> {
  if (typeof options.onCheckpoint !== "function") throw new AutonomiError("INVALID_SOURCE", "Pointer writes require durable onCheckpoint persistence");
  if (!options.payment) throw new AutonomiError("PAYMENT_REQUIRED", "Pointer writes require a PaymentProvider");
  const seed = copySeed(options.ownerSeed);
  const payment = options.payment;
  const signal = options.signal;
  const writer = new CheckpointWriter(options.onCheckpoint);
  let prepared: string | undefined;
  // Set only once the intent is durable and the wallet is about to be invoked.
  let journal: Journal | undefined;
  let releaseTransport: (() => void) | undefined;
  let callbackFailure: unknown;
  const observe = <A extends unknown[], R>(callback: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try { return await callback(...args); }
    catch (error) { callbackFailure = error; throw error; }
  };
  const onPrepared = async (value: unknown): Promise<void> => {
    throwIfAborted(signal);
    if (typeof value !== "string") throw new Error("The core returned an invalid pointer checkpoint");
    prepared = value;
  };
  const pay = async (networkValue: unknown, quoteValue: unknown): Promise<PaymentReceipt> => {
    if (prepared === undefined) throw new AutonomiError("POINTER_FAILED", "Core did not checkpoint the pointer before requesting payment");
    paymentNetworkFromCore(networkValue, network);
    const intent: Journal = {
      version: JOURNAL_VERSION, network: snapshot(network), prepared, quotes: snapshot(quoteValue as VerifiedStorageQuote[]), submissions: [],
    };
    // Persist the intent before invoking a wallet: an empty submission list is NOT proof of no broadcast.
    await abortable(writer.write(intent), signal);
    throwIfAborted(signal);
    journal = intent;
    releaseTransport = context.holdTransport();
    context.report("Waiting for pointer payment");
    let receipt: { value: unknown } | undefined;
    let failure: unknown;
    try {
      receipt = { value: await payment.pay(network, intent.quotes, {
        report: context.report, ...(signal ? { signal } : {}),
        // The wallet waits, at most the checkpoint deadline, until the broadcast is journaled; a failed write never fails it.
        submitted: (submission) => retainSubmission(intent, submission) ? writer.write(intent).catch(() => undefined) : writer.idle(),
      }) };
    } catch (error) { failure = error; }
    // Once money may have been spent, continue to proof creation and storage even if cancelled or persistence fails.
    let paid: PaidState | undefined;
    if (receipt) {
      try { paid = acceptReceipt(intent, receipt.value); }
      catch (error) {
        failure = error;
        // A rejected receipt may still identify a transaction that spent funds.
        if (addEvidence(intent, receipt.value)) void writer.write(intent).catch(() => undefined);
      }
    }
    // A broadcast whose receipt poll failed can still be confirmed by observing it again.
    paid ??= await confirmObserved(intent, signal);
    if (!paid) throw failure;
    intent.paid = paid;
    void writer.write(intent).catch(() => undefined);
    return paid.receipt;
  };
  const onPaid = async (value: { record: Uint8Array; proof: Uint8Array }): Promise<void> => {
    if (!journal?.paid) return;
    // Rust stores this state whatever happens here; an identical snapshot is not written again.
    journal.paid = { ...journal.paid, record: toBase64(value.record), proof: toBase64(value.proof) };
    await writer.write(journal);
  };
  try {
    throwIfAborted(signal);
    const hooks = { onPrepared: observe(onPrepared), onPaid };
    const result = method === "transferPointer"
      ? await raw.transferPointer(seed, (options as PointerTransferOptions).recipient, corePaymentNetwork(network), observe(pay), hooks)
      : await raw[method](seed, (options as PointerWriteOptions).target, (options as PointerWriteOptions).kind, corePaymentNetwork(network), observe(pay), hooks);
    forgetObservers(journal);
    // The stored state is the outcome; let checkpoint writes settle so none lands after the caller cleans up.
    await writer.idle();
    return snapshot(result as PointerWriteResult);
  } catch (error) {
    if (!signal?.aborted) await writer.idle();
    throw new PointerError(callbackFailure ?? error, journal ? writer.latest : undefined);
  } finally {
    seed.fill(0);
    releaseTransport?.();
  }
}

export async function resumePointer(
  raw: RawNetworkClient,
  network: PaymentNetwork,
  checkpoint: string,
  options: PointerRecoveryOptions,
  report: (message: string) => void,
): Promise<Pointer> {
  if (typeof options.onCheckpoint !== "function") throw new AutonomiError("INVALID_SOURCE", "Pointer recovery requires durable onCheckpoint persistence");
  const journal = parseJournal(checkpoint, network);
  const writer = new CheckpointWriter(options.onCheckpoint);
  const signal = options.signal;
  try {
    throwIfAborted(signal);
    if (!journal.paid) {
      let paid = await confirmObserved(journal, signal);
      if (!paid) {
        if (!options.payment?.recover) {
          throw new AutonomiError("PAYMENT_UNRESOLVED", "Observe the original pointer payment with a PaymentProvider that implements recover(); do not submit a fresh payment");
        }
        const recovered = await options.payment.recover(network, snapshot(journal.quotes), snapshot({ submissions: journal.submissions }),
          { report, ...(signal ? { signal } : {}) });
        try { paid = acceptReceipt(journal, recovered); }
        catch (error) {
          if (addEvidence(journal, recovered)) await writer.write(journal).catch(() => undefined);
          throw error;
        }
      }
      journal.paid = paid;
      // Store even if this write fails: storing pays nothing, and the error retains the proof.
      await writer.write(journal).catch(() => undefined);
    }
    throwIfAborted(signal);
    const pointer = await raw.storePaidPointer(fromBase64(journal.paid.record), fromBase64(journal.paid.proof), corePaymentNetwork(network));
    forgetObservers(journal);
    await writer.idle();
    return snapshot(pointer as Pointer);
  } catch (error) {
    if (!signal?.aborted) await writer.idle();
    throw new PointerError(error, writer.latest ?? checkpoint);
  }
}

function parseJournal(checkpoint: string, network: PaymentNetwork): Journal {
  try {
    if (typeof checkpoint !== "string" || checkpoint.length > MAX_CHECKPOINT_CHARS) throw new Error("Pointer checkpoint exceeds 16 MiB");
    const journal = JSON.parse(checkpoint) as Journal;
    if (journal?.version !== JOURNAL_VERSION) throw new Error("Unsupported pointer checkpoint version");
    if (typeof journal.prepared !== "string" || !Array.isArray(journal.quotes) || !Array.isArray(journal.submissions)) {
      throw new Error("Invalid pointer checkpoint");
    }
    paymentNetworkFromCore(corePaymentNetwork(journal.network), network);
    if (journal.paid !== undefined) {
      if (typeof journal.paid?.receipt !== "object" || journal.paid.receipt === null) throw new Error("Invalid paid pointer receipt");
      fromBase64(journal.paid.record);
      fromBase64(journal.paid.proof);
    }
    return journal;
  } catch (error) { throw wrapError("INVALID_SOURCE", "Invalid pointer checkpoint or payment network", error); }
}

/**
 * Rust checks that the receipt pays this plan and rebuilds the proof; the total is checked as for uploads.
 * Rust reads `transactionHashes` keyed by quote hash, or else one `transactionHash` paying every quote.
 */
function acceptReceipt(journal: Journal, value: unknown): PaidState {
  const evidence = paymentFields(value);
  if (!evidence || evidence.totalAmount === undefined) throw new Error("Payment provider returned an invalid receipt");
  const receipt = evidence as PaymentReceipt;
  validateReceipt(receipt, journal.quotes);
  const paid = getBindings().recoverPointerPayment(journal.prepared, receipt) as { record: Uint8Array; proof: Uint8Array };
  return { receipt, record: toBase64(paid.record), proof: toBase64(paid.proof) };
}

/** Observe this page's broadcasts for the journal again. Never submits a transaction. */
async function confirmObserved(journal: Journal, signal?: AbortSignal): Promise<PaidState | undefined> {
  for (const hash of evidenceHashes(journal)) {
    const submission = observers.get(hash);
    if (!submission) continue;
    let settlement: PaymentSettlement;
    try { settlement = await abortable(Promise.resolve().then(() => submission.wait()), signal); }
    catch (error) {
      if (isAbort(error, signal)) throw error;
      continue;
    }
    if (settlement?.status !== "confirmed") continue;
    try { return acceptReceipt(journal, settlement.receipt); } catch { /* Observe the next broadcast. */ }
  }
  return undefined;
}

/** Journal broadcast evidence before validating anything else. Never throws into the wallet. */
function retainSubmission(journal: Journal, submission: PaymentSubmission): boolean {
  try {
    if (typeof submission.transactionHash === "string" && typeof submission.wait === "function") {
      observers.set(normalizeHash(submission.transactionHash), submission);
    }
    return addEvidence(journal, submission);
  } catch { return false; }
}

/** Record JSON-safe evidence of a transaction not yet journaled; report whether the journal changed. */
function addEvidence(journal: Journal, value: unknown): boolean {
  const evidence = paymentFields(value);
  const hashes = evidence ? transactionHashes(evidence) : [];
  const known = new Set(evidenceHashes(journal));
  if (hashes.length === 0 || hashes.every((hash) => known.has(hash))) return false;
  journal.submissions.push(evidence!);
  return true;
}

/** Copy only the known payment fields, so wallet extras such as bigints never reach a checkpoint. */
function paymentFields(value: unknown): PaymentEvidence | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  const hashes = stringRecord(fields.transactionHashes);
  const totalAmount = typeof fields.totalAmount === "bigint" && fields.totalAmount >= 0n
    ? fields.totalAmount.toString() : fields.totalAmount;
  return {
    ...(typeof fields.transactionHash === "string" ? { transactionHash: fields.transactionHash } : {}),
    ...(hashes ? { transactionHashes: hashes } : {}),
    ...(typeof totalAmount === "string" ? { totalAmount } : {}),
    ...(typeof fields.walletAddress === "string" ? { walletAddress: fields.walletAddress } : {}),
  };
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, hash]) => typeof hash === "string") ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

function transactionHashes(evidence: PaymentEvidence): string[] {
  return [evidence.transactionHash, ...Object.values(evidence.transactionHashes ?? {})]
    .filter((hash): hash is string => typeof hash === "string" && hash.trim() !== "")
    .map(normalizeHash);
}

function evidenceHashes(journal: Journal): string[] {
  const evidence = journal.paid ? [...journal.submissions, journal.paid.receipt as PaymentEvidence] : journal.submissions;
  return [...new Set(evidence.flatMap(transactionHashes))];
}

function forgetObservers(journal: Journal | undefined): void {
  if (journal) for (const hash of evidenceHashes(journal)) observers.delete(hash);
}

function normalizeHash(hash: string): string {
  return hash.trim().toLowerCase().replace(/^0x/u, "");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_BLOCK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_BLOCK_BYTES));
  }
  return btoa(binary);
}

function fromBase64(value: unknown): Uint8Array {
  if (typeof value !== "string") throw new Error("Invalid paid pointer bytes");
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

/**
 * Orders durable checkpoint writes. Every snapshot is the complete journal, so
 * snapshots requested while a write runs coalesce: only the newest is written next.
 */
class CheckpointWriter {
  readonly #persist: (checkpoint: string) => void | Promise<void>;
  #latest: string | undefined;
  #durable: string | undefined;
  #running: { value: string; done: Promise<void> } | undefined;
  #queued: { value: string; done: Promise<void>; start(): void } | undefined;
  #observed: Promise<unknown> = Promise.resolve();

  constructor(persist: (checkpoint: string) => void | Promise<void>) {
    this.#persist = persist;
  }

  /** The newest snapshot requested, whether or not it became durable. */
  get latest(): string | undefined {
    return this.#latest;
  }

  /** Resolves once this snapshot or a newer one is durable; rejects if that write fails or times out. */
  write(journal: Journal): Promise<void> {
    let value: string;
    try { value = JSON.stringify(journal); } catch (error) { return Promise.reject(error); }
    this.#latest = value;
    const observed = checkpointDeadline(this.#schedule(value));
    this.#observed = observed.catch(() => undefined);
    return observed;
  }

  /** Wait for the newest requested snapshot, at most until its deadline. Never rejects. */
  async idle(): Promise<void> {
    await this.#observed;
  }

  #schedule(value: string): Promise<void> {
    if (this.#queued) {
      this.#queued.value = value;
      return this.#queued.done;
    }
    if (this.#running) {
      if (this.#running.value === value) return this.#running.done;
      let start!: () => void;
      const done = new Promise<void>((resolve, reject) => { start = () => { this.#start(queued.value).then(resolve, reject); }; });
      const queued = { value, done, start };
      this.#queued = queued;
      return done;
    }
    return this.#durable === value ? Promise.resolve() : this.#start(value);
  }

  #start(value: string): Promise<void> {
    const done = Promise.resolve().then(() => this.#persist(value)).then(
      () => { this.#durable = value; },
      (error: unknown) => { this.#durable = undefined; throw error; },
    );
    this.#running = { value, done };
    void done.catch(() => undefined).then(() => {
      this.#running = undefined;
      const next = this.#queued;
      this.#queued = undefined;
      next?.start();
    });
    return done;
  }
}

// An unresponsive adapter stops only the caller's wait: the write queue stays ordered.
function checkpointDeadline(pending: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AutonomiError("POINTER_FAILED", "Durable pointer checkpoint callback timed out; retain the error checkpoint")), CHECKPOINT_TIMEOUT_MS);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}
