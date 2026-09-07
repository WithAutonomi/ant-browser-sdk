import { AutonomiError } from "../errors.js";
import type {
  PaymentNetwork, PaymentReceipt, PublicFile, UploadPayment, UploadRecovery,
  UploadResult, VerifiedStorageQuote,
} from "../types.js";
import { clearStagedUpload, type StagedUpload } from "./staging.js";
import { snapshot } from "./snapshot.js";

export interface RetainedUpload {
  handle: UploadRecovery;
  network: PaymentNetwork;
  name: string;
  contentType: string;
  size: number;
  bytes?: Uint8Array;
  staged?: StagedUpload;
  payments: UploadPayment[];
  pendingPayments: Promise<unknown>[];
  work?: Promise<unknown>;
  result?: UploadResult;
  status: UploadRecovery["status"];
  settled: Promise<void>;
}
const states = new WeakMap<UploadRecovery, RetainedUpload>();

export function retainUpload(
  network: PaymentNetwork,
  input: { bytes: Uint8Array; name: string; contentType: string } | { staged: StagedUpload },
  id: string,
): RetainedUpload {
  const name = "staged" in input ? input.staged.staged.name : input.name;
  const size = "staged" in input ? input.staged.staged.size : input.bytes.byteLength;
  const contentType = "staged" in input ? input.staged.staged.content_type : input.contentType;
  let discarding: Promise<void> | undefined;
  const handle: UploadRecovery = Object.freeze({
    id, name, size, contentType,
    get status() { return state.status; },
    get payments() { return Object.freeze([...state.payments]); },
    get settled() { return state.settled; },
    discard(): Promise<void> {
      if (state.status === "completed" || state.status === "discarded") return Promise.resolve();
      if (state.status === "active") {
        return Promise.reject(new AutonomiError(
          "UPLOAD_IN_PROGRESS", "Wait for the active upload before discarding its recovery",
        ));
      }
      if (discarding) return discarding;
      state.status = "discarding";
      discarding = state.settled.then(() => releaseUpload(state, "discarded")).catch((error: unknown) => {
        state.status = "ready";
        discarding = undefined;
        throw error;
      });
      return discarding;
    },
  });
  const state: RetainedUpload = {
    handle, network: snapshot(network), name, contentType, size,
    ...input, payments: [], pendingPayments: [], status: "active", settled: Promise.resolve(),
  };
  states.set(handle, state);
  return state;
}

function retainedUpload(handle: UploadRecovery): RetainedUpload {
  const state = states.get(handle);
  if (!state) throw new AutonomiError("INVALID_SOURCE", "Recovery must come from this SDK instance");
  return state;
}

export function uploadSettlement(handle: UploadRecovery): Promise<void> {
  return retainedUpload(handle).settled;
}

export function claimUpload(handle: UploadRecovery, network: PaymentNetwork): RetainedUpload {
  const state = retainedUpload(handle);
  if (state.status === "completed" || state.status === "discarded") {
    throw new AutonomiError("INVALID_SOURCE", `Upload recovery is ${state.status}`);
  }
  if (state.status !== "ready") {
    throw new AutonomiError("UPLOAD_IN_PROGRESS", `Upload recovery is ${state.status}`);
  }
  if (!sameNetwork(state.network, network)) {
    throw new AutonomiError("INVALID_SOURCE", "Resume on the original payment network and contracts");
  }
  state.status = "active";
  state.pendingPayments = [];
  return state;
}

export function awaitUploadSettlement(state: RetainedUpload): void {
  state.status = "settling";
  state.settled = Promise.allSettled([state.work, ...state.pendingPayments]).then(() => {
    if (state.status === "settling") state.status = "ready";
    state.pendingPayments = [];
    delete state.work;
  });
}

export async function releaseUpload(
  state: RetainedUpload,
  status: "completed" | "discarded",
): Promise<void> {
  if (state.staged) await clearStagedUpload(state.staged);
  delete state.staged;
  delete state.bytes;
  delete state.work;
  state.pendingPayments = [];
  state.status = status;
}

export function quoteTotal(quotes: readonly VerifiedStorageQuote[]): string {
  return quotes.reduce((total, quote) => {
    if (!/^\d+$/u.test(quote.amount)) throw new Error("Storage quote has a non-decimal amount");
    return total + BigInt(quote.amount);
  }, 0n).toString();
}

export function validateReceipt(receipt: PaymentReceipt, quotes: readonly VerifiedStorageQuote[]): void {
  if (!/^\d+$/u.test(receipt.totalAmount) || receipt.totalAmount !== quoteTotal(quotes)) {
    throw new Error("Payment provider returned a totalAmount that does not match the verified quotes");
  }
  if (quotes.length > 0 || receipt.transactionHash !== undefined) {
    if (typeof receipt.transactionHash !== "string" || receipt.transactionHash.trim() === "") {
      throw new Error("Payment provider must return a non-empty transactionHash for a paid plan");
    }
  }
}

/** The core accepts one transaction hash for the entire current plan. */
export function paidReceipt(
  state: RetainedUpload,
  network: PaymentNetwork,
  quotes: readonly VerifiedStorageQuote[],
): PaymentReceipt | undefined {
  if (quotes.length === 0) return { totalAmount: "0" };
  for (const payment of state.payments) {
    if (!sameNetwork(payment.network, network)) continue;
    try { validateReceipt(payment.receipt, payment.quotes); } catch { continue; }
    if (payment.receipt.transactionHash === undefined) continue;
    const paid = new Map(payment.quotes.map((quote) => [normalizedHash(quote.quoteHash), quote]));
    const seen = new Set<string>();
    if (quotes.every((quote) => {
      const hash = normalizedHash(quote.quoteHash);
      const previous = paid.get(hash);
      if (seen.has(hash)) return false;
      seen.add(hash);
      return previous && previous.amount === quote.amount &&
        previous.rewardsAddress.toLowerCase() === quote.rewardsAddress.toLowerCase();
    })) return { ...payment.receipt, totalAmount: quoteTotal(quotes) };
  }
  return undefined;
}

export function uploadResult(
  state: RetainedUpload,
  raw: { file: PublicFile; records: number; storageCostAtto: string; transactionHash?: string },
): UploadResult {
  const last = state.payments.at(-1)?.receipt.transactionHash;
  return {
    ...raw,
    ...(raw.transactionHash || !last ? {} : { transactionHash: last }),
    storageCostAtto: state.payments.reduce((sum, payment) => sum + BigInt(payment.receipt.totalAmount), 0n).toString(),
    payments: Object.freeze([...state.payments]),
  };
}

function sameNetwork(a: PaymentNetwork, b: PaymentNetwork): boolean {
  return a.chainId === b.chainId &&
    a.payment_token_address.toLowerCase() === b.payment_token_address.toLowerCase() &&
    a.payment_vault_address.toLowerCase() === b.payment_vault_address.toLowerCase();
}

function normalizedHash(hash: string): string {
  return hash.toLowerCase().replace(/^0x/u, "");
}
