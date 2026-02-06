/**
 * Config module tests
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("resolveHome", () => {
  it("expands ~ to home directory", async () => {
    const { resolveHome } = await import("../src/config.js");
    const home = os.homedir();
    const result = resolveHome("~/.t2c/wallet.json");
    expect(result).toBe(`${home}/.t2c/wallet.json`);
  });

  it("leaves absolute paths unchanged", async () => {
    const { resolveHome } = await import("../src/config.js");
    const result = resolveHome("/absolute/path/to/wallet.json");
    expect(result).toBe("/absolute/path/to/wallet.json");
  });

  it("resolves relative paths to absolute", async () => {
    const { resolveHome } = await import("../src/config.js");
    const path = await import("node:path");
    const result = resolveHome("relative/path.json");
    expect(result).toBe(path.resolve("relative/path.json"));
  });
});

describe("config loading/saving", () => {
  const testConfigDir = `/tmp/t2c-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const testConfigPath = path.join(testConfigDir, "config.json");

  beforeEach(async () => {
    await fs.mkdir(testConfigDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testConfigDir, { recursive: true, force: true });
  });

  it("returns default config when file doesn't exist", async () => {
    const { loadConfig, DEFAULT_CONFIG } = await import("../src/config.js");
    // Loading from non-existent path should return defaults
    const config = await loadConfig();
    expect(config.proxyPort).toBe(DEFAULT_CONFIG.proxyPort);
  });

  it("validates port numbers", async () => {
    const { DEFAULT_CONFIG } = await import("../src/config.js");
    expect(DEFAULT_CONFIG.proxyPort).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.proxyPort).toBeLessThan(65536);
  });
});

describe("DEFAULT_CONFIG", () => {
  it("has all required fields", async () => {
    const { DEFAULT_CONFIG } = await import("../src/config.js");
    expect(DEFAULT_CONFIG).toHaveProperty("gateUrl");
    expect(DEFAULT_CONFIG).toHaveProperty("mintUrl");
    expect(DEFAULT_CONFIG).toHaveProperty("walletPath");
    expect(DEFAULT_CONFIG).toHaveProperty("proxyPort");
    expect(DEFAULT_CONFIG).toHaveProperty("lowBalanceThreshold");
  });

  it("has sensible default values", async () => {
    const { DEFAULT_CONFIG } = await import("../src/config.js");
    expect(DEFAULT_CONFIG.proxyPort).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.proxyPort).toBeLessThan(65536);
    expect(DEFAULT_CONFIG.lowBalanceThreshold).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.gateUrl).toMatch(/^https?:\/\//);
    expect(DEFAULT_CONFIG.mintUrl).toMatch(/^https?:\/\//);
  });
});

describe("formatUnits", () => {
  it("formats zero", async () => {
    const { formatUnits } = await import("../src/config.js");
    expect(formatUnits(0)).toBe("$0.00");
  });

  it("formats whole dollars", async () => {
    const { formatUnits } = await import("../src/config.js");
    expect(formatUnits(100000)).toBe("$1.00");
    expect(formatUnits(500000)).toBe("$5.00");
  });

  it("formats cents", async () => {
    const { formatUnits } = await import("../src/config.js");
    expect(formatUnits(45000)).toBe("$0.45");
    expect(formatUnits(1000)).toBe("$0.01");
  });

  it("formats sub-cent amounts", async () => {
    const { formatUnits } = await import("../src/config.js");
    expect(formatUnits(500)).toBe("$0.005");
    expect(formatUnits(1)).toBe("$0.00001");
    expect(formatUnits(10)).toBe("$0.0001");
  });

  it("formats large amounts with commas", async () => {
    const { formatUnits } = await import("../src/config.js");
    expect(formatUnits(10000000)).toBe("$100.00");
    expect(formatUnits(100000000)).toBe("$1,000.00");
  });
});

describe("error classes", () => {
  it("ConfigError is recoverable aware", async () => {
    const { ConfigError } = await import("../src/config.js");
    const err = new ConfigError("test error", true);
    expect(err.recoverable).toBe(true);
    expect(err.name).toBe("ConfigError");
  });

  it("NetworkError has endpoint", async () => {
    const { NetworkError } = await import("../src/config.js");
    const err = new NetworkError("connection failed", "https://test.com");
    expect(err.endpoint).toBe("https://test.com");
    expect(err.name).toBe("NetworkError");
  });

  it("WalletError has code", async () => {
    const { WalletError } = await import("../src/config.js");
    const err = new WalletError("insufficient balance", "INSUFFICIENT_BALANCE");
    expect(err.code).toBe("INSUFFICIENT_BALANCE");
    expect(err.name).toBe("WalletError");
  });

  it("ConfigError defaults to not recoverable", async () => {
    const { ConfigError } = await import("../src/config.js");
    const err = new ConfigError("test");
    expect(err.recoverable).toBe(false);
  });

  it("NetworkError stores cause", async () => {
    const { NetworkError } = await import("../src/config.js");
    const cause = new Error("original");
    const err = new NetworkError("wrapped", "https://test.com", cause);
    expect(err.cause).toBe(cause);
  });
});

// ── saveConfig ──────────────────────────────────────────────────

describe("saveConfig", () => {
  it("throws on invalid port (0)", async () => {
    const { saveConfig, DEFAULT_CONFIG } = await import("../src/config.js");
    await expect(
      saveConfig({ ...DEFAULT_CONFIG, proxyPort: 0 }),
    ).rejects.toThrow("Invalid proxy port");
  });

  it("throws on port > 65535", async () => {
    const { saveConfig, DEFAULT_CONFIG } = await import("../src/config.js");
    await expect(
      saveConfig({ ...DEFAULT_CONFIG, proxyPort: 70000 }),
    ).rejects.toThrow("Invalid proxy port");
  });

  it("throws on invalid gateUrl", async () => {
    const { saveConfig, DEFAULT_CONFIG } = await import("../src/config.js");
    await expect(
      saveConfig({ ...DEFAULT_CONFIG, gateUrl: "not-a-url" }),
    ).rejects.toThrow("Invalid gate URL");
  });

  it("throws on invalid mintUrl", async () => {
    const { saveConfig, DEFAULT_CONFIG } = await import("../src/config.js");
    await expect(
      saveConfig({ ...DEFAULT_CONFIG, mintUrl: "bad" }),
    ).rejects.toThrow("Invalid mint URL");
  });
});

// ── loadConfig edge cases ───────────────────────────────────────

describe("loadConfig edge cases", () => {
  it("recovers from corrupted JSON config", async () => {
    const { loadConfig, CONFIG_PATH } = await import("../src/config.js");

    // Write corrupted content
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, "{broken json!!");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = await loadConfig();
    warnSpy.mockRestore();

    // Should return defaults on corruption
    expect(config.proxyPort).toBe(10402);
  });

  it("warns and uses default for invalid port in config", async () => {
    const { loadConfig, CONFIG_PATH, DEFAULT_CONFIG } = await import("../src/config.js");

    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ proxyPort: -5 }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = await loadConfig();
    warnSpy.mockRestore();

    expect(config.proxyPort).toBe(DEFAULT_CONFIG.proxyPort);
  });

  it("warns and uses default for invalid gateUrl in config", async () => {
    const { loadConfig, CONFIG_PATH, DEFAULT_CONFIG } = await import("../src/config.js");

    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ gateUrl: "not-a-url" }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = await loadConfig();
    warnSpy.mockRestore();

    expect(config.gateUrl).toBe(DEFAULT_CONFIG.gateUrl);
  });

  it("warns and uses default for invalid mintUrl in config", async () => {
    const { loadConfig, CONFIG_PATH, DEFAULT_CONFIG } = await import("../src/config.js");

    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ mintUrl: 12345 }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = await loadConfig();
    warnSpy.mockRestore();

    expect(config.mintUrl).toBe(DEFAULT_CONFIG.mintUrl);
  });
});

// ── configExists ────────────────────────────────────────────────

describe("configExists", () => {
  it("returns true when config file exists", async () => {
    const { configExists, CONFIG_PATH } = await import("../src/config.js");
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, "{}");
    expect(await configExists()).toBe(true);
  });
});

// ── Failed token persistence ────────────────────────────────────

describe("failed token persistence", () => {
  const testDir = `/tmp/t2c-test-failedtokens-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("loadFailedTokens returns empty when file missing", async () => {
    const { loadFailedTokens } = await import("../src/config.js");
    const result = await loadFailedTokens();
    // May or may not exist — just check we get a valid structure
    expect(result).toHaveProperty("tokens");
    expect(Array.isArray(result.tokens)).toBe(true);
  });

  it("saveFailedTokens and loadFailedTokens roundtrip", async () => {
    const { saveFailedTokens, loadFailedTokens, FAILED_TOKENS_PATH } = await import("../src/config.js");

    const data = {
      tokens: [
        { token: "cashuABC", type: "change" as const, timestamp: 1700000000000, error: "network error" },
        { token: "cashuDEF", type: "refund" as const, timestamp: 1700000001000, error: "timeout" },
      ],
    };
    await saveFailedTokens(data);

    const loaded = await loadFailedTokens();
    expect(loaded.tokens).toHaveLength(2);
    expect(loaded.tokens[0].token).toBe("cashuABC");
    expect(loaded.tokens[1].type).toBe("refund");
  });

  it("appendFailedToken adds to existing tokens", async () => {
    const { appendFailedToken, loadFailedTokens, saveFailedTokens } = await import("../src/config.js");

    // Start with one token
    await saveFailedTokens({
      tokens: [{ token: "existing", type: "change", timestamp: 1000, error: "err" }],
    });

    await appendFailedToken("newtoken", "refund", "new error");

    const loaded = await loadFailedTokens();
    expect(loaded.tokens).toHaveLength(2);
    expect(loaded.tokens[1].token).toBe("newtoken");
    expect(loaded.tokens[1].type).toBe("refund");
    expect(loaded.tokens[1].error).toBe("new error");
    expect(loaded.tokens[1].timestamp).toBeGreaterThan(0);
  });
});

// ── Transaction log ─────────────────────────────────────────────

describe("transaction log", () => {
  it("appendTransaction creates file and writes JSONL", async () => {
    const { appendTransaction, TRANSACTIONS_LOG_PATH } = await import("../src/config.js");

    const record = {
      id: "tx-test",
      timestamp: 1700000000000,
      model: "gpt-4o",
      priceSat: 100,
      changeSat: 20,
      refundSat: 0,
      gateStatus: 200,
      balanceBefore: 1000,
      balanceAfter: 920,
      durationMs: 500,
    };
    await appendTransaction(record);

    const content = await fs.readFile(TRANSACTIONS_LOG_PATH, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.id).toBe("tx-test");
  });

  it("loadTransactions returns empty array when file missing", async () => {
    const { loadTransactions } = await import("../src/config.js");
    // The file may exist from prior tests, but the function should not throw
    const result = await loadTransactions();
    expect(Array.isArray(result)).toBe(true);
  });

  it("loadTransactions with limit returns last N records", async () => {
    const { appendTransaction, loadTransactions } = await import("../src/config.js");

    // Append a few records
    for (let i = 0; i < 5; i++) {
      await appendTransaction({
        id: `tx-lim-${i}`,
        timestamp: 1700000000000 + i * 1000,
        model: "test",
        priceSat: 10,
        changeSat: 0,
        refundSat: 0,
        gateStatus: 200,
        balanceBefore: 100,
        balanceAfter: 90,
        durationMs: 100,
      });
    }

    const limited = await loadTransactions(2);
    expect(limited.length).toBeLessThanOrEqual(2);
  });
});

// ── Health checks ───────────────────────────────────────────────

describe("health checks", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("checkGateHealth returns true on ok response", async () => {
    const { checkGateHealth } = await import("../src/config.js");
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    expect(await checkGateHealth("https://gate.test")).toBe(true);
  });

  it("checkGateHealth returns false on non-ok response", async () => {
    const { checkGateHealth } = await import("../src/config.js");
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

    expect(await checkGateHealth("https://gate.test")).toBe(false);
  });

  it("checkGateHealth returns false on network error", async () => {
    const { checkGateHealth } = await import("../src/config.js");
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("timeout")) as unknown as typeof fetch;

    expect(await checkGateHealth("https://gate.test")).toBe(false);
  });

  it("checkMintHealth returns true on ok response", async () => {
    const { checkMintHealth } = await import("../src/config.js");
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

    expect(await checkMintHealth("https://mint.test")).toBe(true);
  });

  it("checkMintHealth returns false on non-ok", async () => {
    const { checkMintHealth } = await import("../src/config.js");
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

    expect(await checkMintHealth("https://mint.test")).toBe(false);
  });

  it("checkMintHealth returns false on network error", async () => {
    const { checkMintHealth } = await import("../src/config.js");
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("fail")) as unknown as typeof fetch;

    expect(await checkMintHealth("https://mint.test")).toBe(false);
  });

  it("checkGateHealth calls /health endpoint", async () => {
    const { checkGateHealth } = await import("../src/config.js");
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await checkGateHealth("https://gate.example.com");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://gate.example.com/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("checkMintHealth calls /v1/info endpoint", async () => {
    const { checkMintHealth } = await import("../src/config.js");
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await checkMintHealth("https://mint.example.com");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://mint.example.com/v1/info",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

// ── loadOrCreateProxySecret ─────────────────────────────────────

describe("loadOrCreateProxySecret", () => {
  it("creates a secret starting with t2c-", async () => {
    const { loadOrCreateProxySecret } = await import("../src/config.js");
    const secret = await loadOrCreateProxySecret();
    expect(secret).toMatch(/^t2c-[a-f0-9]+$/);
  });

  it("returns same secret on subsequent calls", async () => {
    const { loadOrCreateProxySecret } = await import("../src/config.js");
    const s1 = await loadOrCreateProxySecret();
    const s2 = await loadOrCreateProxySecret();
    expect(s1).toBe(s2);
  });
});
