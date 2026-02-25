/**
 * Debug command tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Globals mock ──────────────────────────────────────────────────
vi.stubGlobal("fetch", vi.fn());

// ── Mock os.homedir() so all module-level paths are predictable ──
// NOTE: vi.mock factories are hoisted above const declarations, so we
// use string literals inside the factory to avoid "before initialization" errors.
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => "/home/test",
    },
  };
});

// ── Mock fs/promises ──────────────────────────────────────────────
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      access: vi.fn(),
      readdir: vi.fn().mockResolvedValue([]),
      copyFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// ── Mock config module ────────────────────────────────────────────
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
    loadOrCreateProxySecret: vi.fn().mockResolvedValue("test-secret-123"),
    formatUnits: vi.fn((units: number) => {
      const dollars = units / 100000;
      return "$" + dollars.toFixed(dollars >= 1 || dollars === 0 ? 2 : 5);
    }),
  };
});

// ── Mock cashu-store module (for dynamic import in topup) ─────────
// No external variable references in factory (hoisted).
vi.mock("../src/cashu-store.js", () => ({
  CashuStore: {
    load: vi.fn().mockResolvedValue({
      balance: 5000,
      proofCount: 10,
      receiveToken: vi.fn(),
    }),
  },
}));

import fs from "node:fs/promises";
import path from "node:path";
import { debugCommand } from "../src/commands/debug.js";
import { loadConfig, loadOrCreateProxySecret, formatUnits } from "../src/config.js";
import { CashuStore } from "../src/cashu-store.js";

// Constants matching module-level paths in debug.ts (using the mocked homedir)
const TEST_HOME = "/home/test";
const OPENCLAW_DIR = path.join(TEST_HOME, ".openclaw");
const OPENCLAW_CONFIG = path.join(OPENCLAW_DIR, "openclaw.json");
const OPENCLAW_BACKUP = path.join(OPENCLAW_DIR, "openclaw.json.t2c-debug-bak");
const PENDING_TOKEN_PATH = path.join(TEST_HOME, ".t2c", "pending-topup.token");

/** Helper to get the receiveToken mock from the current CashuStore.load mock value */
function getReceiveTokenMock(): ReturnType<typeof vi.fn> {
  const wallet = vi.mocked(CashuStore.load).mock.results.at(-1);
  if (wallet && wallet.type === "return") {
    return (wallet.value as Promise<{ receiveToken: ReturnType<typeof vi.fn> }>)
      .then((w) => w.receiveToken) as any;
  }
  // Fallback: create a fresh mock via the mock setup
  const receiveToken = vi.fn();
  vi.mocked(CashuStore.load).mockResolvedValue({
    balance: 5000,
    proofCount: 10,
    receiveToken,
  } as any);
  return receiveToken;
}

/** Helper to set up the wallet mock with a controllable receiveToken */
function setupWallet(): ReturnType<typeof vi.fn> {
  const receiveToken = vi.fn();
  vi.mocked(CashuStore.load).mockResolvedValue({
    balance: 5000,
    proofCount: 10,
    receiveToken,
  } as any);
  return receiveToken;
}

describe("debugCommand", () => {
  let logOutput: string;
  let errOutput: string;
  const originalLog = console.log;
  const originalErr = console.error;
  const originalExit = process.exit;
  let mockReceiveToken: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logOutput = "";
    errOutput = "";
    console.log = (...args: unknown[]) => { logOutput += args.join(" ") + "\n"; };
    console.error = (...args: unknown[]) => { errOutput += args.join(" ") + "\n"; };
    process.exit = vi.fn() as unknown as typeof process.exit;
    vi.mocked(globalThis.fetch).mockReset();
    vi.mocked(fs.readFile).mockReset();
    vi.mocked(fs.writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(fs.unlink).mockReset().mockResolvedValue(undefined);
    vi.mocked(fs.access).mockReset();
    vi.mocked(fs.readdir).mockReset().mockResolvedValue([]);
    vi.mocked(fs.copyFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockReset().mockResolvedValue(undefined as any);
    vi.mocked(loadConfig).mockResolvedValue({
      gateUrl: "https://gate.test.local",
      mintUrl: "https://mint.test.local",
      walletPath: "~/.t2c/wallet.json",
      proxyPort: 10402,
      lowBalanceThreshold: 1000,
      autoDiscover: false,
      discoveryUrl: "https://token2.cash/gates.json",
    });
    vi.mocked(loadOrCreateProxySecret).mockResolvedValue("test-secret-123");
    mockReceiveToken = setupWallet();
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalErr;
    process.exit = originalExit;
  });

  // ══════════════════════════════════════════════════════════════════
  // debugCommand dispatch
  // ══════════════════════════════════════════════════════════════════

  describe("dispatch", () => {
    it("calls forceToken2Chat for 'force' subcommand", async () => {
      // access rejects -> "config not found" path entered
      // readFile still needs valid JSON because process.exit is mocked (doesn't stop)
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({}) as any);
      vi.mocked(fs.readdir).mockResolvedValue([]);
      await debugCommand("force");
      expect(errOutput).toContain("OpenClaw config not found");
    });

    it("calls rollbackConfig for 'rollback' subcommand", async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      await debugCommand("rollback");
      expect(errOutput).toContain("No debug backup found");
    });

    it("calls showLogs for 'logs' subcommand", async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));
      await debugCommand("logs");
      expect(logOutput).toContain("Auth Profiles");
    });

    it("calls topupFromGate for 'topup' subcommand", async () => {
      await debugCommand("topup");
      expect(errOutput).toContain("Specify a positive amount");
    });

    it("prints usage help for unknown subcommand", async () => {
      await debugCommand("unknown");
      expect(logOutput).toContain("t2c debug");
      expect(logOutput).toContain("Usage:");
      expect(logOutput).toContain("force");
      expect(logOutput).toContain("rollback");
      expect(logOutput).toContain("logs");
      expect(logOutput).toContain("topup");
    });

    it("prints usage help for empty subcommand", async () => {
      await debugCommand("");
      expect(logOutput).toContain("Usage:");
    });

    it("prints development warning in usage help", async () => {
      await debugCommand("anything-else");
      expect(logOutput).toContain("development/testing only");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // forceToken2Chat
  // ══════════════════════════════════════════════════════════════════

  describe("force", () => {
    it("exits when OpenClaw config not found", async () => {
      // access rejects -> "config not found" path, but since process.exit
      // is mocked, execution continues past it. Provide valid readFile
      // response so it doesn't crash on loadOpenClawConfig.
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({}) as any);
      vi.mocked(fs.readdir).mockResolvedValue([]);
      await debugCommand("force");
      expect(errOutput).toContain("OpenClaw config not found");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("exits when backup already exists (already forced)", async () => {
      // Both access(OPENCLAW_CONFIG) and access(OPENCLAW_BACKUP) succeed
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({}) as any);
      vi.mocked(fs.readdir).mockResolvedValue([]);
      await debugCommand("force");
      expect(errOutput).toContain("Already in debug-force mode");
      expect(errOutput).toContain("rollback");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("successfully forces token2chat as sole provider", async () => {
      vi.mocked(fs.access)
        .mockResolvedValueOnce(undefined)           // OPENCLAW_CONFIG exists
        .mockRejectedValueOnce(new Error("ENOENT")); // OPENCLAW_BACKUP doesn't exist

      const openclawConfig = {
        auth: { profiles: { existing: {} }, order: { key: "val" } },
        models: { mode: "something", providers: { openai: {} } },
        agents: { defaults: { model: { primary: "openai/gpt-4", fallbacks: ["openai/gpt-3"] } } },
      };
      const configJson = JSON.stringify(openclawConfig, null, 2);

      vi.mocked(fs.readFile).mockResolvedValue(configJson as any);
      vi.mocked(fs.readdir).mockResolvedValue([]);

      await debugCommand("force");

      expect(logOutput).toContain("Backed up current config");
      expect(logOutput).toContain("Forced token2chat as sole provider");
      expect(logOutput).toContain("token2chat/anthropic-claude-opus-4-20250514");
      expect(logOutput).toContain("Restart OpenClaw");
      expect(logOutput).toContain("t2c debug rollback");
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it("handles config with no auth section", async () => {
      vi.mocked(fs.access)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("ENOENT"));

      const configNoAuth = { models: { mode: "merge", providers: {} } };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(configNoAuth) as any);
      vi.mocked(fs.readdir).mockResolvedValue([]);

      await debugCommand("force");

      expect(logOutput).toContain("Forced token2chat as sole provider");
    });

    it("handles config with no models section", async () => {
      vi.mocked(fs.access)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("ENOENT"));

      const configNoModels = { auth: { profiles: { p: {} }, order: {} } };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(configNoModels) as any);
      vi.mocked(fs.readdir).mockResolvedValue([]);

      await debugCommand("force");

      expect(logOutput).toContain("Forced token2chat as sole provider");
      const writeCall = vi.mocked(fs.writeFile).mock.calls.find(
        (call) => call[0] === OPENCLAW_CONFIG
      );
      expect(writeCall).toBeDefined();
      const saved = JSON.parse(writeCall![1] as string);
      expect(saved.models).toBeDefined();
      expect(saved.models.providers.token2chat).toBeDefined();
    });

    it("handles config with no agents section", async () => {
      vi.mocked(fs.access)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("ENOENT"));

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({}) as any);
      vi.mocked(fs.readdir).mockResolvedValue([]);

      await debugCommand("force");

      expect(logOutput).toContain("Forced token2chat as sole provider");
      const writeCall = vi.mocked(fs.writeFile).mock.calls.find(
        (call) => call[0] === OPENCLAW_CONFIG
      );
      expect(writeCall).toBeDefined();
      const saved = JSON.parse(writeCall![1] as string);
      expect(saved.agents.defaults.model.primary).toBe("token2chat/anthropic-claude-opus-4-20250514");
    });

    it("clears token2chat cooldowns during force", async () => {
      vi.mocked(fs.access)
        .mockResolvedValueOnce(undefined)           // OPENCLAW_CONFIG exists
        .mockRejectedValueOnce(new Error("ENOENT")) // OPENCLAW_BACKUP doesn't exist
        .mockResolvedValueOnce(undefined);           // auth-profiles.json found for agent

      const openclawConfig = { models: {} };
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(openclawConfig) as any) // loadOpenClawConfig
        .mockResolvedValueOnce(JSON.stringify(openclawConfig) as any) // backup raw read
        .mockResolvedValueOnce(JSON.stringify({                        // auth-profiles.json
          usageStats: {
            "token2chat/model-a": {
              disabledUntil: Date.now() + 60000,
              disabledReason: "rate_limit",
              errorCount: 5,
              failureCounts: { "429": 3 },
            },
            "openai/gpt-4": {
              disabledUntil: Date.now() + 60000,
              disabledReason: "billing",
              errorCount: 2,
            },
          },
        }) as any);

      vi.mocked(fs.readdir).mockResolvedValue(["agent1" as any]);

      await debugCommand("force");

      expect(logOutput).toContain("Cleared 1 token2chat cooldown");

      // Verify auth profile was written with cleared cooldown
      const profileWriteCall = vi.mocked(fs.writeFile).mock.calls.find(
        (call) => (call[0] as string).includes("auth-profiles.json")
      );
      expect(profileWriteCall).toBeDefined();
      const profileData = JSON.parse(profileWriteCall![1] as string);
      expect(profileData.usageStats["token2chat/model-a"].disabledUntil).toBeNull();
      expect(profileData.usageStats["token2chat/model-a"].errorCount).toBe(0);
      expect(profileData.usageStats["token2chat/model-a"].failureCounts).toEqual({});
      // Non-token2chat should be unchanged
      expect(profileData.usageStats["openai/gpt-4"].disabledUntil).toBeDefined();
      expect(profileData.usageStats["openai/gpt-4"].errorCount).toBe(2);
    });

    it("handles empty usageStats during cooldown clearing", async () => {
      vi.mocked(fs.access)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockResolvedValueOnce(undefined);

      const openclawConfig = { models: {} };
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(openclawConfig) as any)
        .mockResolvedValueOnce(JSON.stringify(openclawConfig) as any)
        .mockResolvedValueOnce(JSON.stringify({ usageStats: {} }) as any);

      vi.mocked(fs.readdir).mockResolvedValue(["agent1" as any]);

      await debugCommand("force");

      expect(logOutput).not.toContain("Cleared");
      expect(logOutput).toContain("Forced token2chat");
    });

    it("handles profile with no usageStats during cooldown clearing", async () => {
      vi.mocked(fs.access)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockResolvedValueOnce(undefined);

      const openclawConfig = { models: {} };
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(openclawConfig) as any)
        .mockResolvedValueOnce(JSON.stringify(openclawConfig) as any)
        .mockResolvedValueOnce(JSON.stringify({}) as any);

      vi.mocked(fs.readdir).mockResolvedValue(["agent1" as any]);

      await debugCommand("force");

      expect(logOutput).toContain("Forced token2chat");
    });

    it("handles unreadable profile files during cooldown clearing", async () => {
      vi.mocked(fs.access)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockResolvedValueOnce(undefined);

      const openclawConfig = { models: {} };
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(openclawConfig) as any)
        .mockResolvedValueOnce(JSON.stringify(openclawConfig) as any)
        .mockRejectedValueOnce(new Error("Permission denied"));

      vi.mocked(fs.readdir).mockResolvedValue(["agent1" as any]);

      await debugCommand("force");

      expect(logOutput).toContain("Forced token2chat");
    });

    it("sets correct model configuration in forced config", async () => {
      vi.mocked(fs.access)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("ENOENT"));

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({}) as any);
      vi.mocked(fs.readdir).mockResolvedValue([]);

      await debugCommand("force");

      const writeCall = vi.mocked(fs.writeFile).mock.calls.find(
        (call) => call[0] === OPENCLAW_CONFIG
      );
      const saved = JSON.parse(writeCall![1] as string);

      expect(saved.models.mode).toBe("merge");
      expect(saved.models.providers.token2chat.baseUrl).toContain("10402");
      expect(saved.models.providers.token2chat.apiKey).toBe("test-secret-123");
      expect(saved.models.providers.token2chat.api).toBe("openai-completions");
      expect(saved.models.providers.token2chat.models).toHaveLength(4);

      expect(saved.agents.defaults.model.fallbacks).toEqual([
        "token2chat/anthropic-claude-sonnet-4-20250514",
        "token2chat/openai-gpt-4o",
        "token2chat/openai-gpt-4o-mini",
      ]);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // rollbackConfig
  // ══════════════════════════════════════════════════════════════════

  describe("rollback", () => {
    it("exits when no backup found", async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      await debugCommand("rollback");
      expect(errOutput).toContain("No debug backup found");
      expect(errOutput).toContain("Nothing to rollback");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("successfully restores config from backup", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      await debugCommand("rollback");

      expect(fs.copyFile).toHaveBeenCalledWith(OPENCLAW_BACKUP, OPENCLAW_CONFIG);
      expect(fs.unlink).toHaveBeenCalledWith(OPENCLAW_BACKUP);
      expect(logOutput).toContain("Config restored from backup");
      expect(logOutput).toContain("Restart OpenClaw");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // showLogs
  // ══════════════════════════════════════════════════════════════════

  describe("logs", () => {
    it("displays auth profiles header", async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));
      await debugCommand("logs");
      expect(logOutput).toContain("Auth Profiles");
      expect(logOutput).toContain("Cooldowns");
    });

    it("shows 'No usage stats' for profiles without usageStats", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["myagent" as any]);
      vi.mocked(fs.access).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("auth-profiles.json")) return undefined;
        if (ps.includes("gateway")) throw new Error("ENOENT");
        return undefined;
      });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({}) as any);
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("No usage stats");
    });

    it("displays profile with active cooldown", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["testagent" as any]);
      vi.mocked(fs.access).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("auth-profiles.json")) return undefined;
        if (ps.includes("gateway")) throw new Error("ENOENT");
        return undefined;
      });
      const futureTime = Date.now() + 300000; // 5 min in future
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        usageStats: {
          "openai/gpt-4": {
            lastUsed: Date.now() - 10000,
            disabledUntil: futureTime,
            disabledReason: "rate_limit",
            errorCount: 3,
            failureCounts: { "429": 2 },
          },
        },
      }) as any);
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("testagent");
      expect(logOutput).toContain("COOLDOWN");
      expect(logOutput).toContain("rate_limit");
      expect(logOutput).toContain("min left");
      expect(logOutput).toContain("Failures:");
    });

    it("displays profile with errors but no active cooldown", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["agent1" as any]);
      vi.mocked(fs.access).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("auth-profiles.json")) return undefined;
        if (ps.includes("gateway")) throw new Error("ENOENT");
        return undefined;
      });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        usageStats: {
          "openai/gpt-4": {
            lastUsed: Date.now() - 10000,
            errorCount: 2,
            disabledUntil: null,
          },
        },
      }) as any);
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("2 errors");
    });

    it("shows OK status for healthy profile", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["agent1" as any]);
      vi.mocked(fs.access).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("auth-profiles.json")) return undefined;
        if (ps.includes("gateway")) throw new Error("ENOENT");
        return undefined;
      });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        usageStats: {
          "openai/gpt-4": {
            lastUsed: Date.now() - 10000,
            errorCount: 0,
          },
        },
      }) as any);
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("OK");
    });

    it("shows marker for token2chat provider entries", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["agent1" as any]);
      vi.mocked(fs.access).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("auth-profiles.json")) return undefined;
        if (ps.includes("gateway")) throw new Error("ENOENT");
        return undefined;
      });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        usageStats: {
          "token2chat/model-x": {
            lastUsed: Date.now(),
            errorCount: 0,
          },
        },
      }) as any);
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("token2chat/model-x");
    });

    it("shows 'never' for profile with no lastUsed", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["agent1" as any]);
      vi.mocked(fs.access).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("auth-profiles.json")) return undefined;
        if (ps.includes("gateway")) throw new Error("ENOENT");
        return undefined;
      });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        usageStats: {
          "openai/gpt-4": {},
        },
      }) as any);
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("never");
    });

    it("handles missing agents directory", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("Auth Profiles");
    });

    it("handles unreadable profile files", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["broken-agent" as any]);
      vi.mocked(fs.access).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("auth-profiles.json")) return undefined;
        if (ps.includes("gateway")) throw new Error("ENOENT");
        return undefined;
      });
      vi.mocked(fs.readFile).mockRejectedValue(new Error("Permission denied"));
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("Failed to read");
    });

    it("parses gateway log files for keyword matches", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("gateway.err.log")) {
          return "Error: model not found\nSome other line\nAll models failed for request\n" as any;
        }
        if (ps.includes("gateway.log")) {
          return "INFO: provider token2chat connected\nDEBUG: something unrelated\nWARN: rate_limit hit\n" as any;
        }
        return "" as any;
      });
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("model not found");
      expect(logOutput).toContain("All models failed");
      expect(logOutput).toContain("token2chat connected");
      expect(logOutput).toContain("rate_limit hit");
      expect(logOutput).not.toContain("something unrelated");
    });

    it("shows 'No model/provider entries found' when no matches", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("gateway")) {
          return "Some unrelated log line\nAnother unrelated line\n" as any;
        }
        return "" as any;
      });
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("No model/provider entries found");
    });

    it("handles missing log files gracefully", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("Recent Model/Provider Errors");
    });

    it("shows proxy health when running (fetch succeeds)", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ balance: 5000 }),
      } as any);

      await debugCommand("logs");

      expect(logOutput).toContain("Running on port 10402");
      expect(formatUnits).toHaveBeenCalledWith(5000);
    });

    it("shows 'unknown' balance when health data has no balance field", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as any);

      await debugCommand("logs");

      expect(logOutput).toContain("Running on port 10402");
      expect(logOutput).toContain("unknown");
    });

    it("shows proxy not reachable when fetch fails", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("Not reachable");
      expect(logOutput).toContain("10402");
    });

    it("shows HTTP error status when proxy returns non-ok", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: false,
        status: 503,
      } as any);

      await debugCommand("logs");

      expect(logOutput).toContain("HTTP 503");
    });

    it("respects --lines option", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      const manyLines = Array.from({ length: 50 }, (_, i) => `Error: model failure ${i}`).join("\n");
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("gateway.err.log")) return manyLines as any;
        if (ps.includes("gateway.log")) return "" as any;
        return "" as any;
      });
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs", { lines: "5" });

      expect(logOutput).toContain("Last 5 entries");
    });

    it("defaults to 30 lines when --lines not specified", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      const manyLines = Array.from({ length: 40 }, (_, i) => `Error: model failure ${i}`).join("\n");
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("gateway.err.log")) return manyLines as any;
        if (ps.includes("gateway.log")) return "" as any;
        return "" as any;
      });
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("Last 30 entries");
    });

    it("trims long log lines to 160 chars", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      const longLine = "Error: model " + "x".repeat(200);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("gateway.err.log")) return longLine as any;
        if (ps.includes("gateway.log")) return "" as any;
        return "" as any;
      });
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("...");
    });

    it("shows cooldown with 'unknown' reason when disabledReason is null", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["agent1" as any]);
      vi.mocked(fs.access).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("auth-profiles.json")) return undefined;
        if (ps.includes("gateway")) throw new Error("ENOENT");
        return undefined;
      });
      const futureTime = Date.now() + 120000;
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        usageStats: {
          "provider/model": {
            disabledUntil: futureTime,
            disabledReason: null,
            errorCount: 1,
          },
        },
      }) as any);
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("COOLDOWN");
      expect(logOutput).toContain("unknown");
    });

    it("displays proxy health section header", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("Proxy Health");
    });

    it("does not show failure counts when empty", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["agent1" as any]);
      vi.mocked(fs.access).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("auth-profiles.json")) return undefined;
        if (ps.includes("gateway")) throw new Error("ENOENT");
        return undefined;
      });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        usageStats: {
          "openai/gpt-4": {
            lastUsed: Date.now(),
            errorCount: 0,
            failureCounts: {},
          },
        },
      }) as any);
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).not.toContain("Failures:");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // topupFromGate
  // ══════════════════════════════════════════════════════════════════

  describe("topup", () => {
    it("exits with error when amount is 0", async () => {
      await debugCommand("topup", { amount: "0" });
      expect(errOutput).toContain("Specify a positive amount");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("exits with error when amount is negative", async () => {
      await debugCommand("topup", { amount: "-5" });
      expect(errOutput).toContain("Specify a positive amount");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("exits with error when amount not specified", async () => {
      await debugCommand("topup", {});
      expect(errOutput).toContain("Specify a positive amount");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("exits with error when amount is non-numeric", async () => {
      await debugCommand("topup", { amount: "abc" });
      expect(errOutput).toContain("Specify a positive amount");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("recovers pending token from previous failed topup", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) return "cashuAexistingToken123" as any;
        throw new Error("ENOENT");
      });

      mockReceiveToken.mockResolvedValue(2000);

      await debugCommand("topup", { amount: "5000" });

      expect(logOutput).toContain("Found pending token");
      expect(logOutput).toContain("Attempting to receive it first");
      expect(logOutput).toContain("Recovered");
      expect(fs.unlink).toHaveBeenCalledWith(PENDING_TOKEN_PATH);
    });

    it("handles failed pending token recovery with Error object", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) return "cashuAbadToken" as any;
        throw new Error("ENOENT");
      });

      mockReceiveToken.mockRejectedValue(new Error("token already spent"));

      await debugCommand("topup", { amount: "5000" });

      expect(errOutput).toContain("Failed to receive pending token");
      expect(errOutput).toContain("token already spent");
      expect(errOutput).toContain("Token saved at");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("handles failed pending token recovery with non-Error throw", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) return "cashuAbadToken" as any;
        throw new Error("ENOENT");
      });

      mockReceiveToken.mockRejectedValue("non-error rejection string");

      await debugCommand("topup", { amount: "5000" });

      expect(errOutput).toContain("Failed to receive pending token");
      expect(errOutput).toContain("non-error rejection string");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("skips empty pending token and proceeds to withdraw", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) return "   " as any;
        if (ps.includes("admin-token.txt")) return "admin-secret-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          token: "cashuAnewToken",
          amount_sats: 5000,
          change_sats: 0,
          remaining_balance_sats: 10000,
        }),
      } as any);
      mockReceiveToken.mockResolvedValue(5000);

      await debugCommand("topup", { amount: "5000" });

      expect(logOutput).toContain("Withdrawing");
    });

    it("exits when admin token not found", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));

      await debugCommand("topup", { amount: "5000" });

      expect(errOutput).toContain("Admin token not found");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("successful withdraw and receive flow", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("ENOENT");
        if (ps.includes("admin-token.txt")) return "my-admin-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          token: "cashuAvalidToken",
          amount_sats: 5000,
          change_sats: 200,
          remaining_balance_sats: 15000,
        }),
      } as any);
      mockReceiveToken.mockResolvedValue(5000);

      await debugCommand("topup", { amount: "5000" });

      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
        "https://gate.test.local/homo/withdraw",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Authorization": "Bearer my-admin-token",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ amount: 5000 }),
        }),
      );

      expect(logOutput).toContain("Withdrawing");
      expect(logOutput).toContain("Gate withdrew");
      expect(logOutput).toContain("Receiving token into local wallet");
      expect(logOutput).toContain("Received");
      expect(logOutput).toContain("New balance");
      expect(logOutput).toContain("Done!");

      // Token should have been saved as pending before receive
      expect(fs.writeFile).toHaveBeenCalledWith(
        PENDING_TOKEN_PATH,
        "cashuAvalidToken",
        { mode: 0o600 },
      );

      // Pending token deleted after successful receive
      expect(fs.unlink).toHaveBeenCalledWith(PENDING_TOKEN_PATH);
    });

    it("handles Gate withdraw HTTP error", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("ENOENT");
        if (ps.includes("admin-token.txt")) return "admin-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: false,
        status: 402,
        json: async () => ({ error: "Insufficient balance" }),
      } as any);

      await debugCommand("topup", { amount: "5000" });

      expect(errOutput).toContain("Gate withdraw failed");
      expect(errOutput).toContain("Insufficient balance");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("handles Gate withdraw HTTP error with no error field in response", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("ENOENT");
        if (ps.includes("admin-token.txt")) return "admin-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ message: "forbidden" }), // no "error" field
      } as any);

      await debugCommand("topup", { amount: "5000" });

      expect(errOutput).toContain("Gate withdraw failed");
      expect(errOutput).toContain("403");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("handles Gate withdraw HTTP error with unparseable JSON", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("ENOENT");
        if (ps.includes("admin-token.txt")) return "admin-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => { throw new Error("not json"); },
      } as any);

      await debugCommand("topup", { amount: "5000" });

      expect(errOutput).toContain("Gate withdraw failed");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("handles Gate withdraw unexpected response (success=false)", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("ENOENT");
        if (ps.includes("admin-token.txt")) return "admin-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: false,
          token: null,
          amount_sats: 0,
          remaining_balance_sats: 0,
        }),
      } as any);

      await debugCommand("topup", { amount: "5000" });

      expect(errOutput).toContain("Gate returned unexpected response");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("handles Gate network error", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("ENOENT");
        if (ps.includes("admin-token.txt")) return "admin-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("topup", { amount: "5000" });

      expect(errOutput).toContain("Failed to connect to Gate");
      expect(errOutput).toContain("ECONNREFUSED");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("handles Gate network error with non-Error throw", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("ENOENT");
        if (ps.includes("admin-token.txt")) return "admin-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockRejectedValue("string error");

      await debugCommand("topup", { amount: "5000" });

      expect(errOutput).toContain("Failed to connect to Gate");
      expect(errOutput).toContain("string error");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("handles pending token save failure (prints token for manual recovery)", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("ENOENT");
        if (ps.includes("admin-token.txt")) return "admin-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          token: "cashuAimportantToken",
          amount_sats: 5000,
          change_sats: 0,
          remaining_balance_sats: 10000,
        }),
      } as any);

      // mkdir succeeds but writeFile for pending token fails
      vi.mocked(fs.mkdir).mockResolvedValue(undefined as any);
      vi.mocked(fs.writeFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("EPERM");
        return undefined;
      });

      mockReceiveToken.mockResolvedValue(5000);

      await debugCommand("topup", { amount: "5000" });

      expect(errOutput).toContain("Could not save pending token");
      expect(errOutput).toContain("cashuAimportantToken");
      expect(errOutput).toContain("t2c recover");
      // Should still try to receive and succeed
      expect(logOutput).toContain("Received");
    });

    it("handles mint swap failure (token saved at path)", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("ENOENT");
        if (ps.includes("admin-token.txt")) return "admin-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          token: "cashuAtheToken",
          amount_sats: 5000,
          change_sats: 0,
          remaining_balance_sats: 10000,
        }),
      } as any);

      mockReceiveToken.mockRejectedValue(new Error("mint unreachable"));

      await debugCommand("topup", { amount: "5000" });

      expect(errOutput).toContain("Mint swap failed");
      expect(errOutput).toContain("mint unreachable");
      expect(errOutput).toContain("Token is saved at");
      expect(errOutput).toContain("still valid");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("handles mint swap failure with non-Error throw", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("ENOENT");
        if (ps.includes("admin-token.txt")) return "admin-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          token: "cashuAtoken",
          amount_sats: 5000,
          change_sats: 0,
          remaining_balance_sats: 10000,
        }),
      } as any);

      mockReceiveToken.mockRejectedValue("raw string error");

      await debugCommand("topup", { amount: "5000" });

      expect(errOutput).toContain("Mint swap failed");
      expect(errOutput).toContain("raw string error");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("calls formatUnits for withdraw and receive amounts", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("ENOENT");
        if (ps.includes("admin-token.txt")) return "admin-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          token: "cashuAtoken",
          amount_sats: 5000,
          change_sats: 100,
          remaining_balance_sats: 20000,
        }),
      } as any);
      mockReceiveToken.mockResolvedValue(5000);

      await debugCommand("topup", { amount: "5000" });

      expect(formatUnits).toHaveBeenCalledWith(5000);
      expect(formatUnits).toHaveBeenCalledWith(100);
      expect(formatUnits).toHaveBeenCalledWith(20000);
    });

    it("handles unlink failure after successful receive gracefully", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("ENOENT");
        if (ps.includes("admin-token.txt")) return "admin-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          token: "cashuAtoken",
          amount_sats: 3000,
          change_sats: 0,
          remaining_balance_sats: 7000,
        }),
      } as any);
      mockReceiveToken.mockResolvedValue(3000);

      // Make unlink fail (pending token file can't be deleted)
      vi.mocked(fs.unlink).mockRejectedValue(new Error("ENOENT"));

      await debugCommand("topup", { amount: "3000" });

      // Should still succeed — the catch block is empty
      expect(logOutput).toContain("Received");
      expect(logOutput).toContain("Done!");
    });

    it("shows new balance after successful receive", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("pending-topup.token")) throw new Error("ENOENT");
        if (ps.includes("admin-token.txt")) return "admin-token\n" as any;
        throw new Error("ENOENT");
      });

      vi.mocked(globalThis.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          token: "cashuAtoken",
          amount_sats: 3000,
          change_sats: 0,
          remaining_balance_sats: 7000,
        }),
      } as any);
      mockReceiveToken.mockResolvedValue(3000);

      // Set a specific balance for the wallet
      vi.mocked(CashuStore.load).mockResolvedValue({
        balance: 8000,
        proofCount: 15,
        receiveToken: mockReceiveToken,
      } as any);

      await debugCommand("topup", { amount: "3000" });

      expect(logOutput).toContain("New balance");
      expect(formatUnits).toHaveBeenCalledWith(8000);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // findAuthProfiles (tested indirectly via logs)
  // ══════════════════════════════════════════════════════════════════

  describe("findAuthProfiles (indirect)", () => {
    it("finds agents with auth-profiles.json and skips those without", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["agent-a", "agent-b", "agent-c"] as any);
      vi.mocked(fs.access).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("agent-a") && ps.includes("auth-profiles.json")) return undefined;
        if (ps.includes("agent-b") && ps.includes("auth-profiles.json")) throw new Error("ENOENT");
        if (ps.includes("agent-c") && ps.includes("auth-profiles.json")) return undefined;
        if (ps.includes("gateway")) throw new Error("ENOENT");
        return undefined;
      });
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        const ps = String(p);
        if (ps.includes("agent-a")) return JSON.stringify({ usageStats: { "openai/gpt-4": { lastUsed: 1 } } }) as any;
        if (ps.includes("agent-c")) return JSON.stringify({ usageStats: { "token2chat/model": { lastUsed: 2 } } }) as any;
        return "" as any;
      });
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      expect(logOutput).toContain("agent-a");
      expect(logOutput).toContain("agent-c");
      expect(logOutput).not.toContain("agent-b");
    });

    it("returns empty when agents dir does not exist", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await debugCommand("logs");

      // Should not crash, profiles section should just be empty
      expect(logOutput).toContain("Auth Profiles");
    });
  });
});
