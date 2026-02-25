/**
 * Connectors tests
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { T2CConfig } from "../src/config.js";
import type { Connector } from "../src/connectors/interface.js";

// Test config
const testConfig: T2CConfig = {
  gateUrl: "https://gate.test.com",
  mintUrl: "https://mint.test.com",
  walletPath: "~/.t2c/wallet.json",
  proxyPort: 10402,
  lowBalanceThreshold: 1000,
};

describe("Connector interface", () => {
  it("is importable", async () => {
    const { Connector } = await import("../src/connectors/interface.js");
    // Interface is a type, just check module loads
    expect(true).toBe(true);
  });
});

describe("OpenClawConnector", () => {
  const testDir = `/tmp/t2c-test-openclaw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const openclawDir = path.join(testDir, ".openclaw");
  const configPath = path.join(openclawDir, "clawdbot.json");

  beforeEach(async () => {
    await fs.mkdir(openclawDir, { recursive: true });
    // Mock HOME for tests
    vi.stubEnv("HOME", testDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("has correct id and name", async () => {
    const { openclawConnector } = await import("../src/connectors/openclaw.js");
    expect(openclawConnector.id).toBe("openclaw");
    expect(openclawConnector.name).toBe("OpenClaw");
  });

  it("detect() returns true when clawdbot.json exists", async () => {
    // Create fake clawdbot.json
    await fs.writeFile(configPath, "{}");

    const { openclawConnector } = await import("../src/connectors/openclaw.js");
    const detected = await openclawConnector.detect();
    expect(detected).toBe(true);
  });

  it("detect() returns false when clawdbot.json does not exist", async () => {
    // Remove the file if exists
    await fs.rm(configPath, { force: true });

    const { openclawConnector } = await import("../src/connectors/openclaw.js");
    const detected = await openclawConnector.detect();
    expect(detected).toBe(false);
  });

  it("connect() creates clawdbot.json with correct plugin config", async () => {
    // Create empty config first
    await fs.writeFile(configPath, "{}");

    const { openclawConnector } = await import("../src/connectors/openclaw.js");
    await openclawConnector.connect(testConfig);

    const content = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    
    // Check plugin config
    expect(config.plugins).toBeDefined();
    expect(config.plugins.entries).toBeDefined();
    expect(config.plugins.entries.token2chat).toBeDefined();
    expect(config.plugins.entries.token2chat.enabled).toBe(true);
    expect(config.plugins.entries.token2chat.config.gateUrl).toBe(testConfig.gateUrl);
    expect(config.plugins.entries.token2chat.config.mintUrl).toBe(testConfig.mintUrl);
    expect(config.plugins.entries.token2chat.config.proxyPort).toBe(testConfig.proxyPort);
    expect(config.plugins.entries.token2chat.config.walletPath).toBe(testConfig.walletPath);

    // Check models provider config
    expect(config.models).toBeDefined();
    expect(config.models.providers).toBeDefined();
    expect(config.models.providers.token2chat).toBeDefined();
    expect(config.models.providers.token2chat.baseUrl).toBe("http://127.0.0.1:10402/v1");
    expect(config.models.providers.token2chat.apiKey).toMatch(/^t2c-/);
  });

  it("detect() returns true when openclaw.json exists (preferred name)", async () => {
    const newConfigPath = path.join(openclawDir, "openclaw.json");
    await fs.writeFile(newConfigPath, "{}");

    const { openclawConnector } = await import("../src/connectors/openclaw.js");
    const detected = await openclawConnector.detect();
    expect(detected).toBe(true);
  });

  it("connect() shows error when not detected", async () => {
    // Remove all config files
    await fs.rm(configPath, { force: true });
    await fs.rm(path.join(openclawDir, "openclaw.json"), { force: true });
    await fs.rm(openclawDir, { recursive: true, force: true });

    const { openclawConnector } = await import("../src/connectors/openclaw.js");

    let errOutput = "";
    const originalErr = console.error;
    console.error = (...args) => { errOutput += args.join(" ") + "\n"; };

    await openclawConnector.connect(testConfig);

    console.error = originalErr;

    expect(errOutput).toContain("OpenClaw not detected");
  });

  it("verify() returns true when config has token2chat entries", async () => {
    const configContent = {
      plugins: { entries: { token2chat: { enabled: true } } },
      models: { providers: { token2chat: { baseUrl: "http://test" } } },
    };
    await fs.writeFile(configPath, JSON.stringify(configContent));

    const { openclawConnector } = await import("../src/connectors/openclaw.js");
    const verified = await openclawConnector.verify!();
    expect(verified).toBe(true);
  });

  it("verify() returns false when config missing token2chat", async () => {
    await fs.writeFile(configPath, JSON.stringify({ agent: {} }));

    const { openclawConnector } = await import("../src/connectors/openclaw.js");
    const verified = await openclawConnector.verify!();
    expect(verified).toBe(false);
  });

  it("verify() returns false when config file doesn't exist", async () => {
    await fs.rm(configPath, { force: true });
    await fs.rm(path.join(openclawDir, "openclaw.json"), { force: true });
    await fs.rm(openclawDir, { recursive: true, force: true });

    const { openclawConnector } = await import("../src/connectors/openclaw.js");
    const verified = await openclawConnector.verify!();
    expect(verified).toBe(false);
  });

  it("connect() uses gate models when available", async () => {
    await fs.writeFile(configPath, "{}");

    // Mock fetch to return pricing data
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: {
          "openai/gpt-4o": { per_request: 100 },
          "anthropic/claude-sonnet-4": { per_request: 200 },
          "*": { per_request: 50 }, // wildcard should be filtered
        },
      }),
    }) as unknown as typeof fetch;

    const { openclawConnector } = await import("../src/connectors/openclaw.js");

    let logOutput = "";
    const origLog = console.log;
    console.log = (...args) => { logOutput += args.join(" ") + "\n"; };

    await openclawConnector.connect(testConfig);

    console.log = origLog;
    globalThis.fetch = originalFetch;

    expect(logOutput).toContain("Found 2 models");

    // Read config to check models
    const content = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    const models = config.models.providers.token2chat.models;

    // Check slash→dash transformation
    expect(models.some((m: any) => m.id === "openai-gpt-4o")).toBe(true);
    expect(models.some((m: any) => m.id === "anthropic-claude-sonnet-4")).toBe(true);
    // Wildcard should not appear
    expect(models.some((m: any) => m.id === "*")).toBe(false);
  });

  it("connect() preserves existing config entries", async () => {
    // Create config with existing data
    await fs.writeFile(configPath, JSON.stringify({
      agent: {
        name: "MyAgent",
        model: "claude-sonnet-4"
      }
    }, null, 2));

    const { openclawConnector } = await import("../src/connectors/openclaw.js");
    await openclawConnector.connect(testConfig);

    const content = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    
    // Original config preserved
    expect(config.agent).toBeDefined();
    expect(config.agent.name).toBe("MyAgent");
    expect(config.agent.model).toBe("claude-sonnet-4");
    
    // New config added
    expect(config.plugins).toBeDefined();
    expect(config.plugins.entries.token2chat).toBeDefined();
  });
});

describe("CursorConnector", () => {
  it("has correct id and name", async () => {
    const { cursorConnector } = await import("../src/connectors/cursor.js");
    expect(cursorConnector.id).toBe("cursor");
    expect(cursorConnector.name).toBe("Cursor");
  });

  it("detect() returns boolean based on Cursor installation", async () => {
    const { cursorConnector } = await import("../src/connectors/cursor.js");
    const detected = await cursorConnector.detect();
    expect(typeof detected).toBe("boolean");
  });

  it("connect() prints configuration instructions", async () => {
    const { cursorConnector } = await import("../src/connectors/cursor.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await cursorConnector.connect(testConfig);

    console.log = originalLog;

    expect(output).toContain("Cursor");
    expect(output).toContain("OpenAI Base URL");
    expect(output).toContain(`${testConfig.proxyPort}`);
  });

  it("verify() returns boolean", async () => {
    const { cursorConnector } = await import("../src/connectors/cursor.js");
    const result = await cursorConnector.verify!();
    expect(typeof result).toBe("boolean");
  });
});

describe("EnvConnector", () => {
  it("has correct id and name", async () => {
    const { envConnector } = await import("../src/connectors/env.js");
    expect(envConnector.id).toBe("env");
    expect(envConnector.name).toBe("Environment Variables");
  });

  it("detect() always returns true", async () => {
    const { envConnector } = await import("../src/connectors/env.js");
    const detected = await envConnector.detect();
    expect(detected).toBe(true);
  });

  it("connect() outputs OPENAI_API_BASE and OPENAI_API_KEY", async () => {
    const { envConnector } = await import("../src/connectors/env.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await envConnector.connect(testConfig);

    console.log = originalLog;

    expect(output).toContain("OPENAI_API_BASE");
    expect(output).toContain("http://127.0.0.1:10402/v1");
    expect(output).toContain("OPENAI_API_KEY");
    expect(output).toMatch(/t2c-[a-f0-9]+/);
  });
});

describe("Connectors index", () => {
  it("exports all connectors", async () => {
    const connectors = await import("../src/connectors/index.js");
    expect(connectors.openclawConnector).toBeDefined();
    expect(connectors.cursorConnector).toBeDefined();
    expect(connectors.envConnector).toBeDefined();
  });

  it("exports connectors registry", async () => {
    const { connectors } = await import("../src/connectors/index.js");
    expect(connectors).toBeInstanceOf(Map);
    expect(connectors.get("openclaw")).toBeDefined();
    expect(connectors.get("cursor")).toBeDefined();
    expect(connectors.get("env")).toBeDefined();
  });
});
