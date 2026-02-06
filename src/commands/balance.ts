/**
 * t2c balance - Simple balance display
 */
import { loadConfig, WALLET_PATH, formatUnits } from "../config.js";
import { CashuStore } from "../cashu-store.js";

interface BalanceOptions {
  json?: boolean;
}

export async function balanceCommand(opts: BalanceOptions): Promise<void> {
  const config = await loadConfig();

  try {
    const wallet = await CashuStore.load(WALLET_PATH, config.mintUrl);

    if (opts.json) {
      console.log(
        JSON.stringify({
          balance: wallet.balance,
          proofs: wallet.proofCount,
        })
      );
    } else {
      console.log(formatUnits(wallet.balance));
    }
  } catch (e) {
    if (opts.json) {
      console.log(JSON.stringify({ error: "Wallet not found" }));
    } else {
      console.error("Wallet not found. Run 't2c setup' first.");
    }
    process.exit(1);
  }
}
