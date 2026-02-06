/**
 * t2c doctor - Self-diagnostic command
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  configExists,
  checkGateHealth,
  checkMintHealth,
  CONFIG_PATH,
  WALLET_PATH,
  formatUnits,
} from "../config.js";
import { CashuStore } from "../cashu-store.js";

// Platform-specific service paths
const LAUNCHD_PLIST_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  "com.token2chat.proxy.plist"
);
const SYSTEMD_UNIT_PATH = path.join(
  os.homedir(),
  ".config",
  "systemd",
  "user",
  "t2c-proxy.service"
);

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

async function checkConfig(): Promise<CheckResult> {
  const exists = await configExists();
  if (exists) {
    return {
      name: "Config",
      ok: true,
      detail: CONFIG_PATH,
    };
  }
  return {
    name: "Config",
    ok: false,
    detail: "Not found",
    fix: "run 't2c setup'",
  };
}

async function checkWallet(
  config: Awaited<ReturnType<typeof loadConfig>>
): Promise<CheckResult> {
  try {
    const wallet = await CashuStore.load(WALLET_PATH, config.mintUrl);
    return {
      name: "Wallet",
      ok: true,
      detail: `${WALLET_PATH} (${formatUnits(wallet.balance)})`,
    };
  } catch (e) {
    return {
      name: "Wallet",
      ok: false,
      detail: "Not found or unreadable",
      fix: "run 't2c setup'",
    };
  }
}

async function checkProxy(port: number): Promise<CheckResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      return {
        name: "Proxy",
        ok: true,
        detail: `Running on :${port}`,
      };
    }
    return {
      name: "Proxy",
      ok: false,
      detail: `Port ${port} responded but health check failed`,
      fix: "run 't2c service restart'",
    };
  } catch {
    return {
      name: "Proxy",
      ok: false,
      detail: "Not running",
      fix: "run 't2c service start'",
    };
  }
}

async function checkGate(url: string): Promise<CheckResult> {
  const ok = await checkGateHealth(url);
  return {
    name: "Gate",
    ok,
    detail: `${url} (${ok ? "reachable" : "unreachable"})`,
    ...(!ok && { fix: "check your internet connection" }),
  };
}

async function checkMint(url: string): Promise<CheckResult> {
  let ok = await checkMintHealth(url);
  if (!ok) {
    // Try alternate endpoint
    try {
      const res = await fetch(`${url}/info`, { signal: AbortSignal.timeout(5000) });
      ok = res.ok;
    } catch {
      // still unreachable
    }
  }
  return {
    name: "Mint",
    ok,
    detail: `${url} (${ok ? "reachable" : "unreachable"})`,
    ...(!ok && { fix: "check your internet connection" }),
  };
}

async function checkService(): Promise<CheckResult> {
  const platform = os.platform();

  if (platform === "darwin") {
    try {
      await fs.access(LAUNCHD_PLIST_PATH);
      return {
        name: "Service",
        ok: true,
        detail: "Installed (launchd)",
      };
    } catch {
      return {
        name: "Service",
        ok: false,
        detail: "Not installed",
        fix: "run 't2c service install'",
      };
    }
  } else if (platform === "linux") {
    try {
      await fs.access(SYSTEMD_UNIT_PATH);
      return {
        name: "Service",
        ok: true,
        detail: "Installed (systemd)",
      };
    } catch {
      return {
        name: "Service",
        ok: false,
        detail: "Not installed",
        fix: "run 't2c service install'",
      };
    }
  }

  return {
    name: "Service",
    ok: false,
    detail: `Unsupported platform (${platform})`,
  };
}

export async function doctorCommand(): Promise<void> {
  console.log("\n🎟️  Token2Chat Doctor\n");

  const config = await loadConfig();

  // Run all checks
  const results: CheckResult[] = await Promise.all([
    checkConfig(),
    checkWallet(config),
    checkProxy(config.proxyPort),
    checkGate(config.gateUrl),
    checkMint(config.mintUrl),
    checkService(),
  ]);

  // Print results
  for (const result of results) {
    const icon = result.ok ? "✅" : "❌";
    console.log(`${icon} ${result.name.padEnd(10)} ${result.detail}`);
  }

  // Print fixes for failed checks
  const failed = results.filter((r) => !r.ok && r.fix);
  if (failed.length > 0) {
    console.log("\n📋 Suggested fixes:\n");
    for (const result of failed) {
      console.log(`   ${result.name}: ${result.fix}`);
    }
  }

  const allOk = results.every((r) => r.ok);
  if (allOk) {
    console.log("\n✨ All systems operational!\n");
  } else {
    console.log("");
  }
}
