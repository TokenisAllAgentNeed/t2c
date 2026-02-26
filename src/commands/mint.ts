/**
 * t2c mint - Add funds to wallet
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, resolveHome, CONFIG_DIR, formatUnits } from "../config.js";
import { CashuStore } from "../cashu-store.js";
import { scanDeposits, CHAIN_CONFIGS, type DepositTx } from "../chain-scan.js";

export interface MintOptions {
  check?: boolean;
  scan?: boolean;
  usdc?: boolean;
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

// 1 USDC (1000000 base units) = 100000 ecash units
const USDC_RATE = 100_000;
const USDC_BASE = 1_000_000;

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

function formatTokenAmount(amount: number, decimals: number): string {
  const value = amount / Math.pow(10, decimals);
  return value.toFixed(decimals);
}

function baseUnitsToEcashUnits(baseUnits: number, decimals: number): number {
  // baseUnits / 10^decimals gives token amount (e.g. 1.0 USDC)
  // multiply by USDC_RATE to get ecash units
  return Math.floor((baseUnits / Math.pow(10, decimals)) * USDC_RATE);
}

// ── --scan: Scan chains for deposits ───────────────────────────

async function handleScan(mintUrl: string): Promise<DepositTx[]> {
  const depositAddress = await fetchDepositAddress(mintUrl);
  const shortAddr = depositAddress.slice(0, 6) + "..." + depositAddress.slice(-4);

  console.log(`\n🔍 Scanning chains for deposits to ${shortAddr}\n`);

  const deposits = await scanDeposits(depositAddress, CHAIN_CONFIGS);

  // Group by chain
  const byChain = new Map<string, DepositTx[]>();
  for (const chain of CHAIN_CONFIGS) {
    byChain.set(chain.name, []);
  }
  for (const d of deposits) {
    const list = byChain.get(d.chain);
    if (list) list.push(d);
  }

  for (const [chainName, txs] of byChain) {
    if (txs.length > 0) {
      console.log(`  ${chainName}:`);
      for (const tx of txs) {
        const shortTx = tx.txHash.slice(0, 10) + "..." + tx.txHash.slice(-6);
        console.log(`    ✅ ${formatTokenAmount(tx.amount, tx.decimals)} ${tx.token} — tx ${shortTx} (block ${tx.blockNumber})`);
      }
    } else {
      console.log(`  ${chainName}: no deposits found`);
    }
    console.log("");
  }

  const chainCount = new Set(deposits.map((d) => d.chain)).size;
  console.log(`Found ${deposits.length} deposit(s) on ${chainCount} chain(s).\n`);

  return deposits;
}

// ── --usdc: Full deposit → mint flow ───────────────────────────

async function handleUsdc(wallet: CashuStore, mintUrl: string): Promise<void> {
  // 1. Scan for deposits
  const deposits = await handleScan(mintUrl);

  if (deposits.length === 0) {
    console.log("No deposits to mint from. Send USDC/USDT first.\n");
    return;
  }

  // 2. Select deposit (auto-select if only one)
  let selected: DepositTx;
  if (deposits.length === 1) {
    selected = deposits[0];
    console.log(`Auto-selecting: ${formatTokenAmount(selected.amount, selected.decimals)} ${selected.token} on ${selected.chain}\n`);
  } else {
    console.log("Multiple deposits found. Select one:\n");
    for (let i = 0; i < deposits.length; i++) {
      const d = deposits[i];
      console.log(`  [${i + 1}] ${formatTokenAmount(d.amount, d.decimals)} ${d.token} on ${d.chain} (tx ${d.txHash.slice(0, 10)}...)`);
    }
    console.log("");

    // Read selection from stdin
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("Select deposit [1]: ", (ans) => {
        rl.close();
        resolve(ans.trim() || "1");
      });
    });

    const idx = parseInt(answer, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= deposits.length) {
      console.error("Invalid selection.");
      process.exit(1);
      return;
    }
    selected = deposits[idx];
  }

  // 3. Calculate amounts
  // ecash units for minting proofs (1 USDC = 100,000 units)
  const ecashUnits = baseUnitsToEcashUnits(selected.amount, selected.decimals);
  // token amount for mint quote (1 USDC = 1.0, mint multiplies by USDC_RATE internally)
  const tokenAmount = selected.amount / Math.pow(10, selected.decimals);
  if (ecashUnits <= 0) {
    console.error("Deposit amount too small to mint.");
    process.exit(1);
    return;
  }

  console.log(`Requesting mint quote for ${formatUnits(ecashUnits)}...\n`);

  // 4. Get quote from mint (amount in token units, e.g. 1 = $1.00)
  const quoteRes = await fetch(`${mintUrl}/v1/mint/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: tokenAmount,
      chain: selected.chain,
      token: selected.token,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!quoteRes.ok) {
    const body = await quoteRes.text().catch(() => "");
    console.error(`Failed to get mint quote (${quoteRes.status}): ${body}`);
    process.exit(1);
    return;
  }

  const quote = (await quoteRes.json()) as { quote: string };

  // 5. Mint from deposit
  console.log(`Minting ${formatUnits(ecashUnits)} from ${selected.token} deposit...\n`);

  try {
    const minted = await wallet.mintFromDeposit(quote.quote, selected.txHash, ecashUnits);
    console.log(`🎉 Successfully minted ${formatUnits(minted)}`);
    console.log(`New balance: ${formatUnits(wallet.balance)}\n`);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`Failed to mint from deposit: ${errMsg}`);
    process.exit(1);
    return;
  }
}

// ── Main command ───────────────────────────────────────────────

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

  // --scan: just scan and display
  if (opts.scan) {
    await handleScan(config.mintUrl);
    return;
  }

  // --usdc: full deposit → mint flow
  if (opts.usdc) {
    await handleUsdc(wallet, config.mintUrl);
    return;
  }

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
