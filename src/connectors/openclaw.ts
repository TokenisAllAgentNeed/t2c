/**
 * OpenClaw Connector
 *
 * Patches OpenClaw config to add Token2Chat plugin and models provider.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { type T2CConfig, loadOrCreateProxySecret, WALLET_PATH, formatUnits } from "../config.js";
import { CashuStore } from "../cashu-store.js";
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
 *
 * Only adds the token2chat models provider — does NOT modify
 * agents.defaults.model or agents.defaults.models so existing
 * primary/fallback routing is preserved.
 */
function mergeToken2ChatConfig(
  existingConfig: Record<string, unknown>,
  t2cConfig: T2CConfig,
  gateModels: ModelEntry[],
  apiKey: string,
): Record<string, unknown> {
  const config = { ...existingConfig };

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
  const activeModels = gateModels.length > 0 ? gateModels : DEFAULT_MODELS;
  providers.token2chat = {
    baseUrl: `http://127.0.0.1:${t2cConfig.proxyPort}/v1`,
    apiKey,
    api: "openai-completions",
    authHeader: true,
    models: activeModels,
  };

  // Do NOT touch agents.defaults — the user's primary model and
  // fallback chain should stay intact. Token2Chat models are available
  // via the "token2chat/" provider prefix (e.g. token2chat/anthropic-claude-sonnet-4).

  return config;
}

/**
 * Sync Token2Chat credentials into OpenClaw auth-profiles.json.
 *
 * Finds any profile keyed "token2chat:local" or with provider === "token2chat"
 * and updates its token. If none exists, adds "token2chat:local".
 * Other profiles are preserved.
 */
async function syncAuthProfiles(apiKey: string): Promise<void> {
  const authProfilesPath = path.join(
    os.homedir(),
    OPENCLAW_CONFIG_DIR,
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  );

  let authProfiles: Record<string, unknown>;
  try {
    const raw = await fs.readFile(authProfilesPath, "utf-8");
    authProfiles = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("   ℹ️  auth-profiles.json not found, skipping auth sync");
      return;
    }
    console.warn(`   ⚠️  Failed to read auth-profiles.json: ${(e as Error).message}`);
    return;
  }

  const profiles = authProfiles.profiles as Record<string, Record<string, unknown>> | undefined;
  if (!profiles || typeof profiles !== "object") {
    console.warn("   ⚠️  auth-profiles.json has no 'profiles' object, skipping");
    return;
  }

  let updated = false;
  for (const [key, profile] of Object.entries(profiles)) {
    if (key === "token2chat:local" || profile?.provider === "token2chat") {
      profiles[key] = { ...profile, token: apiKey };
      updated = true;
    }
  }

  if (!updated) {
    profiles["token2chat:local"] = {
      type: "token",
      provider: "token2chat",
      token: apiKey,
    };
  }

  // Backup and write
  try {
    const existing = await fs.readFile(authProfilesPath, "utf-8");
    await fs.writeFile(`${authProfilesPath}.backup.${Date.now()}`, existing);
  } catch {
    // OK
  }

  await fs.writeFile(authProfilesPath, JSON.stringify(authProfiles, null, 2) + "\n");
  console.log("   ✅ auth-profiles.json synced (token2chat token updated)");
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

    // Sync auth-profiles.json so the gateway uses the correct proxy-secret
    await syncAuthProfiles(apiKey);

    console.log("✅ OpenClaw configured for Token2Chat\n");
    console.log(`   Config: ${configPath}`);
    if (existingContent) {
      console.log(`   Backup: ${backupPath}`);
    }
    // Show wallet balance for onboarding
    try {
      const wallet = await CashuStore.load(WALLET_PATH, config.mintUrl);
      console.log(`\n💰 Wallet balance: ${formatUnits(wallet.balance)}`);
    } catch {
      console.log("\n💰 Wallet: not funded yet");
      console.log(`   Fund your wallet: t2c mint <amount>`);
      console.log(`   Mint URL: ${config.mintUrl}`);
    }

    // Show available model IDs for easy copy-paste
    const activeModels = gateModels.length > 0 ? gateModels : DEFAULT_MODELS;
    const modelList = activeModels.map((m) => `token2chat/${m.id}`);

    console.log("\n📋 Next steps:\n");
    console.log("   1. Restart OpenClaw gateway:");
    console.log("      openclaw gateway restart\n");
    console.log("   2. Make sure the t2c proxy is running:");
    console.log("      t2c service start\n");
    console.log("   3. Use Token2Chat models (via provider prefix):");
    for (const mid of modelList) {
      console.log(`      ${mid}`);
    }
    console.log("");
    console.log("   4. (Optional) Add as fallback in openclaw.json:");
    console.log('      agents.defaults.model.fallbacks → ["token2chat/anthropic-claude-sonnet-4", ...]');
    console.log("");
  },

  async verify(): Promise<boolean> {
    // Check if config has our entries
    try {
      const configPath = await getConfigPath();
      const content = await fs.readFile(configPath, "utf-8");
      const doc = JSON.parse(content) as Record<string, unknown>;
      const models = doc?.models as Record<string, unknown> | undefined;
      const providers = models?.providers as Record<string, unknown> | undefined;
      return providers?.token2chat !== undefined;
    } catch {
      return false;
    }
  },
};
