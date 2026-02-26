/**
 * t2c uninstall - Remove t2c service, config, and data (preserving wallet)
 *
 * IMPORTANT: wallet.json is ALWAYS preserved. There is intentionally NO option
 * to delete the wallet. Users who want to delete their wallet must do so manually.
 */
import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import {
  CONFIG_DIR,
  CONFIG_PATH,
  WALLET_PATH,
  PID_PATH,
  LOG_PATH,
  PROXY_SECRET_PATH,
  FAILED_TOKENS_PATH,
  TRANSACTIONS_LOG_PATH,
} from "../config.js";

export interface UninstallOptions {
  yes: boolean;
  removeOpenclaw: boolean;
}

// Launchd / systemd paths (keep in sync with service.ts)
const LAUNCHD_PLIST_NAME = "com.token2chat.proxy.plist";
const LAUNCHD_PLIST_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  LAUNCHD_PLIST_NAME
);
const SYSTEMD_UNIT_NAME = "t2c-proxy.service";
const SYSTEMD_UNIT_PATH = path.join(
  os.homedir(),
  ".config",
  "systemd",
  "user",
  SYSTEMD_UNIT_NAME
);

const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

/**
 * Files in ~/.t2c that the uninstall command will remove.
 * wallet.json is intentionally EXCLUDED — it is always preserved.
 */
const KNOWN_REMOVABLE_FILES = [
  "config.json",
  "proxy-secret",
  "proxy.log",
  "proxy.pid",
  "failed-tokens.json",
  "transactions.jsonl",
  "pending-quotes.json",
];

/**
 * Returns the list of known file basenames that will be removed from ~/.t2c.
 * wallet.json is NEVER included.
 */
export function getFilesToRemove(): string[] {
  return [...KNOWN_REMOVABLE_FILES];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "yes" || answer.toLowerCase() === "y");
    });
  });
}

/**
 * List all removable files in CONFIG_DIR (known files + any corrupted backups).
 * wallet.json is ALWAYS excluded.
 */
async function listRemovableFiles(): Promise<string[]> {
  const removable: string[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(CONFIG_DIR);
  } catch {
    return [];
  }

  for (const entry of entries) {
    // Never remove wallet
    if (entry === "wallet.json") continue;

    // Known files
    if (KNOWN_REMOVABLE_FILES.includes(entry)) {
      removable.push(entry);
      continue;
    }

    // Corrupted config backups (config.json.corrupted.*)
    if (entry.startsWith("config.json.corrupted.")) {
      removable.push(entry);
      continue;
    }

    // OpenClaw config backups (openclaw.json.backup.*)
    if (entry.startsWith("openclaw.json.backup.")) {
      removable.push(entry);
      continue;
    }
  }

  return removable;
}

/**
 * Stop and uninstall the platform service (launchd on macOS, systemd on Linux).
 */
async function removeService(): Promise<string[]> {
  const actions: string[] = [];
  const platform = os.platform();

  if (platform === "darwin") {
    // Stop proxy via PID if running
    await stopProxyViaPid();

    // Unload and remove launchd plist
    if (await fileExists(LAUNCHD_PLIST_PATH)) {
      try {
        execSync(`launchctl unload ${LAUNCHD_PLIST_PATH}`, { stdio: "ignore" });
        actions.push("Unloaded launchd service");
      } catch {
        // May not be loaded
      }
      await fs.unlink(LAUNCHD_PLIST_PATH);
      actions.push(`Removed ${LAUNCHD_PLIST_PATH}`);
    }
  } else if (platform === "linux") {
    await stopProxyViaPid();

    if (await fileExists(SYSTEMD_UNIT_PATH)) {
      try {
        execSync(`systemctl --user stop ${SYSTEMD_UNIT_NAME}`, { stdio: "ignore" });
        execSync(`systemctl --user disable ${SYSTEMD_UNIT_NAME}`, { stdio: "ignore" });
        actions.push("Stopped and disabled systemd service");
      } catch {
        // May not be running
      }
      await fs.unlink(SYSTEMD_UNIT_PATH);
      try {
        execSync("systemctl --user daemon-reload", { stdio: "ignore" });
      } catch {
        // best effort
      }
      actions.push(`Removed ${SYSTEMD_UNIT_PATH}`);
    }
  }

  return actions;
}

async function stopProxyViaPid(): Promise<void> {
  try {
    const raw = await fs.readFile(PID_PATH, "utf-8");
    const pid = parseInt(raw.trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        // Wait briefly for clean shutdown
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 100));
          try {
            process.kill(pid, 0);
          } catch {
            break; // process exited
          }
        }
      } catch {
        // Process may not exist
      }
    }
  } catch {
    // PID file may not exist
  }
}

/**
 * Remove token2chat provider from OpenClaw global config (openclaw.json).
 * Also removes token2chat entries from agents.defaults.model.fallbacks.
 */
async function removeOpenClawGlobalConfig(): Promise<boolean> {
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    let changed = false;

    // Remove models.providers.token2chat
    if (config?.models?.providers?.token2chat) {
      delete config.models.providers.token2chat;
      changed = true;

      // If providers is now empty, clean up
      if (Object.keys(config.models.providers).length === 0) {
        delete config.models.providers;
      }
      // If models only had providers, clean up
      if (config.models && Object.keys(config.models).length === 0) {
        delete config.models;
      }
    }

    // Remove token2chat entries from agents.defaults.model.fallbacks
    const fallbacks = config?.agents?.defaults?.model?.fallbacks;
    if (Array.isArray(fallbacks)) {
      const filtered = fallbacks.filter(
        (f: string) => typeof f !== "string" || !f.startsWith("token2chat/"),
      );
      if (filtered.length !== fallbacks.length) {
        config.agents.defaults.model.fallbacks = filtered;
        changed = true;
      }
    }

    if (changed) {
      await fs.writeFile(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
    }
    return changed;
  } catch {
    return false;
  }
}

/**
 * Remove token2chat provider from all per-agent models.json files
 * and token2chat auth profiles from auth-profiles.json files.
 *
 * Scans ~/.openclaw/agents/{name}/models.json and ~/.openclaw/agents/{name}/agent/auth-profiles.json
 */
async function removeOpenClawAgentConfigs(): Promise<string[]> {
  const actions: string[] = [];
  const agentsDir = path.join(os.homedir(), ".openclaw", "agents");

  let agents: string[];
  try {
    agents = await fs.readdir(agentsDir);
  } catch {
    return actions;
  }

  for (const agent of agents) {
    // Clean models.json at both levels: agents/{name}/models.json AND agents/{name}/agent/models.json
    const modelsPaths = [
      path.join(agentsDir, agent, "models.json"),
      path.join(agentsDir, agent, "agent", "models.json"),
    ];
    for (const modelsPath of modelsPaths) {
      try {
        const raw = await fs.readFile(modelsPath, "utf-8");
        const config = JSON.parse(raw);
        if (config?.providers?.token2chat) {
          delete config.providers.token2chat;
          await fs.writeFile(modelsPath, JSON.stringify(config, null, 2) + "\n");
          const rel = modelsPath.replace(agentsDir + path.sep, "");
          actions.push(`Removed token2chat provider from ${rel}`);
        }
      } catch {
        // File doesn't exist or isn't valid JSON — skip
      }
    }

    // Clean agent/auth-profiles.json
    const authPath = path.join(agentsDir, agent, "agent", "auth-profiles.json");
    try {
      const raw = await fs.readFile(authPath, "utf-8");
      const authConfig = JSON.parse(raw);
      const profiles = authConfig?.profiles;
      if (profiles && typeof profiles === "object") {
        let changed = false;
        for (const key of Object.keys(profiles)) {
          if (key === "token2chat:local" || profiles[key]?.provider === "token2chat") {
            delete profiles[key];
            changed = true;
          }
        }
        if (changed) {
          await fs.writeFile(authPath, JSON.stringify(authConfig, null, 2) + "\n");
          actions.push(`Removed token2chat auth profile from ${agent}/agent/auth-profiles.json`);
        }
      }
    } catch {
      // skip
    }
  }

  return actions;
}

/**
 * Remove all token2chat integration from OpenClaw:
 * - Global config (models.providers + fallbacks)
 * - Per-agent models.json
 * - Per-agent auth-profiles.json
 */
async function removeOpenClawIntegration(): Promise<{ global: boolean; agentActions: string[] }> {
  const global = await removeOpenClawGlobalConfig();
  const agentActions = await removeOpenClawAgentConfigs();
  return { global, agentActions };
}

export async function uninstallCommand(opts: UninstallOptions): Promise<void> {
  const platform = os.platform();

  // Gather what will be affected
  const removableFiles = await listRemovableFiles();
  const hasService =
    platform === "darwin"
      ? await fileExists(LAUNCHD_PLIST_PATH)
      : platform === "linux"
        ? await fileExists(SYSTEMD_UNIT_PATH)
        : false;
  const hasPid = await fileExists(PID_PATH);

  const hasAnything = removableFiles.length > 0 || hasService || hasPid;

  if (!hasAnything && !opts.removeOpenclaw) {
    console.log("\n✅ Nothing to uninstall. t2c is not configured on this system.\n");
    return;
  }

  // ── Dry-run listing ────────────────────────────────

  console.log("\n🗑️  t2c uninstall — the following will be removed:\n");

  if (hasService || hasPid) {
    if (platform === "darwin") {
      console.log("  📦 Service: launchd service (com.token2chat.proxy)");
    } else if (platform === "linux") {
      console.log("  📦 Service: systemd user service (t2c-proxy)");
    }
    if (hasPid) {
      console.log("  🔄 Running proxy process will be stopped");
    }
  }

  if (removableFiles.length > 0) {
    console.log(`\n  📁 Files in ${CONFIG_DIR}:`);
    for (const f of removableFiles) {
      console.log(`     - ${f}`);
    }
  }

  if (opts.removeOpenclaw) {
    console.log("\n  🔌 OpenClaw:");
    console.log("     - token2chat provider from openclaw.json");
    console.log("     - token2chat fallbacks from agents.defaults");
    console.log("     - token2chat provider from per-agent models.json");
    console.log("     - token2chat auth profiles from per-agent auth-profiles.json");
  }

  // Always show wallet preservation notice
  console.log(`\n  🔒 wallet.json will be preserved (your funds are safe)\n`);

  // ── Confirmation ───────────────────────────────────

  if (!opts.yes) {
    const proceed = await confirm("Proceed with uninstall? (yes/no): ");
    if (!proceed) {
      console.log("\nAborted. Nothing was changed.\n");
      return;
    }
  }

  // ── Execute removal ────────────────────────────────

  // 1. Stop & remove service
  const serviceActions = await removeService();
  for (const action of serviceActions) {
    console.log(`  ✓ ${action}`);
  }

  // 2. Remove files from CONFIG_DIR
  for (const filename of removableFiles) {
    const fullPath = path.join(CONFIG_DIR, filename);
    try {
      await fs.unlink(fullPath);
      console.log(`  ✓ Removed ${filename}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`  ✗ Failed to remove ${filename}: ${(e as Error).message}`);
      }
    }
  }

  // 3. Remove OpenClaw integration if requested
  if (opts.removeOpenclaw) {
    const { global: globalRemoved, agentActions } = await removeOpenClawIntegration();
    if (globalRemoved) {
      console.log("  ✓ Removed token2chat from OpenClaw global config");
    } else {
      console.log("  ℹ OpenClaw: no token2chat provider in global config");
    }
    for (const action of agentActions) {
      console.log(`  ✓ ${action}`);
    }
    if (!globalRemoved && agentActions.length === 0) {
      console.log("  ℹ OpenClaw: no token2chat residue found");
    }
  }

  console.log("\n✅ Uninstall complete. Your wallet.json has been preserved.\n");
}
