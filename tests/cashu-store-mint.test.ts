/**
 * CashuStore mint-dependent operation tests
 *
 * Tests for receiveToken, createMintQuote, mintFromQuote, and
 * mutex contention — uses mocked @cashu/cashu-ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

// Mock @cashu/cashu-ts
const mockLoadMint = vi.fn().mockResolvedValue(undefined);
const mockReceive = vi.fn();
const mockCreateMintQuote = vi.fn();
const mockCheckMintQuote = vi.fn();
const mockMintProofs = vi.fn();

vi.mock("@cashu/cashu-ts", () => ({
  CashuMint: vi.fn().mockImplementation(() => ({})),
  CashuWallet: vi.fn().mockImplementation(() => ({
    loadMint: mockLoadMint,
    receive: mockReceive,
    createMintQuote: mockCreateMintQuote,
    checkMintQuote: mockCheckMintQuote,
    mintProofs: mockMintProofs,
  })),
  MintQuoteState: { PAID: "PAID", ISSUED: "ISSUED", UNPAID: "UNPAID" },
  getEncodedTokenV4: vi.fn().mockReturnValue("cashuBmocked_token"),
}));

import { CashuStore } from "../src/cashu-store.js";
import { CashuWallet } from "@cashu/cashu-ts";

describe("CashuStore mint operations", () => {
  const testDir = "/tmp/t2c-cashu-mint-test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const testWalletPath = path.join(testDir, "wallet.json");

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
    mockLoadMint.mockReset().mockResolvedValue(undefined);
    mockReceive.mockReset();
    mockCreateMintQuote.mockReset();
    mockCheckMintQuote.mockReset();
    mockMintProofs.mockReset();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function createWallet(proofs: Array<{ amount: number; secret: string }> = []) {
    const walletData = {
      mint: "https://mint.test.com",
      unit: "usd",
      proofs: proofs.map((p, i) => ({
        id: "00ad268c4d1f5826",
        amount: p.amount,
        secret: p.secret,
        C: "02" + "a".repeat(62),
      })),
    };
    await fs.writeFile(testWalletPath, JSON.stringify(walletData));
    return CashuStore.load(testWalletPath);
  }

  describe("CashuWallet initialization", () => {
    it("passes unit from wallet data to CashuWallet constructor", async () => {
      const wallet = await createWallet();
      // Trigger lazy wallet init
      mockReceive.mockResolvedValue([]);
      await wallet.receiveToken("cashuBtest");

      // CashuWallet should have been constructed with { unit: "usd" }
      expect(CashuWallet).toHaveBeenCalledWith(
        expect.anything(), // CashuMint instance
        expect.objectContaining({ unit: "usd" }),
      );
    });
  });

  describe("receiveToken", () => {
    it("receives token and adds proofs to wallet", async () => {
      const wallet = await createWallet([{ amount: 100, secret: "s1" }]);
      expect(wallet.balance).toBe(100);

      mockReceive.mockResolvedValue([
        { id: "00ad268c4d1f5826", amount: 50, secret: "new1", C: "02" + "b".repeat(62) },
        { id: "00ad268c4d1f5826", amount: 25, secret: "new2", C: "02" + "c".repeat(62) },
      ]);

      const received = await wallet.receiveToken("cashuBtest_token");
      expect(received).toBe(75);
      expect(wallet.balance).toBe(175);
    });

    it("returns 0 when receive returns empty proofs", async () => {
      const wallet = await createWallet();
      mockReceive.mockResolvedValue([]);

      const received = await wallet.receiveToken("cashuBtest_token");
      expect(received).toBe(0);
    });

    it("returns 0 when receive returns null", async () => {
      const wallet = await createWallet();
      mockReceive.mockResolvedValue(null);

      const received = await wallet.receiveToken("cashuBtest_token");
      expect(received).toBe(0);
    });
  });

  describe("createMintQuote", () => {
    it("creates a mint quote and returns quote and request", async () => {
      const wallet = await createWallet();
      mockCreateMintQuote.mockResolvedValue({
        quote: "quote-123",
        request: "lnbc1000...",
      });

      const result = await wallet.createMintQuote(1000);
      expect(result.quote).toBe("quote-123");
      expect(result.request).toBe("lnbc1000...");
    });
  });

  describe("mintFromQuote", () => {
    it("mints proofs from a paid quote", async () => {
      const wallet = await createWallet();
      mockCheckMintQuote.mockResolvedValue({ state: "PAID" });
      mockMintProofs.mockResolvedValue([
        { id: "00ad268c4d1f5826", amount: 500, secret: "minted1", C: "02" + "d".repeat(62) },
        { id: "00ad268c4d1f5826", amount: 500, secret: "minted2", C: "02" + "e".repeat(62) },
      ]);

      const minted = await wallet.mintFromQuote("quote-123", 1000);
      expect(minted).toBe(1000);
      expect(wallet.balance).toBe(1000);
    });

    it("mints proofs from an issued quote", async () => {
      const wallet = await createWallet();
      mockCheckMintQuote.mockResolvedValue({ state: "ISSUED" });
      mockMintProofs.mockResolvedValue([
        { id: "00ad268c4d1f5826", amount: 200, secret: "m1", C: "02" + "d".repeat(62) },
      ]);

      const minted = await wallet.mintFromQuote("quote-456", 200);
      expect(minted).toBe(200);
    });

    it("throws when quote is not paid", async () => {
      const wallet = await createWallet();
      mockCheckMintQuote.mockResolvedValue({ state: "UNPAID" });

      await expect(wallet.mintFromQuote("quote-789", 1000)).rejects.toThrow("Quote not paid");
    });
  });

  describe("mutex contention", () => {
    it("serializes concurrent operations", async () => {
      const wallet = await createWallet([
        { amount: 100, secret: "c1" },
        { amount: 200, secret: "c2" },
        { amount: 300, secret: "c3" },
      ]);
      expect(wallet.balance).toBe(600);

      // Run two selectAndEncode operations concurrently
      // Both need proofs, so mutex should prevent double-spend
      const [token1, token2] = await Promise.all([
        wallet.selectAndEncode(100),
        wallet.selectAndEncode(200),
      ]);

      expect(token1).toBeTruthy();
      expect(token2).toBeTruthy();
      // Greedy selection picks largest first: 300-proof for the 100 request,
      // 200-proof for the 200 request. Remaining: 100
      expect(wallet.balance).toBe(100);
    });
  });
});
