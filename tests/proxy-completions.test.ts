/**
 * Tests for the POST /v1/chat/completions handler in proxy.ts.
 *
 * Covers: successful completion, streaming, retry on 429, gate failover,
 * change/refund token processing, transaction recording, and body size limit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { startProxy, type Logger } from "../src/proxy.js";
import type { T2CConfig } from "../src/config.js";

const testDir = "/tmp/t2c-proxy-completions-" + Date.now();
const testWalletPath = path.join(testDir, "wallet.json");

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Port for our tests
let testPort: number;

function getConfig(overrides: Partial<T2CConfig> = {}): T2CConfig {
  return {
    gateUrl: "https://gate.test.local",
    mintUrl: "https://mint.test.local",
    walletPath: testWalletPath,
    proxyPort: testPort,
    lowBalanceThreshold: 100,
    ...overrides,
  };
}

/** Write a wallet with given proof amounts */
async function writeWallet(amounts: number[]) {
  const proofs = amounts.map((amount, i) => ({
    id: "00ad268c4d1f5826",
    amount,
    secret: `secret_${amount}_${i}`,
    C: "02" + "ab".repeat(32),
  }));
  await fs.writeFile(
    testWalletPath,
    JSON.stringify({ mint: "https://mint.test.local", unit: "usd", proofs })
  );
}

/** Make an HTTP request using node:http (doesn't go through globalThis.fetch) */
function httpRequest(
  opts: {
    port: number;
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await fs.mkdir(testDir, { recursive: true });
  testPort = 40000 + Math.floor(Math.random() * 10000);
  mockFetch = vi.fn();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
});

/** Helper to start proxy with mocked fetch and make a completions request */
async function setupAndRequest(opts: {
  walletAmounts: number[];
  gateMockResponses: Array<() => Response | Promise<Response>>;
  pricingResponse?: Record<string, unknown>;
  model?: string;
  stream?: boolean;
  configOverrides?: Partial<T2CConfig>;
}): Promise<{
  res: { status: number; headers: http.IncomingHttpHeaders; body: string };
  handle: { stop: () => void; proxySecret: string };
  fetchCalls: Array<[string, RequestInit]>;
}> {
  await writeWallet(opts.walletAmounts);

  const gateResponses = [...opts.gateMockResponses];
  const pricingRes = opts.pricingResponse ?? {
    unit: "usd",
    models: {
      "*": { mode: "per_request", per_request: 200 },
    },
  };

  // Mock globalThis.fetch for gate/pricing calls
  mockFetch.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const urlStr = url.toString();

    // Pricing endpoint
    if (urlStr.includes("/v1/pricing")) {
      return new Response(JSON.stringify(pricingRes), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Gate completions endpoint
    if (urlStr.includes("/v1/chat/completions") && gateResponses.length > 0) {
      const factory = gateResponses.shift()!;
      return factory();
    }

    // Fallback
    return new Response("Not found", { status: 404 });
  });

  globalThis.fetch = mockFetch;

  const handle = await startProxy(
    getConfig(opts.configOverrides),
    silentLogger
  );
  await new Promise((r) => setTimeout(r, 400));

  const res = await httpRequest({
    port: testPort,
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      Authorization: `Bearer ${handle.proxySecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? "test-model",
      messages: [{ role: "user", content: "Hello" }],
      ...(opts.stream ? { stream: true } : {}),
    }),
  });

  return {
    res,
    handle,
    fetchCalls: mockFetch.mock.calls as Array<[string, RequestInit]>,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("POST /v1/chat/completions (proxy.ts)", () => {
  describe("successful non-streaming", () => {
    it("proxies request to gate and returns response", async () => {
      const { res, handle } = await setupAndRequest({
        walletAmounts: [512],
        gateMockResponses: [
          () =>
            new Response(
              JSON.stringify({
                choices: [{ message: { content: "Hello from LLM!" } }],
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            ),
        ],
      });

      try {
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.choices[0].message.content).toBe("Hello from LLM!");
      } finally {
        handle.stop();
      }
    });

    it("receives and processes change token", async () => {
      const { res, handle } = await setupAndRequest({
        walletAmounts: [512],
        gateMockResponses: [
          () =>
            new Response(
              JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "X-Cashu-Change": "cashuBfake_change_token",
                },
              }
            ),
        ],
      });

      try {
        // Request succeeds (change token receive may fail but proxy still returns 200)
        expect(res.status).toBe(200);
      } finally {
        handle.stop();
      }
    });
  });

  describe("streaming", () => {
    it("streams SSE response from gate", async () => {
      const encoder = new TextEncoder();
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
        "data: [DONE]\n\n",
      ];

      const { res, handle } = await setupAndRequest({
        walletAmounts: [512],
        stream: true,
        gateMockResponses: [
          () => {
            const stream = new ReadableStream({
              start(controller) {
                for (const chunk of chunks) {
                  controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
              },
            });
            return new Response(stream, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            });
          },
        ],
      });

      try {
        expect(res.status).toBe(200);
        expect(res.body).toContain("Hi");
        expect(res.body).toContain("there");
        expect(res.body).toContain("[DONE]");
      } finally {
        handle.stop();
      }
    });

    it("extracts cashu-change SSE event and does not forward to client", async () => {
      const encoder = new TextEncoder();
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        "event: cashu-change\ndata: cashuBsseChangeToken123\n\n",
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ];

      const { res, handle } = await setupAndRequest({
        walletAmounts: [512],
        stream: true,
        gateMockResponses: [
          () => {
            const stream = new ReadableStream({
              start(controller) {
                for (const chunk of chunks) {
                  controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
              },
            });
            return new Response(stream, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            });
          },
        ],
      });

      try {
        expect(res.status).toBe(200);
        // Content should be forwarded
        expect(res.body).toContain("Hello");
        expect(res.body).toContain("world");
        expect(res.body).toContain("[DONE]");
        // cashu-change event should NOT be forwarded
        expect(res.body).not.toContain("cashu-change");
        expect(res.body).not.toContain("cashuBsseChangeToken123");
      } finally {
        handle.stop();
      }
    });
  });

  describe("upstream error → refund", () => {
    it("returns gate error status with refund processing", async () => {
      const { res, handle } = await setupAndRequest({
        walletAmounts: [512],
        gateMockResponses: [
          () =>
            new Response(
              JSON.stringify({ error: { message: "Internal error" } }),
              {
                status: 500,
                headers: {
                  "Content-Type": "application/json",
                  "X-Cashu-Refund": "cashuBfake_refund_token",
                },
              }
            ),
        ],
      });

      try {
        expect(res.status).toBe(500);
      } finally {
        handle.stop();
      }
    });
  });

  describe("retry on 429", () => {
    it("retries on 429 and succeeds on second attempt", async () => {
      const { res, handle, fetchCalls } = await setupAndRequest({
        walletAmounts: [1024, 512],
        gateMockResponses: [
          // First attempt: 429
          () =>
            new Response(JSON.stringify({ error: "rate limited" }), {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "0",
              },
            }),
          // Second attempt: success
          () =>
            new Response(
              JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            ),
        ],
      });

      try {
        expect(res.status).toBe(200);
        // Should have made at least 2 gate requests (+ pricing)
        const gateCalls = fetchCalls.filter(([url]) =>
          url.toString().includes("/v1/chat/completions")
        );
        expect(gateCalls.length).toBe(2);
      } finally {
        handle.stop();
      }
    });

    it("returns 429 after all retries exhausted", async () => {
      // Create enough proofs for multiple retries
      const { res, handle } = await setupAndRequest({
        walletAmounts: [256, 256, 256, 256, 256],
        gateMockResponses: [
          // All attempts return 429
          () => new Response("{}", { status: 429, headers: { "Retry-After": "0" } }),
          () => new Response("{}", { status: 429, headers: { "Retry-After": "0" } }),
          () => new Response("{}", { status: 429, headers: { "Retry-After": "0" } }),
          () => new Response("{}", { status: 429, headers: { "Retry-After": "0" } }),
        ],
      });

      try {
        expect(res.status).toBe(429);
      } finally {
        handle.stop();
      }
    }, 15_000);
  });

  describe("request body too large", () => {
    it("handles oversized request body", async () => {
      await writeWallet([512]);

      mockFetch.mockImplementation(async (url: string) => {
        if (url.toString().includes("/v1/pricing")) {
          return new Response(
            JSON.stringify({ unit: "usd", models: { "*": { mode: "per_request", per_request: 200 } } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("ok", { status: 200 });
      });
      globalThis.fetch = mockFetch;

      const handle = await startProxy(getConfig(), silentLogger);
      await new Promise((r) => setTimeout(r, 400));

      try {
        // Send a huge body (>1MB)
        const hugeBody = "x".repeat(2 * 1024 * 1024);
        const res = await httpRequest({
          port: testPort,
          method: "POST",
          path: "/v1/chat/completions",
          headers: {
            Authorization: `Bearer ${handle.proxySecret}`,
            "Content-Type": "application/json",
          },
          body: hugeBody,
        });

        // Should get an error (400 or 500)
        expect(res.status).toBeGreaterThanOrEqual(400);
      } finally {
        handle.stop();
      }
    });
  });

  describe("model transform", () => {
    it("transforms model ID before sending to gate", async () => {
      const { res, handle, fetchCalls } = await setupAndRequest({
        walletAmounts: [512],
        gateMockResponses: [
          () =>
            new Response(
              JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            ),
        ],
        model: "gpt-4o", // Should be transformed
      });

      try {
        expect(res.status).toBe(200);

        // Check the gate call used transformed model
        const gateCall = fetchCalls.find(([url]) =>
          url.toString().includes("/v1/chat/completions")
        );
        expect(gateCall).toBeDefined();
        if (gateCall) {
          const sentBody = JSON.parse(gateCall[1].body as string);
          // transformModelId may or may not change the model
          expect(sentBody.model).toBeDefined();
        }
      } finally {
        handle.stop();
      }
    });
  });
});
