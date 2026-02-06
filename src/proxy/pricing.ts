/**
 * PricingCache - Caches model pricing from Gate with TTL.
 */

export interface PricingCacheOptions {
  ttlMs?: number;
  fetchFn?: typeof fetch;
}

interface GatePricingResponse {
  models: Record<string, { per_request: number }>;
}

const DEFAULT_TTL_MS = 5 * 60_000; // 5 minutes
const DEFAULT_PRICE = 500; // units

export class PricingCache {
  private cache: Record<string, number> | null = null;
  private fetchedAt = 0;
  private fetchPromise: Promise<Record<string, number>> | null = null;

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
  async get(): Promise<Record<string, number>> {
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
   */
  getPrice(model: string, defaultPrice = DEFAULT_PRICE): number {
    if (!this.cache) {
      return defaultPrice;
    }
    return this.cache[model] ?? this.cache["*"] ?? defaultPrice;
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

  private async doFetch(): Promise<Record<string, number>> {
    try {
      const res = await this.fetchFn(`${this.gateUrl}/v1/pricing`);
      if (!res.ok) {
        return this.cache ?? {};
      }

      const data = (await res.json()) as GatePricingResponse;
      const prices: Record<string, number> = {};

      for (const [model, rule] of Object.entries(data.models)) {
        prices[model] = rule.per_request;
      }

      this.cache = prices;
      this.fetchedAt = Date.now();
      return prices;
    } catch {
      return this.cache ?? {};
    }
  }
}
