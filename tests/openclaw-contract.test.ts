/**
 * Contract tests for the OpenClaw connector.
 *
 * These test that `t2c connect openclaw` produces config that
 * OpenClaw can actually load without crashing. They test the
 * CONTRACT (what the consumer needs), not the implementation.
 *
 * Categories:
 * 1. Invariant tests — "don't break what exists"
 * 2. Schema contract tests — "output must satisfy consumer's schema"
 * 3. Idempotency tests — "running twice shouldn't corrupt"
 * 4. Real-world config tests — "works with realistic configs"
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import type { T2CConfig } from "../src/config.js";

const testConfig: T2CConfig = {
  gateUrl: "https://gate.test.com",
  mintUrl: "https://mint.test.com",
  walletPath: "~/.t2c/wallet.json",
  proxyPort: 10402,
  lowBalanceThreshold: 1000,
};

/**
 * A realistic OpenClaw config with multiple providers, agents, fallbacks,
 * and all the fields that a real user would have.
 */
const REALISTIC_OPENCLAW_CONFIG = {
  models: {
    providers: {
      dashscope: {
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: "sk-test-dashscope",
        api: "openai-completions",
        models: [
          {
            id: "qwen-plus",
            name: "Qwen3 Plus",
            reasoning: false,
            input: ["text"],
            cost: { input: 0.004, output: 0.012, cacheRead: 0.001, cacheWrite: 0.004 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
      moonshot: {
        baseUrl: "https://api.moonshot.cn/v1",
        apiKey: "sk-test-moonshot",
        api: "openai-completions",
        models: [
          {
            id: "kimi-latest",
            name: "Kimi Latest",
            reasoning: false,
            input: ["text"],
            cost: { input: 0.012, output: 0.012 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: [
          "anthropic/claude-opus-4-5",
          "google/gemini-2.5-pro",
          "dashscope/qwen-plus",
        ],
      },
      models: undefined, // not set — unrestricted
    },
    list: [
      {
        id: "main",
        name: "Shell",
        default: true,
        model: "anthropic/claude-opus-4-6",
        tools: { profile: "full" },
      },
      {
        id: "jobs",
        name: "Jobs",
        model: {
          primary: "anthropic/claude-sonnet-4-20250514",
          fallbacks: ["openai/gpt-4o"],
        },
      },
    ],
  },
  tools: {
    exec: { security: "allowlist" },
  },
  gateway: {
    controlUi: { enabled: true },
  },
};

describe("OpenClaw Connector — Contract Tests", () => {
  const testDir = `/tmp/t2c-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const openclawDir = path.join(testDir, ".openclaw");
  const configPath = path.join(openclawDir, "openclaw.json");

  beforeEach(async () => {
    await fs.mkdir(openclawDir, { recursive: true });
    vi.stubEnv("HOME", testDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // ================================================================
  // 1. INVARIANT TESTS — "don't break what exists"
  // ================================================================

  describe("Invariant: existing config preservation", () => {
    it("does NOT modify agents.defaults.model.primary", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(result.agents.defaults.model.primary).toBe("anthropic/claude-opus-4-6");
    });

    it("does NOT modify agents.defaults.model.fallbacks", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(result.agents.defaults.model.fallbacks).toEqual([
        "anthropic/claude-opus-4-5",
        "google/gemini-2.5-pro",
        "dashscope/qwen-plus",
      ]);
    });

    it("does NOT inject agents.defaults.models allowlist", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      // Should remain undefined — not set to an array of token2chat models
      expect(result.agents.defaults.models).toBeUndefined();
    });

    it("preserves per-agent model config (string format)", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(result.agents.list[0].model).toBe("anthropic/claude-opus-4-6");
    });

    it("preserves per-agent model config (object format with fallbacks)", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(result.agents.list[1].model).toEqual({
        primary: "anthropic/claude-sonnet-4-20250514",
        fallbacks: ["openai/gpt-4o"],
      });
    });

    it("preserves existing providers (dashscope, moonshot, etc.)", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(result.models.providers.dashscope).toBeDefined();
      expect(result.models.providers.dashscope.apiKey).toBe("sk-test-dashscope");
      expect(result.models.providers.moonshot).toBeDefined();
      expect(result.models.providers.moonshot.apiKey).toBe("sk-test-moonshot");
    });

    it("preserves tools config", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(result.tools.exec.security).toBe("allowlist");
    });

    it("preserves gateway config", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(result.gateway.controlUi.enabled).toBe(true);
    });
  });

  // ================================================================
  // 2. SCHEMA CONTRACT TESTS — "output satisfies OpenClaw's needs"
  // ================================================================

  describe("Schema: token2chat provider entry", () => {
    it("adds a valid token2chat provider with baseUrl, apiKey, api, and models", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      const t2c = result.models.providers.token2chat;

      expect(t2c).toBeDefined();
      expect(t2c.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      expect(t2c.apiKey).toMatch(/^t2c-/);
      expect(t2c.api).toBe("openai-completions");
      expect(Array.isArray(t2c.models)).toBe(true);
      expect(t2c.models.length).toBeGreaterThan(0);
    });

    it("each model entry has at minimum id and name", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      const models = result.models.providers.token2chat.models;

      for (const model of models) {
        expect(typeof model.id).toBe("string");
        expect(model.id.length).toBeGreaterThan(0);
        expect(typeof model.name).toBe("string");
        expect(model.name.length).toBeGreaterThan(0);
      }
    });

    it("model IDs use dash format (not slash) for OpenClaw compatibility", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      // Mock Gate to return slash-format models
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: {
            "anthropic/claude-sonnet-4": { per_request: 200 },
            "openai/gpt-4o": { per_request: 100 },
          },
        }),
      }) as unknown as typeof fetch;

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      globalThis.fetch = originalFetch;

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      const models = result.models.providers.token2chat.models;

      for (const model of models) {
        // No slash in model ID — OpenClaw uses provider/model-id format,
        // so having a slash in the model ID would create double-slash
        expect(model.id).not.toContain("/");
      }
    });

    it("uses proxy port from config", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const customConfig = { ...testConfig, proxyPort: 9999 };
      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(customConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(result.models.providers.token2chat.baseUrl).toBe("http://127.0.0.1:9999/v1");
    });
  });

  // ================================================================
  // 3. IDEMPOTENCY TESTS — "running twice shouldn't corrupt"
  // ================================================================

  describe("Idempotency: running connect twice", () => {
    it("second run produces same result as first (no double-nesting)", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");

      // First run
      await openclawConnector.connect(testConfig);
      const afterFirst = JSON.parse(await fs.readFile(configPath, "utf-8"));

      // Second run
      await openclawConnector.connect(testConfig);
      const afterSecond = JSON.parse(await fs.readFile(configPath, "utf-8"));

      // Model IDs should be the same (not double-transformed)
      const firstModels = afterFirst.models.providers.token2chat.models.map((m: any) => m.id);
      const secondModels = afterSecond.models.providers.token2chat.models.map((m: any) => m.id);
      expect(secondModels).toEqual(firstModels);

      // Other providers still intact
      expect(afterSecond.models.providers.dashscope).toBeDefined();
      expect(afterSecond.models.providers.moonshot).toBeDefined();

      // Agent config still intact
      expect(afterSecond.agents.defaults.model.primary).toBe("anthropic/claude-opus-4-6");
    });

    it("second run doesn't accumulate providers or duplicate entries", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");

      await openclawConnector.connect(testConfig);
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      const providerNames = Object.keys(result.models.providers);
      const t2cCount = providerNames.filter((n) => n === "token2chat").length;
      expect(t2cCount).toBe(1);
    });
  });

  // ================================================================
  // 4. REAL-WORLD SCENARIOS — edge cases from actual usage
  // ================================================================

  describe("Real-world: edge cases", () => {
    it("handles empty config (fresh OpenClaw install)", async () => {
      await fs.writeFile(configPath, "{}");

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(result.models.providers.token2chat).toBeDefined();
      // Should NOT crash or create agents.defaults
      expect(result.agents?.defaults?.model?.fallbacks).toBeUndefined();
    });

    it("handles config with agents but no models section", async () => {
      const config = {
        agents: {
          list: [{ id: "main", name: "Bot", default: true }],
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(result.models.providers.token2chat).toBeDefined();
      expect(result.agents.list[0].name).toBe("Bot");
    });

    it("handles config with models but no providers section", async () => {
      const config = {
        models: { someOtherSetting: true },
      };
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(result.models.providers.token2chat).toBeDefined();
      expect(result.models.someOtherSetting).toBe(true);
    });

    it("creates a backup before modifying", async () => {
      await fs.writeFile(configPath, JSON.stringify(REALISTIC_OPENCLAW_CONFIG, null, 2));

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      // Check that a backup file exists
      const files = await fs.readdir(openclawDir);
      const backups = files.filter((f) => f.includes("backup"));
      expect(backups.length).toBeGreaterThan(0);

      // Backup should be valid JSON matching original
      const backupContent = await fs.readFile(
        path.join(openclawDir, backups[0]),
        "utf-8",
      );
      const backupConfig = JSON.parse(backupContent);
      expect(backupConfig.agents.defaults.model.primary).toBe("anthropic/claude-opus-4-6");
    });

    it("wildcard model from Gate is filtered out", async () => {
      await fs.writeFile(configPath, "{}");

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: {
            "anthropic/claude-sonnet-4": { per_request: 200 },
            "*": { per_request: 50 },
          },
        }),
      }) as unknown as typeof fetch;

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      globalThis.fetch = originalFetch;

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      const modelIds = result.models.providers.token2chat.models.map((m: any) => m.id);
      expect(modelIds).not.toContain("*");
    });

    it("Gate returning 0 models falls back to defaults", async () => {
      await fs.writeFile(configPath, "{}");

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: {} }),
      }) as unknown as typeof fetch;

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      globalThis.fetch = originalFetch;

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      const models = result.models.providers.token2chat.models;
      expect(models.length).toBeGreaterThan(0);
    });

    it("Gate being unreachable falls back to defaults", async () => {
      await fs.writeFile(configPath, "{}");

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

      const { openclawConnector } = await import("../src/connectors/openclaw.js");
      await openclawConnector.connect(testConfig);

      globalThis.fetch = originalFetch;

      const result = JSON.parse(await fs.readFile(configPath, "utf-8"));
      const models = result.models.providers.token2chat.models;
      expect(models.length).toBeGreaterThan(0);
    });
  });
});
