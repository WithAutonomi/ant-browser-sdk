export type AutonomiErrorCode =
  | "INITIALIZATION_FAILED"
  | "INVALID_SOURCE"
  | "CONNECTION_FAILED"
  | "CLIENT_CLOSED"
  | "PAYMENT_REQUIRED"
  | "PAYMENT_FAILED"
  | "LOOKUP_FAILED"
  | "UPLOAD_FAILED"
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
