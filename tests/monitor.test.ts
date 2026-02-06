/**
 * Monitor command integration tests
 *
 * Tests for the TUI dashboard panel content generation and data fetching.
 * Mocks external dependencies (fetch, config, transactions).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetch globally before imports
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock config module
vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    loadConfig: vi.fn().mockResolvedValue({
      gateUrl: "https://gate.test.local",
      mintUrl: "https://mint.test.local",
      walletPath: "~/.t2c/wallet.json",
      proxyPort: 10402,
      lowBalanceThreshold: 1000,
      autoDiscover: false,
      discoveryUrl: "https://token2.cash/gates.json",
    }),
    loadTransactions: vi.fn().mockResolvedValue([]),
    resolveHome: vi.fn((p: string) => p.replace("~", "/home/test")),
  };
});

// Mock cashu-store
vi.mock("../src/cashu-store.js", () => ({
  CashuStore: {
    load: vi.fn().mockResolvedValue({
      balance: 5000,
      proofCount: 10,
    }),
  },
}));

import {
  fetchGateStats,
  fetchMintStats,
  buildProxyContent,
  formatSats,
  type GateStats,
  type MintStats,
} from "../src/commands/monitor.js";
import { loadTransactions } from "../src/config.js";

describe("formatSats", () => {
  it("formats zero correctly", () => {
    expect(formatSats(0)).toBe("0");
  });

  it("formats small numbers without separators", () => {
    expect(formatSats(123)).toBe("123");
  });

  it("formats thousands with comma separators", () => {
    expect(formatSats(1234)).toBe("1,234");
    expect(formatSats(12345)).toBe("12,345");
    expect(formatSats(123456)).toBe("123,456");
  });

  it("formats millions correctly", () => {
    expect(formatSats(1234567)).toBe("1,234,567");
  });
});

describe("fetchGateStats", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns stats on successful response", async () => {
    const mockStats: GateStats = {
      generated_at: "2024-01-15T10:00:00Z",
      today: {
        total_requests: 100,
        success_count: 95,
        error_count: 5,
        ecash_received: 50000,
        model_breakdown: {
          "gpt-4": { count: 50, ecash_in: 30000, errors: 2 },
          "claude-3": { count: 50, ecash_in: 20000, errors: 3 },
        },
        error_breakdown: {
          "rate_limit": 3,
          "auth_failed": 2,
        },
      },
      last_7_days: {
        total_requests: 500,
        success_count: 480,
        error_count: 20,
        ecash_received: 250000,
        model_breakdown: {},
        error_breakdown: {},
      },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockStats,
    });

    const result = await fetchGateStats("https://gate.test.local");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://gate.test.local/stats",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result).toEqual(mockStats);
  });

  it("returns null on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = await fetchGateStats("https://gate.test.local");

    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await fetchGateStats("https://gate.test.local");

    expect(result).toBeNull();
  });

  it("returns null on timeout", async () => {
    mockFetch.mockRejectedValueOnce(new Error("The operation was aborted"));

    const result = await fetchGateStats("https://gate.test.local");

    expect(result).toBeNull();
  });
});

describe("fetchMintStats", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns stats on successful response", async () => {
    const mockStats: MintStats = {
      totalMintedSats: 100000,
      totalMeltedSats: 50000,
      mintCount: 100,
      meltCount: 50,
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockStats,
    });

    const result = await fetchMintStats("https://mint.test.local");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://mint.test.local/stats",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result).toEqual(mockStats);
  });

  it("returns null on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result = await fetchMintStats("https://mint.test.local");

    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await fetchMintStats("https://mint.test.local");

    expect(result).toBeNull();
  });
});

describe("buildProxyContent", () => {
  const mockedLoadTransactions = vi.mocked(loadTransactions);

  beforeEach(() => {
    mockedLoadTransactions.mockReset();
  });

  it("shows empty state when no transactions", async () => {
    mockedLoadTransactions.mockResolvedValueOnce([]);

    const content = await buildProxyContent(10, 40);

    expect(content).toContain("No transactions yet");
    expect(content).toContain("Run requests through the proxy");
  });

  it("shows summary stats with transactions", async () => {
    mockedLoadTransactions.mockResolvedValueOnce([
      {
        id: "tx1",
        timestamp: Date.now() - 60000,
        model: "gpt-4",
        priceSat: 100,
        changeSat: 10,
        refundSat: 0,
        gateStatus: 200,
        balanceBefore: 1000,
        balanceAfter: 910,
        durationMs: 1500,
      },
      {
        id: "tx2",
        timestamp: Date.now(),
        model: "claude-3-opus",
        priceSat: 200,
        changeSat: 20,
        refundSat: 0,
        gateStatus: 200,
        balanceBefore: 910,
        balanceAfter: 730,
        durationMs: 2000,
      },
    ]);

    const content = await buildProxyContent(15, 50);

    // Should show request count
    expect(content).toContain("Requests: 2");
    // Should show net spent (300 - 30 = 270 units = $0.0027)
    expect(content).toContain("$0.0027");
    // Should show "All OK" since no errors
    expect(content).toContain("All OK");
    // Should contain model names
    expect(content).toMatch(/gpt-4|claude/);
  });

  it("shows error count when transactions have errors", async () => {
    mockedLoadTransactions.mockResolvedValueOnce([
      {
        id: "tx1",
        timestamp: Date.now(),
        model: "gpt-4",
        priceSat: 100,
        changeSat: 0,
        refundSat: 0,
        gateStatus: 500,
        balanceBefore: 1000,
        balanceAfter: 900,
        durationMs: 500,
        error: "Internal server error",
      },
      {
        id: "tx2",
        timestamp: Date.now(),
        model: "claude-3",
        priceSat: 50,
        changeSat: 5,
        refundSat: 0,
        gateStatus: 200,
        balanceBefore: 900,
        balanceAfter: 855,
        durationMs: 1000,
      },
    ]);

    const content = await buildProxyContent(15, 50);

    // Should show error count
    expect(content).toContain("Errors: 1");
  });

  it("truncates long model names based on width", async () => {
    mockedLoadTransactions.mockResolvedValueOnce([
      {
        id: "tx1",
        timestamp: Date.now(),
        model: "anthropic/claude-3-opus-20240229-very-long-name",
        priceSat: 100,
        changeSat: 10,
        refundSat: 0,
        gateStatus: 200,
        balanceBefore: 1000,
        balanceAfter: 910,
        durationMs: 1500,
      },
    ]);

    const content = await buildProxyContent(10, 30);

    // Model name should be truncated with ".."
    expect(content).toContain("..");
    // Full name should not appear
    expect(content).not.toContain("anthropic/claude-3-opus-20240229-very-long-name");
  });

  it("shows +N more when transactions exceed maxLines", async () => {
    const manyTransactions = Array.from({ length: 20 }, (_, i) => ({
      id: `tx${i}`,
      timestamp: Date.now() - i * 1000,
      model: "gpt-4",
      priceSat: 10,
      changeSat: 1,
      refundSat: 0,
      gateStatus: 200,
      balanceBefore: 1000 - i * 9,
      balanceAfter: 1000 - (i + 1) * 9,
      durationMs: 100,
    }));

    mockedLoadTransactions.mockResolvedValueOnce(manyTransactions);

    // With maxLines=8, should show fewer transactions
    const content = await buildProxyContent(8, 50);

    expect(content).toContain("... +");
    expect(content).toContain("more");
  });

  it("formats transaction time correctly", async () => {
    // Fixed timestamp for predictable testing
    const fixedTime = new Date("2024-01-15T14:30:45Z").getTime();

    mockedLoadTransactions.mockResolvedValueOnce([
      {
        id: "tx1",
        timestamp: fixedTime,
        model: "gpt-4",
        priceSat: 100,
        changeSat: 10,
        refundSat: 0,
        gateStatus: 200,
        balanceBefore: 1000,
        balanceAfter: 910,
        durationMs: 1500,
      },
    ]);

    const content = await buildProxyContent(10, 50);

    // Should contain time in HH:MM:SS format
    expect(content).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("shows success indicator for 200 status", async () => {
    mockedLoadTransactions.mockResolvedValueOnce([
      {
        id: "tx1",
        timestamp: Date.now(),
        model: "gpt-4",
        priceSat: 100,
        changeSat: 10,
        refundSat: 0,
        gateStatus: 200,
        balanceBefore: 1000,
        balanceAfter: 910,
        durationMs: 1500,
      },
    ]);

    const content = await buildProxyContent(10, 50);

    // Should contain green checkmark
    expect(content).toContain("✓");
    expect(content).toContain("green-fg");
  });

  it("shows error indicator for failed transactions", async () => {
    mockedLoadTransactions.mockResolvedValueOnce([
      {
        id: "tx1",
        timestamp: Date.now(),
        model: "gpt-4",
        priceSat: 100,
        changeSat: 0,
        refundSat: 0,
        gateStatus: 500,
        balanceBefore: 1000,
        balanceAfter: 900,
        durationMs: 500,
        error: "Server error",
      },
    ]);

    const content = await buildProxyContent(10, 50);

    // Should contain red X
    expect(content).toContain("✗");
    expect(content).toContain("red-fg");
  });
});

describe("monitor command export", () => {
  it("exports monitorCommand function", async () => {
    const { monitorCommand } = await import("../src/commands/monitor.js");
    expect(monitorCommand).toBeDefined();
    expect(typeof monitorCommand).toBe("function");
  });

  it("exports all interfaces and types", async () => {
    const mod = await import("../src/commands/monitor.js");
    expect(mod.fetchGateStats).toBeDefined();
    expect(mod.fetchMintStats).toBeDefined();
    expect(mod.buildProxyContent).toBeDefined();
    expect(mod.formatSats).toBeDefined();
  });
});
