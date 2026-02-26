/**
 * Chain scan tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  getBalance,
  scanDeposits,
  CHAIN_CONFIGS,
  type ChainConfig,
} from "../src/chain-scan.js";

// ── Helpers ─────────────────────────────────────────────────────

function rpcResponse(result: unknown) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id: 1, result }),
  } as Response;
}

function rpcError(message: string) {
  return {
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id: 1, error: { message } }),
  } as Response;
}

function httpError(status: number) {
  return { ok: false, status } as Response;
}

// Pad a number to 64 hex chars (uint256)
function uint256Hex(n: number): string {
  return "0x" + BigInt(n).toString(16).padStart(64, "0");
}

const DEPOSIT_ADDR = "0xDC20821A78C4e1c586BE317e87A12f690E94E6c6";

// Transfer event topic
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

describe("chain-scan", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── getBalance ──────────────────────────────────────────────

  describe("getBalance", () => {
    it("parses balance from eth_call response", async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse(uint256Hex(1000000)));

      const balance = await getBalance(
        "https://base.drpc.org",
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        DEPOSIT_ADDR,
      );

      expect(balance).toBe(1000000n);
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("returns 0 for empty response", async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse("0x"));

      const balance = await getBalance(
        "https://base.drpc.org",
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        DEPOSIT_ADDR,
      );

      expect(balance).toBe(0n);
    });

    it("returns 0 for null result", async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse(null));

      const balance = await getBalance(
        "https://base.drpc.org",
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        DEPOSIT_ADDR,
      );

      expect(balance).toBe(0n);
    });

    it("returns 0 for zero balance", async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse(uint256Hex(0)));

      const balance = await getBalance(
        "https://base.drpc.org",
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        DEPOSIT_ADDR,
      );

      expect(balance).toBe(0n);
    });

    it("queries at specific block when provided", async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse(uint256Hex(500000)));

      await getBalance(
        "https://base.drpc.org",
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        DEPOSIT_ADDR,
        42655000,
      );

      const call = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(call.method).toBe("eth_call");
      expect(call.params[1]).toBe("0x" + (42655000).toString(16));
    });

    it("throws on RPC error response", async () => {
      mockFetch.mockResolvedValueOnce(rpcError("rate limited"));

      await expect(
        getBalance("https://base.drpc.org", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", DEPOSIT_ADDR),
      ).rejects.toThrow("RPC error: rate limited");
    });

    it("throws on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(httpError(500));

      await expect(
        getBalance("https://base.drpc.org", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", DEPOSIT_ADDR),
      ).rejects.toThrow("RPC eth_call failed: 500");
    });
  });

  // ── scanDeposits ────────────────────────────────────────────

  describe("scanDeposits", () => {
    it("returns empty array when all balances are zero", async () => {
      // Each chain has 2 tokens → 6 balance queries total
      for (let i = 0; i < 6; i++) {
        mockFetch.mockResolvedValueOnce(rpcResponse(uint256Hex(0)));
      }

      const deposits = await scanDeposits(DEPOSIT_ADDR, CHAIN_CONFIGS);
      expect(deposits).toEqual([]);
    });

    it("finds deposits via binary search and getLogs", async () => {
      const testChain: ChainConfig = {
        name: "Base",
        rpcUrl: "https://base.drpc.org",
        tokens: [
          { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
        ],
      };

      const latestBlock = 42656000;
      const changeBlock = 42655864;
      const balance = 1000000n; // 1 USDC

      // 1. balanceOf at latest → has balance
      mockFetch.mockResolvedValueOnce(rpcResponse(uint256Hex(Number(balance))));

      // 2. eth_blockNumber
      mockFetch.mockResolvedValueOnce(rpcResponse("0x" + latestBlock.toString(16)));

      // 3. Binary search: balance at (latest - 100000) → 0
      mockFetch.mockResolvedValueOnce(rpcResponse(uint256Hex(0)));

      // 4-N. Binary search iterations — simulate convergence
      // We need ~17 iterations for 100000 range (log2(100000) ≈ 17)
      // At mid points: respond with 0 (not yet deposited) or balance (deposited)
      // Simplify: respond such that binary search converges to changeBlock
      const lo0 = latestBlock - 100000;
      let lo = lo0;
      let hi = latestBlock;
      const responses: Array<{ block: number; hasBalance: boolean }> = [];
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const hasBalance = mid >= changeBlock;
        responses.push({ block: mid, hasBalance });
        if (hasBalance) {
          hi = mid;
        } else {
          lo = mid;
        }
      }
      for (const r of responses) {
        mockFetch.mockResolvedValueOnce(rpcResponse(uint256Hex(r.hasBalance ? Number(balance) : 0)));
      }

      // N+1. getLogs → one transfer event
      mockFetch.mockResolvedValueOnce(rpcResponse([
        {
          transactionHash: "0xaf44ca7b000000000000000000000000000000000000000000000000a88a9f",
          blockNumber: "0x" + changeBlock.toString(16),
          data: uint256Hex(1000000),
          topics: [
            TRANSFER_TOPIC,
            "0x0000000000000000000000001234567890abcdef1234567890abcdef12345678",
            "0x000000000000000000000000dc20821a78c4e1c586be317e87a12f690e94e6c6",
          ],
        },
      ]));

      const deposits = await scanDeposits(DEPOSIT_ADDR, [testChain]);

      expect(deposits).toHaveLength(1);
      expect(deposits[0].amount).toBe(1000000);
      expect(deposits[0].token).toBe("USDC");
      expect(deposits[0].chain).toBe("base");
      expect(deposits[0].decimals).toBe(6);
      expect(deposits[0].blockNumber).toBe(changeBlock);
    });

    it("finds multiple deposits in same range", async () => {
      const testChain: ChainConfig = {
        name: "Base",
        rpcUrl: "https://base.drpc.org",
        tokens: [
          { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
        ],
      };

      const latestBlock = 42656000;

      // 1. balanceOf → has balance (sum of two deposits)
      mockFetch.mockResolvedValueOnce(rpcResponse(uint256Hex(1000099)));

      // 2. eth_blockNumber
      mockFetch.mockResolvedValueOnce(rpcResponse("0x" + latestBlock.toString(16)));

      // 3. Binary search: old balance → 0 (so we know it changed)
      mockFetch.mockResolvedValueOnce(rpcResponse(uint256Hex(0)));

      // Binary search iterations
      const lo0 = latestBlock - 100000;
      let lo = lo0;
      let hi = latestBlock;
      const changeBlock = 42655864;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const hasBalance = mid >= changeBlock;
        mockFetch.mockResolvedValueOnce(rpcResponse(uint256Hex(hasBalance ? 1000099 : 0)));
        if (hasBalance) hi = mid;
        else lo = mid;
      }

      // getLogs → two transfer events
      mockFetch.mockResolvedValueOnce(rpcResponse([
        {
          transactionHash: "0xaf44ca7b0000000000000000000000000000000000000000a88a9f",
          blockNumber: "0x" + (42655864).toString(16),
          data: uint256Hex(1000000),
          topics: [TRANSFER_TOPIC, "0x" + "00".repeat(12) + "1234567890abcdef1234567890abcdef12345678", "0x" + "00".repeat(12) + "dc20821a78c4e1c586be317e87a12f690e94e6c6"],
        },
        {
          transactionHash: "0xa3891cf30000000000000000000000000000000000000001b1887",
          blockNumber: "0x" + (42655867).toString(16),
          data: uint256Hex(99),
          topics: [TRANSFER_TOPIC, "0x" + "00".repeat(12) + "abcdef1234567890abcdef1234567890abcdef12", "0x" + "00".repeat(12) + "dc20821a78c4e1c586be317e87a12f690e94e6c6"],
        },
      ]));

      const deposits = await scanDeposits(DEPOSIT_ADDR, [testChain]);

      expect(deposits).toHaveLength(2);
      expect(deposits[0].amount).toBe(1000000);
      expect(deposits[1].amount).toBe(99);
      expect(deposits[1].blockNumber).toBe(42655867);
    });

    it("handles RPC errors gracefully for individual chains", async () => {
      const testChains: ChainConfig[] = [
        {
          name: "FailChain",
          rpcUrl: "https://fail.drpc.org",
          tokens: [{ symbol: "USDC", address: "0x1111111111111111111111111111111111111111", decimals: 6 }],
        },
        {
          name: "OkChain",
          rpcUrl: "https://ok.drpc.org",
          tokens: [{ symbol: "USDC", address: "0x2222222222222222222222222222222222222222", decimals: 6 }],
        },
      ];

      // FailChain: balance query fails
      mockFetch.mockRejectedValueOnce(new Error("connection refused"));

      // OkChain: balance is 0
      mockFetch.mockResolvedValueOnce(rpcResponse(uint256Hex(0)));

      const deposits = await scanDeposits(DEPOSIT_ADDR, testChains);
      expect(deposits).toEqual([]);
    });

    it("handles empty log results", async () => {
      const testChain: ChainConfig = {
        name: "Base",
        rpcUrl: "https://base.drpc.org",
        tokens: [
          { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
        ],
      };

      const latestBlock = 42656000;

      // 1. balanceOf → has balance
      mockFetch.mockResolvedValueOnce(rpcResponse(uint256Hex(1000000)));

      // 2. eth_blockNumber
      mockFetch.mockResolvedValueOnce(rpcResponse("0x" + latestBlock.toString(16)));

      // 3. Binary search: old balance = current balance (no change in range)
      mockFetch.mockResolvedValueOnce(rpcResponse(uint256Hex(1000000)));

      // getLogs → empty (deposit was older than lookback)
      mockFetch.mockResolvedValueOnce(rpcResponse([]));

      const deposits = await scanDeposits(DEPOSIT_ADDR, [testChain]);
      expect(deposits).toEqual([]);
    });
  });

  // ── Chain configs ─────────────────────────────────────────────

  describe("CHAIN_CONFIGS", () => {
    it("has Base, Ethereum, and Arbitrum", () => {
      const names = CHAIN_CONFIGS.map((c) => c.name);
      expect(names).toContain("Base");
      expect(names).toContain("Ethereum");
      expect(names).toContain("Arbitrum");
    });

    it("each chain has USDC and USDT tokens", () => {
      for (const chain of CHAIN_CONFIGS) {
        const symbols = chain.tokens.map((t) => t.symbol);
        expect(symbols).toContain("USDC");
        expect(symbols).toContain("USDT");
      }
    });

    it("all tokens have 6 decimals", () => {
      for (const chain of CHAIN_CONFIGS) {
        for (const token of chain.tokens) {
          expect(token.decimals).toBe(6);
        }
      }
    });
  });
});
