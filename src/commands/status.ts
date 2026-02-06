/**
 * t2c status - Show service status and wallet balance
 */
import { loadConfig, resolveHome, configExists, checkGateHealth, formatUnits } from "../config.js";
import { CashuStore } from "../cashu-store.js";

interface StatusOptions {
  json?: boolean;
}

interface StatusResult {
  configured: boolean;
  proxyRunning: boolean;
  proxyUrl: string | null;
  wallet: {
    path: string;
    balance: number;
    proofs: number;
  } | null;
  gate: {
    url: string;
    reachable: boolean;
  };
  mint: {
    url: string;
  };
}

async function checkProxy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as Record<string, unknown>;
    return typeof data.ok === "boolean" && data.ok === true;
  } catch {
    return false;
  }
}

export async function statusCommand(opts: StatusOptions): Promise<void> {
  const hasConfig = await configExists();
  const config = await loadConfig();

  const proxyRunning = await checkProxy(config.proxyPort);
  const gateReachable = await checkGateHealth(config.gateUrl);

  let walletInfo: StatusResult["wallet"] = null;
  try {
    const walletPath = resolveHome(config.walletPath);
    const wallet = await CashuStore.load(walletPath, config.mintUrl);
    walletInfo = {
      path: config.walletPath,
      balance: wallet.balance,
      proofs: wallet.proofCount,
    };
  } catch {
    // Wallet doesn't exist yet
  }

  const result: StatusResult = {
    configured: hasConfig,
    proxyRunning,
    proxyUrl: proxyRunning ? `http://127.0.0.1:${config.proxyPort}` : null,
    wallet: walletInfo,
    gate: {
      url: config.gateUrl,
      reachable: gateReachable,
    },
    mint: {
      url: config.mintUrl,
    },
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Pretty print
  console.log("\n🎟️  Token2Chat Status\n");

  // Config
  console.log(`Config:     ${hasConfig ? "✅ Configured" : "⚠️  Not configured (run 't2c setup')"}`);

  // Proxy
  if (proxyRunning) {
    console.log(`Proxy:      ✅ Running on http://127.0.0.1:${config.proxyPort}`);
  } else {
    console.log(`Proxy:      ❌ Not running (run 't2c service start')`);
  }

  // Gate
  console.log(`Gate:       ${gateReachable ? "✅" : "❌"} ${config.gateUrl}`);

  // Mint
  console.log(`Mint:       ${config.mintUrl}`);

  // Wallet
  console.log("");
  if (walletInfo) {
    const status = walletInfo.balance > 0 ? "✅" : "⚠️";
    console.log(`Wallet:     ${status} ${formatUnits(walletInfo.balance)} (${walletInfo.proofs} proofs)`);
    if (walletInfo.balance === 0) {
      console.log(`            Run 't2c mint' to add funds`);
    } else if (walletInfo.balance < config.lowBalanceThreshold) {
      console.log(`            ⚠️  Low balance - consider adding funds`);
    }
  } else {
    console.log(`Wallet:     ⚠️  No wallet found (run 't2c setup')`);
  }

  console.log("");
}
