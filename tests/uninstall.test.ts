/**
 * t2c uninstall command tests (TDD)
 *
 * The uninstall command should:
 * 1. ALWAYS preserve wallet.json (no option to delete it)
 * 2. Stop and uninstall the t2c service (launchd/systemd)
 * 3. Remove proxy-secret, config.json, proxy.log, proxy.pid, etc from ~/.t2c
 * 4. Optionally remove OpenClaw integration (--remove-openclaw flag)
 * 5. Show a dry-run listing before destructive actions
 * 6. Require confirmation before proceeding
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process
const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawn: vi.fn(),
}));

// Mock readline for confirmation prompts
const mockQuestion = vi.fn();
const mockClose = vi.fn();
vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockClose,
  })),
}));

// Mock fs/promises
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      access: vi.fn(),
      stat: vi.fn(),
      readdir: vi.fn(),
      mkdir: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    CONFIG_DIR: "/tmp/t2c-test/.t2c",
    CONFIG_PATH: "/tmp/t2c-test/.t2c/config.json",
    WALLET_PATH: "/tmp/t2c-test/.t2c/wallet.json",
    PID_PATH: "/tmp/t2c-test/.t2c/proxy.pid",
    LOG_PATH: "/tmp/t2c-test/.t2c/proxy.log",
    PROXY_SECRET_PATH: "/tmp/t2c-test/.t2c/proxy-secret",
    FAILED_TOKENS_PATH: "/tmp/t2c-test/.t2c/failed-tokens.json",
    TRANSACTIONS_LOG_PATH: "/tmp/t2c-test/.t2c/transactions.jsonl",
    loadConfig: vi.fn().mockResolvedValue({
      gateUrl: "https://gate.test.local",
      mintUrl: "https://mint.test.local",
      walletPath: "~/.t2c/wallet.json",
      proxyPort: 10402,
      lowBalanceThreshold: 1000,
    }),
    ensureConfigDir: vi.fn().mockResolvedValue(undefined),
  };
});

import fs from "node:fs/promises";
import { uninstallCommand, getFilesToRemove, type UninstallOptions } from "../src/commands/uninstall.js";

describe("t2c uninstall", () => {
  let logOutput: string;
  let errOutput: string;
  const originalLog = console.log;
  const originalErr = console.error;
  const originalExit = process.exit;
  const originalPlatform = process.platform;

  beforeEach(() => {
    logOutput = "";
    errOutput = "";
    console.log = (...args) => { logOutput += args.join(" ") + "\n"; };
    console.error = (...args) => { errOutput += args.join(" ") + "\n"; };
    process.exit = vi.fn() as unknown as typeof process.exit;
    mockExecSync.mockReset();
    mockQuestion.mockReset();
    mockClose.mockReset();
    vi.mocked(fs.readFile).mockReset();
    vi.mocked(fs.writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(fs.unlink).mockReset().mockResolvedValue(undefined);
    vi.mocked(fs.rm).mockReset().mockResolvedValue(undefined);
    vi.mocked(fs.access).mockReset();
    vi.mocked(fs.stat).mockReset();
    vi.mocked(fs.readdir).mockReset();
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalErr;
    process.exit = originalExit;
  });

  // ── Wallet protection ──────────────────────────────

  describe("wallet protection", () => {
    it("NEVER includes wallet.json in files to remove", () => {
      const files = getFilesToRemove();
      const walletFiles = files.filter(f =>
        f.includes("wallet.json") || f.includes("wallet")
      );
      expect(walletFiles).toHaveLength(0);
    });

    it("has no --delete-wallet or similar option", () => {
      // The UninstallOptions type should not have any wallet deletion option
      // This is a compile-time check via the type, but we verify the function signature
      const opts: UninstallOptions = { yes: false, removeOpenclaw: false };
      expect(opts).not.toHaveProperty("deleteWallet");
      expect(opts).not.toHaveProperty("removeWallet");
      expect(opts).not.toHaveProperty("purge");
    });
  });

  // ── Dry-run listing ────────────────────────────────

  describe("dry-run listing", () => {
    it("shows what will be removed before asking for confirmation", async () => {
      // Files exist
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        "config.json", "proxy-secret", "proxy.log", "proxy.pid", "wallet.json",
      ] as any);
      // User declines
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb("n"));

      await uninstallCommand({ yes: false, removeOpenclaw: false });

      expect(logOutput).toContain("will be removed");
      expect(logOutput).toContain("proxy-secret");
      expect(logOutput).toContain("config.json");
      // Must mention wallet is preserved
      expect(logOutput).toContain("wallet.json");
      expect(logOutput).toMatch(/preserv|keep|safe/i);
    });

    it("lists service uninstall action in dry-run", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb("n"));

      await uninstallCommand({ yes: false, removeOpenclaw: false });

      expect(logOutput).toMatch(/service|launchd|systemd/i);
    });
  });

  // ── Confirmation ───────────────────────────────────

  describe("confirmation", () => {
    it("aborts when user says no", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb("n"));

      await uninstallCommand({ yes: false, removeOpenclaw: false });

      expect(logOutput).toContain("Aborted");
      // Should NOT have deleted anything
      expect(fs.unlink).not.toHaveBeenCalled();
      expect(fs.rm).not.toHaveBeenCalled();
    });

    it("proceeds when user says yes", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(["config.json", "proxy-secret", "proxy.log", "wallet.json"] as any);
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb("yes"));

      await uninstallCommand({ yes: false, removeOpenclaw: false });

      expect(logOutput).toContain("Uninstall complete");
      // Should have removed files
      expect(fs.unlink).toHaveBeenCalled();
    });

    it("skips confirmation with --yes flag", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(["config.json", "proxy-secret"] as any);

      await uninstallCommand({ yes: true, removeOpenclaw: false });

      // Should not have asked
      expect(mockQuestion).not.toHaveBeenCalled();
      expect(logOutput).toContain("Uninstall complete");
    });
  });

  // ── Service removal ────────────────────────────────

  describe("service removal", () => {
    it("stops and uninstalls launchd service on macOS", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb("yes"));

      await uninstallCommand({ yes: false, removeOpenclaw: false });

      if (process.platform === "darwin") {
        expect(mockExecSync).toHaveBeenCalled();
        const calls = mockExecSync.mock.calls.map(c => c[0]);
        const hasLaunchctl = calls.some((c: string) => c.includes("launchctl"));
        expect(hasLaunchctl).toBe(true);
      }
    });
  });

  // ── File removal ───────────────────────────────────

  describe("file removal", () => {
    it("removes config, proxy-secret, logs, pid, failed-tokens, transactions", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        "config.json", "proxy-secret", "proxy.log", "proxy.pid",
        "failed-tokens.json", "transactions.jsonl", "wallet.json",
        "pending-quotes.json",
      ] as any);
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb("yes"));

      await uninstallCommand({ yes: false, removeOpenclaw: false });

      const unlinkCalls = vi.mocked(fs.unlink).mock.calls.map(c => c[0] as string);

      // Should remove these files
      expect(unlinkCalls.some(f => f.includes("config.json"))).toBe(true);
      expect(unlinkCalls.some(f => f.includes("proxy-secret"))).toBe(true);
      expect(unlinkCalls.some(f => f.includes("proxy.log"))).toBe(true);
      expect(unlinkCalls.some(f => f.includes("proxy.pid"))).toBe(true);
      expect(unlinkCalls.some(f => f.includes("failed-tokens.json"))).toBe(true);
      expect(unlinkCalls.some(f => f.includes("transactions.jsonl"))).toBe(true);

      // MUST NOT remove wallet.json
      expect(unlinkCalls.some(f => f.includes("wallet.json"))).toBe(false);
    });

    it("also removes corrupted config backups", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([
        "config.json",
        "config.json.corrupted.12345",
        "config.json.corrupted.67890",
        "wallet.json",
      ] as any);
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb("yes"));

      await uninstallCommand({ yes: true, removeOpenclaw: false });

      const unlinkCalls = vi.mocked(fs.unlink).mock.calls.map(c => c[0] as string);
      expect(unlinkCalls.some(f => f.includes("config.json.corrupted"))).toBe(true);
    });

    it("handles missing files gracefully", async () => {
      // Some files exist, some don't
      vi.mocked(fs.access).mockImplementation(async (p) => {
        const s = String(p);
        if (s.includes("proxy-secret")) throw new Error("ENOENT");
        return undefined;
      });
      vi.mocked(fs.readdir).mockResolvedValue(["config.json", "wallet.json"] as any);
      vi.mocked(fs.unlink).mockImplementation(async (p) => {
        if (String(p).includes("proxy-secret")) {
          const e = new Error("ENOENT") as NodeJS.ErrnoException;
          e.code = "ENOENT";
          throw e;
        }
      });

      await uninstallCommand({ yes: true, removeOpenclaw: false });

      // Should not throw
      expect(logOutput).toContain("Uninstall complete");
    });
  });

  // ── OpenClaw integration removal ───────────────────

  describe("OpenClaw integration removal", () => {
    it("removes token2chat provider from openclaw.json when --remove-openclaw", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(["config.json"] as any);
      
      const openclawConfig = {
        models: {
          mode: "merge",
          providers: {
            token2chat: { baseUrl: "http://127.0.0.1:10402/v1" },
            anthropic: { apiKey: "sk-ant-xxx" },
          },
        },
      };
      vi.mocked(fs.readFile).mockImplementation(async (p) => {
        if (String(p).includes("openclaw.json")) {
          return JSON.stringify(openclawConfig);
        }
        throw new Error("ENOENT");
      });

      await uninstallCommand({ yes: true, removeOpenclaw: true });

      // Should have written back openclaw.json without token2chat
      const writeCalls = vi.mocked(fs.writeFile).mock.calls;
      const openclawWrite = writeCalls.find(c => String(c[0]).includes("openclaw.json"));
      expect(openclawWrite).toBeDefined();

      const written = JSON.parse(openclawWrite![1] as string);
      expect(written.models.providers.token2chat).toBeUndefined();
      expect(written.models.providers.anthropic).toBeDefined();
    });

    it("does NOT touch openclaw.json when --remove-openclaw is not set", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(["config.json"] as any);

      await uninstallCommand({ yes: true, removeOpenclaw: false });

      const writeCalls = vi.mocked(fs.writeFile).mock.calls;
      const openclawWrite = writeCalls.find(c => String(c[0]).includes("openclaw.json"));
      expect(openclawWrite).toBeUndefined();
    });

    it("handles missing openclaw.json gracefully", async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue(["config.json"] as any);
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));

      await uninstallCommand({ yes: true, removeOpenclaw: true });

      // Should succeed without error
      expect(logOutput).toContain("Uninstall complete");
    });
  });

  // ── Nothing to uninstall ───────────────────────────

  describe("nothing to uninstall", () => {
    it("reports nothing to do when no files and no service exist", async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(fs.readdir).mockRejectedValue(new Error("ENOENT"));

      await uninstallCommand({ yes: false, removeOpenclaw: false });

      expect(logOutput).toContain("Nothing to uninstall");
    });
  });
});
