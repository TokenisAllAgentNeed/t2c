/**
 * Response utilities and error handler for proxy.
 */
import { type Logger, defaultLogger } from "./types.js";
import { ProxyError } from "./errors.js";

/**
 * Minimal response writer interface.
 */
export interface ResponseWriter {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/**
 * Send a JSON response.
 */
export function sendJsonResponse(
  res: ResponseWriter,
  status: number,
  body?: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body ?? {}));
}

/**
 * Send an error response in OpenAI-compatible format.
 */
export function sendError(
  res: ResponseWriter,
  status: number,
  code: string,
  message: string,
  type?: string,
): void {
  const error: { code: string; message: string; type?: string } = { code, message };
  if (type) error.type = type;
  sendJsonResponse(res, status, { error });
}

/**
 * Handle an error and send appropriate response.
 * Supports ProxyError subclasses and standard Errors.
 */
export function handleError(
  res: ResponseWriter,
  error: unknown,
  logger: Logger = defaultLogger,
): void {
  // Handle ProxyError (and subclasses)
  if (error instanceof ProxyError) {
    logger.error("Proxy error:", error);
    sendJsonResponse(res, error.httpStatus, error.toJSON());
    return;
  }

  // Handle standard Error
  if (error instanceof Error) {
    logger.error("Proxy error:", error);

    // Special case for body too large
    if (error.message === "Request body too large") {
      sendError(res, 413, "payload_too_large", "Request body too large");
      return;
    }

    // Generic internal error
    sendError(res, 500, "proxy_error", "Internal proxy error");
    return;
  }

  // Handle unknown error types
  logger.error("Proxy error:", error);
  sendError(res, 500, "proxy_error", "Internal proxy error");
}
