/**
 * t2c init - Core initialization command
 *
 * Uses sensible defaults for gate/mint/port/wallet.
 * No interactive prompts — just validate connectivity and create wallet.
 */
import {
  saveConfig,
  configExists,
  resolveHome,
  loadConfig,
  checkGateHealth,
  checkMintHealth,
  DEFAULT_CONFIG,
  formatUnits,
  type T2CConfig,
} from "../config.js";
import { CashuStore } from "../cashu-store.js";

export async function initCommand(opts?: { force?: boolean }): Promise<void> {
  console.log("\n🎟️  Token2Chat Init\n");

  const hasConfig = await configExists();

  if (hasConfig && !opts?.force) {
    const existing = await loadConfig();
    console.log("Already initialized.\n");
    console.log(`  Gate:   ${existing.gateUrl}`);
    console.log(`  Mint:   ${existing.mintUrl}`);
    console.log(`  Port:   ${existing.proxyPort}`);
    console.log(`  Wallet: ${existing.walletPath}`);
    console.log("\nRun 't2c init --force' to reinitialize.\n");
    return;
  }

  const config: T2CConfig = { ...DEFAULT_CONFIG };

  // Check Gate connectivity
  process.stdout.write("  Checking Gate...  ");
  const gateOk = await checkGateHealth(config.gateUrl);
  console.log(gateOk ? "✅" : "❌ Unreachable (will retry on first use)");

  // Check Mint connectivity
  process.stdout.write("  Checking Mint...  ");
  const mintOk = await checkMintHealth(config.mintUrl);
  console.log(mintOk ? "✅" : "❌ Unreachable (will retry on first use)");

  // Save config
  await saveConfig(config);
  console.log("\n  Config saved to ~/.t2c/config.json");

  // Initialize wallet
  try {
    const resolvedPath = resolveHome(config.walletPath);
    const wallet = await CashuStore.load(resolvedPath, config.mintUrl);
    console.log(`  Wallet initialized (balance: ${formatUnits(wallet.balance)})`);
  } catch (e) {
    console.log(`  ⚠️  Wallet init failed: ${e}`);
  }

  // Next steps
  console.log("\n📋 Next steps:\n");
  console.log("  1. Connect to your AI tool:");
  console.log("     t2c connect openclaw    # For OpenClaw");
  console.log("     t2c connect env         # For other tools\n");
  console.log("  2. Add funds:");
  console.log("     t2c mint\n");
}
