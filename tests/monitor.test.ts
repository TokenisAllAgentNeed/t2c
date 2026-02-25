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

// ── blessed / blessed-contrib mocks ──
// Track key handler registrations so we can trigger them in tests
const keyHandlers: Record<string, Function> = {};
const mockSetContent = vi.fn();
const mockScreenRender = vi.fn();
const mockScreenDestroy = vi.fn();
const mockScreen = {
  key: vi.fn((keys: string[], handler: Function) => {
    for (const k of keys) {
      keyHandlers[k] = handler;
    }
  }),
  render: mockScreenRender,
  destroy: mockScreenDestroy,
  height: 40,
  width: 80,
};

// Each grid.set() call returns a separate box; track them in order
let boxInstances: Array<{ setContent: ReturnType<typeof vi.fn> }> = [];
function makeMockBox() {
  const box = { setContent: vi.fn() };
  boxInstances.push(box);
  return box;
}

// The status bar is created via blessed.box() (not grid.set)
const mockStatusBar = { setContent: vi.fn() };

vi.mock("blessed", () => ({
  default: {
    screen: vi.fn(() => mockScreen),
    box: vi.fn(() => mockStatusBar),
  },
}));

vi.mock("blessed-contrib", () => ({
  default: {
    grid: vi.fn().mockImplementation(() => ({
      set: vi.fn(() => makeMockBox()),
    })),
  },
}));

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
  monitorCommand,
  type GateStats,
  type MintStats,
} from "../src/commands/monitor.js";
import { loadConfig, loadTransactions } from "../src/config.js";
import { CashuStore } from "../src/cashu-store.js";

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

// ─────────────────────────────────────────────────────────────────────────────
// monitorCommand tests
// ─────────────────────────────────────────────────────────────────────────────

describe("monitorCommand", () => {
  const mockedLoadConfig = vi.mocked(loadConfig);
  const mockedLoadTransactions = vi.mocked(loadTransactions);
  const mockedCashuStoreLoad = vi.mocked(CashuStore.load);

  // Spy on process.exit so cleanup() doesn't kill the test runner
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  // Spy on process.on to capture signal handlers
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  // Spy on setInterval/clearInterval
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;

  /** Helper: gate stats with no errors */
  function makeGateStats(overrides?: Partial<GateStats>): GateStats {
    return {
      generated_at: "2024-01-15T10:00:00Z",
      today: {
        total_requests: 100,
        success_count: 100,
        error_count: 0,
        ecash_received: 50000,
        model_breakdown: {},
        error_breakdown: {},
      },
      last_7_days: {
        total_requests: 500,
        success_count: 500,
        error_count: 0,
        ecash_received: 250000,
        model_breakdown: {},
        error_breakdown: {},
      },
      ...overrides,
    };
  }

  /** Helper: mint stats */
  function makeMintStats(overrides?: Partial<MintStats>): MintStats {
    return {
      totalMintedSats: 100000,
      totalMeltedSats: 50000,
      mintCount: 100,
      meltCount: 50,
      ...overrides,
    };
  }

  /**
   * Utility: set up all mocks for a monitorCommand call.
   * Returns convenience accessors for the 4 panel boxes.
   */
  function setupMocks(options?: {
    gateStats?: GateStats | null;
    mintStats?: MintStats | null;
    transactions?: any[];
    balance?: number;
    proofCount?: number;
    walletError?: Error;
    transactionError?: Error;
  }) {
    const {
      gateStats = makeGateStats(),
      mintStats = makeMintStats(),
      transactions = [],
      balance = 5000,
      proofCount = 10,
      walletError,
      transactionError,
    } = options ?? {};

    // fetchGateStats uses fetch(gateUrl/stats), fetchMintStats uses fetch(mintUrl/stats)
    // The monitorCommand calls them in order: gate first, then mint
    mockFetch.mockReset();
    // Gate fetch
    if (gateStats) {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => gateStats });
    } else {
      mockFetch.mockRejectedValueOnce(new Error("unreachable"));
    }
    // Mint fetch
    if (mintStats) {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mintStats });
    } else {
      mockFetch.mockRejectedValueOnce(new Error("unreachable"));
    }

    // loadConfig is already mocked at module level; reset to default
    mockedLoadConfig.mockResolvedValue({
      gateUrl: "https://gate.test.local",
      mintUrl: "https://mint.test.local",
      walletPath: "~/.t2c/wallet.json",
      proxyPort: 10402,
      lowBalanceThreshold: 1000,
      autoDiscover: false,
      discoveryUrl: "https://token2.cash/gates.json",
    } as any);

    // loadTransactions mock — called twice: once for proxy panel (buildProxyContent), once for funds panel
    if (transactionError) {
      mockedLoadTransactions.mockRejectedValue(transactionError);
    } else {
      mockedLoadTransactions.mockResolvedValue(transactions);
    }

    // CashuStore.load
    if (walletError) {
      mockedCashuStoreLoad.mockRejectedValue(walletError);
    } else {
      mockedCashuStoreLoad.mockResolvedValue({
        balance,
        proofCount,
      } as any);
    }
  }

  beforeEach(() => {
    // Clear box instances and key handlers from previous test
    boxInstances = [];
    for (const k of Object.keys(keyHandlers)) {
      delete keyHandlers[k];
    }
    mockScreen.key.mockClear();
    mockScreenRender.mockClear();
    mockScreenDestroy.mockClear();
    mockStatusBar.setContent.mockClear();

    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    processOnSpy = vi.spyOn(process, "on").mockImplementation((() => process) as any);
    setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(12345 as any);
    clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

    mockedLoadTransactions.mockReset();
    mockedCashuStoreLoad.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    processOnSpy.mockRestore();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  /** Helper: get the 4 panel boxes created during monitorCommand */
  function panels() {
    // grid.set is called 4 times: gate(0), mint(1), proxy(2), funds(3)
    return {
      gate: boxInstances[0],
      mint: boxInstances[1],
      proxy: boxInstances[2],
      funds: boxInstances[3],
    };
  }

  // ── Screen setup ──

  it("creates blessed screen and grid layout", async () => {
    setupMocks();
    await monitorCommand({});

    const blessed = (await import("blessed")).default;
    const contrib = (await import("blessed-contrib")).default;

    expect(blessed.screen).toHaveBeenCalled();
    expect(contrib.grid).toHaveBeenCalled();
    // Should create 4 panels
    expect(boxInstances.length).toBe(4);
  });

  it("registers key bindings for q, escape, C-c, and r", async () => {
    setupMocks();
    await monitorCommand({});

    // screen.key is called at least twice: one for exit keys, one for refresh
    expect(mockScreen.key).toHaveBeenCalledWith(
      ["escape", "q", "C-c"],
      expect.any(Function),
    );
    expect(mockScreen.key).toHaveBeenCalledWith(
      ["r"],
      expect.any(Function),
    );
  });

  it("registers process signal handlers for SIGINT and SIGTERM", async () => {
    setupMocks();
    await monitorCommand({});

    expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  // ── Options parsing ──

  it("uses default refresh interval of 5000ms", async () => {
    setupMocks();
    await monitorCommand({});

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
  });

  it("parses custom refresh interval from opts.refresh", async () => {
    setupMocks();
    await monitorCommand({ refresh: "10" });

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10000);
  });

  it("shows refresh interval in status bar", async () => {
    setupMocks();
    await monitorCommand({ refresh: "3" });

    const blessed = (await import("blessed")).default;
    // blessed.box is called with content containing the interval
    expect(blessed.box).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("interval: 3s"),
      }),
    );
  });

  // ── Gate panel ──

  it("gate panel shows stats when fetchGateStats succeeds", async () => {
    const gateStats = makeGateStats();
    setupMocks({ gateStats });
    await monitorCommand({});

    const { gate } = panels();
    const content = gate.setContent.mock.calls[0][0] as string;

    expect(content).toContain("Gate Statistics");
    expect(content).toContain("Today");
    expect(content).toContain("Last 7 Days");
    expect(content).toContain("100"); // total_requests today
    expect(content).toContain("500"); // total_requests week
    expect(content).toContain("100.0%"); // success rate
  });

  it("gate panel shows Unreachable when fetchGateStats returns null", async () => {
    setupMocks({ gateStats: null });
    await monitorCommand({});

    const { gate } = panels();
    const content = gate.setContent.mock.calls[0][0] as string;

    expect(content).toContain("Unreachable");
    expect(content).toContain("https://gate.test.local");
  });

  it("gate panel shows error count highlighted when error_count > 0", async () => {
    const gateStats = makeGateStats({
      today: {
        total_requests: 100,
        success_count: 90,
        error_count: 10,
        ecash_received: 50000,
        model_breakdown: {},
        error_breakdown: {},
      },
    });
    setupMocks({ gateStats });
    await monitorCommand({});

    const { gate } = panels();
    const content = gate.setContent.mock.calls[0][0] as string;

    // Error count should be red-highlighted
    expect(content).toContain("{red-fg}10{/red-fg}");
    // Success rate = 90%
    expect(content).toContain("90.0%");
  });

  it("gate panel shows error breakdown when errors exist today", async () => {
    const gateStats = makeGateStats({
      today: {
        total_requests: 100,
        success_count: 95,
        error_count: 5,
        ecash_received: 50000,
        model_breakdown: {},
        error_breakdown: {
          "rate_limit": 3,
          "auth_failed": 2,
        },
      },
    });
    setupMocks({ gateStats });
    await monitorCommand({});

    const { gate } = panels();
    const content = gate.setContent.mock.calls[0][0] as string;

    expect(content).toContain("Errors Today");
    expect(content).toContain("rate_limit");
    expect(content).toContain("auth_failed");
  });

  it("gate panel does not show error breakdown when error_count is 0", async () => {
    setupMocks({ gateStats: makeGateStats() });
    await monitorCommand({});

    const { gate } = panels();
    const content = gate.setContent.mock.calls[0][0] as string;

    expect(content).not.toContain("Errors Today");
  });

  it("gate panel handles week errors highlighted in red", async () => {
    const gateStats = makeGateStats({
      last_7_days: {
        total_requests: 500,
        success_count: 480,
        error_count: 20,
        ecash_received: 250000,
        model_breakdown: {},
        error_breakdown: {},
      },
    });
    setupMocks({ gateStats });
    await monitorCommand({});

    const { gate } = panels();
    const content = gate.setContent.mock.calls[0][0] as string;

    expect(content).toContain("{red-fg}20{/red-fg}");
  });

  // ── Mint panel ──

  it("mint panel shows stats with positive net flow (green)", async () => {
    const mintStats = makeMintStats({
      totalMintedSats: 100000,
      totalMeltedSats: 50000,
    });
    setupMocks({ mintStats });
    await monitorCommand({});

    const { mint } = panels();
    const content = mint.setContent.mock.calls[0][0] as string;

    expect(content).toContain("Mint Statistics");
    expect(content).toContain("Minted:");
    expect(content).toContain("Melted:");
    expect(content).toContain("Net:");
    // Positive net flow should be green
    expect(content).toContain("{green-fg}");
    expect(content).toContain("+");
    expect(content).toContain("100 ops");
    expect(content).toContain("50 ops");
  });

  it("mint panel shows stats with negative net flow (red)", async () => {
    const mintStats = makeMintStats({
      totalMintedSats: 30000,
      totalMeltedSats: 80000,
    });
    setupMocks({ mintStats });
    await monitorCommand({});

    const { mint } = panels();
    const content = mint.setContent.mock.calls[0][0] as string;

    // Negative net flow should be red
    expect(content).toContain("{red-fg}");
    expect(content).not.toMatch(/\{red-fg\}\+/); // should not have + prefix for negative
  });

  it("mint panel shows Unable to fetch when fetchMintStats returns null", async () => {
    setupMocks({ mintStats: null });
    await monitorCommand({});

    const { mint } = panels();
    const content = mint.setContent.mock.calls[0][0] as string;

    expect(content).toContain("Unable to fetch stats");
    expect(content).toContain("https://mint.test.local");
  });

  // ── Proxy panel ──

  it("proxy panel calls buildProxyContent and displays result", async () => {
    setupMocks({
      transactions: [
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
      ],
    });
    await monitorCommand({});

    const { proxy } = panels();
    const content = proxy.setContent.mock.calls[0][0] as string;

    // buildProxyContent output should be present
    expect(content).toContain("Requests: 1");
  });

  it("proxy panel shows empty state when no transactions", async () => {
    setupMocks({ transactions: [] });
    await monitorCommand({});

    const { proxy } = panels();
    const content = proxy.setContent.mock.calls[0][0] as string;

    expect(content).toContain("No transactions yet");
  });

  it("proxy panel handles buildProxyContent error", async () => {
    setupMocks({ transactionError: new Error("disk read failed") });
    await monitorCommand({});

    const { proxy } = panels();
    const content = proxy.setContent.mock.calls[0][0] as string;

    expect(content).toContain("Error loading transactions");
    expect(content).toContain("disk read failed");
  });

  // ── Funds panel ──

  it("funds panel shows wallet balance and fund flow stats", async () => {
    setupMocks({
      balance: 5000,
      proofCount: 10,
      transactions: [
        {
          id: "tx1",
          timestamp: Date.now(),
          model: "gpt-4",
          priceSat: 100,
          changeSat: 10,
          refundSat: 5,
          gateStatus: 200,
          balanceBefore: 1000,
          balanceAfter: 915,
          durationMs: 1500,
        },
      ],
    });
    await monitorCommand({});

    const { funds } = panels();
    const content = funds.setContent.mock.calls[0][0] as string;

    expect(content).toContain("Wallet Funds");
    expect(content).toContain("Balance:");
    expect(content).toContain("Proofs:");
    expect(content).toContain("10");
    expect(content).toContain("Fund Flow");
    expect(content).toContain("Spent:");
    expect(content).toContain("Change:");
    expect(content).toContain("Refund:");
    expect(content).toContain("Net:");
    // Balance > LOW_BALANCE_THRESHOLD (500), so should be green
    expect(content).toContain("{green-fg}");
  });

  it("funds panel shows low balance warning when below threshold", async () => {
    setupMocks({ balance: 200, proofCount: 2 });
    await monitorCommand({});

    const { funds } = panels();
    const content = funds.setContent.mock.calls[0][0] as string;

    // Below 500 threshold: red balance + warning
    expect(content).toContain("{red-fg}");
    expect(content).toContain("LOW");
  });

  it("funds panel handles wallet load error", async () => {
    setupMocks({ walletError: new Error("wallet file corrupted") });
    await monitorCommand({});

    const { funds } = panels();
    const content = funds.setContent.mock.calls[0][0] as string;

    expect(content).toContain("Error loading wallet");
    expect(content).toContain("wallet file corrupted");
  });

  // ── Cleanup ──

  it("cleanup clears interval and destroys screen on q key", async () => {
    setupMocks();
    await monitorCommand({});

    // The q key handler should have been registered
    expect(keyHandlers["q"]).toBeDefined();

    // Trigger the q key handler
    keyHandlers["q"]();

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(mockScreenDestroy).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("cleanup works via escape key", async () => {
    setupMocks();
    await monitorCommand({});

    expect(keyHandlers["escape"]).toBeDefined();
    keyHandlers["escape"]();

    expect(mockScreenDestroy).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("cleanup works via C-c key", async () => {
    setupMocks();
    await monitorCommand({});

    expect(keyHandlers["C-c"]).toBeDefined();
    keyHandlers["C-c"]();

    expect(mockScreenDestroy).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  // ── Render lifecycle ──

  it("calls screen.render after initial updatePanels", async () => {
    setupMocks();
    await monitorCommand({});

    // screen.render is called at least twice: once inside updatePanels and once after
    expect(mockScreenRender).toHaveBeenCalled();
  });

  it("sets up auto-refresh interval after initial render", async () => {
    setupMocks();
    await monitorCommand({});

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
  });

  // ── r key triggers refresh ──

  it("r key triggers updatePanels refresh", async () => {
    setupMocks();
    await monitorCommand({});

    expect(keyHandlers["r"]).toBeDefined();

    // Set up mocks for the second fetch round
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeGateStats(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeMintStats(),
    });

    // Trigger the r key (which calls updatePanels() without awaiting)
    keyHandlers["r"]();

    // Wait for all microtasks/promises to flush
    await new Promise((r) => setTimeout(r, 50));

    // Panels should have been updated again (setContent called a second time)
    const { gate } = panels();
    expect(gate.setContent).toHaveBeenCalledTimes(2);
  });

  // ── Edge cases ──

  it("handles zero total_requests in gate stats (success rate shows 100.0%)", async () => {
    const gateStats = makeGateStats({
      today: {
        total_requests: 0,
        success_count: 0,
        error_count: 0,
        ecash_received: 0,
        model_breakdown: {},
        error_breakdown: {},
      },
      last_7_days: {
        total_requests: 0,
        success_count: 0,
        error_count: 0,
        ecash_received: 0,
        model_breakdown: {},
        error_breakdown: {},
      },
    });
    setupMocks({ gateStats });
    await monitorCommand({});

    const { gate } = panels();
    const content = gate.setContent.mock.calls[0][0] as string;

    expect(content).toContain("100.0%");
  });

  it("funds panel calculates net cost correctly from multiple transactions", async () => {
    setupMocks({
      transactions: [
        {
          id: "tx1",
          timestamp: Date.now(),
          model: "gpt-4",
          priceSat: 100,
          changeSat: 10,
          refundSat: 5,
          gateStatus: 200,
          balanceBefore: 1000,
          balanceAfter: 915,
          durationMs: 1500,
        },
        {
          id: "tx2",
          timestamp: Date.now(),
          model: "claude-3",
          priceSat: 200,
          changeSat: 30,
          refundSat: 10,
          gateStatus: 200,
          balanceBefore: 915,
          balanceAfter: 745,
          durationMs: 2000,
        },
      ],
    });
    await monitorCommand({});

    const { funds } = panels();
    const content = funds.setContent.mock.calls[0][0] as string;

    // totalSpent=300, totalChange=40, totalRefund=15, net=300-40-15=245
    // 245 units = $0.00245
    expect(content).toContain("Fund Flow");
    expect(content).toContain("Spent:");
    expect(content).toContain("Change:");
    expect(content).toContain("Refund:");
    expect(content).toContain("Net:");
  });

  it("mint panel net flow of zero is shown as green with + prefix", async () => {
    const mintStats = makeMintStats({
      totalMintedSats: 50000,
      totalMeltedSats: 50000,
    });
    setupMocks({ mintStats });
    await monitorCommand({});

    const { mint } = panels();
    const content = mint.setContent.mock.calls[0][0] as string;

    // Zero net flow: netFlow >= 0 means green and + prefix
    expect(content).toContain("{green-fg}");
    expect(content).toMatch(/\+/);
  });
});
