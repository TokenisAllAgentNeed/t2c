/**
 * Mint command tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

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
    }),
    resolveHome: vi.fn((p: string) => p.replace("~", "/home/test")),
    CONFIG_DIR: "/tmp/t2c-test-mint",
    formatUnits: vi.fn((v: number) => `$${(v / 100000).toFixed(2)}`),
  };
});

vi.mock("../src/cashu-store.js", () => ({
  CashuStore: {
    load: vi.fn().mockResolvedValue({
      balance: 5000,
      proofCount: 10,
      mintFromQuote: vi.fn(),
      createMintQuote: vi.fn(),
      mintFromDeposit: vi.fn(),
    }),
  },
}));

vi.mock("../src/chain-scan.js", () => ({
  scanDeposits: vi.fn(),
  CHAIN_CONFIGS: [
    { name: "Base", rpcUrl: "https://base.drpc.org", tokens: [{ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }] },
    { name: "Ethereum", rpcUrl: "https://eth.drpc.org", tokens: [{ symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }] },
    { name: "Arbitrum", rpcUrl: "https://arbitrum.drpc.org", tokens: [{ symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 }] },
  ],
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import fs from "node:fs/promises";
import { mintCommand } from "../src/commands/mint.js";
import { CashuStore } from "../src/cashu-store.js";
import { scanDeposits } from "../src/chain-scan.js";

const mockScanDeposits = vi.mocked(scanDeposits);

describe("mintCommand", () => {
  let logOutput: string;
  let errOutput: string;
  let warnOutput: string;
  const originalLog = console.log;
  const originalErr = console.error;
  const originalWarn = console.warn;
  const originalExit = process.exit;
  const mockedLoad = vi.mocked(CashuStore.load);

  function setupWallet(overrides: Record<string, unknown> = {}) {
    const mintFromQuote = vi.fn();
    const createMintQuote = vi.fn();
    const mintFromDeposit = vi.fn();
    const wallet = { balance: 5000, proofCount: 10, mintFromQuote, createMintQuote, mintFromDeposit, ...overrides };
    mockedLoad.mockResolvedValue(wallet as any);
    return { mintFromQuote, createMintQuote, mintFromDeposit };
  }

  beforeEach(() => {
    logOutput = "";
    errOutput = "";
    warnOutput = "";
    console.log = (...args) => { logOutput += args.join(" ") + "\n"; };
    console.error = (...args) => { errOutput += args.join(" ") + "\n"; };
    console.warn = (...args) => { warnOutput += args.join(" ") + "\n"; };
    process.exit = vi.fn() as unknown as typeof process.exit;
    mockFetch.mockReset();
    mockScanDeposits.mockReset();
    vi.mocked(fs.readFile).mockReset();
    vi.mocked(fs.writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockReset().mockResolvedValue(undefined as any);
    setupWallet();
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalErr;
    console.warn = originalWarn;
    process.exit = originalExit;
  });

  // ── Default mode (show deposit instructions) ─────

  describe("default (no amount, no --check)", () => {
    it("shows header and balance", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      await mintCommand(undefined, {});
      expect(logOutput).toContain("Token2Chat Funding");
      expect(logOutput).toContain("Current balance");
    });

    it("shows Lightning and EVM funding options", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      await mintCommand(undefined, {});
      expect(logOutput).toContain("Lightning");
      expect(logOutput).toContain("EVM Stablecoins");
      expect(logOutput).toContain("USDC");
    });

    it("uses deposit address from mint info", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ deposit_address: "0xCustomAddress" }),
      } as Response);
      await mintCommand(undefined, {});
      expect(logOutput).toContain("0xCustomAddress");
    });

    it("uses fallback address when mint unreachable", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      await mintCommand(undefined, {});
      expect(logOutput).toContain("0xDC20821A78C4e1c586BE317e87A12f690E94E6c6");
    });

    it("shows supported chains", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      await mintCommand(undefined, {});
      expect(logOutput).toContain("Ethereum");
      expect(logOutput).toContain("Base");
      expect(logOutput).toContain("Arbitrum");
    });
  });

  // ── --check mode ──────────────────────────────────

  describe("--check mode", () => {
    it("reports no pending quotes", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      await mintCommand(undefined, { check: true });
      expect(logOutput).toContain("No pending quotes");
    });

    it("mints from paid quote", async () => {
      const { mintFromQuote } = setupWallet();
      mintFromQuote.mockResolvedValueOnce(10000);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        quotes: [{ quote: "quote123abc", amount: 10000, request: "lnbc...", createdAt: Date.now() }],
      }));

      await mintCommand(undefined, { check: true });
      expect(logOutput).toContain("Minted");
      expect(logOutput).toContain("Total minted");
    });

    it("handles unpaid quotes", async () => {
      const { mintFromQuote } = setupWallet();
      mintFromQuote.mockRejectedValueOnce(new Error("not paid"));
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        quotes: [{ quote: "unpaid123", amount: 5000, request: "lnbc...", createdAt: Date.now() }],
      }));

      await mintCommand(undefined, { check: true });
      expect(logOutput).toContain("awaiting payment");
    });

    it("handles already issued quotes", async () => {
      const { mintFromQuote } = setupWallet();
      mintFromQuote.mockRejectedValueOnce(new Error("ISSUED already"));
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        quotes: [{ quote: "issued123", amount: 5000, request: "lnbc...", createdAt: Date.now() }],
      }));

      await mintCommand(undefined, { check: true });
      expect(logOutput).toContain("already processed");
    });

    it("handles expired quotes", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        quotes: [{ quote: "old123", amount: 5000, request: "lnbc...", createdAt: 0 }],
      }));

      await mintCommand(undefined, { check: true });
      expect(logOutput).toContain("expired");
    });

    it("warns on unknown errors", async () => {
      const { mintFromQuote } = setupWallet();
      mintFromQuote.mockRejectedValueOnce(new Error("network timeout"));
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        quotes: [{ quote: "err123ab", amount: 5000, request: "lnbc...", createdAt: Date.now() }],
      }));

      await mintCommand(undefined, { check: true });
      expect(warnOutput).toContain("network timeout");
    });
  });

  // ── Lightning amount mode ─────────────────────────

  describe("Lightning (with amount)", () => {
    it("creates Lightning invoice", async () => {
      const { createMintQuote } = setupWallet();
      createMintQuote.mockResolvedValueOnce({
        quote: "newquote123",
        request: "lnbc100n1...",
      });
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));

      await mintCommand("10000", {});
      expect(logOutput).toContain("Lightning invoice");
      expect(logOutput).toContain("lnbc100n1...");
      expect(logOutput).toContain("newquote123");
    });

    it("rejects invalid amount", async () => {
      await mintCommand("abc", {});
      expect(errOutput).toContain("Invalid amount");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("rejects zero amount", async () => {
      await mintCommand("0", {});
      expect(errOutput).toContain("Invalid amount");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("handles quote creation failure", async () => {
      const { createMintQuote } = setupWallet();
      createMintQuote.mockRejectedValueOnce(new Error("mint down"));

      await mintCommand("10000", {});
      expect(errOutput).toContain("Failed to create Lightning invoice");
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  // ── --scan mode ──────────────────────────────────

  describe("--scan mode", () => {
    it("triggers chain scan and displays results", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ deposit_address: "0xDC20821A78C4e1c586BE317e87A12f690E94E6c6" }),
      } as Response);
      mockScanDeposits.mockResolvedValueOnce([
        { txHash: "0xaf44ca7b1234567890", amount: 1000000, decimals: 6, token: "USDC", chain: "Base", blockNumber: 42655864 },
      ]);

      await mintCommand(undefined, { scan: true });
      expect(logOutput).toContain("Scanning chains");
      expect(logOutput).toContain("USDC");
      expect(logOutput).toContain("1 deposit(s)");
    });

    it("shows no deposits message when empty", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ deposit_address: "0xDC20821A78C4e1c586BE317e87A12f690E94E6c6" }),
      } as Response);
      mockScanDeposits.mockResolvedValueOnce([]);

      await mintCommand(undefined, { scan: true });
      expect(logOutput).toContain("Scanning chains");
      expect(logOutput).toContain("0 deposit(s)");
    });
  });

  // ── --usdc mode ─────────────────────────────────

  describe("--usdc mode", () => {
    it("shows no deposits message when scan returns empty", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ deposit_address: "0xDC20821A78C4e1c586BE317e87A12f690E94E6c6" }),
      } as Response);
      mockScanDeposits.mockResolvedValueOnce([]);

      await mintCommand(undefined, { usdc: true });
      expect(logOutput).toContain("No deposits to mint");
    });

    it("mints from single USDC deposit", async () => {
      const { mintFromDeposit } = setupWallet({ balance: 105000 });
      mintFromDeposit.mockResolvedValueOnce(100000);

      // fetchDepositAddress call
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ deposit_address: "0xDC20821A78C4e1c586BE317e87A12f690E94E6c6" }),
        } as Response);

      mockScanDeposits.mockResolvedValueOnce([
        { txHash: "0xaf44ca7b1234567890", amount: 1000000, decimals: 6, token: "USDC", chain: "Base", blockNumber: 42655864 },
      ]);

      // Quote request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ quote: "deposit-quote-123" }),
      } as Response);

      await mintCommand(undefined, { usdc: true });
      expect(logOutput).toContain("Auto-selecting");
      expect(logOutput).toContain("Successfully minted");
      expect(mintFromDeposit).toHaveBeenCalledWith("deposit-quote-123", "0xaf44ca7b1234567890", 100000);
    });

    it("handles mint deposit failure", async () => {
      const { mintFromDeposit } = setupWallet();
      mintFromDeposit.mockRejectedValueOnce(new Error("already redeemed"));

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ deposit_address: "0xDC20821A78C4e1c586BE317e87A12f690E94E6c6" }),
        } as Response);

      mockScanDeposits.mockResolvedValueOnce([
        { txHash: "0xtx123", amount: 1000000, decimals: 6, token: "USDC", chain: "Base", blockNumber: 100 },
      ]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ quote: "q1" }),
      } as Response);

      await mintCommand(undefined, { usdc: true });
      expect(errOutput).toContain("Failed to mint from deposit");
      expect(errOutput).toContain("already redeemed");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("handles quote request failure", async () => {
      setupWallet();

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ deposit_address: "0xDC20821A78C4e1c586BE317e87A12f690E94E6c6" }),
        } as Response);

      mockScanDeposits.mockResolvedValueOnce([
        { txHash: "0xtx123", amount: 1000000, decimals: 6, token: "USDC", chain: "Base", blockNumber: 100 },
      ]);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "internal error",
      } as Response);

      await mintCommand(undefined, { usdc: true });
      expect(errOutput).toContain("Failed to get mint quote");
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  // ── Error handling ────────────────────────────────

  it("handles wallet load failure", async () => {
    mockedLoad.mockRejectedValueOnce(new Error("corrupt"));
    await mintCommand(undefined, {}).catch(() => {});
    expect(errOutput).toContain("Failed to load wallet");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
