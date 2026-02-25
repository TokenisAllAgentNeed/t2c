/**
 * Connect command tests — focused on edge cases for full coverage
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config module — factory must not reference outer variables (hoisting)
vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    configExists: vi.fn(),
    loadConfig: vi.fn(),
  };
});

// Mock connectors module
vi.mock("../src/connectors/index.js", () => {
  const detect = vi.fn();
  const connect = vi.fn();
  const map = new Map([
    ["test-app", {
      id: "test-app",
      name: "Test App",
      description: "A test connector",
      detect,
      connect,
    }],
  ]);

  return {
    connectors: map,
    getConnector: (id: string) => map.get(id),
    listConnectorIds: () => Array.from(map.keys()),
  };
});

import { connectCommand } from "../src/commands/connect.js";
import { configExists, loadConfig, ConfigError } from "../src/config.js";
import { connectors } from "../src/connectors/index.js";

const testConnector = () => connectors.get("test-app")!;

describe("connectCommand", () => {
  let logOutput: string;
  const originalLog = console.log;

  beforeEach(() => {
    logOutput = "";
    console.log = (...args) => { logOutput += args.join(" ") + "\n"; };
    vi.mocked(configExists).mockReset();
    vi.mocked(loadConfig).mockReset();
    vi.mocked(testConnector().detect).mockReset();
    vi.mocked(testConnector().connect).mockReset();
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("lists connectors when called with empty string", async () => {
    vi.mocked(testConnector().detect).mockResolvedValue(true);
    await connectCommand("");
    expect(logOutput).toContain("test-app");
    expect(logOutput).toContain("Test App");
  });

  it("lists connectors when called with whitespace-only string", async () => {
    vi.mocked(testConnector().detect).mockResolvedValue(false);
    await connectCommand("   ");
    expect(logOutput).toContain("test-app");
  });

  it("throws ConfigError when not initialized", async () => {
    vi.mocked(configExists).mockResolvedValue(false);

    await expect(connectCommand("test-app")).rejects.toThrow(ConfigError);
    await expect(connectCommand("test-app")).rejects.toThrow("not initialized");
  });

  it("throws ConfigError for unknown connector", async () => {
    vi.mocked(configExists).mockResolvedValue(true);
    vi.mocked(loadConfig).mockResolvedValue({
      gateUrl: "https://gate.test",
      mintUrl: "https://mint.test",
      walletPath: "~/.t2c/wallet.json",
      proxyPort: 10402,
      lowBalanceThreshold: 1000,
      autoDiscover: false,
      discoveryUrl: "https://token2.cash/gates.json",
    });

    await expect(connectCommand("nonexistent")).rejects.toThrow(ConfigError);
    await expect(connectCommand("nonexistent")).rejects.toThrow("Unknown connector");
  });

  it("calls connector.connect with loaded config", async () => {
    const testConfig = {
      gateUrl: "https://gate.test",
      mintUrl: "https://mint.test",
      walletPath: "~/.t2c/wallet.json",
      proxyPort: 10402,
      lowBalanceThreshold: 1000,
      autoDiscover: false,
      discoveryUrl: "https://token2.cash/gates.json",
    };
    vi.mocked(configExists).mockResolvedValue(true);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);
    vi.mocked(testConnector().connect).mockResolvedValue(undefined);

    await connectCommand("test-app");

    expect(testConnector().connect).toHaveBeenCalledWith(testConfig);
  });

  it("shows not-detected indicator for unavailable connectors", async () => {
    vi.mocked(testConnector().detect).mockResolvedValue(false);
    await connectCommand("");
    expect(logOutput).toContain("⚪");
  });

  it("shows detected indicator for available connectors", async () => {
    vi.mocked(testConnector().detect).mockResolvedValue(true);
    await connectCommand("");
    expect(logOutput).toContain("✅");
  });
});
