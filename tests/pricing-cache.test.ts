/**
 * Unit tests for PricingCache class.
 * Tests caching, TTL, fetching, price lookup, and token estimation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PricingCache } from "../src/proxy/pricing.js";

describe("PricingCache", () => {
  const mockFetch = vi.fn();
  const gateUrl = "https://gate.example.com";

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createCache(ttlMs?: number) {
    return new PricingCache(gateUrl, { ttlMs, fetchFn: mockFetch });
  }

  /** Helper: mock Gate response with per_token models */
  function mockPerTokenResponse(models: Record<string, { input_per_million: number; output_per_million: number }>) {
    const mapped: Record<string, any> = {};
    for (const [k, v] of Object.entries(models)) {
      mapped[k] = { mode: "per_token", ...v };
    }
    return {
      ok: true,
      json: async () => ({ models: mapped }),
    };
  }

  /** Helper: mock Gate response with per_request models */
  function mockPerRequestResponse(models: Record<string, number>) {
    const mapped: Record<string, any> = {};
    for (const [k, v] of Object.entries(models)) {
      mapped[k] = { mode: "per_request", per_request: v };
    }
    return {
      ok: true,
      json: async () => ({ models: mapped }),
    };
  }

  describe("fetch", () => {
    it("fetches pricing from gate URL", async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerTokenResponse({
          "gpt-4o": { input_per_million: 250000, output_per_million: 1000000 },
          "claude-3": { input_per_million: 300000, output_per_million: 1500000 },
        })
      );

      const cache = createCache();
      await cache.refresh();

      expect(mockFetch).toHaveBeenCalledWith(`${gateUrl}/v1/pricing`);
    });

    it("stores per_token pricing from response", async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerTokenResponse({
          "gpt-4o": { input_per_million: 15000, output_per_million: 60000 },
        })
      );

      const cache = createCache();
      await cache.refresh();

      // estimatePrice should use the stored per_token pricing (not DEFAULT_PRICE)
      const price = cache.estimatePrice("gpt-4o", { messages: [{ role: "user", content: "hi" }], max_tokens: 100 });
      expect(price).toBeGreaterThan(0);
      expect(price).not.toBe(500); // should not be DEFAULT_PRICE
    });

    it("stores per_request pricing from response", async () => {
      mockFetch.mockResolvedValueOnce(mockPerRequestResponse({ "gpt-4o": 100 }));

      const cache = createCache();
      await cache.refresh();

      expect(cache.estimatePrice("gpt-4o", {})).toBe(100);
      expect(cache.getPrice("gpt-4o")).toBe(100);
    });

    it("returns empty record on fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const cache = createCache();
      const prices = await cache.get();

      expect(prices).toEqual({});
    });

    it("returns empty record on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const cache = createCache();
      const prices = await cache.get();

      expect(prices).toEqual({});
    });
  });

  describe("caching", () => {
    it("does not refetch within TTL", async () => {
      mockFetch.mockResolvedValue(
        mockPerTokenResponse({ "model-a": { input_per_million: 50000, output_per_million: 200000 } })
      );

      const cache = createCache(60_000); // 60s TTL
      await cache.get();
      await cache.get();
      await cache.get();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("refetches after TTL expires", async () => {
      mockFetch.mockResolvedValue(
        mockPerTokenResponse({ "model-a": { input_per_million: 50000, output_per_million: 200000 } })
      );

      const cache = createCache(60_000);
      await cache.get();

      // Advance time past TTL
      vi.advanceTimersByTime(61_000);

      await cache.get();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("uses default 5 minute TTL", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: {} }),
      });

      const cache = new PricingCache(gateUrl, { fetchFn: mockFetch });
      await cache.get();

      // Should not refetch at 4 minutes
      vi.advanceTimersByTime(4 * 60_000);
      await cache.get();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Should refetch at 5+ minutes
      vi.advanceTimersByTime(2 * 60_000);
      await cache.get();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("getPrice", () => {
    it("returns per_request price for exact match", async () => {
      mockFetch.mockResolvedValueOnce(mockPerRequestResponse({ "gpt-4o": 100 }));

      const cache = createCache();
      await cache.refresh();

      expect(cache.getPrice("gpt-4o")).toBe(100);
    });

    it("returns wildcard per_request price for unknown model", async () => {
      mockFetch.mockResolvedValueOnce(mockPerRequestResponse({ "gpt-4o": 100, "*": 300 }));

      const cache = createCache();
      await cache.refresh();

      expect(cache.getPrice("unknown-model")).toBe(300);
    });

    it("returns default 500 for per_token models (getPrice is simple fallback)", async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerTokenResponse({ "gpt-4o": { input_per_million: 15000, output_per_million: 60000 } })
      );

      const cache = createCache();
      await cache.refresh();

      // getPrice doesn't know about per_token, returns default
      expect(cache.getPrice("gpt-4o")).toBe(500);
    });

    it("returns default 500 when no wildcard and unknown model", async () => {
      mockFetch.mockResolvedValueOnce(mockPerRequestResponse({ "gpt-4o": 100 }));

      const cache = createCache();
      await cache.refresh();

      expect(cache.getPrice("unknown-model")).toBe(500);
    });

    it("returns default 500 when cache is empty", () => {
      const cache = createCache();
      expect(cache.getPrice("any-model")).toBe(500);
    });

    it("accepts custom default price", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: {} }),
      });

      const cache = createCache();
      await cache.refresh();

      expect(cache.getPrice("unknown", 250)).toBe(250);
    });
  });

  describe("estimatePrice", () => {
    it("estimates per_token pricing for Opus short message (~31K+ units)", async () => {
      // Opus: input 1,500,000 / output 7,500,000 per million tokens
      mockFetch.mockResolvedValueOnce(
        mockPerTokenResponse({
          "anthropic/claude-opus-4-20250514": { input_per_million: 1500000, output_per_million: 7500000 },
        })
      );

      const cache = createCache();
      await cache.refresh();

      const price = cache.estimatePrice("anthropic/claude-opus-4-20250514", {
        messages: [{ role: "user", content: "Hello, world!" }],
        max_tokens: 4096,
      });

      // input: "Hello, world!" = 13 chars → ceil(13/4 * 1.1) = ceil(3.575) = 4 tokens, min 100 → 100
      // output: 4096 tokens
      // cost = ceil((100 * 1500000 + 4096 * 7500000) / 1000000) = ceil(150 + 30720) = 30870
      expect(price).toBeGreaterThanOrEqual(30000);
      expect(price).not.toBe(500); // definitely not the default
    });

    it("matches dash-format model IDs to slash-format cache keys", async () => {
      // Gate returns slash format, OpenClaw sends dash format
      mockFetch.mockResolvedValueOnce(
        mockPerTokenResponse({
          "anthropic/claude-opus-4-20250514": { input_per_million: 1500000, output_per_million: 7500000 },
          "*": { input_per_million: 100000, output_per_million: 500000 },
        })
      );

      const cache = createCache();
      await cache.refresh();

      // Request with dash format (as OpenClaw sends)
      const price = cache.estimatePrice("anthropic-claude-opus-4-20250514", {
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 4096,
      });

      // Should use Opus pricing (1.5M/7.5M), NOT wildcard (100K/500K)
      expect(price).toBeGreaterThanOrEqual(30000);

      // Wildcard would give ~2148 units
      expect(price).toBeGreaterThan(5000);
    });

    it("returns fixed price for per_request pricing", async () => {
      mockFetch.mockResolvedValueOnce(mockPerRequestResponse({ "fixed-model": 42 }));

      const cache = createCache();
      await cache.refresh();

      const price = cache.estimatePrice("fixed-model", {
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 1000,
      });

      expect(price).toBe(42);
    });

    it("uses MIN_TOKEN_ESTIMATE when no messages provided", async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerTokenResponse({
          "model-a": { input_per_million: 100000, output_per_million: 500000 },
        })
      );

      const cache = createCache();
      await cache.refresh();

      const price = cache.estimatePrice("model-a", {});

      // input: MIN_TOKEN_ESTIMATE=100, output: DEFAULT_MAX_TOKENS=4096
      // cost = ceil((100 * 100000 + 4096 * 500000) / 1000000) = ceil(10 + 2048) = 2058
      expect(price).toBe(2058);
    });

    it("uses MIN_TOKEN_ESTIMATE when messages array is empty", async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerTokenResponse({
          "model-a": { input_per_million: 100000, output_per_million: 500000 },
        })
      );

      const cache = createCache();
      await cache.refresh();

      const priceNoMsg = cache.estimatePrice("model-a", { messages: [] });
      const priceUndef = cache.estimatePrice("model-a", {});

      expect(priceNoMsg).toBe(priceUndef);
    });

    it("accounts for images in messages", async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerTokenResponse({
          "model-a": { input_per_million: 100000, output_per_million: 500000 },
        })
      );

      const cache = createCache();
      await cache.refresh();

      const priceWithImage = cache.estimatePrice("model-a", {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: "data:..." } },
            ],
          },
        ],
        max_tokens: 1000,
      });

      const priceWithoutImage = cache.estimatePrice("model-a", {
        messages: [{ role: "user", content: "What is this?" }],
        max_tokens: 1000,
      });

      // Image adds IMAGE_TOKEN_ESTIMATE=800 tokens worth of input
      expect(priceWithImage).toBeGreaterThan(priceWithoutImage);
    });

    it("falls back to wildcard for unknown model", async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerTokenResponse({
          "known-model": { input_per_million: 15000, output_per_million: 60000 },
          "*": { input_per_million: 100000, output_per_million: 500000 },
        })
      );

      const cache = createCache();
      await cache.refresh();

      const price = cache.estimatePrice("unknown-model", {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
      });

      // Should use wildcard pricing, not DEFAULT_PRICE
      // input: min 100 tokens, output: 100 tokens
      // cost = ceil((100 * 100000 + 100 * 500000) / 1000000) = ceil(10 + 50) = 60
      expect(price).toBe(60);
    });

    it("falls back to DEFAULT_PRICE when cache is empty", () => {
      const cache = createCache();
      const price = cache.estimatePrice("any-model", {
        messages: [{ role: "user", content: "hi" }],
      });
      expect(price).toBe(500);
    });

    it("returns at least 1", async () => {
      // Very cheap model with tiny request
      mockFetch.mockResolvedValueOnce(
        mockPerTokenResponse({
          "cheap-model": { input_per_million: 1, output_per_million: 1 },
        })
      );

      const cache = createCache();
      await cache.refresh();

      const price = cache.estimatePrice("cheap-model", {
        messages: [{ role: "user", content: "x" }],
        max_tokens: 1,
      });

      expect(price).toBeGreaterThanOrEqual(1);
    });
  });

  describe("invalidate", () => {
    it("clears cache and forces refetch", async () => {
      mockFetch.mockResolvedValue(
        mockPerTokenResponse({ "model-a": { input_per_million: 50000, output_per_million: 200000 } })
      );

      const cache = createCache(60_000);
      await cache.get();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      cache.invalidate();
      await cache.get();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("getPrice returns default after invalidate", async () => {
      mockFetch.mockResolvedValueOnce(mockPerRequestResponse({ "model-a": 50 }));

      const cache = createCache();
      await cache.refresh();
      expect(cache.getPrice("model-a")).toBe(50);

      cache.invalidate();
      expect(cache.getPrice("model-a")).toBe(500);
    });

    it("estimatePrice returns DEFAULT_PRICE after invalidate", async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerTokenResponse({ "model-a": { input_per_million: 100000, output_per_million: 500000 } })
      );

      const cache = createCache();
      await cache.refresh();

      cache.invalidate();
      expect(cache.estimatePrice("model-a", { messages: [{ role: "user", content: "hi" }] })).toBe(500);
    });
  });

  describe("models list", () => {
    it("returns list of available models", async () => {
      mockFetch.mockResolvedValueOnce(
        mockPerTokenResponse({
          "gpt-4o": { input_per_million: 250000, output_per_million: 1000000 },
          "claude-3": { input_per_million: 300000, output_per_million: 1500000 },
          "*": { input_per_million: 100000, output_per_million: 500000 },
        })
      );

      const cache = createCache();
      await cache.refresh();

      const models = cache.getModels();
      expect(models).toContain("gpt-4o");
      expect(models).toContain("claude-3");
      // Wildcard should not be included in models list
      expect(models).not.toContain("*");
    });

    it("returns empty array when cache is empty", () => {
      const cache = createCache();
      expect(cache.getModels()).toEqual([]);
    });
  });

  describe("concurrent requests", () => {
    it("deduplicates concurrent fetches", async () => {
      let resolvePromise: (value: unknown) => void;
      const delayedResponse = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      mockFetch.mockReturnValueOnce(
        delayedResponse.then(() =>
          mockPerTokenResponse({ "model-a": { input_per_million: 50000, output_per_million: 200000 } })
        )
      );

      const cache = createCache();

      // Start multiple concurrent gets
      const p1 = cache.get();
      const p2 = cache.get();
      const p3 = cache.get();

      // Resolve the fetch
      resolvePromise!(undefined);

      await Promise.all([p1, p2, p3]);

      // Should only have fetched once
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("backward compatibility (per_request format)", () => {
    it("handles mixed per_token and per_request models", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: {
            "per-token-model": { mode: "per_token", input_per_million: 100000, output_per_million: 500000 },
            "per-request-model": { mode: "per_request", per_request: 200 },
          },
        }),
      });

      const cache = createCache();
      await cache.refresh();

      // per_request model returns fixed price
      expect(cache.estimatePrice("per-request-model", { messages: [{ role: "user", content: "hi" }] })).toBe(200);

      // per_token model estimates from body
      const tokenPrice = cache.estimatePrice("per-token-model", {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
      });
      expect(tokenPrice).toBeGreaterThan(0);
      expect(tokenPrice).not.toBe(500);
    });
  });
});
