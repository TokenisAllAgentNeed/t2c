/**
 * Recover command tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    resolveHome: vi.fn((p: string) => p.replace("~", "/home/test")),
    loadFailedTokens: vi.fn().mockResolvedValue({ tokens: [] }),
    saveFailedTokens: vi.fn().mockResolvedValue(undefined),
    FAILED_TOKENS_PATH: "/home/test/.t2c/failed-tokens.json",
  };
});

vi.mock("../src/cashu-store.js", () => ({
  CashuStore: {
    load: vi.fn().mockResolvedValue({ balance: 5000, proofCount: 10, receiveToken: vi.fn() }),
  },
}));

import { recoverCommand } from "../src/commands/recover.js";
import { loadFailedTokens, saveFailedTokens } from "../src/config.js";
import { CashuStore } from "../src/cashu-store.js";

describe("recoverCommand", () => {
  let logOutput: string;
  let errOutput: string;
  const originalLog = console.log;
  const originalErr = console.error;
  const originalExit = process.exit;
  const mockedLoad = vi.mocked(CashuStore.load);

  /** Helper to set up the wallet mock and return the receiveToken spy */
  function setupWallet(): ReturnType<typeof vi.fn> {
    const receiveToken = vi.fn();
    const wallet = { balance: 5000, proofCount: 10, receiveToken };
    mockedLoad.mockResolvedValue(wallet as any);
    return receiveToken;
  }

  beforeEach(() => {
    logOutput = "";
    errOutput = "";
    console.log = (...args) => { logOutput += args.join(" ") + "\n"; };
    console.error = (...args) => { errOutput += args.join(" ") + "\n"; };
    process.exit = vi.fn() as unknown as typeof process.exit;
    setupWallet();
    vi.mocked(loadFailedTokens).mockReset().mockResolvedValue({ tokens: [] });
    vi.mocked(saveFailedTokens).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalErr;
    process.exit = originalExit;
  });

  it("displays header", async () => {
    await recoverCommand();
    expect(logOutput).toContain("Token Recovery");
  });

  it("shows no tokens message when nothing to recover", async () => {
    await recoverCommand();
    expect(logOutput).toContain("No failed tokens to recover");
  });

  it("recovers a single token successfully", async () => {
    const recv = setupWallet();
    vi.mocked(loadFailedTokens).mockResolvedValueOnce({
      tokens: [
        { token: "cashuAtoken123", type: "change", timestamp: 1700000000000, error: "network" },
      ],
    });
    recv.mockResolvedValueOnce(500);

    await recoverCommand();

    expect(logOutput).toContain("Recovered");
    expect(logOutput).toContain("$0.005");
    expect(saveFailedTokens).toHaveBeenCalledWith({ tokens: [] });
  });

  it("shows count of tokens to recover", async () => {
    const recv = setupWallet();
    vi.mocked(loadFailedTokens).mockResolvedValueOnce({
      tokens: [
        { token: "a", type: "change", timestamp: 1000, error: "err1" },
        { token: "b", type: "refund", timestamp: 2000, error: "err2" },
      ],
    });
    recv.mockResolvedValue(100);

    await recoverCommand();

    expect(logOutput).toContain("2 failed token(s)");
  });

  it("handles partial recovery (some still fail)", async () => {
    const recv = setupWallet();
    vi.mocked(loadFailedTokens).mockResolvedValueOnce({
      tokens: [
        { token: "good-token", type: "change", timestamp: 1000, error: "was-network" },
        { token: "bad-token", type: "refund", timestamp: 2000, error: "still-bad" },
      ],
    });
    recv
      .mockResolvedValueOnce(300)
      .mockRejectedValueOnce(new Error("mint rejected"));

    await recoverCommand();

    expect(logOutput).toContain("Recovered");
    expect(logOutput).toContain("Failed: mint rejected");
    // Should save remaining failed tokens
    const saveCall = vi.mocked(saveFailedTokens).mock.calls[0][0];
    expect(saveCall.tokens).toHaveLength(1);
    expect(saveCall.tokens[0].token).toBe("bad-token");
  });

  it("shows total recovered and new balance", async () => {
    const recv = setupWallet();
    vi.mocked(loadFailedTokens).mockResolvedValueOnce({
      tokens: [
        { token: "tok", type: "change", timestamp: 1000, error: "err" },
      ],
    });
    recv.mockResolvedValueOnce(1000);

    await recoverCommand();

    expect(logOutput).toContain("Recovered total");
    expect(logOutput).toContain("New wallet balance");
  });

  it("shows success message when all tokens recovered", async () => {
    const recv = setupWallet();
    vi.mocked(loadFailedTokens).mockResolvedValueOnce({
      tokens: [
        { token: "tok", type: "change", timestamp: 1000, error: "err" },
      ],
    });
    recv.mockResolvedValueOnce(1000);

    await recoverCommand();

    expect(logOutput).toContain("All tokens recovered successfully");
  });

  it("shows warning for still-failed tokens", async () => {
    const recv = setupWallet();
    vi.mocked(loadFailedTokens).mockResolvedValueOnce({
      tokens: [
        { token: "bad", type: "refund", timestamp: 1000, error: "err" },
      ],
    });
    recv.mockRejectedValueOnce(new Error("invalid"));

    await recoverCommand();

    expect(logOutput).toContain("1 token(s) still failed");
    expect(logOutput).toContain("failed-tokens.json");
  });

  it("handles wallet load failure", async () => {
    vi.mocked(loadFailedTokens).mockResolvedValueOnce({
      tokens: [
        { token: "tok", type: "change", timestamp: 1000, error: "err" },
      ],
    });
    mockedLoad.mockRejectedValueOnce(new Error("corrupt"));

    await recoverCommand();

    expect(errOutput).toContain("Failed to load wallet");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
