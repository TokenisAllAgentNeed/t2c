/**
 * Service command tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process before imports
const mockSpawn = vi.fn();
const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

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
    ensureConfigDir: vi.fn().mockResolvedValue(undefined),
    PID_PATH: "/tmp/t2c-test-pid",
    LOG_PATH: "/tmp/t2c-test-log",
    CONFIG_DIR: "/tmp/t2c-test-config",
  };
});

vi.mock("../src/proxy.js", () => ({
  startProxy: vi.fn().mockResolvedValue({ stop: vi.fn() }),
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
      access: vi.fn(),
      mkdir: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue({ fd: 3, close: vi.fn().mockResolvedValue(undefined) }),
    },
  };
});

import fs from "node:fs/promises";
import os from "node:os";
import { startProxy } from "../src/proxy.js";
import { serviceCommand } from "../src/commands/service.js";

const mockFetch = vi.fn();

describe("serviceCommand", () => {
  let logOutput: string;
  let errOutput: string;
  const originalLog = console.log;
  const originalErr = console.error;
  const originalExit = process.exit;
  const originalKill = process.kill;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logOutput = "";
    errOutput = "";
    console.log = (...args) => { logOutput += args.join(" ") + "\n"; };
    console.error = (...args) => { errOutput += args.join(" ") + "\n"; };
    process.exit = vi.fn() as unknown as typeof process.exit;
    process.kill = vi.fn() as unknown as typeof process.kill;
    globalThis.fetch = mockFetch;
    mockFetch.mockReset();
    mockSpawn.mockReset();
    mockExecSync.mockReset();
    vi.mocked(fs.readFile).mockReset();
    vi.mocked(fs.writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(fs.unlink).mockReset().mockResolvedValue(undefined);
    vi.mocked(fs.access).mockReset();
    vi.mocked(fs.mkdir).mockReset().mockResolvedValue(undefined as any);
    vi.mocked(fs.open).mockReset().mockResolvedValue({ fd: 3, close: vi.fn().mockResolvedValue(undefined) } as any);
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalErr;
    process.exit = originalExit;
    process.kill = originalKill;
    globalThis.fetch = originalFetch;
  });

  // ── stop ──────────────────────────────────────────

  describe("stop", () => {
    it("reports not running when no PID file", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      await serviceCommand("stop", {});
      expect(logOutput).toContain("Proxy not running");
    });

    it("sends SIGTERM to running process", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("12345");
      // process.kill(pid, 0) succeeds first (process exists), then throws (process stopped)
      vi.mocked(process.kill)
        .mockReturnValueOnce(true as any)   // getPid check
        .mockReturnValueOnce(true as any)   // SIGTERM send
        .mockImplementationOnce(() => { throw new Error("ESRCH"); }); // poll: process gone

      await serviceCommand("stop", {});
      expect(process.kill).toHaveBeenCalledWith(12345, "SIGTERM");
      expect(logOutput).toContain("Stopping proxy");
      expect(logOutput).toContain("Proxy stopped");
    });

    it("cleans stale PID file when process not found", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("99999");
      // process.kill(pid, 0) throws = process doesn't exist
      vi.mocked(process.kill).mockImplementation(() => { throw new Error("ESRCH"); });

      await serviceCommand("stop", {});
      // getPid returns null (stale), so "not running"
      expect(logOutput).toContain("Proxy not running");
    });
  });

  // ── logs ──────────────────────────────────────────

  describe("logs", () => {
    it("shows last N lines from log file", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
      vi.mocked(fs.readFile).mockResolvedValue(lines.join("\n"));

      await serviceCommand("logs", { lines: "10" });
      expect(logOutput).toContain("line-90");
      expect(logOutput).toContain("line-99");
      expect(logOutput).not.toContain("line-80");
    });

    it("shows 'No logs found' when file missing", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      await serviceCommand("logs", {});
      expect(logOutput).toContain("No logs found");
    });

    it("defaults to 50 lines", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
      vi.mocked(fs.readFile).mockResolvedValue(lines.join("\n"));

      await serviceCommand("logs", {});
      // Should show last 50 lines (line-50 through line-99)
      expect(logOutput).toContain("line-50");
      expect(logOutput).toContain("line-99");
    });
  });

  // ── status ────────────────────────────────────────

  describe("status", () => {
    it("shows not running when health check fails", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      // For launchd access check
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));

      await serviceCommand("status", {});
      expect(logOutput).toContain("Not running");
    });

    it("shows running when health check passes", async () => {
      mockFetch.mockResolvedValue({ ok: true } as Response);
      vi.mocked(fs.readFile).mockResolvedValue("12345");
      vi.mocked(process.kill).mockReturnValue(true as any);
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));

      await serviceCommand("status", {});
      expect(logOutput).toContain("Running");
      expect(logOutput).toContain("12345");
    });

    it("shows port number", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));

      await serviceCommand("status", {});
      expect(logOutput).toContain("10402");
    });

    it("shows launchd installed when plist exists (darwin)", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      // fs.access succeeds for plist
      vi.mocked(fs.access).mockResolvedValue(undefined);

      await serviceCommand("status", {});
      expect(logOutput).toContain("Installed");
    });
  });

  // ── install ───────────────────────────────────────

  describe("install", () => {
    it("generates and writes launchd plist on darwin", async () => {
      // os.platform() returns 'darwin' in test env on macOS
      await serviceCommand("install", {});

      // On macOS the install should write a plist
      if (process.platform === "darwin") {
        expect(fs.writeFile).toHaveBeenCalled();
        expect(logOutput).toContain("launchd");
      }
    });
  });

  // ── uninstall ─────────────────────────────────────

  describe("uninstall", () => {
    it("reports not installed when file missing (darwin)", async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      vi.mocked(fs.unlink).mockRejectedValueOnce(err);

      await serviceCommand("uninstall", {});

      if (process.platform === "darwin") {
        expect(logOutput).toContain("not installed");
      }
    });
  });

  // ── start daemon ──────────────────────────────────

  describe("start (daemon)", () => {
    it("reports already running when PID exists", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("12345");
      vi.mocked(process.kill).mockReturnValue(true as any);

      await serviceCommand("start", {});
      expect(logOutput).toContain("already running");
      expect(logOutput).toContain("12345");
    });

    it("reports already running when health check passes", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch.mockResolvedValue({ ok: true } as Response);

      await serviceCommand("start", {});
      expect(logOutput).toContain("already running");
    });

    it("spawns daemon process when not running", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      mockSpawn.mockReturnValue({
        pid: 54321,
        unref: vi.fn(),
      });

      await serviceCommand("start", {});
      expect(mockSpawn).toHaveBeenCalled();
      expect(logOutput).toContain("54321");
      expect(logOutput).toContain("started");
    });

    it("reports failure when spawn has no PID", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      mockSpawn.mockReturnValue({
        pid: undefined,
        unref: vi.fn(),
      });

      await serviceCommand("start", {});
      expect(errOutput).toContain("Failed to start");
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  // ── start foreground ──────────────────────────────

  describe("start (foreground)", () => {
    it("reports already running when health check passes", async () => {
      mockFetch.mockResolvedValue({ ok: true } as Response);

      await serviceCommand("start", { foreground: true });
      expect(logOutput).toContain("already running");
    });

    it("reports already running via T2C_DAEMON env", async () => {
      const origEnv = process.env.T2C_DAEMON;
      process.env.T2C_DAEMON = "1";

      mockFetch.mockResolvedValue({ ok: true } as Response);

      await serviceCommand("start", {});
      expect(logOutput).toContain("already running");

      // Restore env
      if (origEnv === undefined) {
        delete process.env.T2C_DAEMON;
      } else {
        process.env.T2C_DAEMON = origEnv;
      }
    });

    it("starts proxy in foreground when not already running", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      // startProxy returns a handle; the function then awaits forever.
      // We race against a timeout to avoid hanging.
      const result = await Promise.race([
        serviceCommand("start", { foreground: true }),
        new Promise<string>((r) => setTimeout(() => r("timed-out"), 500)),
      ]);

      expect(result).toBe("timed-out");
      expect(logOutput).toContain("Starting proxy in foreground");
      expect(startProxy).toHaveBeenCalled();
    });
  });

  // ── restart ────────────────────────────────────────

  describe("restart", () => {
    it("stops then starts daemon", async () => {
      // Stop: no PID (not running)
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      // Start: health check fails (not running)
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      mockSpawn.mockReturnValue({
        pid: 77777,
        unref: vi.fn(),
      });

      await serviceCommand("restart", {});

      expect(logOutput).toContain("Proxy not running");
      expect(logOutput).toContain("77777");
      expect(logOutput).toContain("started");
    });

    it("stops running process then starts daemon", async () => {
      // Stop: PID exists, process exits immediately after SIGTERM
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce("11111")  // getPid in stopService
        .mockRejectedValueOnce(new Error("ENOENT"))  // getPid in startDaemon
      ;
      vi.mocked(process.kill)
        .mockReturnValueOnce(true as any)   // getPid check (process exists)
        .mockReturnValueOnce(true as any)   // SIGTERM send
        .mockImplementationOnce(() => { throw new Error("ESRCH"); }) // poll: process gone
      ;
      // Start: health check fails (not running)
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      mockSpawn.mockReturnValue({
        pid: 88888,
        unref: vi.fn(),
      });

      await serviceCommand("restart", {});

      expect(logOutput).toContain("Stopping proxy");
      expect(logOutput).toContain("Proxy stopped");
      expect(logOutput).toContain("88888");
    });
  });

  // ── stop edge cases ────────────────────────────────

  describe("stop (edge cases)", () => {
    it("force kills after timeout when process won't die", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("33333");

      // getPid check passes, SIGTERM succeeds, then process.kill(pid,0) keeps succeeding 30 times (process alive),
      // then force kill succeeds.
      const killMock = vi.mocked(process.kill);
      killMock
        .mockReturnValueOnce(true as any)   // getPid: process.kill(pid, 0)
        .mockReturnValueOnce(true as any);  // SIGTERM send

      // The loop checks 30 times with process.kill(pid, 0). All succeed (process still alive).
      for (let i = 0; i < 30; i++) {
        killMock.mockReturnValueOnce(true as any);
      }
      // SIGKILL
      killMock.mockReturnValueOnce(true as any);

      await serviceCommand("stop", {});

      expect(process.kill).toHaveBeenCalledWith(33333, "SIGTERM");
      expect(process.kill).toHaveBeenCalledWith(33333, "SIGKILL");
      expect(logOutput).toContain("Proxy killed");
    });

    it("handles error when killing process", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("44444");

      vi.mocked(process.kill)
        .mockReturnValueOnce(true as any)   // getPid check
        .mockImplementationOnce(() => { throw new Error("EPERM"); });  // SIGTERM throws

      await serviceCommand("stop", {});

      expect(errOutput).toContain("Failed to stop proxy");
      expect(errOutput).toContain("EPERM");
    });
  });

  // ── install (Linux) ────────────────────────────────

  describe("install (linux)", () => {
    let platformSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      platformSpy = vi.spyOn(os, "platform").mockReturnValue("linux");
    });

    afterEach(() => {
      platformSpy.mockRestore();
    });

    it("generates and writes systemd unit on linux", async () => {
      await serviceCommand("install", {});

      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const writtenPath = writeCall[0] as string;
      const writtenContent = writeCall[1] as string;

      expect(writtenPath).toContain("systemd");
      expect(writtenPath).toContain("t2c-proxy.service");
      expect(writtenContent).toContain("[Unit]");
      expect(writtenContent).toContain("Token2Chat Proxy");
      expect(writtenContent).toContain("[Service]");
      expect(writtenContent).toContain("[Install]");

      expect(logOutput).toContain("systemd user service");
      expect(logOutput).toContain("systemctl --user");
    });
  });

  // ── install (unsupported platform) ─────────────────

  describe("install (unsupported platform)", () => {
    let platformSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      platformSpy = vi.spyOn(os, "platform").mockReturnValue("win32");
    });

    afterEach(() => {
      platformSpy.mockRestore();
    });

    it("errors on unsupported platform", async () => {
      await serviceCommand("install", {});

      expect(errOutput).toContain("Unsupported platform");
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  // ── uninstall (Linux) ──────────────────────────────

  describe("uninstall (linux)", () => {
    let platformSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      platformSpy = vi.spyOn(os, "platform").mockReturnValue("linux");
    });

    afterEach(() => {
      platformSpy.mockRestore();
    });

    it("successfully uninstalls systemd service", async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      mockExecSync.mockReturnValue(undefined);

      await serviceCommand("uninstall", {});

      // Should have tried to stop/disable and then unlink
      expect(mockExecSync).toHaveBeenCalled();
      expect(fs.unlink).toHaveBeenCalled();
      expect(logOutput).toContain("Uninstalled systemd");
    });

    it("reports not installed when ENOENT on linux", async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      // execSync for stop/disable may throw (that is caught), but unlink throws ENOENT
      mockExecSync.mockImplementation(() => { throw new Error("not loaded"); });
      vi.mocked(fs.unlink).mockRejectedValue(err);

      await serviceCommand("uninstall", {});

      expect(logOutput).toContain("not installed");
    });
  });

  // ── uninstall (unsupported platform) ───────────────

  describe("uninstall (unsupported platform)", () => {
    let platformSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      platformSpy = vi.spyOn(os, "platform").mockReturnValue("win32");
    });

    afterEach(() => {
      platformSpy.mockRestore();
    });

    it("errors on unsupported platform", async () => {
      await serviceCommand("uninstall", {});

      expect(errOutput).toContain("Unsupported platform");
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  // ── status (Linux) ────────────────────────────────

  describe("status (linux)", () => {
    let platformSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      platformSpy = vi.spyOn(os, "platform").mockReturnValue("linux");
    });

    afterEach(() => {
      platformSpy.mockRestore();
    });

    it("shows systemd installed when unit file exists", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(fs.access).mockResolvedValue(undefined);

      await serviceCommand("status", {});

      expect(logOutput).toContain("linux");
      expect(logOutput).toContain("Installed");
      expect(logOutput).toContain("systemd");
    });

    it("shows systemd not installed when unit file missing", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));

      await serviceCommand("status", {});

      expect(logOutput).toContain("linux");
      expect(logOutput).toContain("Not installed");
    });
  });
});
