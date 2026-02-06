/**
 * Balance command tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  };
});

// Mock CashuStore — no external variable refs in factory (hoisted)
vi.mock("../src/cashu-store.js", () => ({
  CashuStore: {
    load: vi.fn().mockResolvedValue({ balance: 5000, proofCount: 10 }),
  },
}));

import { balanceCommand } from "../src/commands/balance.js";
import { CashuStore } from "../src/cashu-store.js";

describe("balanceCommand", () => {
  let logOutput: string;
  let errOutput: string;
  const originalLog = console.log;
  const originalErr = console.error;
  const originalExit = process.exit;
  const mockedLoad = vi.mocked(CashuStore.load);

  beforeEach(() => {
    logOutput = "";
    errOutput = "";
    console.log = (...args) => { logOutput += args.join(" ") + "\n"; };
    console.error = (...args) => { errOutput += args.join(" ") + "\n"; };
    process.exit = vi.fn() as unknown as typeof process.exit;
    mockedLoad.mockResolvedValue({ balance: 5000, proofCount: 10 } as any);
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalErr;
    process.exit = originalExit;
  });

  it("displays formatted balance in text mode", async () => {
    await balanceCommand({});
    expect(logOutput).toContain("$0.05");
  });

  it("displays JSON output when --json flag used", async () => {
    await balanceCommand({ json: true });
    const parsed = JSON.parse(logOutput.trim());
    expect(parsed).toEqual({ balance: 5000, proofs: 10 });
  });

  it("displays higher balance correctly", async () => {
    mockedLoad.mockResolvedValueOnce({ balance: 100000, proofCount: 5 } as any);
    await balanceCommand({});
    expect(logOutput).toContain("$1.00");
  });

  it("displays zero balance", async () => {
    mockedLoad.mockResolvedValueOnce({ balance: 0, proofCount: 0 } as any);
    await balanceCommand({});
    expect(logOutput).toContain("$0.00");
  });

  it("handles wallet not found (text mode)", async () => {
    mockedLoad.mockRejectedValueOnce(new Error("ENOENT"));
    await balanceCommand({});
    expect(errOutput).toContain("Wallet not found");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("handles wallet not found (json mode)", async () => {
    mockedLoad.mockRejectedValueOnce(new Error("ENOENT"));
    await balanceCommand({ json: true });
    const parsed = JSON.parse(logOutput.trim());
    expect(parsed).toEqual({ error: "Wallet not found" });
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
