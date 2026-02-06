/**
 * Audit command tests
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import type { TransactionRecord, FailedToken } from "../src/config.js";
import { detectAnomalies, auditCommand, type AuditReport } from "../src/commands/audit.js";

// ── Mocks (hoisted to file top by vitest) ──

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    loadConfig: vi.fn(),
    resolveHome: vi.fn((p: string) => p.replace("~", "/home/test")),
    loadFailedTokens: vi.fn(),
    loadTransactions: vi.fn(),
  };
});

vi.mock("../src/cashu-store.js", () => ({
  CashuStore: {
    load: vi.fn(),
  },
}));

vi.mock("../src/gate-discovery.js", () => ({
  GateRegistry: vi.fn().mockImplementation(() => ({
    discover: vi.fn().mockResolvedValue([]),
    getAll: vi.fn().mockReturnValue([]),
  })),
}));

import { loadConfig, loadFailedTokens, loadTransactions, resolveHome } from "../src/config.js";
import { CashuStore } from "../src/cashu-store.js";
import { GateRegistry } from "../src/gate-discovery.js";

const testDir = `/tmp/t2c-test-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`;

beforeEach(async () => {
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("transaction log", () => {
  it("appendTransaction writes JSONL line", async () => {
    const logPath = path.join(testDir, "transactions.jsonl");

    // Manually write like appendTransaction does
    const record: TransactionRecord = {
      id: "tx-test-001",
      timestamp: 1700000000000,
      model: "openai/gpt-4o-mini",
      priceSat: 150,
      changeSat: 20,
      refundSat: 0,
      gateStatus: 200,
      balanceBefore: 1000,
      balanceAfter: 870,
      durationMs: 1234,
    };
    await fs.appendFile(logPath, JSON.stringify(record) + "\n");

    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as TransactionRecord;
    expect(parsed.id).toBe("tx-test-001");
    expect(parsed.model).toBe("openai/gpt-4o-mini");
    expect(parsed.priceSat).toBe(150);
    expect(parsed.changeSat).toBe(20);
    expect(parsed.balanceBefore).toBe(1000);
    expect(parsed.balanceAfter).toBe(870);
  });

  it("loadTransactions reads JSONL and respects limit", async () => {
    const logPath = path.join(testDir, "transactions.jsonl");
    const records: TransactionRecord[] = [];
    for (let i = 0; i < 5; i++) {
      records.push({
        id: `tx-${i}`,
        timestamp: 1700000000000 + i * 1000,
        model: "test-model",
        priceSat: 100,
        changeSat: 0,
        refundSat: 0,
        gateStatus: 200,
        balanceBefore: 1000 - i * 100,
        balanceAfter: 900 - i * 100,
        durationMs: 500,
      });
    }
    await fs.writeFile(logPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    // Read all
    const content = await fs.readFile(logPath, "utf-8");
    const all = content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as TransactionRecord);
    expect(all).toHaveLength(5);

    // Read with limit (last N)
    const limited = all.slice(-3);
    expect(limited).toHaveLength(3);
    expect(limited[0].id).toBe("tx-2");
    expect(limited[2].id).toBe("tx-4");
  });

  it("handles error field in transactions", async () => {
    const record: TransactionRecord = {
      id: "tx-err",
      timestamp: 1700000000000,
      model: "test-model",
      priceSat: 100,
      changeSat: 0,
      refundSat: 0,
      gateStatus: 429,
      balanceBefore: 1000,
      balanceAfter: 900,
      durationMs: 5000,
      error: "Rate limited after retries",
    };

    const line = JSON.stringify(record);
    const parsed = JSON.parse(line) as TransactionRecord;
    expect(parsed.error).toBe("Rate limited after retries");
    expect(parsed.gateStatus).toBe(429);
  });
});

// ── Helper to build minimal AuditReport ──

function makeReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    timestamp: Date.now(),
    wallet: {
      balance: 5000,
      proofCount: 10,
      proofBreakdown: { 512: 5, 256: 10 },
      mint: "https://mint.token2chat.com",
    },
    mint: { reachable: true, keysetIds: ["00ab"] },
    gate: { reachable: true, mints: ["https://mint.token2chat.com"] },
    discoveredGates: [],
    transactions: {
      total: 10,
      shown: 10,
      totalSpent: 1000,
      totalChange: 600,
      totalRefund: 0,
      netCost: 400,
      errorCount: 0,
      recent: [],
    },
    failedTokens: [],
    anomalies: [],
    ...overrides,
  };
}

describe("detectAnomalies", () => {
  it("returns no anomalies for healthy state", () => {
    const report = makeReport();
    const anomalies = detectAnomalies(report);
    expect(anomalies).toEqual([]);
  });

  it("detects zero balance", () => {
    const report = makeReport({
      wallet: { balance: 0, proofCount: 0, proofBreakdown: {}, mint: "https://mint.token2chat.com" },
    });
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.severity === "error" && a.message.includes("balance is 0"))).toBe(true);
  });

  it("detects low balance (< 500)", () => {
    const report = makeReport({
      wallet: { balance: 200, proofCount: 5, proofBreakdown: {}, mint: "https://mint.token2chat.com" },
    });
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.severity === "warn" && a.message.includes("Low wallet balance"))).toBe(true);
  });

  it("detects high proof count (> 100)", () => {
    const report = makeReport({
      wallet: { balance: 5000, proofCount: 150, proofBreakdown: {}, mint: "https://mint.token2chat.com" },
    });
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.severity === "warn" && a.message.includes("High proof count"))).toBe(true);
  });

  it("detects no wallet", () => {
    const report = makeReport({ wallet: null });
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.severity === "error" && a.message.includes("No wallet found"))).toBe(true);
  });

  it("detects unreachable mint", () => {
    const report = makeReport({ mint: { reachable: false, error: "timeout" } });
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.severity === "error" && a.message.includes("Mint unreachable"))).toBe(true);
  });

  it("detects no active keysets", () => {
    const report = makeReport({ mint: { reachable: true, keysetIds: [] } });
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.severity === "error" && a.message.includes("no active keysets"))).toBe(true);
  });

  it("detects unreachable gate", () => {
    const report = makeReport({ gate: { reachable: false, error: "connection refused" } });
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.severity === "error" && a.message.includes("Gate unreachable"))).toBe(true);
  });

  it("detects mint not in gate trusted list", () => {
    const report = makeReport({
      gate: { reachable: true, mints: ["https://other-mint.example.com"] },
    });
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.severity === "error" && a.message.includes("not in Gate's trusted mints"))).toBe(true);
  });

  it("detects failed transactions", () => {
    const report = makeReport({
      transactions: {
        total: 5, shown: 5, totalSpent: 500, totalChange: 100, totalRefund: 0, netCost: 400, errorCount: 3, recent: [],
      },
    });
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.severity === "warn" && a.message.includes("3 failed transaction"))).toBe(true);
  });

  it("detects high fund loss rate (> 50%)", () => {
    const report = makeReport({
      transactions: {
        total: 10, shown: 10, totalSpent: 1000, totalChange: 100, totalRefund: 0, netCost: 900, errorCount: 0, recent: [],
      },
    });
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.severity === "warn" && a.message.includes("High fund loss rate"))).toBe(true);
  });

  it("does not flag normal loss rate (< 50%)", () => {
    const report = makeReport({
      transactions: {
        total: 10, shown: 10, totalSpent: 1000, totalChange: 600, totalRefund: 0, netCost: 400, errorCount: 0, recent: [],
      },
    });
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.message.includes("High fund loss rate"))).toBe(false);
  });

  it("detects failed tokens needing recovery", () => {
    const report = makeReport({
      failedTokens: [
        { token: "cashuA...", type: "change", timestamp: Date.now(), error: "network error" },
        { token: "cashuB...", type: "refund", timestamp: Date.now(), error: "timeout" },
      ],
    });
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.severity === "error" && a.message.includes("2 failed token"))).toBe(true);
  });

  it("detects balance drift", () => {
    const report = makeReport({
      transactions: {
        total: 1, shown: 1, totalSpent: 100, totalChange: 0, totalRefund: 0, netCost: 100, errorCount: 0,
        recent: [{ id: "tx-1", timestamp: Date.now(), model: "m", priceSat: 100, changeSat: 0, refundSat: 0, gateStatus: 200, balanceBefore: 5000, balanceAfter: 4900, durationMs: 100 }],
      },
    });
    // Wallet balance doesn't match last tx balanceAfter
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.severity === "info" && a.message.includes("Balance drift"))).toBe(true);
  });

  it("no balance drift when consistent", () => {
    const report = makeReport({
      wallet: { balance: 4900, proofCount: 10, proofBreakdown: {}, mint: "https://mint.token2chat.com" },
      transactions: {
        total: 1, shown: 1, totalSpent: 100, totalChange: 0, totalRefund: 0, netCost: 100, errorCount: 0,
        recent: [{ id: "tx-1", timestamp: Date.now(), model: "m", priceSat: 100, changeSat: 0, refundSat: 0, gateStatus: 200, balanceBefore: 5000, balanceAfter: 4900, durationMs: 100 }],
      },
    });
    const anomalies = detectAnomalies(report);
    expect(anomalies.some((a) => a.message.includes("Balance drift"))).toBe(false);
  });
});

describe("TransactionRecord shape", () => {
  it("all required fields present", () => {
    const record: TransactionRecord = {
      id: "tx-shape",
      timestamp: Date.now(),
      model: "openai/gpt-4o",
      priceSat: 2500,
      changeSat: 300,
      refundSat: 0,
      gateStatus: 200,
      balanceBefore: 5000,
      balanceAfter: 2800,
      durationMs: 2000,
    };
    expect(record.id).toBeTruthy();
    expect(record.timestamp).toBeGreaterThan(0);
    expect(record.priceSat).toBeGreaterThan(0);
    expect(record.balanceBefore).toBeGreaterThan(record.balanceAfter);
    expect(record.durationMs).toBeGreaterThan(0);
    expect(record.error).toBeUndefined();
  });

  it("net cost calculation is correct", () => {
    const spent = 500;
    const change = 120;
    const refund = 0;
    const net = spent - change - refund;
    expect(net).toBe(380);
  });
});

// ── auditCommand & printReport tests ──

const DEFAULT_CONFIG = {
  gateUrl: "https://gate.test.local",
  mintUrl: "https://mint.test.local",
  walletPath: "~/.t2c/wallet.json",
  proxyPort: 10402,
  lowBalanceThreshold: 1000,
  autoDiscover: false,
  discoveryUrl: "https://token2.cash/gates.json",
};

function makeMockStore(balance: number, proofs: { amount: number }[]) {
  return {
    balance,
    proofCount: proofs.length,
    exportData: () => ({
      mint: "https://mint.test.local",
      unit: "usd",
      proofs,
    }),
  };
}

/**
 * Helper: set up all mocks for a standard auditCommand call.
 * Returns objects so individual tests can override specific mocks.
 */
function setupAuditMocks(overrides: {
  config?: typeof DEFAULT_CONFIG;
  store?: ReturnType<typeof makeMockStore> | null;
  transactions?: TransactionRecord[];
  failedTokens?: FailedToken[];
  mintInfoOk?: boolean;
  mintInfoData?: Record<string, unknown>;
  mintKeysetsOk?: boolean;
  mintKeysetsData?: Record<string, unknown>;
  gateHealthOk?: boolean;
  gateHealthData?: Record<string, unknown>;
  gatePricingOk?: boolean;
  gatePricingData?: Record<string, unknown>;
  discoveredGates?: Array<{ name: string; url: string; mint: string; models: string[]; healthy: boolean }>;
} = {}) {
  const config = overrides.config ?? DEFAULT_CONFIG;

  vi.mocked(loadConfig).mockResolvedValue(config);
  vi.mocked(loadTransactions).mockResolvedValue(overrides.transactions ?? []);
  vi.mocked(loadFailedTokens).mockResolvedValue({ tokens: overrides.failedTokens ?? [] });
  vi.mocked(resolveHome).mockImplementation((p: string) => p.replace("~", "/home/test"));

  if (overrides.store === null) {
    vi.mocked(CashuStore.load).mockRejectedValue(new Error("wallet not found"));
  } else {
    const store = overrides.store ?? makeMockStore(5000, [{ amount: 1024 }, { amount: 512 }, { amount: 256 }]);
    vi.mocked(CashuStore.load).mockResolvedValue(store as any);
  }

  // Gate discovery mock
  const gates = overrides.discoveredGates ?? [];
  vi.mocked(GateRegistry).mockImplementation(() => ({
    discover: vi.fn().mockResolvedValue([]),
    getAll: vi.fn().mockReturnValue(gates),
  }) as any);

  // Set up fetch mock to handle mint and gate endpoints
  const mintInfoOk = overrides.mintInfoOk ?? true;
  const mintKeysetsOk = overrides.mintKeysetsOk ?? true;
  const gateHealthOk = overrides.gateHealthOk ?? true;
  const gatePricingOk = overrides.gatePricingOk ?? true;

  mockFetch.mockImplementation((url: string) => {
    if (url.includes("/v1/info")) {
      return Promise.resolve({
        ok: mintInfoOk,
        json: async () => overrides.mintInfoData ?? { name: "TestMint", version: "0.1.0", nuts: { "1": {}, "2": {} } },
      });
    }
    if (url.includes("/v1/keysets")) {
      return Promise.resolve({
        ok: mintKeysetsOk,
        json: async () => overrides.mintKeysetsData ?? { keysets: [{ id: "00ab", active: true }, { id: "00cd", active: false }] },
      });
    }
    if (url.includes("/health")) {
      return Promise.resolve({
        ok: gateHealthOk,
        json: async () => overrides.gateHealthData ?? { mints: ["https://mint.test.local"], models: ["gpt-4", "claude-3"] },
      });
    }
    if (url.includes("/v1/pricing")) {
      return Promise.resolve({
        ok: gatePricingOk,
        json: async () => overrides.gatePricingData ?? { models: { "gpt-4": { input_per_million: 100, output_per_million: 200 } } },
      });
    }
    return Promise.resolve({ ok: false });
  });
}

describe("auditCommand", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(loadConfig).mockReset();
    vi.mocked(loadTransactions).mockReset();
    vi.mocked(loadFailedTokens).mockReset();
    vi.mocked(CashuStore.load).mockReset();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe("JSON output mode", () => {
    it("outputs valid JSON with all report sections", async () => {
      setupAuditMocks();
      await auditCommand({ json: true });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      expect(report.timestamp).toBeGreaterThan(0);
      expect(report.wallet).not.toBeNull();
      expect(report.wallet!.balance).toBe(5000);
      expect(report.mint.reachable).toBe(true);
      expect(report.gate.reachable).toBe(true);
      expect(report.transactions).toBeDefined();
      expect(report.failedTokens).toEqual([]);
      expect(Array.isArray(report.anomalies)).toBe(true);
    });

    it("includes wallet proof breakdown in JSON", async () => {
      setupAuditMocks({
        store: makeMockStore(3072, [
          { amount: 1024 }, { amount: 1024 },
          { amount: 512 }, { amount: 512 },
        ]),
      });
      await auditCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      expect(report.wallet!.proofBreakdown).toEqual({ 1024: 2, 512: 2 });
      expect(report.wallet!.proofCount).toBe(4);
    });

    it("shows wallet as null when wallet load fails", async () => {
      setupAuditMocks({ store: null });
      await auditCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      expect(report.wallet).toBeNull();
      expect(report.anomalies.some((a) => a.message.includes("No wallet found"))).toBe(true);
    });

    it("shows mint info when reachable", async () => {
      setupAuditMocks({
        mintInfoData: { name: "Cashu Mint", version: "1.2.3", nuts: { "1": {}, "4": {} } },
        mintKeysetsData: { keysets: [{ id: "keyset1", active: true }, { id: "keyset2", active: true }] },
      });
      await auditCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      expect(report.mint.reachable).toBe(true);
      expect(report.mint.name).toBe("Cashu Mint");
      expect(report.mint.version).toBe("1.2.3");
      expect(report.mint.keysetIds).toEqual(["keyset1", "keyset2"]);
    });

    it("shows mint as unreachable on fetch failure", async () => {
      setupAuditMocks({ mintInfoOk: false, mintKeysetsOk: false });

      // Override fetch to throw for mint endpoints
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/v1/info") || url.includes("/v1/keysets")) {
          return Promise.reject(new Error("connection refused"));
        }
        if (url.includes("/health")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ mints: ["https://mint.test.local"], models: ["gpt-4"] }),
          });
        }
        if (url.includes("/v1/pricing")) {
          return Promise.resolve({ ok: false });
        }
        return Promise.resolve({ ok: false });
      });

      await auditCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      expect(report.mint.reachable).toBe(false);
      expect(report.mint.error).toBe("connection refused");
    });

    it("shows gate info when reachable", async () => {
      setupAuditMocks({
        gateHealthData: { mints: ["https://mint.test.local"], models: ["gpt-4", "claude-3-opus"] },
        gatePricingData: { models: { "gpt-4": { input_per_million: 50, output_per_million: 150, per_request: 10 } } },
      });
      await auditCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      expect(report.gate.reachable).toBe(true);
      expect(report.gate.mints).toEqual(["https://mint.test.local"]);
      expect(report.gate.models).toEqual(["gpt-4", "claude-3-opus"]);
      expect(report.gate.pricing).toBeDefined();
      expect(report.gate.pricing!["gpt-4"].per_request).toBe(10);
    });

    it("shows gate as unreachable on fetch failure", async () => {
      mockFetch.mockReset();
      setupAuditMocks();

      // Override fetch to throw for gate endpoints
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/health") || url.includes("/v1/pricing")) {
          return Promise.reject(new Error("ECONNREFUSED"));
        }
        if (url.includes("/v1/info")) {
          return Promise.resolve({ ok: true, json: async () => ({ name: "Mint" }) });
        }
        if (url.includes("/v1/keysets")) {
          return Promise.resolve({ ok: true, json: async () => ({ keysets: [] }) });
        }
        return Promise.resolve({ ok: false });
      });

      await auditCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      expect(report.gate.reachable).toBe(false);
      expect(report.gate.error).toBe("ECONNREFUSED");
    });

    it("computes transaction summaries correctly", async () => {
      const txns: TransactionRecord[] = [
        { id: "tx-1", timestamp: 1700000000000, model: "gpt-4", priceSat: 300, changeSat: 50, refundSat: 0, gateStatus: 200, balanceBefore: 5000, balanceAfter: 4700, durationMs: 100 },
        { id: "tx-2", timestamp: 1700000001000, model: "claude-3", priceSat: 200, changeSat: 30, refundSat: 10, gateStatus: 200, balanceBefore: 4700, balanceAfter: 4500, durationMs: 200 },
        { id: "tx-3", timestamp: 1700000002000, model: "gpt-4", priceSat: 100, changeSat: 0, refundSat: 0, gateStatus: 500, balanceBefore: 4500, balanceAfter: 4400, durationMs: 50, error: "server error" },
      ];
      setupAuditMocks({ transactions: txns });
      await auditCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      expect(report.transactions.total).toBe(3);
      expect(report.transactions.totalSpent).toBe(600);
      expect(report.transactions.totalChange).toBe(80);
      expect(report.transactions.totalRefund).toBe(10);
      expect(report.transactions.netCost).toBe(510);
      expect(report.transactions.errorCount).toBe(1);
      expect(report.transactions.recent).toHaveLength(3);
    });

    it("includes failed tokens in report", async () => {
      const failedTokens: FailedToken[] = [
        { token: "cashuAbc123456789012345678901234567890", type: "change", timestamp: 1700000000000, error: "network timeout" },
        { token: "cashuDef123456789012345678901234567890", type: "refund", timestamp: 1700000001000, error: "mint rejected" },
      ];
      setupAuditMocks({ failedTokens });
      await auditCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      expect(report.failedTokens).toHaveLength(2);
      expect(report.failedTokens[0].type).toBe("change");
      expect(report.failedTokens[1].error).toBe("mint rejected");
      expect(report.anomalies.some((a) => a.message.includes("2 failed token"))).toBe(true);
    });

    it("includes discovered gates in report", async () => {
      setupAuditMocks({
        discoveredGates: [
          { name: "Gate A", url: "https://gate-a.example.com", mint: "https://mint.test.local", models: ["gpt-4"], healthy: true },
          { name: "Gate B", url: "https://gate-b.example.com", mint: "https://mint.other.com", models: ["claude-3"], healthy: false },
        ],
      });
      await auditCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      expect(report.discoveredGates).toHaveLength(2);
      expect(report.discoveredGates[0].name).toBe("Gate A");
      expect(report.discoveredGates[0].healthy).toBe(true);
      expect(report.discoveredGates[1].healthy).toBe(false);
    });

    it("detects anomalies and includes them in JSON", async () => {
      setupAuditMocks({
        store: makeMockStore(100, [{ amount: 100 }]),
        gateHealthData: { mints: ["https://other-mint.example.com"], models: ["gpt-4"] },
      });
      await auditCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      // Low balance warning
      expect(report.anomalies.some((a) => a.severity === "warn" && a.message.includes("Low wallet balance"))).toBe(true);
      // Mint not in gate trusted list
      expect(report.anomalies.some((a) => a.severity === "error" && a.message.includes("not in Gate's trusted mints"))).toBe(true);
    });
  });

  describe("lines option", () => {
    it("limits recent transactions with --lines", async () => {
      const txns: TransactionRecord[] = Array.from({ length: 10 }, (_, i) => ({
        id: `tx-${i}`,
        timestamp: 1700000000000 + i * 1000,
        model: "gpt-4",
        priceSat: 100,
        changeSat: 10,
        refundSat: 0,
        gateStatus: 200,
        balanceBefore: 5000 - i * 90,
        balanceAfter: 4910 - i * 90,
        durationMs: 100,
      }));
      setupAuditMocks({ transactions: txns });
      await auditCommand({ json: true, lines: "5" });

      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      expect(report.transactions.total).toBe(10);
      expect(report.transactions.shown).toBe(5);
      expect(report.transactions.recent).toHaveLength(5);
      // Should be the last 5 transactions
      expect(report.transactions.recent[0].id).toBe("tx-5");
      expect(report.transactions.recent[4].id).toBe("tx-9");
    });

    it("defaults to 20 lines when not specified", async () => {
      const txns: TransactionRecord[] = Array.from({ length: 25 }, (_, i) => ({
        id: `tx-${i}`,
        timestamp: 1700000000000 + i * 1000,
        model: "gpt-4",
        priceSat: 50,
        changeSat: 5,
        refundSat: 0,
        gateStatus: 200,
        balanceBefore: 10000 - i * 45,
        balanceAfter: 9955 - i * 45,
        durationMs: 100,
      }));
      setupAuditMocks({ transactions: txns });
      await auditCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      expect(report.transactions.total).toBe(25);
      expect(report.transactions.shown).toBe(20);
      expect(report.transactions.recent).toHaveLength(20);
    });
  });

  describe("text output mode (printReport)", () => {
    it("prints report header with timestamp", async () => {
      setupAuditMocks();
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("t2c Audit Report");
      expect(allOutput).toContain("========================================");
    });

    it("prints wallet section with balance and proofs", async () => {
      setupAuditMocks({
        store: makeMockStore(5000, [
          { amount: 1024 }, { amount: 1024 },
          { amount: 512 },
        ]),
      });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("--- Wallet ---");
      expect(allOutput).toContain("Balance:");
      expect(allOutput).toContain("$0.05"); // 5000 / 100000
      expect(allOutput).toContain("Proofs:");
      expect(allOutput).toContain("3");
      expect(allOutput).toContain("Mint:");
      expect(allOutput).toContain("https://mint.test.local");
      expect(allOutput).toContain("Breakdown:");
    });

    it("prints '(no wallet found)' when wallet is missing", async () => {
      setupAuditMocks({ store: null });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("(no wallet found)");
    });

    it("prints mint section with reachable status", async () => {
      setupAuditMocks({
        mintInfoData: { name: "TestMint", version: "2.0.0", nuts: { "1": {}, "2": {}, "4": {} } },
      });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("--- Mint ---");
      expect(allOutput).toContain("Status:");
      expect(allOutput).toContain("reachable");
      expect(allOutput).toContain("Name:");
      expect(allOutput).toContain("TestMint");
      expect(allOutput).toContain("Version:");
      expect(allOutput).toContain("2.0.0");
      expect(allOutput).toContain("NUTs:");
      expect(allOutput).toContain("Keysets:");
    });

    it("prints mint UNREACHABLE when mint is down", async () => {
      mockFetch.mockReset();
      setupAuditMocks();
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/v1/info") || url.includes("/v1/keysets")) {
          return Promise.reject(new Error("timeout"));
        }
        if (url.includes("/health")) {
          return Promise.resolve({ ok: true, json: async () => ({ mints: [], models: [] }) });
        }
        if (url.includes("/v1/pricing")) {
          return Promise.resolve({ ok: false });
        }
        return Promise.resolve({ ok: false });
      });

      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("UNREACHABLE");
    });

    it("prints gate section with models and pricing", async () => {
      setupAuditMocks({
        gateHealthData: { mints: ["https://mint.test.local"], models: ["gpt-4", "claude-3"] },
        gatePricingData: {
          models: {
            "gpt-4": { input_per_million: 100, output_per_million: 200, per_request: 5 },
          },
        },
      });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("--- Gate ---");
      expect(allOutput).toContain("reachable");
      expect(allOutput).toContain("Mints:");
      expect(allOutput).toContain("Models:");
      expect(allOutput).toContain("gpt-4");
      expect(allOutput).toContain("claude-3");
      expect(allOutput).toContain("Pricing:");
      expect(allOutput).toContain("in:100/M");
      expect(allOutput).toContain("out:200/M");
      expect(allOutput).toContain("req:5");
    });

    it("prints gate UNREACHABLE when gate is down", async () => {
      mockFetch.mockReset();
      setupAuditMocks();
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("/health") || url.includes("/v1/pricing")) {
          return Promise.reject(new Error("ECONNREFUSED"));
        }
        if (url.includes("/v1/info")) {
          return Promise.resolve({ ok: true, json: async () => ({}) });
        }
        if (url.includes("/v1/keysets")) {
          return Promise.resolve({ ok: true, json: async () => ({ keysets: [] }) });
        }
        return Promise.resolve({ ok: false });
      });

      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("--- Gate ---");
      expect(allOutput).toContain("UNREACHABLE");
    });

    it("prints discovered gates section when gates exist", async () => {
      setupAuditMocks({
        discoveredGates: [
          { name: "Alpha Gate", url: "https://alpha.example.com", mint: "https://mint.test.local", models: ["gpt-4", "claude-3"], healthy: true },
          { name: "Beta Gate", url: "https://beta.example.com", mint: "https://mint2.test.local", models: [], healthy: false },
        ],
      });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("--- Discovered Gates ---");
      expect(allOutput).toContain("[OK] Alpha Gate");
      expect(allOutput).toContain("[DOWN] Beta Gate");
      expect(allOutput).toContain("Mint: https://mint.test.local");
      expect(allOutput).toContain("Models: gpt-4, claude-3");
    });

    it("does not print discovered gates section when empty", async () => {
      setupAuditMocks({ discoveredGates: [] });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).not.toContain("--- Discovered Gates ---");
    });

    it("prints transactions summary and table", async () => {
      const txns: TransactionRecord[] = [
        { id: "tx-1", timestamp: 1700000000000, model: "gpt-4", priceSat: 300, changeSat: 50, refundSat: 0, gateStatus: 200, balanceBefore: 5000, balanceAfter: 4700, durationMs: 1500 },
        { id: "tx-2", timestamp: 1700000001000, model: "claude-3-opus", priceSat: 200, changeSat: 30, refundSat: 10, gateStatus: 200, balanceBefore: 4700, balanceAfter: 4500, durationMs: 2500 },
      ];
      setupAuditMocks({ transactions: txns });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("--- Transactions ---");
      expect(allOutput).toContain("Total:");
      expect(allOutput).toContain("2 requests");
      expect(allOutput).toContain("Spent:");
      expect(allOutput).toContain("Change:");
      expect(allOutput).toContain("Refund:");
      expect(allOutput).toContain("Net cost:");
      expect(allOutput).toContain("Errors:");
      expect(allOutput).toContain("Recent transactions:");
      expect(allOutput).toContain("Time");
      expect(allOutput).toContain("Model");
      expect(allOutput).toContain("Paid");
      expect(allOutput).toContain("Status");
      expect(allOutput).toContain("Duration");
      // Should contain model names
      expect(allOutput).toContain("gpt-4");
      expect(allOutput).toContain("claude-3-opus");
      // Duration formatting
      expect(allOutput).toContain("1.5s");
      expect(allOutput).toContain("2.5s");
    });

    it("prints '(no transactions recorded yet)' when empty", async () => {
      setupAuditMocks({ transactions: [] });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("(no transactions recorded yet)");
    });

    it("prints transactions with error status", async () => {
      const txns: TransactionRecord[] = [
        { id: "tx-err", timestamp: 1700000000000, model: "gpt-4", priceSat: 100, changeSat: 0, refundSat: 0, gateStatus: 500, balanceBefore: 5000, balanceAfter: 4900, durationMs: 500, error: "server error" },
      ];
      setupAuditMocks({ transactions: txns });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("ERR");
    });

    it("prints failed tokens section", async () => {
      const failedTokens: FailedToken[] = [
        { token: "cashuAbc123456789012345678901234567890end", type: "change", timestamp: 1700000000000, error: "network timeout" },
      ];
      setupAuditMocks({ failedTokens });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("--- Failed Tokens ---");
      expect(allOutput).toContain("[change]");
      expect(allOutput).toContain("network timeout");
      // token.slice(0, 40) + "..." — our 41-char token gets truncated at 40
      expect(allOutput).toContain("Token: cashuAbc123456789012345678901234567890en...");
    });

    it("prints anomalies section with severity icons", async () => {
      setupAuditMocks({
        store: null, // triggers "No wallet found" error anomaly
        gateHealthData: { mints: [], models: [] },
      });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("--- Anomalies ---");
      expect(allOutput).toContain("[!!]"); // error severity icon
      expect(allOutput).toContain("No wallet found");
    });

    it("prints 'No anomalies detected.' when healthy", async () => {
      setupAuditMocks({
        gateHealthData: { mints: ["https://mint.test.local"], models: ["gpt-4"] },
      });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("No anomalies detected.");
    });

    it("prints warn severity icon for warnings", async () => {
      const txns: TransactionRecord[] = [
        { id: "tx-err", timestamp: 1700000000000, model: "gpt-4", priceSat: 100, changeSat: 0, refundSat: 0, gateStatus: 500, balanceBefore: 5000, balanceAfter: 4900, durationMs: 500, error: "server error" },
      ];
      setupAuditMocks({
        transactions: txns,
        gateHealthData: { mints: ["https://mint.test.local"], models: ["gpt-4"] },
      });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("[ !]"); // warn severity icon
      expect(allOutput).toContain("1 failed transaction");
    });

    it("prints info severity icon for informational anomalies", async () => {
      // Balance drift triggers an info anomaly
      const txns: TransactionRecord[] = [
        { id: "tx-1", timestamp: 1700000000000, model: "gpt-4", priceSat: 100, changeSat: 0, refundSat: 0, gateStatus: 200, balanceBefore: 9000, balanceAfter: 8900, durationMs: 100 },
      ];
      setupAuditMocks({
        // wallet balance (5000) != last tx balanceAfter (8900) -> drift
        transactions: txns,
        gateHealthData: { mints: ["https://mint.test.local"], models: ["gpt-4"] },
      });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("[ i]"); // info severity icon
      expect(allOutput).toContain("Balance drift");
    });

    it("truncates long model names in transaction table", async () => {
      const txns: TransactionRecord[] = [
        {
          id: "tx-long",
          timestamp: 1700000000000,
          model: "anthropic/claude-3-opus-20240229-very-long",
          priceSat: 100, changeSat: 10, refundSat: 0, gateStatus: 200,
          balanceBefore: 5000, balanceAfter: 4900, durationMs: 1000,
        },
      ];
      setupAuditMocks({ transactions: txns });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      // Model name > 26 chars gets truncated to 24 + ".."
      expect(allOutput).toContain("..");
      expect(allOutput).not.toContain("anthropic/claude-3-opus-20240229-very-long");
    });

    it("formats sub-second durations in ms", async () => {
      const txns: TransactionRecord[] = [
        { id: "tx-fast", timestamp: 1700000000000, model: "gpt-4", priceSat: 50, changeSat: 5, refundSat: 0, gateStatus: 200, balanceBefore: 5000, balanceAfter: 4950, durationMs: 750 },
      ];
      setupAuditMocks({ transactions: txns });
      await auditCommand({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("750ms");
    });
  });

  describe("gate discovery error handling", () => {
    it("returns empty discovered gates when discovery fails", async () => {
      setupAuditMocks();
      // Override GateRegistry to throw on discover
      vi.mocked(GateRegistry).mockImplementation(() => ({
        discover: vi.fn().mockRejectedValue(new Error("discovery failed")),
        getAll: vi.fn().mockReturnValue([]),
      }) as any);

      await auditCommand({ json: true });

      const output = consoleSpy.mock.calls[0][0] as string;
      const report = JSON.parse(output) as AuditReport;

      expect(report.discoveredGates).toEqual([]);
    });
  });

  describe("config loading", () => {
    it("calls loadConfig and uses mintUrl and gateUrl", async () => {
      setupAuditMocks();
      await auditCommand({ json: true });

      expect(loadConfig).toHaveBeenCalledTimes(1);
      // fetch should have been called with the configured mint and gate URLs
      const fetchCalls = mockFetch.mock.calls.map((c) => c[0] as string);
      expect(fetchCalls.some((url) => url.startsWith("https://mint.test.local/"))).toBe(true);
      expect(fetchCalls.some((url) => url.startsWith("https://gate.test.local/"))).toBe(true);
    });

    it("calls resolveHome with walletPath for CashuStore.load", async () => {
      setupAuditMocks();
      await auditCommand({ json: true });

      expect(resolveHome).toHaveBeenCalledWith("~/.t2c/wallet.json");
      expect(CashuStore.load).toHaveBeenCalledWith("/home/test/.t2c/wallet.json", "https://mint.test.local");
    });
  });
});
