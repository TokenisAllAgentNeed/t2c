/**
 * t2c recover - Recover failed tokens
 */
import {
  loadConfig,
  resolveHome,
  FAILED_TOKENS_PATH,
  loadFailedTokens,
  saveFailedTokens,
  formatUnits,
  type FailedToken,
} from "../config.js";
import { CashuStore } from "../cashu-store.js";

export async function recoverCommand(): Promise<void> {
  const config = await loadConfig();
  const walletPath = resolveHome(config.walletPath);

  console.log("\n🔧 Token Recovery\n");

  const failedData = await loadFailedTokens();

  if (failedData.tokens.length === 0) {
    console.log("No failed tokens to recover. ✨\n");
    return;
  }

  console.log(`Found ${failedData.tokens.length} failed token(s) to recover.\n`);

  let wallet: CashuStore;
  try {
    wallet = await CashuStore.load(walletPath, config.mintUrl);
  } catch (e) {
    console.error(`Failed to load wallet: ${e}`);
    console.error("Run 't2c setup' first.");
    process.exit(1);
  }

  const stillFailed: FailedToken[] = [];
  let recoveredTotal = 0;

  for (const ft of failedData.tokens) {
    const shortToken = ft.token.slice(0, 20) + "...";
    const date = new Date(ft.timestamp).toLocaleString();

    console.log(`Attempting to recover ${ft.type} token from ${date}...`);

    try {
      const amount = await wallet.receiveToken(ft.token);
      console.log(`  ✅ Recovered ${formatUnits(amount)}\n`);
      recoveredTotal += amount;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.log(`  ❌ Failed: ${errMsg}\n`);
      stillFailed.push({
        ...ft,
        error: errMsg,
        timestamp: Date.now(),
      });
    }
  }

  // Save remaining failed tokens
  await saveFailedTokens({ tokens: stillFailed });

  console.log("─".repeat(40));

  if (recoveredTotal > 0) {
    console.log(`\n🎉 Recovered total: ${formatUnits(recoveredTotal)}`);
    console.log(`New wallet balance: ${formatUnits(wallet.balance)}\n`);
  }

  if (stillFailed.length > 0) {
    console.log(`\n⚠️  ${stillFailed.length} token(s) still failed.`);
    console.log(`   Saved to: ${FAILED_TOKENS_PATH}`);
    console.log("   You can manually import these tokens or contact support.\n");
  } else if (recoveredTotal > 0) {
    console.log("All tokens recovered successfully! ✨\n");
  }
}
