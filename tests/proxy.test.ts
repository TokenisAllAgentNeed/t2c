/**
 * Proxy module tests
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { startProxy, type Logger } from "../src/proxy.js";
import type { T2CConfig } from "../src/config.js";

describe("startProxy", () => {
  const testDir = "/tmp/t2c-proxy-test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const testWalletPath = path.join(testDir, "wallet.json");
  let testPort = 30000 + Math.floor(Math.random() * 10000);

  const testConfig: T2CConfig = {
    gateUrl: "https://gate.test.local",
    mintUrl: "https://mint.test.local",
    walletPath: testWalletPath,
    proxyPort: testPort,
    lowBalanceThreshold: 1000,
  };

  const silentLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
    testPort = 30000 + Math.floor(Math.random() * 10000);
    testConfig.proxyPort = testPort;
    testConfig.walletPath = testWalletPath;
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("starts and responds to health check", async () => {
    // Create wallet file
    const walletData = {
      mint: "https://mint.test.local",
      unit: "usd",
      proofs: [{ id: "00ad268c4d1f5826", amount: 1000, secret: "s1", C: "02" + "0".repeat(62) }],
    };
    await fs.writeFile(testWalletPath, JSON.stringify(walletData));

    const handle = await startProxy(testConfig, silentLogger);

    // Wait for server to be ready
    await new Promise((r) => setTimeout(r, 300));

    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/health`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty("ok");
      expect(data.ok).toBe(true);
      // Health endpoint should NOT expose sensitive data
      expect(data).not.toHaveProperty("balance");
      expect(data).not.toHaveProperty("mint");
      expect(data).not.toHaveProperty("gate");
    } finally {
      handle.stop();
    }
  });

  it("returns 401 for unauthenticated requests", async () => {
    await fs.writeFile(testWalletPath, JSON.stringify({ mint: "x", unit: "usd", proofs: [] }));
    const handle = await startProxy(testConfig, silentLogger);
    await new Promise((r) => setTimeout(r, 300));

    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/unknown`);
      expect(res.status).toBe(401);
    } finally {
      handle.stop();
    }
  });

  it("returns 404 for unknown endpoints with valid auth", async () => {
    await fs.writeFile(testWalletPath, JSON.stringify({ mint: "x", unit: "usd", proofs: [] }));
    const handle = await startProxy(testConfig, silentLogger);
    await new Promise((r) => setTimeout(r, 300));

    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/unknown`, {
        headers: { Authorization: `Bearer ${handle.proxySecret}` },
      });
      expect(res.status).toBe(404);
    } finally {
      handle.stop();
    }
  });

  it("stops cleanly", async () => {
    await fs.writeFile(testWalletPath, JSON.stringify({ mint: "x", unit: "usd", proofs: [] }));
    const handle = await startProxy(testConfig, silentLogger);
    await new Promise((r) => setTimeout(r, 300));

    // Verify running
    let res = await fetch(`http://127.0.0.1:${testPort}/health`);
    expect(res.status).toBe(200);

    // Stop
    handle.stop();
    await new Promise((r) => setTimeout(r, 200));

    // Should be stopped
    await expect(fetch(`http://127.0.0.1:${testPort}/health`)).rejects.toThrow();
  });

  it("returns 404 for non-POST to chat/completions with auth", async () => {
    await fs.writeFile(testWalletPath, JSON.stringify({ mint: "x", unit: "usd", proofs: [] }));
    const handle = await startProxy(testConfig, silentLogger);
    await new Promise((r) => setTimeout(r, 300));

    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/v1/chat/completions`, {
        headers: { Authorization: `Bearer ${handle.proxySecret}` },
      });
      expect(res.status).toBe(404);
    } finally {
      handle.stop();
    }
  });

  it("returns 402 for insufficient balance", async () => {
    // Empty wallet — balance is 0
    // Use localhost port 1 so fetchPricing fails fast (ECONNREFUSED)
    const localConfig = { ...testConfig, gateUrl: "http://127.0.0.1:1" };
    await fs.writeFile(testWalletPath, JSON.stringify({ mint: "x", unit: "usd", proofs: [] }));
    const handle = await startProxy(localConfig, silentLogger);
    await new Promise((r) => setTimeout(r, 300));

    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.proxySecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(402);

      const data = await res.json();
      expect(data.error.code).toBe("insufficient_balance");
      expect(data.error.type).toBe("insufficient_funds");
    } finally {
      handle.stop();
    }
  });

  it("returns 502 for pricing passthrough when gate is unreachable", async () => {
    const localConfig = { ...testConfig, gateUrl: "http://127.0.0.1:1" };
    await fs.writeFile(testWalletPath, JSON.stringify({ mint: "x", unit: "usd", proofs: [] }));
    const handle = await startProxy(localConfig, silentLogger);
    await new Promise((r) => setTimeout(r, 300));

    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/v1/pricing`, {
        headers: { Authorization: `Bearer ${handle.proxySecret}` },
      });
      expect(res.status).toBe(502);

      const data = await res.json();
      expect(data.error).toBe("Gate unreachable");
    } finally {
      handle.stop();
    }
  });

  it("returns models list from /v1/models", async () => {
    const localConfig = { ...testConfig, gateUrl: "http://127.0.0.1:1" };
    await fs.writeFile(testWalletPath, JSON.stringify({ mint: "x", unit: "usd", proofs: [] }));
    const handle = await startProxy(localConfig, silentLogger);
    await new Promise((r) => setTimeout(r, 300));

    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/v1/models`, {
        headers: { Authorization: `Bearer ${handle.proxySecret}` },
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.object).toBe("list");
      expect(Array.isArray(data.data)).toBe(true);
    } finally {
      handle.stop();
    }
  });

  it("returns 401 for wrong bearer token", async () => {
    await fs.writeFile(testWalletPath, JSON.stringify({ mint: "x", unit: "usd", proofs: [] }));
    const handle = await startProxy(testConfig, silentLogger);
    await new Promise((r) => setTimeout(r, 300));

    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/v1/models`, {
        headers: { Authorization: "Bearer wrong-token-value" },
      });
      expect(res.status).toBe(401);
    } finally {
      handle.stop();
    }
  });

  it("returns 401 for malformed Authorization header", async () => {
    await fs.writeFile(testWalletPath, JSON.stringify({ mint: "x", unit: "usd", proofs: [] }));
    const handle = await startProxy(testConfig, silentLogger);
    await new Promise((r) => setTimeout(r, 300));

    try {
      // Missing "Bearer " prefix
      const res = await fetch(`http://127.0.0.1:${testPort}/v1/models`, {
        headers: { Authorization: "Basic sometoken" },
      });
      expect(res.status).toBe(401);
    } finally {
      handle.stop();
    }
  });
});
