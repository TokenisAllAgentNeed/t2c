/**
 * Adapters tests
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { T2CConfig } from "../src/config.js";

// Test config
const testConfig: T2CConfig = {
  gateUrl: "https://gate.test.com",
  mintUrl: "https://mint.test.com",
  walletPath: "~/.t2c/wallet.json",
  proxyPort: 10402,
  lowBalanceThreshold: 1000,
};

describe("openclawAdapter", () => {
  it("generates valid OpenClaw config JSON", async () => {
    const { openclawAdapter } = await import("../src/adapters/openclaw.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await openclawAdapter(testConfig, { json: true });

    console.log = originalLog;

    const parsed = JSON.parse(output.trim());
    expect(parsed.models.providers.token2chat).toBeDefined();
    expect(parsed.models.providers.token2chat.baseUrl).toBe("http://127.0.0.1:10402/v1");
    expect(parsed.models.providers.token2chat.apiKey).toBe("t2c-local");
    expect(parsed.models.providers.token2chat.models).toBeInstanceOf(Array);
  });

  it("generates models with required fields", async () => {
    const { openclawAdapter } = await import("../src/adapters/openclaw.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await openclawAdapter(testConfig, { json: true });

    console.log = originalLog;

    const parsed = JSON.parse(output.trim());
    const models = parsed.models.providers.token2chat.models;
    expect(models.length).toBeGreaterThan(0);

    const firstModel = models[0];
    expect(firstModel).toHaveProperty("id");
    expect(firstModel).toHaveProperty("name");
    expect(firstModel).toHaveProperty("contextWindow");
  });
});

describe("cursorAdapter", () => {
  it("outputs correct Cursor config", async () => {
    const { cursorAdapter } = await import("../src/adapters/cursor.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await cursorAdapter(testConfig, { json: true });

    console.log = originalLog;

    const parsed = JSON.parse(output.trim());
    expect(parsed.openai.baseUrl).toBe("http://127.0.0.1:10402/v1");
    expect(parsed.openai.apiKey).toBe("t2c-local");
  });

  it("displays instructions without --json", async () => {
    const { cursorAdapter } = await import("../src/adapters/cursor.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await cursorAdapter(testConfig, {});

    console.log = originalLog;

    expect(output).toContain("Cursor Configuration");
    expect(output).toContain("127.0.0.1:10402");
  });
});

describe("envAdapter", () => {
  it("outputs correct environment variables", async () => {
    const { envAdapter } = await import("../src/adapters/env.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await envAdapter(testConfig, { json: true });

    console.log = originalLog;

    const parsed = JSON.parse(output.trim());
    expect(parsed.OPENAI_API_KEY).toBe("t2c-local");
    expect(parsed.OPENAI_BASE_URL).toBe("http://127.0.0.1:10402/v1");
  });

  it("displays shell export commands without --json", async () => {
    const { envAdapter } = await import("../src/adapters/env.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await envAdapter(testConfig, {});

    console.log = originalLog;

    expect(output).toContain("export OPENAI_API_KEY");
    expect(output).toContain("export OPENAI_BASE_URL");
  });
});

describe("clineAdapter", () => {
  it("outputs correct Cline config JSON", async () => {
    const { clineAdapter } = await import("../src/adapters/cline.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await clineAdapter(testConfig, { json: true });

    console.log = originalLog;

    const parsed = JSON.parse(output.trim());
    expect(parsed["cline.apiProvider"]).toBe("openai-compatible");
    expect(parsed["cline.openAiCompatibleApiBaseUrl"]).toBe("http://127.0.0.1:10402/v1");
    expect(parsed["cline.openAiCompatibleApiKey"]).toBe("t2c-local");
    expect(parsed["cline.openAiCompatibleModelId"]).toBe("anthropic/claude-sonnet-4");
  });

  it("displays VS Code settings instructions without --json", async () => {
    const { clineAdapter } = await import("../src/adapters/cline.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await clineAdapter(testConfig, {});

    console.log = originalLog;

    expect(output).toContain("Cline Configuration");
    expect(output).toContain("settings.json");
    expect(output).toContain("cline.apiProvider");
  });
});

describe("continueAdapter", () => {
  it("outputs correct Continue config JSON", async () => {
    const { continueAdapter } = await import("../src/adapters/continue.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await continueAdapter(testConfig, { json: true });

    console.log = originalLog;

    const parsed = JSON.parse(output.trim());
    expect(parsed.models).toBeInstanceOf(Array);
    expect(parsed.models[0].provider).toBe("openai");
    expect(parsed.models[0].apiBase).toBe("http://127.0.0.1:10402/v1");
    expect(parsed.models[0].apiKey).toBe("t2c-local");
  });

  it("displays Continue config instructions without --json", async () => {
    const { continueAdapter } = await import("../src/adapters/continue.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await continueAdapter(testConfig, {});

    console.log = originalLog;

    expect(output).toContain("Continue Configuration");
    expect(output).toContain("~/.continue/config.json");
  });
});

describe("aiderAdapter", () => {
  it("outputs correct Aider env vars JSON", async () => {
    const { aiderAdapter } = await import("../src/adapters/aider.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await aiderAdapter(testConfig, { json: true });

    console.log = originalLog;

    const parsed = JSON.parse(output.trim());
    expect(parsed.OPENAI_API_KEY).toBe("t2c-local");
    expect(parsed.OPENAI_API_BASE).toBe("http://127.0.0.1:10402/v1");
  });

  it("displays Aider configuration options without --json", async () => {
    const { aiderAdapter } = await import("../src/adapters/aider.js");

    let output = "";
    const originalLog = console.log;
    console.log = (...args) => {
      output += args.join(" ") + "\n";
    };

    await aiderAdapter(testConfig, {});

    console.log = originalLog;

    expect(output).toContain("Aider Configuration");
    expect(output).toContain("OPENAI_API_KEY");
    expect(output).toContain("OPENAI_API_BASE");
    expect(output).toContain(".aider.conf.yml");
  });
});

describe("adapter index", () => {
  it("exports all adapters", async () => {
    const adapters = await import("../src/adapters/index.js");
    expect(adapters.openclawAdapter).toBeDefined();
    expect(adapters.cursorAdapter).toBeDefined();
    expect(adapters.envAdapter).toBeDefined();
    expect(adapters.clineAdapter).toBeDefined();
    expect(adapters.continueAdapter).toBeDefined();
    expect(adapters.aiderAdapter).toBeDefined();
  });
});
