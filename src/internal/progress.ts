import type { Operation, ProgressDetails, ProgressEvent, ProgressListener, ProgressPhase, UploadRecovery } from "../types.js";
import { throwIfAborted } from "./abort.js";

let sequence = 0;
const prefix = Math.random().toString(36).slice(2);
export function operationId(): string { return `${prefix}-${++sequence}`; }

export interface Reporter {
  (message: string, details?: ProgressDetails): void;
  finish(outcome?: OperationOutcome): void;
}

export type OperationOutcome = { status: "succeeded" } |
  { status: "failed" | "cancelled"; error: unknown; recovery?: UploadRecovery };

export function progressReporter(
  operation: Operation,
  id: string,
  phase: ProgressPhase,
  notify: ProgressListener,
  signal?: AbortSignal,
  parentOperationId?: string,
): Reporter {
  let finished = false;
  let lastMessage = `${operation} started`;
  let current: ProgressDetails = { phase };
  const emit = (event: ProgressEvent): void => {
    try { notify(Object.freeze(event)); } catch { /* UI callbacks do not affect operation results. */ }
  };
  const identity = { operation, operationId: id, ...(parentOperationId === undefined ? {} : { parentOperationId }) };
  const report: Reporter = (message, details) => {
    if (finished) return;
    throwIfAborted(signal);
    if (details) current = details;
    lastMessage = message;
    emit({ ...identity, message, ...current, status: "running" });
    // A listener may synchronously cancel this operation.
    throwIfAborted(signal);
  };
  report.finish = (outcome = { status: "succeeded" }) => {
    if (finished) return;
    finished = true;
    emit({ ...identity, ...current, message: lastMessage,
      ...(outcome.status === "succeeded" ? { phase: "complete" as const } : {}), ...outcome });
  };
  return report;
}
