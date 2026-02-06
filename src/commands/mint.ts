/**
 * t2c mint - Add funds to wallet
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, resolveHome, CONFIG_DIR, formatUnits } from "../config.js";
import { CashuStore } from "../cashu-store.js";

interface MintOptions {
  check?: boolean;
}

// Fallback deposit address (Mint's EVM address for USDC/USDT)
// This is used if /v1/info endpoint doesn't provide a deposit address
const FALLBACK_DEPOSIT_ADDRESS = "0xDC20821A78C4e1c586BE317e87A12f690E94E6c6";

const SUPPORTED_CHAINS = [
  { name: "Ethereum", chainId: 1, tokens: ["USDC", "USDT"] },
  { name: "Base", chainId: 8453, tokens: ["USDC", "USDT"] },
  { name: "Arbitrum", chainId: 42161, tokens: ["USDC", "USDT"] },
  { name: "BNB Chain", chainId: 56, tokens: ["USDC", "USDT"] },
];

// Path to store pending quotes
const PENDING_QUOTES_PATH = path.join(CONFIG_DIR, "pending-quotes.json");

interface PendingQuote {
  quote: string;
  amount: number;
  request: string;
  createdAt: number;
}

interface PendingQuotesFile {
  quotes: PendingQuote[];
}

async function loadPendingQuotes(): Promise<PendingQuotesFile> {
  try {
    const raw = await fs.readFile(PENDING_QUOTES_PATH, "utf-8");
    return JSON.parse(raw) as PendingQuotesFile;
  } catch {
    return { quotes: [] };
  }
}

async function savePendingQuotes(data: PendingQuotesFile): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(PENDING_QUOTES_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function fetchDepositAddress(mintUrl: string): Promise<string> {
  try {
    const res = await fetch(`${mintUrl}/v1/info`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { deposit_address?: string; depositAddress?: string };
      if (data.deposit_address) return data.deposit_address;
      if (data.depositAddress) return data.depositAddress;
    }
  } catch {
    // Fall through to default
  }
  return FALLBACK_DEPOSIT_ADDRESS;
}

export async function mintCommand(
  amount: string | undefined,
  opts: MintOptions,
): Promise<void> {
  const config = await loadConfig();
  const walletPath = resolveHome(config.walletPath);

  let wallet: CashuStore;
  try {
    wallet = await CashuStore.load(walletPath, config.mintUrl);
  } catch (e) {
    console.error(`Failed to load wallet: ${e}`);
    console.error("Run 't2c setup' first.");
    process.exit(1);
  }

  const currentBalance = wallet.balance;

  console.log("\n🎟️  Token2Chat Funding\n");
  console.log(`Current balance: ${formatUnits(currentBalance)}\n`);

  if (opts.check) {
    // Check for pending Lightning quotes and mint paid ones
    console.log("Checking pending Lightning quotes...\n");

    const pendingData = await loadPendingQuotes();
    if (pendingData.quotes.length === 0) {
      console.log("No pending quotes found.");
      console.log("Use 't2c mint <amount>' to create a Lightning invoice.\n");
      return;
    }

    let mintedTotal = 0;
    const stillPending: PendingQuote[] = [];
    const expired: PendingQuote[] = [];
    const now = Date.now();
    const QUOTE_TTL_MS = 60 * 60 * 1000; // 1 hour

    for (const pq of pendingData.quotes) {
      // Skip expired quotes (older than 1 hour)
      if (now - pq.createdAt > QUOTE_TTL_MS) {
        expired.push(pq);
        continue;
      }

      try {
        const minted = await wallet.mintFromQuote(pq.quote, pq.amount);
        console.log(`✅ Minted ${formatUnits(minted)} from quote ${pq.quote.slice(0, 8)}...`);
        mintedTotal += minted;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.includes("not paid") || errMsg.includes("UNPAID")) {
          stillPending.push(pq);
        } else if (errMsg.includes("ISSUED") || errMsg.includes("already")) {
          // Already minted, skip
          console.log(`ℹ️  Quote ${pq.quote.slice(0, 8)}... already processed`);
        } else {
          console.warn(`⚠️  Error checking quote ${pq.quote.slice(0, 8)}...: ${errMsg}`);
          stillPending.push(pq);
        }
      }
    }

    // Update pending quotes file
    await savePendingQuotes({ quotes: stillPending });

    if (mintedTotal > 0) {
      console.log(`\n🎉 Total minted: ${formatUnits(mintedTotal)}`);
      console.log(`New balance: ${formatUnits(wallet.balance)}\n`);
    } else if (stillPending.length > 0) {
      console.log(`\n${stillPending.length} quote(s) still awaiting payment.`);
      console.log("Pay the Lightning invoice and run 't2c mint --check' again.\n");
    } else {
      console.log("No paid quotes found.\n");
    }

    if (expired.length > 0) {
      console.log(`ℹ️  ${expired.length} expired quote(s) removed.\n`);
    }
    return;
  }

  // Lightning funding (if amount specified)
  if (amount) {
    const units = parseInt(amount, 10);
    if (isNaN(units) || units <= 0) {
      console.error("Invalid amount. Specify units to fund via Lightning.");
      process.exit(1);
    }

    console.log(`⚡ Creating Lightning invoice for ${formatUnits(units)}...\n`);
    try {
      const quote = await wallet.createMintQuote(units);

      // Save to pending quotes
      const pendingData = await loadPendingQuotes();
      pendingData.quotes.push({
        quote: quote.quote,
        amount: units,
        request: quote.request,
        createdAt: Date.now(),
      });
      await savePendingQuotes(pendingData);

      console.log("Pay this Lightning invoice:\n");
      console.log(`  ${quote.request}\n`);
      console.log(`Quote ID: ${quote.quote}`);
      console.log("\nAfter paying, run 't2c mint --check' to mint your tokens.\n");
    } catch (e) {
      console.error(`Failed to create Lightning invoice: ${e}`);
      process.exit(1);
    }
    return;
  }

  // Show deposit instructions (EVM stablecoins)
  const depositAddress = await fetchDepositAddress(config.mintUrl);

  console.log("Option 1: Lightning (recommended)\n");
  console.log("  t2c mint <amount>         Create a Lightning invoice\n");

  console.log("Option 2: EVM Stablecoins\n");
  console.log("  Send USDC or USDT to:\n");
  console.log(`  ${depositAddress}\n`);
  console.log("  Supported chains:");
  for (const chain of SUPPORTED_CHAINS) {
    console.log(`    • ${chain.name} (${chain.tokens.join(", ")})`);
  }

  console.log("\n💡 Tips:");
  console.log("  • Lightning deposits are instant");
  console.log("  • EVM deposits: 100,000 units = $1.00 USD");
  console.log("  • Minimum deposit: $1.00 USD\n");
}
