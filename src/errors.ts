import type { UploadRecovery } from "./types.js";

export type AutonomiErrorCode =
  | "INITIALIZATION_FAILED"
  | "INVALID_SOURCE"
  | "CONNECTION_FAILED"
  | "NETWORK_MISMATCH"
  | "CLIENT_CLOSED"
  | "PAYMENT_REQUIRED"
  | "PAYMENT_FAILED"
  | "PAYMENT_UNRESOLVED"
  | "LOOKUP_FAILED"
  | "UPLOAD_FAILED"
  | "UPLOAD_IN_PROGRESS"
  | "RECOVERY_PAYMENT_REQUIRED"
  | "DOWNLOAD_FAILED"
  | "OPEN_FILE_FAILED"
  | "SAVE_FAILED"
  | "MEDIA_FAILED";

/** Stable SDK error with a machine-readable code and the original cause. */
export class AutonomiError extends Error {
  readonly code: AutonomiErrorCode;

  constructor(code: AutonomiErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AutonomiError";
    this.code = code;
  }
}

/** Upload failure with explicit recovery ownership and the original error code. */
export class UploadError extends AutonomiError {
  readonly recovery: UploadRecovery;
  constructor(error: AutonomiError, recovery: UploadRecovery) {
    super(error.code, error.message, error);
    this.name = "UploadError";
    this.recovery = recovery;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function wrapError(
  code: AutonomiErrorCode,
  context: string,
  error: unknown,
): AutonomiError {
  if (error instanceof AutonomiError) return error;
  return new AutonomiError(code, `${context}: ${errorMessage(error)}`, error);
}
