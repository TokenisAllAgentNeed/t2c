/**
 * Config command tests (src/commands/config.ts)
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
    }),
    loadOrCreateProxySecret: vi.fn().mockResolvedValue("t2c-abc123"),
  };
});

// Mock all adapters
vi.mock("../src/adapters/openclaw.js", () => ({
  openclawAdapter: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapters/cursor.js", () => ({
  cursorAdapter: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapters/env.js", () => ({
  envAdapter: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapters/cline.js", () => ({
  clineAdapter: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapters/continue.js", () => ({
  continueAdapter: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapters/aider.js", () => ({
  aiderAdapter: vi.fn().mockResolvedValue(undefined),
}));

import { configCommand } from "../src/commands/config.js";
import { openclawAdapter } from "../src/adapters/openclaw.js";
import { cursorAdapter } from "../src/adapters/cursor.js";
import { envAdapter } from "../src/adapters/env.js";
import { clineAdapter } from "../src/adapters/cline.js";
import { continueAdapter } from "../src/adapters/continue.js";
import { aiderAdapter } from "../src/adapters/aider.js";

describe("configCommand", () => {
  let logOutput: string;
  let errOutput: string;
  const originalLog = console.log;
  const originalErr = console.error;
  const originalExit = process.exit;

  beforeEach(() => {
    logOutput = "";
    errOutput = "";
    console.log = (...args) => { logOutput += args.join(" ") + "\n"; };
    console.error = (...args) => { errOutput += args.join(" ") + "\n"; };
    process.exit = vi.fn() as unknown as typeof process.exit;
    vi.mocked(openclawAdapter).mockReset().mockResolvedValue(undefined);
    vi.mocked(cursorAdapter).mockReset().mockResolvedValue(undefined);
    vi.mocked(envAdapter).mockReset().mockResolvedValue(undefined);
    vi.mocked(clineAdapter).mockReset().mockResolvedValue(undefined);
    vi.mocked(continueAdapter).mockReset().mockResolvedValue(undefined);
    vi.mocked(aiderAdapter).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalErr;
    process.exit = originalExit;
  });

  it("lists all supported tools", async () => {
    await configCommand("list", {});
    expect(logOutput).toContain("Supported AI Tools");
    expect(logOutput).toContain("openclaw");
    expect(logOutput).toContain("cursor");
    expect(logOutput).toContain("cline");
    expect(logOutput).toContain("continue");
    expect(logOutput).toContain("aider");
    expect(logOutput).toContain("env");
  });

  it("calls openclaw adapter", async () => {
    await configCommand("openclaw", {});
    expect(openclawAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ gateUrl: "https://gate.test.local" }),
      expect.objectContaining({ proxySecret: "t2c-abc123" }),
    );
  });

  it("calls cursor adapter", async () => {
    await configCommand("cursor", {});
    expect(cursorAdapter).toHaveBeenCalled();
  });

  it("calls env adapter", async () => {
    await configCommand("env", {});
    expect(envAdapter).toHaveBeenCalled();
  });

  it("calls cline adapter", async () => {
    await configCommand("cline", {});
    expect(clineAdapter).toHaveBeenCalled();
  });

  it("calls continue adapter", async () => {
    await configCommand("continue", {});
    expect(continueAdapter).toHaveBeenCalled();
  });

  it("calls aider adapter", async () => {
    await configCommand("aider", {});
    expect(aiderAdapter).toHaveBeenCalled();
  });

  it("shows error for unknown tool", async () => {
    // process.exit is mocked, so execution continues past the guard —
    // the adapter lookup returns undefined and throws.
    await configCommand("unknown-tool", {}).catch(() => {});
    expect(errOutput).toContain("Unknown tool");
    expect(errOutput).toContain("unknown-tool");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("passes --json option to adapter", async () => {
    await configCommand("openclaw", { json: true });
    expect(openclawAdapter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ json: true, proxySecret: "t2c-abc123" }),
    );
  });

  it("passes --apply option to adapter", async () => {
    await configCommand("openclaw", { apply: true });
    expect(openclawAdapter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apply: true, proxySecret: "t2c-abc123" }),
    );
  });
});
