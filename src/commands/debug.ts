/**
 * t2c debug - Debug/testing commands (DO NOT SHIP — remove before release)
 *
 * ⚠️  DELETE THIS FILE BEFORE PUBLISHING TO NPM ⚠️
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, loadOrCreateProxySecret, formatUnits } from "../config.js";

const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const OPENCLAW_CONFIG = path.join(OPENCLAW_DIR, "openclaw.json");
const OPENCLAW_BACKUP = path.join(OPENCLAW_DIR, "openclaw.json.t2c-debug-bak");
const GATEWAY_ERR_LOG = path.join(OPENCLAW_DIR, "logs", "gateway.err.log");
const GATEWAY_LOG = path.join(OPENCLAW_DIR, "logs", "gateway.log");

// Models to expose when forcing token2chat as sole provider
const T2C_MODELS = [
  { id: "openai-gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128_000 },
  { id: "openai-gpt-4o", name: "GPT-4o", contextWindow: 128_000 },
  { id: "anthropic-claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 200_000 },
  { id: "anthropic-claude-opus-4-20250514", name: "Claude Opus 4", contextWindow: 200_000 },
];

interface OpenClawConfig {
  auth?: { profiles?: Record<string, unknown>; order?: Record<string, unknown> };
  models?: { mode?: string; providers?: Record<string, unknown> };
  agents?: { defaults?: { model?: { primary?: string; fallbacks?: string[] } } };
  [key: string]: unknown;
}

interface AuthProfileStats {
  usageStats?: Record<string, {
    lastUsed?: number;
    errorCount?: number;
    lastFailureAt?: number;
    failureCounts?: Record<string, number>;
    disabledUntil?: number | null;
    disabledReason?: string | null;
  }>;
}

async function loadOpenClawConfig(): Promise<OpenClawConfig> {
  const raw = await fs.readFile(OPENCLAW_CONFIG, "utf-8");
  return JSON.parse(raw) as OpenClawConfig;
}

async function saveOpenClawConfig(config: OpenClawConfig): Promise<void> {
  await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config, null, 2));
}

/**
 * Find all auth-profiles.json files across agent dirs.
 */
async function findAuthProfiles(): Promise<string[]> {
  const agentsDir = path.join(OPENCLAW_DIR, "agents");
  const results: string[] = [];
  try {
    const agents = await fs.readdir(agentsDir);
    for (const agent of agents) {
      const profilePath = path.join(agentsDir, agent, "agent", "auth-profiles.json");
      try {
        await fs.access(profilePath);
        results.push(profilePath);
      } catch {
        // not found for this agent
      }
    }
  } catch {
    // agents dir doesn't exist
  }
  return results;
}

/**
 * Clear token2chat cooldown from all auth-profiles.json files.
 */
async function clearToken2ChatCooldown(): Promise<number> {
  const profiles = await findAuthProfiles();
  let cleared = 0;

  for (const profilePath of profiles) {
    try {
      const raw = await fs.readFile(profilePath, "utf-8");
      const data = JSON.parse(raw) as AuthProfileStats;

      if (!data.usageStats) continue;

      let modified = false;
      for (const [key, stats] of Object.entries(data.usageStats)) {
        if (key.startsWith("token2chat") && stats.disabledUntil) {
          stats.disabledUntil = null;
          stats.disabledReason = null;
          stats.errorCount = 0;
          if (stats.failureCounts) stats.failureCounts = {};
          modified = true;
          cleared++;
        }
      }

      if (modified) {
        await fs.writeFile(profilePath, JSON.stringify(data, null, 2));
      }
    } catch {
      // skip unreadable files
    }
  }
  return cleared;
}

async function forceToken2Chat(): Promise<void> {
  // Check openclaw config exists
  try {
    await fs.access(OPENCLAW_CONFIG);
  } catch {
    console.error("❌ OpenClaw config not found:", OPENCLAW_CONFIG);
    process.exit(1);
  }

  // Check if already forced
  try {
    await fs.access(OPENCLAW_BACKUP);
    console.error("⚠️  Already in debug-force mode (backup exists).");
    console.error("   Run 't2c debug rollback' first to restore, then force again.");
    process.exit(1);
  } catch {
    // Good — no backup means we haven't forced yet
  }

  const config = await loadOpenClawConfig();
  const t2cConfig = await loadConfig();

  // Backup current config
  const raw = await fs.readFile(OPENCLAW_CONFIG, "utf-8");
  await fs.writeFile(OPENCLAW_BACKUP, raw);
  console.log("✅ Backed up current config");

  // Clear token2chat cooldown before forcing
  const cleared = await clearToken2ChatCooldown();
  if (cleared > 0) {
    console.log(`✅ Cleared ${cleared} token2chat cooldown(s)`);
  }

  // Clear auth profiles and order
  if (config.auth) {
    config.auth.profiles = {};
    config.auth.order = {};
  }

  // Replace all providers with just token2chat
  if (!config.models) config.models = {};
  config.models.mode = "merge";
  config.models.providers = {
    token2chat: {
      baseUrl: `http://127.0.0.1:${t2cConfig.proxyPort}/v1`,
      apiKey: await loadOrCreateProxySecret(),
      api: "openai-completions",
      authHeader: true,
      models: T2C_MODELS.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow,
        maxTokens: 16_384,
      })),
    },
  };

  // Set primary model and fallbacks to token2chat only
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.model) config.agents.defaults.model = {};
  config.agents.defaults.model.primary = "token2chat/anthropic-claude-opus-4-20250514";
  config.agents.defaults.model.fallbacks = [
    "token2chat/anthropic-claude-sonnet-4-20250514",
    "token2chat/openai-gpt-4o",
    "token2chat/openai-gpt-4o-mini",
  ];

  await saveOpenClawConfig(config);

  console.log("✅ Forced token2chat as sole provider\n");
  console.log("   Primary:   token2chat/anthropic-claude-opus-4-20250514");
  console.log("   Fallbacks: sonnet-4 → gpt-4o → gpt-4o-mini\n");
  console.log("⚠️  Restart OpenClaw to apply:");
  console.log("   openclaw gateway restart\n");
  console.log("📌 To restore: t2c debug rollback");
}

async function rollbackConfig(): Promise<void> {
  try {
    await fs.access(OPENCLAW_BACKUP);
  } catch {
    console.error("❌ No debug backup found. Nothing to rollback.");
    process.exit(1);
  }

  await fs.copyFile(OPENCLAW_BACKUP, OPENCLAW_CONFIG);
  await fs.unlink(OPENCLAW_BACKUP);

  console.log("✅ Config restored from backup\n");
  console.log("⚠️  Restart OpenClaw to apply:");
  console.log("   openclaw gateway restart");
}

/**
 * Show auth profile status and recent model-related logs.
 */
async function showLogs(opts: { lines?: string }): Promise<void> {
  const maxLines = parseInt(opts.lines || "30", 10);

  // ── 1. Auth Profiles Status ──
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║         Auth Profiles & Cooldowns            ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const profiles = await findAuthProfiles();
  const now = Date.now();

  for (const profilePath of profiles) {
    const agentName = profilePath.split(path.sep).at(-3) || "unknown";
    try {
      const raw = await fs.readFile(profilePath, "utf-8");
      const data = JSON.parse(raw) as AuthProfileStats;

      if (!data.usageStats) {
        console.log(`  [${agentName}] No usage stats\n`);
        continue;
      }

      console.log(`  Agent: ${agentName}`);
      for (const [key, stats] of Object.entries(data.usageStats)) {
        const isT2C = key.startsWith("token2chat");
        const marker = isT2C ? "🎟️ " : "   ";
        const lastUsed = stats.lastUsed
          ? new Date(stats.lastUsed).toISOString().replace("T", " ").slice(0, 19)
          : "never";

        let status = "✅ OK";
        if (stats.disabledUntil && stats.disabledUntil > now) {
          const remaining = Math.ceil((stats.disabledUntil - now) / 60000);
          status = `🔴 COOLDOWN (${stats.disabledReason || "unknown"}, ${remaining}min left)`;
        } else if (stats.errorCount && stats.errorCount > 0) {
          status = `⚠️  ${stats.errorCount} errors`;
        }

        console.log(`  ${marker}${key}`);
        console.log(`      Status:    ${status}`);
        console.log(`      Last used: ${lastUsed}`);
        if (stats.failureCounts && Object.keys(stats.failureCounts).length > 0) {
          console.log(`      Failures:  ${JSON.stringify(stats.failureCounts)}`);
        }
        console.log();
      }
    } catch {
      console.log(`  [${agentName}] Failed to read\n`);
    }
  }

  // ── 2. Recent Model Errors from Gateway Logs ──
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║         Recent Model/Provider Errors         ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const keywords = [
    "model", "provider", "token2chat", "cooldown",
    "All models failed", "rate_limit", "billing",
    "auth-profile", "fallback",
  ];
  const pattern = keywords.join("|");

  for (const logFile of [GATEWAY_ERR_LOG, GATEWAY_LOG]) {
    try {
      await fs.access(logFile);
      const content = await fs.readFile(logFile, "utf-8");
      const lines = content.split("\n");

      const matched: string[] = [];
      const regex = new RegExp(pattern, "i");
      for (const line of lines) {
        if (regex.test(line)) {
          matched.push(line);
        }
      }

      const logName = path.basename(logFile);
      const recent = matched.slice(-maxLines);

      if (recent.length === 0) {
        console.log(`  [${logName}] No model/provider entries found\n`);
        continue;
      }

      console.log(`  [${logName}] Last ${recent.length} entries:\n`);
      for (const line of recent) {
        // Trim long lines
        const trimmed = line.length > 160 ? line.slice(0, 157) + "..." : line;
        console.log(`    ${trimmed}`);
      }
      console.log();
    } catch {
      // log file doesn't exist
    }
  }

  // ── 3. Proxy Health ──
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║              Proxy Health                    ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const t2cConfig = await loadConfig();
  try {
    const res = await fetch(`http://127.0.0.1:${t2cConfig.proxyPort}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`  Status:  ✅ Running on port ${t2cConfig.proxyPort}`);
      console.log(`  Balance: ${(data as { balance?: number }).balance != null ? formatUnits((data as { balance?: number }).balance!) : "unknown"}`);
    } else {
      console.log(`  Status:  ⚠️  HTTP ${res.status}`);
    }
  } catch {
    console.log(`  Status:  🔴 Not reachable (port ${t2cConfig.proxyPort})`);
  }
  console.log();
}

/**
 * Topup local plugin wallet from Gate's ecash balance.
 *
 * Flow:
 *   1. Call Gate POST /homo/withdraw {amount} → get Cashu token
 *   2. Save token to ~/.t2c/pending-topup.token (safety net)
 *   3. Receive token into local wallet via mint swap
 *   4. Delete pending token file on success
 */
async function topupFromGate(opts: { amount?: string }): Promise<void> {
  const amount = parseInt(opts.amount || "0", 10);
  if (!amount || amount <= 0) {
    console.error("❌ Specify a positive amount: t2c debug topup --amount 5000");
    process.exit(1);
  }

  const t2cConfig = await loadConfig();
  const pendingTokenPath = path.join(os.homedir(), ".t2c", "pending-topup.token");

  // Check for unfinished previous topup
  try {
    const pending = await fs.readFile(pendingTokenPath, "utf-8");
    if (pending.trim()) {
      console.log("⚠️  Found pending token from a previous failed topup.");
      console.log("   Attempting to receive it first...\n");

      try {
        const { CashuStore } = await import("../cashu-store.js");
        const store = await CashuStore.load(
          path.join(os.homedir(), ".t2c", "wallet.json"),
          t2cConfig.mintUrl,
        );
        const received = await store.receiveToken(pending.trim());
        await fs.unlink(pendingTokenPath);
        console.log(`✅ Recovered ${formatUnits(received)} from pending token\n`);
        console.log(`   New balance: ${formatUnits(store.balance)}`);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`❌ Failed to receive pending token: ${msg}`);
        console.error(`   Token saved at: ${pendingTokenPath}`);
        console.error(`   You can manually import it later.\n`);
        process.exit(1);
      }
    }
  } catch {
    // No pending token, good
  }

  // Read admin token
  const adminTokenPath = path.join(os.homedir(), ".secrets", "admin-token.txt");
  let adminToken: string;
  try {
    adminToken = (await fs.readFile(adminTokenPath, "utf-8")).trim();
  } catch {
    console.error("❌ Admin token not found at ~/.secrets/admin-token.txt");
    process.exit(1);
  }

  console.log(`🔄 Withdrawing ${formatUnits(amount)} from Gate...\n`);

  // 1. Call Gate withdraw
  let token: string;
  let withdrawAmount: number;
  let remainingBalance: number;

  try {
    const res = await fetch(`${t2cConfig.gateUrl}/homo/withdraw`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ amount }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" })) as { error?: string };
      console.error(`❌ Gate withdraw failed: ${err.error || res.status}`);
      process.exit(1);
    }

    const data = await res.json() as {
      success: boolean;
      token: string;
      amount_sats: number;
      change_sats: number;
      remaining_balance_sats: number;
    };

    if (!data.success || !data.token) {
      console.error("❌ Gate returned unexpected response:", JSON.stringify(data));
      process.exit(1);
    }

    token = data.token;
    withdrawAmount = data.amount_sats;
    remainingBalance = data.remaining_balance_sats;

    console.log(`✅ Gate withdrew ${formatUnits(withdrawAmount)} (change: ${formatUnits(data.change_sats)})`);
    console.log(`   Gate remaining: ${formatUnits(remainingBalance)}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`❌ Failed to connect to Gate: ${msg}`);
    process.exit(1);
  }

  // 2. Save token to disk BEFORE attempting receive (safety net)
  try {
    await fs.mkdir(path.dirname(pendingTokenPath), { recursive: true });
    await fs.writeFile(pendingTokenPath, token, { mode: 0o600 });
  } catch (e) {
    // If we can't save, print it so user can manually recover
    console.error("⚠️  Could not save pending token to disk. Token:");
    console.error(token);
    console.error("\nSave this token and run 't2c recover' later.");
  }

  // 3. Receive token into local wallet (mint swap)
  console.log("🔄 Receiving token into local wallet (mint swap)...\n");

  try {
    const { CashuStore } = await import("../cashu-store.js");
    const store = await CashuStore.load(
      path.join(os.homedir(), ".t2c", "wallet.json"),
      t2cConfig.mintUrl,
    );

    const received = await store.receiveToken(token);

    // 4. Success — delete pending token
    try {
      await fs.unlink(pendingTokenPath);
    } catch {
      // fine
    }

    console.log(`✅ Received ${formatUnits(received)} into local wallet`);
    console.log(`   New balance: ${formatUnits(store.balance)}\n`);
    console.log("Done! Plugin proxy will use these funds for LLM calls.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`❌ Mint swap failed: ${msg}`);
    console.error(`\n   Token is saved at: ${pendingTokenPath}`);
    console.error("   The token is still valid. Run 't2c debug topup' again to retry.");
    process.exit(1);
  }
}

export async function debugCommand(subcommand: string, opts: Record<string, string> = {}): Promise<void> {
  switch (subcommand) {
    case "force":
      await forceToken2Chat();
      break;
    case "rollback":
      await rollbackConfig();
      break;
    case "logs":
      await showLogs(opts);
      break;
    case "topup":
      await topupFromGate(opts);
      break;
    default:
      console.log("t2c debug — Debug/testing commands\n");
      console.log("Usage:");
      console.log("  t2c debug force              Force OpenClaw to use token2chat exclusively");
      console.log("  t2c debug rollback           Restore original OpenClaw config");
      console.log("  t2c debug logs               Show auth profiles, cooldowns, and model errors");
      console.log("  t2c debug topup --amount N   Transfer N units from Gate to local wallet\n");
      console.log("⚠️  These commands are for development/testing only.");
      break;
  }
}
