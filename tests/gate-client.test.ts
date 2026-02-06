/**
 * Unit tests for GateClient class.
 * Tests request handling, retry logic, change/refund processing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GateClient, type GateRequestOptions, type GateResponse } from "../src/proxy/gate-client.js";

describe("GateClient", () => {
  const mockFetch = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createClient(gateUrl = "https://gate.example.com") {
    return new GateClient(gateUrl, {
      fetchFn: mockFetch,
      logger: mockLogger,
    });
  }

  describe("request", () => {
    it("sends POST request with X-Cashu header", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => '{"choices":[]}',
        body: null,
      });

      const client = createClient();
      await client.request({
        path: "/v1/chat/completions",
        body: '{"model":"gpt-4"}',
        token: "cashuAtoken123",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://gate.example.com/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "X-Cashu": "cashuAtoken123",
          }),
          body: '{"model":"gpt-4"}',
        })
      );
    });

    it("returns response with status and body", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => '{"id":"resp-1","choices":[]}',
        body: null,
      });

      const client = createClient();
      const result = await client.request({
        path: "/v1/chat/completions",
        body: "{}",
        token: "token",
      });

      expect(result.status).toBe(200);
      expect(result.body).toBe('{"id":"resp-1","choices":[]}');
    });

    it("extracts change token from X-Cashu-Change header", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers({
          "content-type": "application/json",
          "X-Cashu-Change": "cashuAchange456",
        }),
        text: async () => "{}",
        body: null,
      });

      const client = createClient();
      const result = await client.request({
        path: "/v1/chat/completions",
        body: "{}",
        token: "token",
      });

      expect(result.changeToken).toBe("cashuAchange456");
    });

    it("extracts refund token from X-Cashu-Refund header", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers({
          "content-type": "application/json",
          "X-Cashu-Refund": "cashuArefund789",
        }),
        text: async () => "{}",
        body: null,
      });

      const client = createClient();
      const result = await client.request({
        path: "/v1/chat/completions",
        body: "{}",
        token: "token",
      });

      expect(result.refundToken).toBe("cashuArefund789");
    });

    it("returns both change and refund tokens when present", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers({
          "X-Cashu-Change": "change-token",
          "X-Cashu-Refund": "refund-token",
        }),
        text: async () => "{}",
        body: null,
      });

      const client = createClient();
      const result = await client.request({
        path: "/v1/chat/completions",
        body: "{}",
        token: "token",
      });

      expect(result.changeToken).toBe("change-token");
      expect(result.refundToken).toBe("refund-token");
    });
  });

  describe("retry logic", () => {
    it("retries on 429 with exponential backoff", async () => {
      mockFetch
        .mockResolvedValueOnce({
          status: 429,
          headers: new Headers(),
          text: async () => '{"error":"rate limited"}',
          body: null,
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: new Headers(),
          text: async () => '{"ok":true}',
          body: null,
        });

      const client = createClient();
      const requestPromise = client.request({
        path: "/v1/chat/completions",
        body: "{}",
        token: "token",
        maxRetries: 2,
      });

      // First call happens immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Wait for retry delay (default 2000ms base)
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const result = await requestPromise;
      expect(result.status).toBe(200);
    });

    it("respects Retry-After header in seconds", async () => {
      mockFetch
        .mockResolvedValueOnce({
          status: 429,
          headers: new Headers({ "Retry-After": "5" }),
          text: async () => "{}",
          body: null,
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: new Headers(),
          text: async () => "{}",
          body: null,
        });

      const client = createClient();
      const requestPromise = client.request({
        path: "/v1/chat/completions",
        body: "{}",
        token: "token",
        maxRetries: 1,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Should wait 5 seconds as per Retry-After
      await vi.advanceTimersByTimeAsync(4999);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      await requestPromise;
    });

    it("caps retry delay at maxDelayMs", async () => {
      mockFetch
        .mockResolvedValueOnce({
          status: 429,
          headers: new Headers({ "Retry-After": "120" }), // 2 minutes
          text: async () => "{}",
          body: null,
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: new Headers(),
          text: async () => "{}",
          body: null,
        });

      const client = createClient();
      const requestPromise = client.request({
        path: "/v1/chat/completions",
        body: "{}",
        token: "token",
        maxRetries: 1,
        maxDelayMs: 10_000, // Cap at 10 seconds
      });

      await vi.advanceTimersByTimeAsync(0);

      // Should be capped at 10 seconds, not 120
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      await requestPromise;
    });

    it("returns last 429 response after max retries exhausted", async () => {
      mockFetch.mockResolvedValue({
        status: 429,
        headers: new Headers(),
        text: async () => '{"error":"still rate limited"}',
        body: null,
      });

      const client = createClient();
      const requestPromise = client.request({
        path: "/v1/chat/completions",
        body: "{}",
        token: "token",
        maxRetries: 2,
        baseDelayMs: 100,
      });

      // Initial + 2 retries = 3 calls total
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100); // retry 1
      await vi.advanceTimersByTimeAsync(200); // retry 2

      const result = await requestPromise;
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(result.status).toBe(429);
      expect(result.retriesExhausted).toBe(true);
    });

    it("does not retry on non-429 errors", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 500,
        headers: new Headers(),
        text: async () => '{"error":"server error"}',
        body: null,
      });

      const client = createClient();
      const result = await client.request({
        path: "/v1/chat/completions",
        body: "{}",
        token: "token",
        maxRetries: 2,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(500);
    });

    it("logs retry attempts", async () => {
      mockFetch
        .mockResolvedValueOnce({
          status: 429,
          headers: new Headers(),
          text: async () => "{}",
          body: null,
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: new Headers(),
          text: async () => "{}",
          body: null,
        });

      const client = createClient();
      const requestPromise = client.request({
        path: "/v1/chat/completions",
        body: "{}",
        token: "token",
        maxRetries: 1,
        baseDelayMs: 100,
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      await requestPromise;

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("429")
      );
    });
  });

  describe("streaming", () => {
    it("returns stream when response has body", async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: chunk1\n"));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        text: async () => "",
        body: mockStream,
      });

      const client = createClient();
      const result = await client.request({
        path: "/v1/chat/completions",
        body: '{"stream":true}',
        token: "token",
        stream: true,
      });

      expect(result.status).toBe(200);
      expect(result.stream).toBeDefined();
    });

    it("does not return stream for non-streaming request", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        text: async () => '{"result":"ok"}',
        body: null,
      });

      const client = createClient();
      const result = await client.request({
        path: "/v1/chat/completions",
        body: "{}",
        token: "token",
        stream: false,
      });

      expect(result.stream).toBeUndefined();
      expect(result.body).toBe('{"result":"ok"}');
    });
  });

  describe("gate URL handling", () => {
    it("uses provided gateUrl for requests", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        text: async () => "{}",
        body: null,
      });

      const client = createClient("https://custom-gate.io");
      await client.request({
        path: "/v1/chat/completions",
        body: "{}",
        token: "token",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://custom-gate.io/v1/chat/completions",
        expect.anything()
      );
    });

    it("allows overriding gate URL per request", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        text: async () => "{}",
        body: null,
      });

      const client = createClient("https://default-gate.com");
      await client.request({
        path: "/v1/chat/completions",
        body: "{}",
        token: "token",
        gateUrl: "https://override-gate.com",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://override-gate.com/v1/chat/completions",
        expect.anything()
      );
    });
  });

  describe("error handling", () => {
    it("throws on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const client = createClient();
      await expect(
        client.request({
          path: "/v1/chat/completions",
          body: "{}",
          token: "token",
        })
      ).rejects.toThrow("Network error");
    });

    it("logs network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const client = createClient();
      await expect(
        client.request({
          path: "/v1/chat/completions",
          body: "{}",
          token: "token",
        })
      ).rejects.toThrow();

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
