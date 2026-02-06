/**
 * Status command tests
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
      autoDiscover: false,
      discoveryUrl: "https://token2.cash/gates.json",
    }),
    configExists: vi.fn().mockResolvedValue(true),
    resolveHome: vi.fn((p: string) => p.replace("~", "/home/test")),
    checkGateHealth: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../src/cashu-store.js", () => ({
  CashuStore: {
    load: vi.fn().mockResolvedValue({ balance: 5000, proofCount: 10 }),
  },
}));

import { statusCommand } from "../src/commands/status.js";
import { configExists, checkGateHealth } from "../src/config.js";
import { CashuStore } from "../src/cashu-store.js";

describe("statusCommand", () => {
  let logOutput: string;
  const originalLog = console.log;
  const mockedLoad = vi.mocked(CashuStore.load);

  beforeEach(() => {
    logOutput = "";
    console.log = (...args) => { logOutput += args.join(" ") + "\n"; };
    mockFetch.mockReset();
    vi.mocked(configExists).mockResolvedValue(true);
    vi.mocked(checkGateHealth).mockResolvedValue(true);
    mockedLoad.mockResolvedValue({ balance: 5000, proofCount: 10 } as any);
    // Proxy health check — not running by default
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("shows configured status", async () => {
    await statusCommand({});
    expect(logOutput).toContain("Configured");
  });

  it("shows not configured when config missing", async () => {
    vi.mocked(configExists).mockResolvedValueOnce(false);
    await statusCommand({});
    expect(logOutput).toContain("Not configured");
  });

  it("shows proxy not running", async () => {
    await statusCommand({});
    expect(logOutput).toContain("Not running");
  });

  it("shows proxy running when health check passes", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });
    await statusCommand({});
    expect(logOutput).toContain("Running");
  });

  it("shows gate reachable", async () => {
    await statusCommand({});
    expect(logOutput).toContain("gate.test.local");
  });

  it("shows wallet balance", async () => {
    await statusCommand({});
    expect(logOutput).toContain("$0.05");
    expect(logOutput).toContain("10 proofs");
  });

  it("shows low balance warning when balance is below threshold", async () => {
    mockedLoad.mockResolvedValueOnce({ balance: 500, proofCount: 3 } as any);
    await statusCommand({});
    expect(logOutput).toContain("Low balance");
  });

  it("shows add funds message for zero balance", async () => {
    mockedLoad.mockResolvedValueOnce({ balance: 0, proofCount: 0 } as any);
    await statusCommand({});
    expect(logOutput).toContain("add funds");
  });

  it("shows no wallet when wallet fails to load", async () => {
    mockedLoad.mockRejectedValueOnce(new Error("not found"));
    await statusCommand({});
    expect(logOutput).toContain("No wallet found");
  });

  it("outputs valid JSON with --json", async () => {
    await statusCommand({ json: true });
    const parsed = JSON.parse(logOutput.trim());
    expect(parsed).toHaveProperty("configured", true);
    expect(parsed).toHaveProperty("proxyRunning", false);
    expect(parsed).toHaveProperty("wallet");
    expect(parsed.wallet.balance).toBe(5000);
    expect(parsed).toHaveProperty("gate");
    expect(parsed.gate.reachable).toBe(true);
  });

  it("JSON output includes null wallet when wallet missing", async () => {
    mockedLoad.mockRejectedValueOnce(new Error("nope"));
    await statusCommand({ json: true });
    const parsed = JSON.parse(logOutput.trim());
    expect(parsed.wallet).toBeNull();
  });

  it("JSON output shows proxyUrl when proxy running", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });
    await statusCommand({ json: true });
    const parsed = JSON.parse(logOutput.trim());
    expect(parsed.proxyRunning).toBe(true);
    expect(parsed.proxyUrl).toBe("http://127.0.0.1:10402");
  });
});
