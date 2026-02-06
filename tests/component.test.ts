/**
 * Component test — End-to-end proxy integration test.
 *
 * Starts the proxy, sends requests through it to a mock gate,
 * and verifies the full request/response cycle:
 * - X-Cashu header is attached
 * - Change tokens are processed
 * - Auth rejection without bearer token
 * - Retry on 429
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { startProxy, type Logger } from "../src/proxy.js";
import type { T2CConfig } from "../src/config.js";

const testDir = "/tmp/t2c-component-" + Date.now();
const testWalletPath = path.join(testDir, "wallet.json");

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

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

async function writeWallet(amounts: number[]) {
  const proofs = amounts.map((amount, i) => ({
    id: "00ad268c4d1f5826",
    amount,
    secret: `secret_${amount}_${i}`,
    C: "02" + "ab".repeat(32),
  }));
  await fs.writeFile(
    testWalletPath,
    JSON.stringify({ mint: "https://mint.test.local", unit: "usd", proofs }),
  );
}

function httpRequest(opts: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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
      },
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
  testPort = 50000 + Math.floor(Math.random() * 10000);
  mockFetch = vi.fn();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
});

const pricingRes = {
  unit: "usd",
  models: { "*": { mode: "per_request", per_request: 200 } },
};

describe("Component: proxy end-to-end", () => {
  it("adds X-Cashu header to gate request", async () => {
    await writeWallet([512]);

    let capturedHeaders: Record<string, string> = {};

    mockFetch.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/pricing")) {
        return new Response(JSON.stringify(pricingRes), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/v1/chat/completions")) {
        // Capture the headers sent to gate
        const hdrs = init?.headers;
        if (hdrs instanceof Headers) {
          hdrs.forEach((v, k) => { capturedHeaders[k.toLowerCase()] = v; });
        } else if (hdrs && typeof hdrs === "object") {
          for (const [k, v] of Object.entries(hdrs)) {
            capturedHeaders[k.toLowerCase()] = String(v);
          }
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    });
    globalThis.fetch = mockFetch;

    const handle = await startProxy(getConfig(), silentLogger);
    await new Promise((r) => setTimeout(r, 400));

    try {
      const res = await httpRequest({
        port: testPort,
        method: "POST",
        path: "/v1/chat/completions",
        headers: {
          Authorization: `Bearer ${handle.proxySecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      expect(res.status).toBe(200);
      // Proxy should have sent X-Cashu header to gate
      expect(capturedHeaders["x-cashu"]).toBeDefined();
      expect(capturedHeaders["x-cashu"].length).toBeGreaterThan(0);
    } finally {
      handle.stop();
    }
  });

  it("processes change token from gate response header", async () => {
    await writeWallet([512]);

    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/pricing")) {
        return new Response(JSON.stringify(pricingRes), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/v1/chat/completions")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "hi" } }] }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Cashu-Change": "cashuBfakeChangeToken",
            },
          },
        );
      }
      return new Response("Not found", { status: 404 });
    });
    globalThis.fetch = mockFetch;

    const handle = await startProxy(getConfig(), silentLogger);
    await new Promise((r) => setTimeout(r, 400));

    try {
      const res = await httpRequest({
        port: testPort,
        method: "POST",
        path: "/v1/chat/completions",
        headers: {
          Authorization: `Bearer ${handle.proxySecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      // Request succeeds — change token is processed internally
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.choices[0].message.content).toBe("hi");
    } finally {
      handle.stop();
    }
  });

  it("handles cashu-change SSE event in streaming response", async () => {
    await writeWallet([512]);
    const encoder = new TextEncoder();

    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/pricing")) {
        return new Response(JSON.stringify(pricingRes), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/v1/chat/completions")) {
        const chunks = [
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          "event: cashu-change\ndata: cashuBstreamToken\n\n",
          'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
          "data: [DONE]\n\n",
        ];
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
      }
      return new Response("Not found", { status: 404 });
    });
    globalThis.fetch = mockFetch;

    const handle = await startProxy(getConfig(), silentLogger);
    await new Promise((r) => setTimeout(r, 400));

    try {
      const res = await httpRequest({
        port: testPort,
        method: "POST",
        path: "/v1/chat/completions",
        headers: {
          Authorization: `Bearer ${handle.proxySecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        }),
      });

      expect(res.status).toBe(200);
      // Content should be forwarded
      expect(res.body).toContain("Hi");
      expect(res.body).toContain("[DONE]");
      // Change token event should NOT be forwarded to client
      expect(res.body).not.toContain("cashu-change");
      expect(res.body).not.toContain("cashuBstreamToken");
    } finally {
      handle.stop();
    }
  });

  it("rejects requests without bearer token", async () => {
    await writeWallet([512]);

    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/pricing")) {
        return new Response(JSON.stringify(pricingRes), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });
    globalThis.fetch = mockFetch;

    const handle = await startProxy(getConfig(), silentLogger);
    await new Promise((r) => setTimeout(r, 400));

    try {
      // No Authorization header
      const res = await httpRequest({
        port: testPort,
        method: "POST",
        path: "/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      expect(res.status).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.message).toContain("Unauthorized");
    } finally {
      handle.stop();
    }
  });

  it("retries on 429 and succeeds", async () => {
    await writeWallet([512, 512]);
    let attemptCount = 0;

    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("/v1/pricing")) {
        return new Response(JSON.stringify(pricingRes), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/v1/chat/completions")) {
        attemptCount++;
        if (attemptCount === 1) {
          // First: 429
          return new Response(
            JSON.stringify({ error: "rate limited" }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "0",
              },
            },
          );
        }
        // Second: success
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "retried!" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    });
    globalThis.fetch = mockFetch;

    const handle = await startProxy(getConfig(), silentLogger);
    await new Promise((r) => setTimeout(r, 400));

    try {
      const res = await httpRequest({
        port: testPort,
        method: "POST",
        path: "/v1/chat/completions",
        headers: {
          Authorization: `Bearer ${handle.proxySecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.choices[0].message.content).toBe("retried!");
      expect(attemptCount).toBe(2);
    } finally {
      handle.stop();
    }
  }, 15_000);
});
