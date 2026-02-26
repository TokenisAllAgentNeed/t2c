/**
 * CashuStore tests
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { CashuStore } from "../src/cashu-store.js";

describe("CashuStore", () => {
  const testDir = "/tmp/t2c-cashu-test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const testWalletPath = path.join(testDir, "wallet.json");

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("load", () => {
    it("creates new wallet if file doesn't exist", async () => {
      const wallet = await CashuStore.load(testWalletPath, "https://mint.test.com");
      expect(wallet.balance).toBe(0);
      expect(wallet.proofCount).toBe(0);
      expect(wallet.mint).toBe("https://mint.test.com");

      // File should have been created with usd unit
      const exists = await fs.access(testWalletPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
      const raw = JSON.parse(await fs.readFile(testWalletPath, "utf-8"));
      expect(raw.unit).toBe("usd");
    });

    it("loads existing wallet from file", async () => {
      const walletData = {
        mint: "https://mint.example.com",
        unit: "usd",
        proofs: [
          { id: "00ad268c4d1f5826", amount: 100, secret: "secret1", C: "02" + "0".repeat(62) },
          { id: "00ad268c4d1f5826", amount: 200, secret: "secret2", C: "02" + "0".repeat(62) },
        ],
      };
      await fs.writeFile(testWalletPath, JSON.stringify(walletData));

      const wallet = await CashuStore.load(testWalletPath);
      expect(wallet.balance).toBe(300);
      expect(wallet.proofCount).toBe(2);
      expect(wallet.mint).toBe("https://mint.example.com");
    });

    it("migrates legacy wallet with unit=sat to usd", async () => {
      const legacyData = {
        mint: "https://mint.token2chat.com",
        unit: "sat",
        proofs: [
          { id: "00ad268c4d1f5826", amount: 100, secret: "s1", C: "02" + "0".repeat(62) },
        ],
      };
      await fs.writeFile(testWalletPath, JSON.stringify(legacyData));

      const wallet = await CashuStore.load(testWalletPath);
      expect(wallet.balance).toBe(100);

      // Unit should be migrated
      const exported = wallet.exportData();
      expect(exported.unit).toBe("usd");

      // File should be updated on disk
      const raw = JSON.parse(await fs.readFile(testWalletPath, "utf-8"));
      expect(raw.unit).toBe("usd");
    });

    it("handles corrupted wallet file", async () => {
      await fs.writeFile(testWalletPath, "not valid json");

      // Should create a new wallet instead of crashing
      const wallet = await CashuStore.load(testWalletPath, "https://mint.fallback.com");
      expect(wallet.balance).toBe(0);
    });
  });

  describe("balance and proofCount", () => {
    it("calculates balance correctly", async () => {
      const walletData = {
        mint: "https://mint.test.com",
        unit: "usd",
        proofs: [
          { id: "00ad268c4d1f5826", amount: 1, secret: "s1", C: "02" + "0".repeat(62) },
          { id: "00ad268c4d1f5826", amount: 2, secret: "s2", C: "02" + "0".repeat(62) },
          { id: "00ad268c4d1f5826", amount: 4, secret: "s3", C: "02" + "0".repeat(62) },
          { id: "00ad268c4d1f5826", amount: 8, secret: "s4", C: "02" + "0".repeat(62) },
        ],
      };
      await fs.writeFile(testWalletPath, JSON.stringify(walletData));

      const wallet = await CashuStore.load(testWalletPath);
      expect(wallet.balance).toBe(15);
      expect(wallet.proofCount).toBe(4);
    });

    it("returns zero for empty wallet", async () => {
      const wallet = await CashuStore.load(testWalletPath);
      expect(wallet.balance).toBe(0);
      expect(wallet.proofCount).toBe(0);
    });
  });

  describe("needsFunding", () => {
    it("returns true when balance is below threshold", async () => {
      const walletData = {
        mint: "https://mint.test.com",
        unit: "usd",
        proofs: [{ id: "00ad268c4d1f5826", amount: 100, secret: "s1", C: "02" + "0".repeat(62) }],
      };
      await fs.writeFile(testWalletPath, JSON.stringify(walletData));

      const wallet = await CashuStore.load(testWalletPath);
      expect(wallet.needsFunding(500)).toBe(true);
      expect(wallet.needsFunding(100)).toBe(false);
      expect(wallet.needsFunding(99)).toBe(false);
    });
  });

  describe("selectAndEncode", () => {
    it("throws when balance is insufficient", async () => {
      const walletData = {
        mint: "https://mint.test.com",
        unit: "usd",
        proofs: [{ id: "00ad268c4d1f5826", amount: 100, secret: "s1", C: "02" + "0".repeat(62) }],
      };
      await fs.writeFile(testWalletPath, JSON.stringify(walletData));

      const wallet = await CashuStore.load(testWalletPath);
      await expect(wallet.selectAndEncode(200)).rejects.toThrow("Insufficient balance");
    });

    it("removes proofs from balance after selection", async () => {
      // Use valid hex format for keyset id and C (compressed point)
      const walletData = {
        mint: "https://mint.test.com",
        unit: "usd",
        proofs: [
          { id: "00ad268c4d1f5826", amount: 64, secret: "test_secret_1", C: "02" + "a".repeat(62) },
          { id: "00ad268c4d1f5826", amount: 32, secret: "test_secret_2", C: "02" + "b".repeat(62) },
        ],
      };
      await fs.writeFile(testWalletPath, JSON.stringify(walletData));

      const wallet = await CashuStore.load(testWalletPath);
      expect(wallet.balance).toBe(96);

      // This will select the 64 unit proof (largest first)
      const token = await wallet.selectAndEncode(50);
      expect(token).toBeTruthy();
      expect(token.startsWith("cashu")).toBe(true);

      // After selecting 64 unit proof, only 32 units should remain
      expect(wallet.balance).toBe(32);
    });
  });

  describe("importProofs", () => {
    it("adds proofs to wallet", async () => {
      const wallet = await CashuStore.load(testWalletPath);
      expect(wallet.balance).toBe(0);

      const newProofs = [
        { id: "00ad268c4d1f5826", amount: 100, secret: "s1", C: "02" + "0".repeat(62) },
        { id: "00ad268c4d1f5826", amount: 200, secret: "s2", C: "02" + "0".repeat(62) },
      ];
      const imported = await wallet.importProofs(newProofs as any);

      expect(imported).toBe(300);
      expect(wallet.balance).toBe(300);
    });

    it("returns 0 for empty proofs array", async () => {
      const wallet = await CashuStore.load(testWalletPath);
      const imported = await wallet.importProofs([]);
      expect(imported).toBe(0);
    });
  });

  describe("exportData", () => {
    it("returns a deep copy of wallet data", async () => {
      const walletData = {
        mint: "https://mint.test.com",
        unit: "usd",
        proofs: [{ id: "00ad268c4d1f5826", amount: 100, secret: "s1", C: "02" + "0".repeat(62) }],
      };
      await fs.writeFile(testWalletPath, JSON.stringify(walletData));

      const wallet = await CashuStore.load(testWalletPath);
      const exported = wallet.exportData();

      expect(exported.mint).toBe("https://mint.test.com");
      expect(exported.proofs).toHaveLength(1);

      // Modifications shouldn't affect original
      exported.proofs.push({ id: "2", amount: 200, secret: "s2", C: "C2" } as any);
      expect(wallet.proofCount).toBe(1);
    });
  });

  describe("save", () => {
    it("persists wallet to disk", async () => {
      const wallet = await CashuStore.load(testWalletPath, "https://mint.persist.com");
      await wallet.importProofs([
        { id: "00ad268c4d1f5826", amount: 500, secret: "persist-secret", C: "02" + "0".repeat(62) } as any,
      ]);

      // Create new instance from same file
      const wallet2 = await CashuStore.load(testWalletPath);
      expect(wallet2.balance).toBe(500);
      expect(wallet2.mint).toBe("https://mint.persist.com");
    });
  });
});
