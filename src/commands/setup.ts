/**
 * t2c setup - Interactive setup wizard
 */
import * as readline from "node:readline";
import {
  loadConfig,
  saveConfig,
  configExists,
  resolveHome,
  checkGateHealth,
  checkMintHealth,
  DEFAULT_CONFIG,
  formatUnits,
  type T2CConfig,
} from "../config.js";
import { CashuStore } from "../cashu-store.js";

function createPrompt(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

async function confirm(rl: readline.Interface, prompt: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await question(rl, `${prompt} ${suffix} `);
  if (answer === "") return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

export async function setupCommand(): Promise<void> {
  console.log("\n🎟️  Token2Chat Setup\n");
  console.log("Pay-per-request LLM access via Cashu ecash.\n");

  const hasConfig = await configExists();
  const existingConfig = await loadConfig();
  const rl = createPrompt();

  try {
    // Check if already configured
    if (hasConfig) {
      const reconfigure = await confirm(
        rl,
        "Configuration already exists. Reconfigure?",
        false,
      );
      if (!reconfigure) {
        console.log("\nSetup cancelled. Run 't2c status' to see current configuration.\n");
        return;
      }
    }

    // Step 1: Gate URL
    console.log("Step 1/4: Gate URL");
    console.log(`  The Gate processes LLM requests and handles ecash payments.`);
    const gateUrlAnswer = await question(
      rl,
      `  Gate URL [${existingConfig.gateUrl}]: `,
    );
    const gateUrl = gateUrlAnswer || existingConfig.gateUrl;

    // Verify Gate
    process.stdout.write("  Checking Gate... ");
    const gateOk = await checkGateHealth(gateUrl);
    if (gateOk) {
      console.log("✅ Reachable");
    } else {
      console.log("❌ Unreachable");
      const proceed = await confirm(rl, "  Continue anyway?", false);
      if (!proceed) {
        console.log("\nSetup cancelled.\n");
        return;
      }
    }

    // Step 2: Mint URL
    console.log("\nStep 2/4: Mint URL");
    console.log(`  The Mint issues ecash tokens for payments.`);
    const mintUrlAnswer = await question(
      rl,
      `  Mint URL [${existingConfig.mintUrl}]: `,
    );
    const mintUrl = mintUrlAnswer || existingConfig.mintUrl;

    // Verify Mint
    process.stdout.write("  Checking Mint... ");
    const mintOk = await checkMintHealth(mintUrl);
    if (mintOk) {
      console.log("✅ Reachable");
    } else {
      console.log("❌ Unreachable");
      const proceed = await confirm(rl, "  Continue anyway?", false);
      if (!proceed) {
        console.log("\nSetup cancelled.\n");
        return;
      }
    }

    // Step 3: Proxy port
    console.log("\nStep 3/4: Proxy Port");
    console.log(`  The local proxy runs on this port for AI tools to connect.`);
    const portAnswer = await question(
      rl,
      `  Port [${existingConfig.proxyPort}]: `,
    );
    const proxyPort = portAnswer ? parseInt(portAnswer, 10) : existingConfig.proxyPort;
    if (isNaN(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      console.log("  ❌ Invalid port number");
      return;
    }

    // Step 4: Wallet path
    console.log("\nStep 4/4: Wallet Path");
    console.log(`  Your ecash wallet will be stored here.`);
    const walletPathAnswer = await question(
      rl,
      `  Wallet path [${existingConfig.walletPath}]: `,
    );
    const walletPath = walletPathAnswer || existingConfig.walletPath;

    // Create config
    const config: T2CConfig = {
      gateUrl,
      mintUrl,
      walletPath,
      proxyPort,
      lowBalanceThreshold: DEFAULT_CONFIG.lowBalanceThreshold,
      autoDiscover: DEFAULT_CONFIG.autoDiscover,
      discoveryUrl: DEFAULT_CONFIG.discoveryUrl,
    };

    // Save config
    await saveConfig(config);
    console.log("\n✅ Configuration saved to ~/.t2c/config.json");

    // Initialize wallet
    try {
      const resolvedPath = resolveHome(walletPath);
      const wallet = await CashuStore.load(resolvedPath, mintUrl);
      console.log(`✅ Wallet initialized (balance: ${formatUnits(wallet.balance)})`);
    } catch (e) {
      console.log(`⚠️  Failed to initialize wallet: ${e}`);
    }

    // Next steps
    console.log("\n📋 Next steps:\n");
    console.log("  1. Start the proxy service:");
    console.log("     t2c service start\n");
    console.log("  2. Add funds to your wallet:");
    console.log("     t2c mint\n");
    console.log("  3. Configure your AI tool:");
    console.log("     t2c config openclaw    # For OpenClaw");
    console.log("     t2c config cursor      # For Cursor");
    console.log("     t2c config env         # For other tools\n");
  } finally {
    rl.close();
  }
}
