/**
 * OpenClaw adapter - Generate config for OpenClaw
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { T2CConfig, AdapterConfigOptions } from "../config.js";

// Popular models available through the Gate
const GATE_MODELS = [
  // OpenAI
  { id: "openai-gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128_000 },
  { id: "openai-gpt-4o", name: "GPT-4o", contextWindow: 128_000 },
  { id: "openai-gpt-5.2-pro", name: "GPT-5.2 Pro", contextWindow: 400_000 },
  { id: "openai-o3-pro", name: "OpenAI o3 Pro", contextWindow: 200_000 },
  // Anthropic
  { id: "anthropic-claude-opus-4.5", name: "Claude Opus 4.5", contextWindow: 200_000 },
  { id: "anthropic-claude-sonnet-4.5", name: "Claude Sonnet 4.5", contextWindow: 200_000 },
  { id: "anthropic-claude-opus-4", name: "Claude Opus 4", contextWindow: 200_000 },
  { id: "anthropic-claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: 200_000 },
  // Google
  { id: "google-gemini-3-flash-preview", name: "Gemini 3 Flash", contextWindow: 1_000_000 },
  { id: "google-gemini-2.5-pro-preview", name: "Gemini 2.5 Pro", contextWindow: 1_000_000 },
  // Others
  { id: "deepseek-deepseek-r1", name: "DeepSeek R1", contextWindow: 64_000 },
  { id: "qwen-qwen3-coder-next", name: "Qwen3 Coder", contextWindow: 256_000 },
  { id: "moonshotai-kimi-k2.5", name: "Kimi K2.5", contextWindow: 256_000 },
];

interface OpenClawConfig {
  models?: {
    mode?: string;
    providers?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

function generateOpenClawConfig(t2cConfig: T2CConfig, apiKey: string): object {
  return {
    models: {
      mode: "merge",
      providers: {
        token2chat: {
          baseUrl: `http://127.0.0.1:${t2cConfig.proxyPort}/v1`,
          apiKey,
          api: "openai-completions",
          authHeader: true,
          models: GATE_MODELS.map((m) => ({
            id: m.id,
            name: m.name,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: m.contextWindow,
            maxTokens: 16_384,
          })),
        },
      },
    },
  };
}

async function loadOpenClawConfig(): Promise<{ config: OpenClawConfig; path: string } | null> {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return { config: JSON.parse(raw), path: configPath };
  } catch (e) {
    // Distinguish between file not found and parse error
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    // If file exists but is invalid JSON, throw with helpful message
    throw new Error(`Failed to parse ${configPath}: ${(e as Error).message}`);
  }
}

async function saveOpenClawConfig(config: OpenClawConfig, configPath: string): Promise<void> {
  // Create backup before modifying
  const backupPath = `${configPath}.backup.${Date.now()}`;
  try {
    const existing = await fs.readFile(configPath, "utf-8");
    await fs.writeFile(backupPath, existing);
  } catch {
    // File may not exist yet
  }

  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

function mergeDeep(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = mergeDeep(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Sync Token2Chat credentials into OpenClaw auth-profiles.json.
 *
 * Looks for an existing profile keyed "token2chat:local" or any profile
 * with provider === "token2chat". Updates its token to the current
 * proxy-secret. If none exists, adds "token2chat:local".
 *
 * Other profiles are left untouched.
 */
async function syncAuthProfiles(apiKey: string): Promise<void> {
  const authProfilesPath = path.join(
    os.homedir(),
    ".openclaw",
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
      // File doesn't exist — nothing to sync (OpenClaw not fully initialised)
      console.log("   ℹ️  auth-profiles.json not found, skipping auth sync");
      return;
    }
    console.warn(`   ⚠️  Failed to read auth-profiles.json: ${(e as Error).message}`);
    return;
  }

  const profiles = authProfiles.profiles as Record<string, Record<string, unknown>> | undefined;
  if (!profiles || typeof profiles !== "object") {
    console.warn("   ⚠️  auth-profiles.json has no 'profiles' object, skipping auth sync");
    return;
  }

  // Find existing token2chat profile(s)
  let updated = false;
  for (const [key, profile] of Object.entries(profiles)) {
    if (key === "token2chat:local" || profile?.provider === "token2chat") {
      profiles[key] = { ...profile, token: apiKey };
      updated = true;
    }
  }

  // If no token2chat profile exists, create one
  if (!updated) {
    profiles["token2chat:local"] = {
      type: "token",
      provider: "token2chat",
      token: apiKey,
    };
  }

  // Backup and write
  try {
    const backup = `${authProfilesPath}.backup.${Date.now()}`;
    const existing = await fs.readFile(authProfilesPath, "utf-8");
    await fs.writeFile(backup, existing);
  } catch {
    // OK — may not exist
  }

  await fs.writeFile(authProfilesPath, JSON.stringify(authProfiles, null, 2) + "\n");
  console.log("   ✅ auth-profiles.json synced (token2chat token updated)");
}

export async function openclawAdapter(t2cConfig: T2CConfig, opts: AdapterConfigOptions): Promise<void> {
  const apiKey = opts.proxySecret ?? "t2c-local";
  const patch = generateOpenClawConfig(t2cConfig, apiKey);

  if (opts.json) {
    console.log(JSON.stringify(patch, null, 2));
    return;
  }

  if (opts.apply) {
    let existing: { config: OpenClawConfig; path: string } | null;

    try {
      existing = await loadOpenClawConfig();
    } catch (e) {
      console.error(`Error reading OpenClaw config: ${(e as Error).message}`);
      console.error("\nPossible fixes:");
      console.error("  1. Fix the JSON syntax error in openclaw.json");
      console.error("  2. Run 't2c config openclaw' (without --apply) to see the config to add manually");
      process.exit(1);
    }

    if (!existing) {
      console.error("OpenClaw config not found at ~/.openclaw/openclaw.json");
      console.error("\nTo set up OpenClaw first:");
      console.error("  openclaw onboard\n");
      console.error("Or create the config manually and run this command again.");
      process.exit(1);
    }

    // Check if token2chat provider already exists
    const existingT2C = (existing.config.models?.providers as Record<string, unknown>)?.token2chat;
    if (existingT2C) {
      console.log("Token2Chat provider already configured in OpenClaw.");
      console.log("Updating configuration...\n");
    }

    const merged = mergeDeep(
      existing.config as Record<string, unknown>,
      patch as Record<string, unknown>
    );

    try {
      await saveOpenClawConfig(merged as OpenClawConfig, existing.path);
    } catch (e) {
      console.error(`Failed to save config: ${(e as Error).message}`);
      process.exit(1);
    }

    console.log("✅ OpenClaw config updated: ~/.openclaw/openclaw.json\n");

    // Verify the saved config is valid JSON
    try {
      const verify = await fs.readFile(existing.path, "utf-8");
      JSON.parse(verify);
    } catch {
      console.error("⚠️  Warning: Config may be corrupted. Check ~/.openclaw/openclaw.json");
      console.error("   A backup was created before modification.");
    }

    // Sync auth-profiles.json so OpenClaw's gateway uses the correct proxy-secret
    await syncAuthProfiles(apiKey);

    console.log("\nToken2Chat provider added. To use it:\n");
    console.log("  1. Restart the gateway:");
    console.log("     openclaw gateway restart\n");
    console.log("  2. Set as default model (optional):");
    console.log("     openclaw models set token2chat/anthropic-claude-sonnet-4\n");
    console.log("  3. Or add to fallbacks in openclaw.json:");
    console.log('     agents.defaults.model.fallbacks: ["token2chat/anthropic-claude-sonnet-4"]\n');
    return;
  }

  // Default: show instructions
  console.log("\n🎟️  OpenClaw Configuration\n");
  console.log("Add this to your ~/.openclaw/openclaw.json:\n");
  console.log("```json");
  console.log(JSON.stringify(patch, null, 2));
  console.log("```\n");
  console.log("Or run with --apply to merge automatically:");
  console.log("  t2c config openclaw --apply\n");
  console.log("After updating config:\n");
  console.log("  1. Restart the gateway:");
  console.log("     openclaw gateway restart\n");
  console.log("  2. Set as default or fallback model:");
  console.log("     openclaw models set token2chat/anthropic-claude-sonnet-4\n");
}
