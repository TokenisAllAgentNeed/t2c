/**
 * Setup command tests
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
    saveConfig: vi.fn().mockResolvedValue(undefined),
    configExists: vi.fn().mockResolvedValue(false),
    resolveHome: vi.fn((p: string) => p.replace("~", "/home/test")),
    checkGateHealth: vi.fn().mockResolvedValue(true),
    checkMintHealth: vi.fn().mockResolvedValue(true),
    DEFAULT_CONFIG: {
      gateUrl: "https://gate.token2.chat",
      mintUrl: "https://mint.token2.chat",
      walletPath: "~/.t2c/wallet.json",
      proxyPort: 10402,
      lowBalanceThreshold: 1000,
      autoDiscover: true,
      discoveryUrl: "https://token2.cash/gates.json",
    },
    formatUnits: vi.fn((v: number) => `$${(v / 100000).toFixed(2)}`),
  };
});

vi.mock("../src/cashu-store.js", () => ({
  CashuStore: {
    load: vi.fn().mockResolvedValue({ balance: 0, proofCount: 0 }),
  },
}));

// Mock readline
const mockQuestion = vi.fn();
const mockClose = vi.fn();
vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockClose,
  })),
}));

import { setupCommand } from "../src/commands/setup.js";
import { saveConfig, configExists, checkGateHealth, checkMintHealth } from "../src/config.js";
import { CashuStore } from "../src/cashu-store.js";

describe("setupCommand", () => {
  let logOutput: string;
  const originalLog = console.log;
  const originalStdoutWrite = process.stdout.write;

  /** Queue answers for sequential readline questions */
  function queueAnswers(...answers: string[]) {
    for (const answer of answers) {
      mockQuestion.mockImplementationOnce((_prompt: string, cb: (answer: string) => void) => {
        cb(answer);
      });
    }
  }

  beforeEach(() => {
    logOutput = "";
    console.log = (...args) => { logOutput += args.join(" ") + "\n"; };
    // Suppress process.stdout.write calls (for "Checking Gate...")
    process.stdout.write = vi.fn() as any;
    mockQuestion.mockReset();
    mockClose.mockReset();
    vi.mocked(saveConfig).mockReset().mockResolvedValue(undefined);
    vi.mocked(configExists).mockReset().mockResolvedValue(false);
    vi.mocked(checkGateHealth).mockReset().mockResolvedValue(true);
    vi.mocked(checkMintHealth).mockReset().mockResolvedValue(true);
    vi.mocked(CashuStore.load).mockReset().mockResolvedValue({ balance: 0, proofCount: 0 } as any);
  });

  afterEach(() => {
    console.log = originalLog;
    process.stdout.write = originalStdoutWrite;
  });

  it("shows header", async () => {
    // Accept all defaults: gate, mint, port, wallet
    queueAnswers("", "", "", "");
    await setupCommand();
    expect(logOutput).toContain("Token2Chat Setup");
  });

  it("saves config with defaults when all answers empty", async () => {
    queueAnswers("", "", "", "");
    await setupCommand();
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      gateUrl: "https://gate.test.local",
      mintUrl: "https://mint.test.local",
      proxyPort: 10402,
      walletPath: "~/.t2c/wallet.json",
    }));
  });

  it("saves config with custom values", async () => {
    queueAnswers(
      "https://custom-gate.com",
      "https://custom-mint.com",
      "9999",
      "~/my-wallet.json",
    );
    await setupCommand();
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      gateUrl: "https://custom-gate.com",
      mintUrl: "https://custom-mint.com",
      proxyPort: 9999,
      walletPath: "~/my-wallet.json",
    }));
  });

  it("cancels when already configured and user declines", async () => {
    vi.mocked(configExists).mockResolvedValueOnce(true);
    // Answer "n" to reconfigure prompt
    queueAnswers("n");
    await setupCommand();
    expect(logOutput).toContain("cancelled");
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("continues when already configured and user confirms", async () => {
    vi.mocked(configExists).mockResolvedValueOnce(true);
    // Answer "y" to reconfigure, then defaults for all 4 steps
    queueAnswers("y", "", "", "", "");
    await setupCommand();
    expect(saveConfig).toHaveBeenCalled();
  });

  it("cancels when gate unreachable and user declines", async () => {
    vi.mocked(checkGateHealth).mockResolvedValueOnce(false);
    // Gate URL (default), then "n" to continue
    queueAnswers("", "n");
    await setupCommand();
    expect(logOutput).toContain("Unreachable");
    expect(logOutput).toContain("cancelled");
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("continues when gate unreachable and user confirms", async () => {
    vi.mocked(checkGateHealth).mockResolvedValueOnce(false);
    // Gate URL (default), "y" continue, mint URL (default), port (default), wallet (default)
    queueAnswers("", "y", "", "", "");
    await setupCommand();
    expect(saveConfig).toHaveBeenCalled();
  });

  it("cancels when mint unreachable and user declines", async () => {
    vi.mocked(checkMintHealth).mockResolvedValueOnce(false);
    // Gate URL (default), mint URL (default), "n" to continue
    queueAnswers("", "", "n");
    await setupCommand();
    expect(logOutput).toContain("Unreachable");
    expect(logOutput).toContain("cancelled");
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("shows wallet initialized on success", async () => {
    vi.mocked(CashuStore.load).mockResolvedValueOnce({ balance: 5000, proofCount: 2 } as any);
    queueAnswers("", "", "", "");
    await setupCommand();
    expect(logOutput).toContain("Wallet initialized");
  });

  it("handles wallet init failure gracefully", async () => {
    vi.mocked(CashuStore.load).mockRejectedValueOnce(new Error("network error"));
    queueAnswers("", "", "", "");
    await setupCommand();
    expect(logOutput).toContain("Failed to initialize wallet");
  });

  it("shows next steps after successful setup", async () => {
    queueAnswers("", "", "", "");
    await setupCommand();
    expect(logOutput).toContain("Next steps");
    expect(logOutput).toContain("t2c service start");
    expect(logOutput).toContain("t2c mint");
    expect(logOutput).toContain("t2c config");
  });

  it("rejects invalid port number", async () => {
    queueAnswers("", "", "abc", "");
    await setupCommand();
    expect(logOutput).toContain("Invalid port");
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("closes readline interface", async () => {
    queueAnswers("", "", "", "");
    await setupCommand();
    expect(mockClose).toHaveBeenCalled();
  });
});
