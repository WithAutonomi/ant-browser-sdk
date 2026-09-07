import type { Operation, ProgressDetails, ProgressEvent, ProgressListener, ProgressPhase } from "../types.js";
import { throwIfAborted } from "./abort.js";

let sequence = 0;
const prefix = Math.random().toString(36).slice(2);
export function operationId(): string { return `${prefix}-${++sequence}`; }

export interface Reporter {
  (message: string, details?: ProgressDetails): void;
  finish(): void;
}

export function progressReporter(
  operation: Operation,
  id: string,
  phase: ProgressPhase,
  notify: ProgressListener,
  signal?: AbortSignal,
): Reporter {
  let finished = false;
  let current: ProgressDetails = { phase };
  const report: Reporter = (message, details) => {
    if (finished) return;
    throwIfAborted(signal);
    if (details) current = details;
    const event: ProgressEvent = Object.freeze({ operation, operationId: id, message, ...current });
    notify(event);
    // A listener may synchronously cancel this operation.
    throwIfAborted(signal);
  };
  report.finish = () => { finished = true; };
  return report;
}
