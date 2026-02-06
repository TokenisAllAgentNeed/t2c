/**
 * Unit tests for PricingCache class.
 * Tests caching, TTL, fetching, and price lookup.
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

  describe("fetch", () => {
    it("fetches pricing from gate URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: {
            "gpt-4o": { per_request: 100 },
            "claude-3": { per_request: 200 },
          },
        }),
      });

      const cache = createCache();
      await cache.refresh();

      expect(mockFetch).toHaveBeenCalledWith(`${gateUrl}/v1/pricing`);
    });

    it("extracts per_request prices from response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: {
            "gpt-4o": { per_request: 100 },
            "claude-3": { per_request: 200 },
          },
        }),
      });

      const cache = createCache();
      await cache.refresh();

      expect(cache.getPrice("gpt-4o")).toBe(100);
      expect(cache.getPrice("claude-3")).toBe(200);
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
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: { "model-a": { per_request: 50 } } }),
      });

      const cache = createCache(60_000); // 60s TTL
      await cache.get();
      await cache.get();
      await cache.get();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("refetches after TTL expires", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: { "model-a": { per_request: 50 } } }),
      });

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
    it("returns exact match price", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: { "gpt-4o": { per_request: 100 } },
        }),
      });

      const cache = createCache();
      await cache.refresh();

      expect(cache.getPrice("gpt-4o")).toBe(100);
    });

    it("returns wildcard price for unknown model", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: {
            "gpt-4o": { per_request: 100 },
            "*": { per_request: 300 },
          },
        }),
      });

      const cache = createCache();
      await cache.refresh();

      expect(cache.getPrice("unknown-model")).toBe(300);
    });

    it("returns default 500 when no wildcard and unknown model", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: { "gpt-4o": { per_request: 100 } },
        }),
      });

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

  describe("invalidate", () => {
    it("clears cache and forces refetch", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: { "model-a": { per_request: 50 } } }),
      });

      const cache = createCache(60_000);
      await cache.get();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      cache.invalidate();
      await cache.get();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("getPrice returns default after invalidate", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: { "model-a": { per_request: 50 } } }),
      });

      const cache = createCache();
      await cache.refresh();
      expect(cache.getPrice("model-a")).toBe(50);

      cache.invalidate();
      expect(cache.getPrice("model-a")).toBe(500);
    });
  });

  describe("models list", () => {
    it("returns list of available models", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: {
            "gpt-4o": { per_request: 100 },
            "claude-3": { per_request: 200 },
            "*": { per_request: 500 },
          },
        }),
      });

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
        delayedResponse.then(() => ({
          ok: true,
          json: async () => ({ models: { "model-a": { per_request: 50 } } }),
        }))
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
});
