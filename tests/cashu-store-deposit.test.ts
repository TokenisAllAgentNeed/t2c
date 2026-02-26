/**
 * CashuStore.mintFromDeposit tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock cashu-ts — factory must not reference external variables (hoisted)
vi.mock("@cashu/cashu-ts", async () => {
  const actual = await vi.importActual<typeof import("@cashu/cashu-ts")>("@cashu/cashu-ts");
  return {
    ...actual,
    CashuMint: vi.fn().mockImplementation(() => ({})),
    CashuWallet: vi.fn().mockImplementation(() => ({
      loadMint: vi.fn().mockResolvedValue(undefined),
      getKeys: vi.fn().mockResolvedValue({ id: "keyset1", unit: "usd", keys: { 1: "02cc..." } }),
    })),
    OutputData: {
      createRandomData: vi.fn().mockReturnValue([
        {
          blindedMessage: { amount: 100, B_: "02" + "a".repeat(62), id: "keyset1" },
          toProof: vi.fn().mockReturnValue({
            id: "keyset1",
            amount: 100,
            secret: "test-secret",
            C: "02" + "b".repeat(62),
          }),
        },
      ]),
    },
  };
});

import { CashuStore } from "../src/cashu-store.js";
import { OutputData } from "@cashu/cashu-ts";
import fs from "node:fs/promises";
import path from "node:path";

const mockedCreateRandomData = vi.mocked(OutputData.createRandomData);

describe("CashuStore.mintFromDeposit", () => {
  const testDir = "/tmp/t2c-deposit-test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const testWalletPath = path.join(testDir, "wallet.json");
  const mockKeys = { id: "keyset1", unit: "usd", keys: { 1: "02cc..." } };

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
    mockFetch.mockReset();
    // Reset createRandomData to default single-output behavior
    mockedCreateRandomData.mockReturnValue([
      {
        blindedMessage: { amount: 100, B_: "02" + "a".repeat(62), id: "keyset1" },
        toProof: vi.fn().mockReturnValue({
          id: "keyset1",
          amount: 100,
          secret: "test-secret-" + Date.now(),
          C: "02" + "b".repeat(62),
        }),
      } as any,
    ]);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("creates blinded messages and stores proofs", async () => {
    const wallet = await CashuStore.load(testWalletPath, "https://mint.test.local");
    expect(wallet.balance).toBe(0);

    // Mock successful mint deposit response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        signatures: [{ id: "keyset1", amount: 100, C_: "02" + "c".repeat(62) }],
      }),
    } as Response);

    const minted = await wallet.mintFromDeposit("quote-abc", "0xtxhash123", 100);

    expect(minted).toBeGreaterThan(0);
    expect(wallet.balance).toBeGreaterThan(0);

    // Verify OutputData.createRandomData was called
    expect(mockedCreateRandomData).toHaveBeenCalledWith(100, mockKeys);

    // Verify POST to /v1/mint/deposit
    expect(mockFetch).toHaveBeenCalledWith(
      "https://mint.test.local/v1/mint/deposit",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("quote-abc"),
      }),
    );

    // Verify body contains tx_hash and outputs
    const postBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(postBody.quote).toBe("quote-abc");
    expect(postBody.tx_hash).toBe("0xtxhash123");
    expect(postBody.outputs).toHaveLength(1);
  });

  it("persists proofs to disk after minting", async () => {
    const wallet = await CashuStore.load(testWalletPath, "https://mint.test.local");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        signatures: [{ id: "keyset1", amount: 100, C_: "02" + "c".repeat(62) }],
      }),
    } as Response);

    await wallet.mintFromDeposit("quote-persist", "0xtx", 100);

    // Reload from disk
    const wallet2 = await CashuStore.load(testWalletPath, "https://mint.test.local");
    expect(wallet2.proofCount).toBeGreaterThan(0);
  });

  it("throws on HTTP error from mint", async () => {
    const wallet = await CashuStore.load(testWalletPath, "https://mint.test.local");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"detail":"unknown quote"}',
    } as Response);

    await expect(
      wallet.mintFromDeposit("bad-quote", "0xtx", 100),
    ).rejects.toThrow("Mint deposit failed (400)");
  });

  it("throws on already-paid quote", async () => {
    const wallet = await CashuStore.load(testWalletPath, "https://mint.test.local");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"detail":"quote already paid"}',
    } as Response);

    await expect(
      wallet.mintFromDeposit("used-quote", "0xtx", 100),
    ).rejects.toThrow("Mint deposit failed");
  });

  it("handles multiple output data items", async () => {
    mockedCreateRandomData.mockReturnValueOnce([
      { blindedMessage: { amount: 64, B_: "02" + "a".repeat(62), id: "k1" }, toProof: vi.fn().mockReturnValue({ id: "k1", amount: 64, secret: "s1", C: "02" + "d".repeat(62) }) } as any,
      { blindedMessage: { amount: 32, B_: "02" + "a".repeat(62), id: "k1" }, toProof: vi.fn().mockReturnValue({ id: "k1", amount: 32, secret: "s2", C: "02" + "e".repeat(62) }) } as any,
      { blindedMessage: { amount: 4, B_: "02" + "a".repeat(62), id: "k1" }, toProof: vi.fn().mockReturnValue({ id: "k1", amount: 4, secret: "s3", C: "02" + "f".repeat(62) }) } as any,
    ]);

    const wallet = await CashuStore.load(testWalletPath, "https://mint.test.local");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        signatures: [
          { id: "k1", amount: 64, C_: "02" + "1".repeat(62) },
          { id: "k1", amount: 32, C_: "02" + "2".repeat(62) },
          { id: "k1", amount: 4, C_: "02" + "3".repeat(62) },
        ],
      }),
    } as Response);

    const minted = await wallet.mintFromDeposit("multi-quote", "0xtx", 100);
    expect(minted).toBe(100);
    expect(wallet.proofCount).toBe(3);
  });
});
