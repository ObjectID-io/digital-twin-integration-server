export type ErrorCategory =
  | "VALIDATION" | "AUTHORIZATION" | "CREDIT" | "CONNECTOR" | "OBJECTID"
  | "NETWORK" | "SCHEMA" | "THREAD_INTEGRITY" | "MATURITY" | "INTERNAL";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 500,
    public readonly category: ErrorCategory = "INTERNAL",
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorBody(error: unknown) {
  const appError = error instanceof AppError
    ? error
    : new AppError("INTERNAL_ERROR", "Unexpected server error");
  return {
    status: appError.status,
    body: {
      error: {
        code: appError.code,
        message: appError.message,
        category: appError.category,
        details: appError.details,
      },
    },
  };
}

export function mapObjectIdError(error: unknown): AppError {
  const message = error instanceof Error ? error.message : String(error);
  if (/insufficient gas/i.test(message)) {
    return new AppError("IOTA_INSUFFICIENT_GAS", message, 503, "OBJECTID", { retryable: false });
  }
  if (/credit|balance|insufficient/i.test(message)) {
    return new AppError("OBJECTID_INSUFFICIENT_CREDIT", message, 402, "CREDIT");
  }
  if (/authori[sz]|controllercap|not allowed/i.test(message)) {
    return new AppError("OBJECTID_NOT_AUTHORIZED", message, 403, "AUTHORIZATION");
  }
  if (/timeout|timed out|ECONNREFUSED|ENOTFOUND|ECONNRESET|502|503|temporar/i.test(message)) {
    const submissionUnknown = /ECONNRESET|502|503/i.test(message);
    return new AppError("OBJECTID_TEMPORARY_FAILURE", message, 503, "NETWORK", { retryable: true, submissionUnknown });
  }
  return new AppError("OBJECTID_OPERATION_FAILED", message, 502, "OBJECTID");
}
