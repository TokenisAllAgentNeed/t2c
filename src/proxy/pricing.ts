/**
 * PricingCache - Caches model pricing from Gate with TTL.
 */
import { transformModelId } from "./types.js";

export interface PricingCacheOptions {
  ttlMs?: number;
  fetchFn?: typeof fetch;
}

interface GatePricingRule {
  mode: "per_token" | "per_request";
  /** per_request mode */
  per_request?: number;
  /** per_token mode */
  input_per_million?: number;
  output_per_million?: number;
}

interface GatePricingResponse {
  models: Record<string, GatePricingRule>;
}

// Token estimation constants (must match Gate)
const CHARS_PER_TOKEN = 4;
const TOKEN_OVERHEAD_FACTOR = 1.1;
const MIN_TOKEN_ESTIMATE = 100;
const IMAGE_TOKEN_ESTIMATE = 800;
const DEFAULT_MAX_TOKENS = 4096;

const DEFAULT_TTL_MS = 5 * 60_000; // 5 minutes
const DEFAULT_PRICE = 500; // units

export class PricingCache {
  private cache: Record<string, GatePricingRule> | null = null;
  private fetchedAt = 0;
  private fetchPromise: Promise<Record<string, GatePricingRule>> | null = null;

  private readonly gateUrl: string;
  private readonly ttlMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(gateUrl: string, options: PricingCacheOptions = {}) {
    this.gateUrl = gateUrl;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /**
   * Get cached pricing, refreshing if stale.
   */
  async get(): Promise<Record<string, GatePricingRule>> {
    const now = Date.now();
    if (this.cache && now - this.fetchedAt < this.ttlMs) {
      return this.cache;
    }

    // Deduplicate concurrent fetches
    if (this.fetchPromise) {
      return this.fetchPromise;
    }

    this.fetchPromise = this.doFetch();
    try {
      return await this.fetchPromise;
    } finally {
      this.fetchPromise = null;
    }
  }

  /**
   * Force refresh pricing from gate.
   */
  async refresh(): Promise<void> {
    this.fetchPromise = null;
    await this.doFetch();
  }

  /**
   * Clear cache, forcing next get() to refetch.
   */
  invalidate(): void {
    this.cache = null;
    this.fetchedAt = 0;
    this.fetchPromise = null;
  }

  /**
   * Get price for a model. Uses wildcard "*" or default if not found.
   * Simple fallback — returns per_request price or DEFAULT_PRICE.
   */
  getPrice(model: string, defaultPrice = DEFAULT_PRICE): number {
    if (!this.cache) {
      return defaultPrice;
    }
    // Try exact match, then slash format (dash→slash), then wildcard
    const rule = this.cache[model] ?? this.cache[transformModelId(model)] ?? this.cache["*"];
    if (!rule) return defaultPrice;
    if (rule.mode === "per_request" && rule.per_request != null) {
      return rule.per_request;
    }
    return defaultPrice;
  }

  /**
   * Estimate price for a model based on request body.
   * For per_token: estimates input tokens from messages + max_tokens for output.
   * For per_request: returns the fixed price.
   * Returns at least 1.
   */
  estimatePrice(model: string, body: { messages?: any[]; max_tokens?: number }): number {
    if (!this.cache) {
      return DEFAULT_PRICE;
    }
    // Try exact match, then slash format (dash→slash), then wildcard
    const rule = this.cache[model] ?? this.cache[transformModelId(model)] ?? this.cache["*"];
    if (!rule) return DEFAULT_PRICE;

    if (rule.mode === "per_request" && rule.per_request != null) {
      return Math.max(1, rule.per_request);
    }

    if (rule.mode === "per_token" && rule.input_per_million != null && rule.output_per_million != null) {
      const inputTokens = this.estimateInputTokens(body.messages);
      const outputTokens = body.max_tokens ?? DEFAULT_MAX_TOKENS;

      const cost = Math.ceil(
        (inputTokens * rule.input_per_million + outputTokens * rule.output_per_million) / 1_000_000
      );
      return Math.max(1, cost);
    }

    return DEFAULT_PRICE;
  }

  /**
   * Get list of available models (excludes wildcard).
   */
  getModels(): string[] {
    if (!this.cache) {
      return [];
    }
    return Object.keys(this.cache).filter((m) => m !== "*");
  }

  private estimateInputTokens(messages?: any[]): number {
    if (!messages || messages.length === 0) {
      return MIN_TOKEN_ESTIMATE;
    }

    let charCount = 0;
    let imageCount = 0;

    for (const msg of messages) {
      if (typeof msg.content === "string") {
        charCount += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text" && typeof part.text === "string") {
            charCount += part.text.length;
          } else if (part.type === "image_url" || part.type === "image") {
            imageCount++;
          }
        }
      }
    }

    const textTokens = Math.ceil((charCount / CHARS_PER_TOKEN) * TOKEN_OVERHEAD_FACTOR);
    const totalTokens = textTokens + imageCount * IMAGE_TOKEN_ESTIMATE;
    return Math.max(MIN_TOKEN_ESTIMATE, totalTokens);
  }

  private async doFetch(): Promise<Record<string, GatePricingRule>> {
    try {
      const res = await this.fetchFn(`${this.gateUrl}/v1/pricing`);
      if (!res.ok) {
        return this.cache ?? {};
      }

      const data = (await res.json()) as GatePricingResponse;
      const rules: Record<string, GatePricingRule> = {};

      for (const [model, rule] of Object.entries(data.models)) {
        rules[model] = rule;
      }

      this.cache = rules;
      this.fetchedAt = Date.now();
      return rules;
    } catch {
      return this.cache ?? {};
    }
  }
}
