/**
 * OpenClaw adapter tests (src/adapters/openclaw.ts)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";

const testDir = `/tmp/t2c-test-oc-adapter-${Date.now()}`;
const openclawDir = path.join(testDir, ".openclaw");
const configPath = path.join(openclawDir, "openclaw.json");

// Mock os.homedir to use our test dir
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => testDir,
    },
  };
});

import { openclawAdapter } from "../src/adapters/openclaw.js";
import type { T2CConfig, AdapterConfigOptions } from "../src/config.js";

const testConfig: T2CConfig = {
  gateUrl: "https://gate.test.local",
  mintUrl: "https://mint.test.local",
  walletPath: "~/.t2c/wallet.json",
  proxyPort: 10402,
  lowBalanceThreshold: 1000,
};

describe("openclawAdapter", () => {
  let logOutput: string;
  let errOutput: string;
  const originalLog = console.log;
  const originalErr = console.error;
  const originalExit = process.exit;

  beforeEach(async () => {
    logOutput = "";
    errOutput = "";
    console.log = (...args) => { logOutput += args.join(" ") + "\n"; };
    console.error = (...args) => { errOutput += args.join(" ") + "\n"; };
    process.exit = vi.fn() as unknown as typeof process.exit;
    await fsp.mkdir(openclawDir, { recursive: true });
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalErr;
    process.exit = originalExit;
    await fsp.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("--json mode", () => {
    it("outputs JSON config", async () => {
      await openclawAdapter(testConfig, { proxySecret: "t2c-test" , json: true });
      const parsed = JSON.parse(logOutput.trim());
      expect(parsed.models.providers.token2chat).toBeDefined();
      expect(parsed.models.providers.token2chat.baseUrl).toBe("http://127.0.0.1:10402/v1");
      expect(parsed.models.providers.token2chat.apiKey).toBe("t2c-test");
    });

    it("includes model list", async () => {
      await openclawAdapter(testConfig, { proxySecret: "t2c-test", json: true });
      const parsed = JSON.parse(logOutput.trim());
      const models = parsed.models.providers.token2chat.models;
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m: any) => m.id.includes("claude"))).toBe(true);
    });
  });

  describe("default mode (no flags)", () => {
    it("shows instructions", async () => {
      await openclawAdapter(testConfig, { proxySecret: "t2c-test" });
      expect(logOutput).toContain("OpenClaw Configuration");
      expect(logOutput).toContain("openclaw.json");
      expect(logOutput).toContain("--apply");
    });

    it("shows JSON config in instructions", async () => {
      await openclawAdapter(testConfig, { proxySecret: "t2c-test" });
      expect(logOutput).toContain("token2chat");
      expect(logOutput).toContain("127.0.0.1:10402");
    });
  });

  describe("--apply mode", () => {
    it("errors when config file not found", async () => {
      // No config file exists
      await fsp.rm(configPath, { force: true });
      await fsp.rm(openclawDir, { recursive: true, force: true });

      await openclawAdapter(testConfig, { proxySecret: "t2c-test", apply: true }).catch(() => {});
      expect(errOutput).toContain("not found");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("merges config into existing file", async () => {
      await fsp.writeFile(configPath, JSON.stringify({
        agent: { name: "TestAgent" },
        models: { mode: "merge" },
      }, null, 2));

      await openclawAdapter(testConfig, { proxySecret: "t2c-key", apply: true });

      const content = await fsp.readFile(configPath, "utf-8");
      const config = JSON.parse(content);

      // Original config preserved
      expect(config.agent.name).toBe("TestAgent");
      // New provider added
      expect(config.models.providers.token2chat).toBeDefined();
      expect(config.models.providers.token2chat.apiKey).toBe("t2c-key");
      expect(logOutput).toContain("updated");
    });

    it("creates backup before modifying", async () => {
      await fsp.writeFile(configPath, JSON.stringify({ original: true }));

      await openclawAdapter(testConfig, { proxySecret: "t2c-key", apply: true });

      // Check for backup file
      const files = await fsp.readdir(openclawDir);
      const backups = files.filter(f => f.includes("backup"));
      expect(backups.length).toBeGreaterThan(0);
    });

    it("shows 'updating' message when token2chat already exists", async () => {
      await fsp.writeFile(configPath, JSON.stringify({
        models: {
          providers: {
            token2chat: { baseUrl: "http://old-url" },
          },
        },
      }));

      await openclawAdapter(testConfig, { proxySecret: "t2c-key", apply: true });
      expect(logOutput).toContain("already configured");
      expect(logOutput).toContain("Updating");
    });

    it("handles invalid JSON in config file", async () => {
      await fsp.writeFile(configPath, "{ invalid json }}}");

      await openclawAdapter(testConfig, { proxySecret: "t2c-key", apply: true }).catch(() => {});
      expect(errOutput).toContain("Error reading");
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("shows next steps after apply", async () => {
      await fsp.writeFile(configPath, "{}");

      await openclawAdapter(testConfig, { proxySecret: "t2c-key", apply: true });
      expect(logOutput).toContain("gateway restart");
    });
  });
});
