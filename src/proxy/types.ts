/**
 * Shared type definitions for the proxy module.
 */

/**
 * Logger interface for proxy operations.
 */
export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Default console logger.
 */
export const defaultLogger: Logger = {
  info: (...args) => console.log("[t2c]", ...args),
  warn: (...args) => console.warn("[t2c]", ...args),
  error: (...args) => console.error("[t2c]", ...args),
};

/**
 * Known provider prefixes for model ID transformation.
 * We use `-` as separator in OpenClaw to avoid double-slash issue,
 * but Gate/OpenRouter expects `/` as separator.
 */
export const MODEL_PROVIDER_PREFIXES = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "qwen",
  "moonshotai",
  "mistralai",
  "meta-llama",
  "nvidia",
  "cohere",
  "perplexity",
] as const;

/**
 * Transform model ID from dash format to slash format.
 * e.g., "anthropic-claude-sonnet-4.5" → "anthropic/claude-sonnet-4.5"
 */
export function transformModelId(model: string): string {
  for (const prefix of MODEL_PROVIDER_PREFIXES) {
    if (model.startsWith(`${prefix}-`)) {
      return `${prefix}/${model.slice(prefix.length + 1)}`;
    }
  }
  return model;
}

/**
 * Parse Retry-After header value.
 * Returns milliseconds to wait, or null if invalid.
 */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = parseFloat(value);
  if (!isNaN(seconds) && isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds * 1000));
  }
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }
  return null;
}

/**
 * Result from a proxy request.
 */
export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | string;
}

/**
 * OpenAI chat completion request (minimal).
 */
export interface CompletionRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string | unknown[];
  }>;
  stream?: boolean;
  [key: string]: unknown;
}

/**
 * Model info in OpenAI format.
 */
export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

/**
 * Proxy handle returned by startProxy.
 */
export interface ProxyHandle {
  stop: () => void;
  proxySecret: string;
}

/**
 * Payment result from token selection.
 */
export interface PaymentResult {
  token: string;
  priceSpent: number;
  balanceAfter: number;
}

/**
 * Change/refund received from Gate.
 */
export interface TokenReceiveResult {
  amount: number;
  type: "change" | "refund";
}

/**
 * Proxy request metrics for a single request.
 */
export interface RequestMetrics {
  txId: string;
  model: string;
  priceSat: number;
  changeSat: number;
  refundSat: number;
  gateStatus: number;
  balanceBefore: number;
  balanceAfter: number;
  durationMs: number;
  error?: string;
}

/**
 * Maximum request body size (10 MB).
 */
export const MAX_BODY_SIZE = 10 * 1024 * 1024;

/**
 * Maximum retry delay (30 seconds).
 */
export const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG = {
  maxRetries: 2,
  baseDelayMs: 2000,
  maxDelayMs: MAX_RETRY_DELAY_MS,
} as const;
