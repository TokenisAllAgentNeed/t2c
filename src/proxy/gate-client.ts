/**
 * GateClient - HTTP client for token2chat Gate with retry logic.
 */
import { type Logger, defaultLogger, parseRetryAfter, MAX_RETRY_DELAY_MS } from "./types.js";

export interface GateClientOptions {
  fetchFn?: typeof fetch;
  logger?: Logger;
}

export interface GateRequestOptions {
  path: string;
  body: string;
  token: string;
  gateUrl?: string;
  stream?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface GateResponse {
  status: number;
  body?: string;
  stream?: ReadableStream<Uint8Array>;
  contentType?: string;
  changeToken?: string;
  refundToken?: string;
  retriesExhausted?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GateClient {
  private readonly gateUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly logger: Logger;

  constructor(gateUrl: string, options: GateClientOptions = {}) {
    this.gateUrl = gateUrl;
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger ?? defaultLogger;
  }

  async request(options: GateRequestOptions): Promise<GateResponse> {
    const {
      path,
      body,
      token,
      gateUrl = this.gateUrl,
      stream = false,
      maxRetries = 0,
      baseDelayMs = 2000,
      maxDelayMs = MAX_RETRY_DELAY_MS,
    } = options;

    const url = `${gateUrl}${path}`;
    let lastResponse: Response | null = null;
    let lastBody: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.fetchFn(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Cashu": token,
          },
          body,
        });

        // Extract change/refund tokens
        const changeToken = res.headers.get("X-Cashu-Change") ?? undefined;
        const refundToken = res.headers.get("X-Cashu-Refund") ?? undefined;
        const contentType = res.headers.get("content-type") ?? undefined;

        // If not 429, return immediately
        if (res.status !== 429) {
          if (stream && res.body) {
            return {
              status: res.status,
              stream: res.body,
              contentType,
              changeToken,
              refundToken,
            };
          }

          return {
            status: res.status,
            body: await res.text(),
            contentType,
            changeToken,
            refundToken,
          };
        }

        // Store for potential return after retries exhausted
        lastResponse = res;
        lastBody = await res.text();

        // Log and wait before retry
        if (attempt < maxRetries) {
          const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
          const backoffMs = Math.min(
            retryAfterMs ?? baseDelayMs * Math.pow(2, attempt),
            maxDelayMs,
          );
          this.logger.warn(`Rate limited (429), retrying in ${backoffMs}ms...`);
          await sleep(backoffMs);
        }
      } catch (e) {
        this.logger.error("Gate request failed:", e);
        throw e;
      }
    }

    // All retries exhausted
    return {
      status: lastResponse!.status,
      body: lastBody,
      contentType: lastResponse!.headers.get("content-type") ?? undefined,
      changeToken: lastResponse!.headers.get("X-Cashu-Change") ?? undefined,
      refundToken: lastResponse!.headers.get("X-Cashu-Refund") ?? undefined,
      retriesExhausted: true,
    };
  }
}
