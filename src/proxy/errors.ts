/**
 * Proxy error classes with OpenAI-compatible JSON serialization.
 */

export interface ProxyErrorJSON {
  error: {
    code: string;
    message: string;
    type?: string;
  };
}

/**
 * Base error class for proxy errors.
 * Serializes to OpenAI-compatible error format.
 */
export class ProxyError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly type?: string;

  constructor(
    code: string,
    message: string,
    httpStatus = 500,
    type?: string,
  ) {
    super(message);
    this.name = "ProxyError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.type = type;
  }

  toJSON(): ProxyErrorJSON {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.type && { type: this.type }),
      },
    };
  }
}

/**
 * Thrown when wallet balance is insufficient for the requested model.
 */
export class InsufficientBalanceError extends ProxyError {
  readonly balance: number;
  readonly required: number;
  readonly model: string;

  constructor(balance: number, required: number, model: string) {
    super(
      "insufficient_balance",
      `Wallet balance ${balance} < ${required} required for ${model}. Run 't2c mint' to add funds.`,
      402,
      "insufficient_funds",
    );
    this.name = "InsufficientBalanceError";
    this.balance = balance;
    this.required = required;
    this.model = model;
  }
}

/**
 * Thrown when the Gate is unreachable.
 */
export class GateUnreachableError extends ProxyError {
  readonly gateUrl: string;

  constructor(gateUrl: string, cause?: Error) {
    const host = new URL(gateUrl).host;
    super(
      "gate_unreachable",
      `Gate at ${host} is unreachable`,
      502,
    );
    this.name = "GateUnreachableError";
    this.gateUrl = gateUrl;
    if (cause) {
      this.cause = cause;
    }
  }
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

/**
 * Thrown when request body exceeds size limit.
 */
export class PayloadTooLargeError extends ProxyError {
  readonly size: number;
  readonly limit: number;

  constructor(size: number, limit: number) {
    super(
      "payload_too_large",
      `Request body ${formatBytes(size)} exceeds limit of ${formatBytes(limit)}`,
      413,
    );
    this.name = "PayloadTooLargeError";
    this.size = size;
    this.limit = limit;
  }
}

/**
 * Thrown when authentication fails.
 */
export class UnauthorizedError extends ProxyError {
  constructor(message = "Unauthorized. Provide a valid Bearer token.") {
    super("unauthorized", message, 401, "authentication_error");
    this.name = "UnauthorizedError";
  }
}

/**
 * Thrown when endpoint is not found.
 */
export class NotFoundError extends ProxyError {
  readonly path: string;

  constructor(path: string) {
    super(
      "not_found",
      `Endpoint not found: ${path}`,
      404,
    );
    this.name = "NotFoundError";
    this.path = path;
  }
}
