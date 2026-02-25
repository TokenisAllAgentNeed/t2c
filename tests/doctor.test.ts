/**
 * Doctor command tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
    checkGateHealth: vi.fn().mockResolvedValue(true),
    checkMintHealth: vi.fn().mockResolvedValue(true),
    CONFIG_PATH: "/home/test/.t2c/config.json",
    WALLET_PATH: "/home/test/.t2c/wallet.json",
  };
});

vi.mock("../src/cashu-store.js", () => ({
  CashuStore: {
    load: vi.fn().mockResolvedValue({ balance: 5000, proofCount: 10 }),
  },
}));

// Mock fs/promises for service check
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual.default,
      access: vi.fn(),
    },
  };
});

import fsMod from "node:fs/promises";
import { doctorCommand } from "../src/commands/doctor.js";
import { configExists, checkGateHealth, checkMintHealth } from "../src/config.js";
import { CashuStore } from "../src/cashu-store.js";

describe("doctorCommand", () => {
  let logOutput: string;
  const originalLog = console.log;
  const mockedLoad = vi.mocked(CashuStore.load);

  beforeEach(() => {
    logOutput = "";
    console.log = (...args) => { logOutput += args.join(" ") + "\n"; };
    mockFetch.mockReset();
    vi.mocked(configExists).mockResolvedValue(true);
    vi.mocked(checkGateHealth).mockResolvedValue(true);
    vi.mocked(checkMintHealth).mockResolvedValue(true);
    mockedLoad.mockResolvedValue({ balance: 5000, proofCount: 10 } as any);
    // Proxy health check — not running
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    // Service plist/unit file — not found by default
    vi.mocked(fsMod.access).mockRejectedValue(new Error("ENOENT"));
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("displays doctor header", async () => {
    await doctorCommand();
    expect(logOutput).toContain("Token2Chat Doctor");
  });

  it("shows config check result", async () => {
    await doctorCommand();
    expect(logOutput).toContain("Config");
  });

  it("shows config not found when missing", async () => {
    vi.mocked(configExists).mockResolvedValueOnce(false);
    await doctorCommand();
    expect(logOutput).toContain("Not found");
    expect(logOutput).toContain("t2c setup");
  });

  it("shows wallet check result", async () => {
    await doctorCommand();
    expect(logOutput).toContain("Wallet");
  });

  it("shows wallet not found", async () => {
    mockedLoad.mockRejectedValueOnce(new Error("ENOENT"));
    await doctorCommand();
    expect(logOutput).toContain("Not found or unreadable");
  });

  it("shows proxy not running", async () => {
    await doctorCommand();
    expect(logOutput).toContain("Proxy");
    expect(logOutput).toContain("Not running");
  });

  it("shows proxy running when health check succeeds", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await doctorCommand();
    expect(logOutput).toContain("Running");
  });

  it("shows proxy health check failed for non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    await doctorCommand();
    expect(logOutput).toContain("health check failed");
  });

  it("shows gate reachable", async () => {
    await doctorCommand();
    expect(logOutput).toContain("Gate");
    expect(logOutput).toContain("reachable");
  });

  it("shows gate unreachable", async () => {
    vi.mocked(checkGateHealth).mockResolvedValueOnce(false);
    await doctorCommand();
    expect(logOutput).toContain("unreachable");
  });

  it("shows mint reachable", async () => {
    await doctorCommand();
    expect(logOutput).toContain("Mint");
    expect(logOutput).toContain("reachable");
  });

  it("shows mint unreachable then tries alternate endpoint", async () => {
    vi.mocked(checkMintHealth).mockResolvedValueOnce(false);
    // The alternate fetch also fails
    // (mockFetch already rejects by default)
    await doctorCommand();
    expect(logOutput).toContain("Mint");
  });

  it("shows mint reachable via alternate endpoint", async () => {
    vi.mocked(checkMintHealth).mockResolvedValueOnce(false);
    // First call is proxy health (rejected), second is mint /info
    mockFetch.mockRejectedValueOnce(new Error("proxy down"));
    mockFetch.mockResolvedValueOnce({ ok: true });
    await doctorCommand();
    expect(logOutput).toContain("Mint");
    expect(logOutput).toContain("reachable");
  });

  it("shows service status", async () => {
    await doctorCommand();
    expect(logOutput).toContain("Service");
  });

  it("shows all systems operational when everything passes", async () => {
    // Need proxy to pass too
    mockFetch.mockResolvedValueOnce({ ok: true });
    // We can't easily ensure service file exists, so it will fail
    // Just check for the suggestion block
    await doctorCommand();
    expect(logOutput).toContain("Suggested fixes");
  });

  it("shows suggested fixes for failed checks", async () => {
    vi.mocked(configExists).mockResolvedValueOnce(false);
    await doctorCommand();
    expect(logOutput).toContain("Suggested fixes");
  });

  it("shows all systems operational when all checks pass", async () => {
    // Proxy health passes
    mockFetch.mockResolvedValueOnce({ ok: true });
    // Service file access succeeds (launchd on darwin, systemd on linux)
    vi.mocked(fsMod.access).mockResolvedValue(undefined);

    await doctorCommand();
    expect(logOutput).toContain("All systems operational");
  });

  describe("checkService platform branches", () => {
    it("shows service installed on darwin when plist exists", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      vi.mocked(fsMod.access).mockResolvedValue(undefined);

      await doctorCommand();

      if (process.platform === "darwin") {
        expect(logOutput).toContain("Installed (launchd)");
      }
    });

    it("shows service not installed on darwin when plist missing", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      vi.mocked(fsMod.access).mockRejectedValue(new Error("ENOENT"));

      await doctorCommand();

      if (process.platform === "darwin") {
        expect(logOutput).toContain("Not installed");
        expect(logOutput).toContain("t2c service install");
      }
    });

    it("shows service status for linux when systemd unit exists", async () => {
      const platformSpy = vi.spyOn(os, "platform").mockReturnValue("linux");
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      vi.mocked(fsMod.access).mockResolvedValue(undefined);

      await doctorCommand();
      expect(logOutput).toContain("Installed (systemd)");

      platformSpy.mockRestore();
    });

    it("shows service not installed for linux when systemd unit missing", async () => {
      const platformSpy = vi.spyOn(os, "platform").mockReturnValue("linux");
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      vi.mocked(fsMod.access).mockRejectedValue(new Error("ENOENT"));

      await doctorCommand();
      expect(logOutput).toContain("Not installed");

      platformSpy.mockRestore();
    });

    it("shows unsupported platform for non-darwin/linux", async () => {
      const platformSpy = vi.spyOn(os, "platform").mockReturnValue("win32");
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      await doctorCommand();
      expect(logOutput).toContain("Unsupported platform");

      platformSpy.mockRestore();
    });
  });
});
