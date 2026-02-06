/**
 * Init command tests
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
    checkGateHealth: vi.fn().mockResolvedValue(true),
    checkMintHealth: vi.fn().mockResolvedValue(true),
    resolveHome: vi.fn((p: string) => p.replace("~", "/home/test")),
  };
});

vi.mock("../src/cashu-store.js", () => ({
  CashuStore: {
    load: vi.fn().mockResolvedValue({ balance: 0, proofCount: 0 }),
  },
}));

import { initCommand } from "../src/commands/init.js";
import { configExists, saveConfig, checkGateHealth, checkMintHealth } from "../src/config.js";
import { CashuStore } from "../src/cashu-store.js";

describe("initCommand", () => {
  let logOutput: string;
  let stdoutOutput: string;
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  const mockedLoad = vi.mocked(CashuStore.load);

  beforeEach(() => {
    logOutput = "";
    stdoutOutput = "";
    console.log = (...args) => { logOutput += args.join(" ") + "\n"; };
    process.stdout.write = ((...args: unknown[]) => {
      stdoutOutput += String(args[0]);
      return true;
    }) as typeof process.stdout.write;
    vi.mocked(configExists).mockReset().mockResolvedValue(false);
    vi.mocked(saveConfig).mockReset().mockResolvedValue(undefined);
    vi.mocked(checkGateHealth).mockReset().mockResolvedValue(true);
    vi.mocked(checkMintHealth).mockReset().mockResolvedValue(true);
    mockedLoad.mockReset().mockResolvedValue({ balance: 0, proofCount: 0 } as any);
  });

  afterEach(() => {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  });

  it("displays init header", async () => {
    await initCommand();
    expect(logOutput).toContain("Token2Chat Init");
  });

  it("checks gate and mint connectivity", async () => {
    await initCommand();
    expect(checkGateHealth).toHaveBeenCalled();
    expect(checkMintHealth).toHaveBeenCalled();
  });

  it("saves config on first run", async () => {
    await initCommand();
    expect(saveConfig).toHaveBeenCalled();
  });

  it("initializes wallet", async () => {
    await initCommand();
    expect(CashuStore.load).toHaveBeenCalled();
    expect(logOutput).toContain("Wallet initialized");
  });

  it("shows next steps", async () => {
    await initCommand();
    expect(logOutput).toContain("Next steps");
    expect(logOutput).toContain("t2c connect");
    expect(logOutput).toContain("t2c mint");
  });

  it("shows already initialized when config exists", async () => {
    vi.mocked(configExists).mockResolvedValueOnce(true);
    await initCommand();
    expect(logOutput).toContain("Already initialized");
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("reinitializes with --force flag", async () => {
    vi.mocked(configExists).mockResolvedValueOnce(true);
    await initCommand({ force: true });
    expect(saveConfig).toHaveBeenCalled();
    expect(logOutput).toContain("Config saved");
  });

  it("shows unreachable indicator when gate is down", async () => {
    vi.mocked(checkGateHealth).mockResolvedValueOnce(false);
    await initCommand();
    expect(logOutput).toContain("Unreachable");
  });

  it("shows unreachable indicator when mint is down", async () => {
    vi.mocked(checkMintHealth).mockResolvedValueOnce(false);
    await initCommand();
    expect(logOutput).toContain("Unreachable");
  });

  it("handles wallet init failure gracefully", async () => {
    mockedLoad.mockRejectedValueOnce(new Error("disk full"));
    await initCommand();
    expect(logOutput).toContain("Wallet init failed");
  });
});
