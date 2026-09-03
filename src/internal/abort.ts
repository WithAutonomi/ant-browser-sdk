export function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined
    ? new DOMException("The operation was aborted", "AbortError")
    : signal.reason;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

export function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    (signal?.aborted === true && error === signal.reason) ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

/** Reject when the signal aborts while still observing the underlying promise. */
export function abortable<T>(
  promise: T | PromiseLike<T>,
  signal?: AbortSignal,
  onAbort?: (reason: unknown) => void,
  onLateResolve?: (value: T) => void,
): Promise<T> {
  if (!signal) return Promise.resolve(promise);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let aborted = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      aborted = true;
      const reason = abortReason(signal);
      try {
        onAbort?.(reason);
      } catch {
        // Cancellation cleanup must not replace the signal's reason.
      }
      reject(reason);
    };

    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });

    void Promise.resolve(promise).then(
      (value) => {
        if (aborted) {
          try {
            onLateResolve?.(value);
          } catch {
            // A late resource cleanup has no caller left to observe its error.
          }
          return;
        }
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
