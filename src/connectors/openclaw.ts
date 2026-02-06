/**
 * OpenClaw Connector
 *
 * Patches OpenClaw config to add Token2Chat plugin and models provider.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { type T2CConfig, loadOrCreateProxySecret } from "../config.js";
import type { Connector } from "./interface.js";

/** Model entry for OpenClaw models.providers.*.models */
interface ModelEntry {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * Default models when Gate is unreachable.
 * IDs use dash format (proxy transforms to slash for Gate/OpenRouter).
 */
const DEFAULT_MODELS: ModelEntry[] = [
  { id: "openai-gpt-4o-mini", name: "GPT-4o Mini" },
  { id: "openai-gpt-4o", name: "GPT-4o" },
  { id: "anthropic-claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
  { id: "anthropic-claude-opus-4-20250514", name: "Claude Opus 4" },
];

/**
 * Fetch available models from Gate pricing endpoint.
 * Returns model entries in OpenClaw dash format.
 */
async function fetchGateModels(gateUrl: string): Promise<ModelEntry[]> {
  try {
    const res = await fetch(`${gateUrl}/v1/pricing`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as { models?: Record<string, unknown> };
    if (!data.models) return [];

    return Object.keys(data.models)
      .filter((id) => id !== "*") // skip wildcard
      .map((id) => ({
        // Transform slash to dash for OpenClaw (e.g. "anthropic/claude-sonnet-4" → "anthropic-claude-sonnet-4")
        id: id.replace("/", "-"),
        name: id.split("/").pop()?.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ?? id,
      }));
  } catch {
    return [];
  }
}

const OPENCLAW_CONFIG_DIR = ".openclaw";
// OpenClaw may use either filename (openclaw.json is newer, clawdbot.json is legacy)
const OPENCLAW_CONFIG_FILES = ["openclaw.json", "clawdbot.json"] as const;

/**
 * Find the first existing config file, or return the preferred default.
 */
async function getConfigPath(): Promise<string> {
  const dir = path.join(os.homedir(), OPENCLAW_CONFIG_DIR);
  for (const file of OPENCLAW_CONFIG_FILES) {
    const p = path.join(dir, file);
    try {
      await fs.access(p);
      return p;
    } catch {
      // try next
    }
  }
  // Default to the first (preferred) filename if none exist
  return path.join(dir, OPENCLAW_CONFIG_FILES[0]);
}

/**
 * Merge Token2Chat configuration into existing OpenClaw config.
 * Handles:
 * - Arrays and nested objects
 * - Existing token2chat config (overwrites, doesn't duplicate)
 */
function mergeToken2ChatConfig(
  existingConfig: Record<string, unknown>,
  t2cConfig: T2CConfig,
  gateModels: ModelEntry[],
  apiKey: string,
): Record<string, unknown> {
  const config = { ...existingConfig };

  // Ensure plugins.entries exists
  if (!config.plugins || typeof config.plugins !== "object") {
    config.plugins = {};
  }
  const plugins = config.plugins as Record<string, unknown>;

  if (!plugins.entries || typeof plugins.entries !== "object") {
    plugins.entries = {};
  }
  const entries = plugins.entries as Record<string, unknown>;

  // Set/overwrite token2chat plugin config
  entries.token2chat = {
    enabled: true,
    config: {
      gateUrl: t2cConfig.gateUrl,
      mintUrl: t2cConfig.mintUrl,
      proxyPort: t2cConfig.proxyPort,
      walletPath: t2cConfig.walletPath,
    },
  };

  // Ensure models.providers exists
  if (!config.models || typeof config.models !== "object") {
    config.models = {};
  }
  const models = config.models as Record<string, unknown>;

  if (!models.providers || typeof models.providers !== "object") {
    models.providers = {};
  }
  const providers = models.providers as Record<string, unknown>;

  // Set/overwrite token2chat provider config
  providers.token2chat = {
    baseUrl: `http://127.0.0.1:${t2cConfig.proxyPort}/v1`,
    apiKey,
    api: "openai-completions",
    models: gateModels.length > 0 ? gateModels : DEFAULT_MODELS,
  };

  return config;
}

export const openclawConnector: Connector = {
  id: "openclaw",
  name: "OpenClaw",
  description: "Configure OpenClaw gateway to use Token2Chat",

  async detect(): Promise<boolean> {
    const dir = path.join(os.homedir(), OPENCLAW_CONFIG_DIR);
    for (const file of OPENCLAW_CONFIG_FILES) {
      try {
        await fs.access(path.join(dir, file));
        return true;
      } catch {
        // try next
      }
    }
    return false;
  },

  async connect(config: T2CConfig): Promise<void> {
    // Check if OpenClaw is installed
    const detected = await this.detect();
    if (!detected) {
      const defaultPath = path.join(os.homedir(), OPENCLAW_CONFIG_DIR, OPENCLAW_CONFIG_FILES[0]);
      console.error("❌ OpenClaw not detected");
      console.error(`   Expected config at: ${defaultPath}`);
      console.error("\n   Install OpenClaw first: https://openclaw.dev\n");
      return;
    }

    const configPath = await getConfigPath();

    // Read existing config
    let existingContent = "";
    let existingConfig: Record<string, unknown> = {};
    try {
      existingContent = await fs.readFile(configPath, "utf-8");
      existingConfig = JSON.parse(existingContent) as Record<string, unknown>;
    } catch {
      existingContent = "";
      existingConfig = {};
    }

    // Load proxy secret for authentication
    const apiKey = await loadOrCreateProxySecret();

    // Fetch available models from Gate
    console.log("   Fetching available models from Gate...");
    const gateModels = await fetchGateModels(config.gateUrl);
    if (gateModels.length > 0) {
      console.log(`   Found ${gateModels.length} models`);
    } else {
      console.log(`   Gate unreachable, using ${DEFAULT_MODELS.length} default models`);
    }

    // Merge our config
    const mergedConfig = mergeToken2ChatConfig(existingConfig, config, gateModels, apiKey);

    // Serialize to JSON with pretty formatting
    const newContent = JSON.stringify(mergedConfig, null, 2) + "\n";

    // Backup existing config
    const backupPath = `${configPath}.backup.${Date.now()}`;
    if (existingContent) {
      await fs.writeFile(backupPath, existingContent);
    }

    // Write new config
    await fs.writeFile(configPath, newContent);

    console.log("✅ OpenClaw configured for Token2Chat\n");
    console.log(`   Config: ${configPath}`);
    if (existingContent) {
      console.log(`   Backup: ${backupPath}`);
    }
    console.log("\n📋 Next steps:\n");
    console.log("   1. Restart OpenClaw gateway:");
    console.log("      openclaw gateway restart\n");
    console.log("   2. Start the t2c proxy:");
    console.log("      t2c service start\n");
    console.log("   3. Use Token2Chat models with:");
    console.log("      token2chat/anthropic-claude-sonnet-4\n");
  },

  async verify(): Promise<boolean> {
    // Check if config has our entries
    try {
      const configPath = await getConfigPath();
      const content = await fs.readFile(configPath, "utf-8");
      const doc = JSON.parse(content) as Record<string, unknown>;
      const plugins = doc?.plugins as Record<string, unknown> | undefined;
      const entries = plugins?.entries as Record<string, unknown> | undefined;
      const models = doc?.models as Record<string, unknown> | undefined;
      const providers = models?.providers as Record<string, unknown> | undefined;
      return (
        entries?.token2chat !== undefined && providers?.token2chat !== undefined
      );
    } catch {
      return false;
    }
  },
};
