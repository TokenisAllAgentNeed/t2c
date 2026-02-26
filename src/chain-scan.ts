/**
 * chain-scan — Scan EVM chains for recent USDC/USDT deposits.
 *
 * Uses eth_call (balanceOf) + binary search + eth_getLogs to find
 * deposit transactions without requiring an indexer or API key.
 */

// ── Types ──────────────────────────────────────────────────────

export interface ChainConfig {
  name: string;       // e.g. "Base", "Ethereum"
  rpcUrl: string;
  tokens: TokenConfig[];
}

export interface TokenConfig {
  symbol: string;     // "USDC" or "USDT"
  address: string;    // ERC20 contract address
  decimals: number;
}

export interface DepositTx {
  txHash: string;
  amount: number;      // base units (e.g. 1000000 = 1 USDC)
  decimals: number;
  token: string;       // "USDC" or "USDT"
  chain: string;       // "base", "ethereum", etc.
  blockNumber: number;
}

// ── Chain configs ──────────────────────────────────────────────

export const CHAIN_CONFIGS: ChainConfig[] = [
  {
    name: "Base",
    rpcUrl: "https://base.drpc.org",
    tokens: [
      { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      { symbol: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
    ],
  },
  {
    name: "Ethereum",
    rpcUrl: "https://eth.drpc.org",
    tokens: [
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    ],
  },
  {
    name: "Arbitrum",
    rpcUrl: "https://arbitrum.drpc.org",
    tokens: [
      { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
      { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    ],
  },
];

// ERC20 Transfer(address,address,uint256) event topic
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// balanceOf(address) selector
const BALANCE_OF_SELECTOR = "0x70a08231";

// Max blocks to look back for binary search
const MAX_LOOKBACK = 100_000;

// Block range for getLogs (keep tight for public RPCs)
const LOG_RANGE = 500;

// ── RPC helpers ────────────────────────────────────────────────

function padAddress(addr: string): string {
  return "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

function hexToNumber(hex: string): number {
  return Number(BigInt(hex));
}

function numberToHex(n: number): string {
  return "0x" + n.toString(16);
}

// ── Balance query ──────────────────────────────────────────────

export async function getBalance(
  rpcUrl: string,
  tokenAddress: string,
  depositAddress: string,
  blockNumber?: number,
): Promise<bigint> {
  const data = BALANCE_OF_SELECTOR + padAddress(depositAddress).slice(2);
  const block = blockNumber !== undefined ? numberToHex(blockNumber) : "latest";
  const result = await rpcCall(rpcUrl, "eth_call", [
    { to: tokenAddress, data },
    block,
  ]);
  if (!result || result === "0x") return 0n;
  return BigInt(result as string);
}

// ── Binary search for balance change block ─────────────────────

async function findBalanceChangeBlock(
  rpcUrl: string,
  tokenAddress: string,
  depositAddress: string,
  latestBlock: number,
  currentBalance: bigint,
): Promise<number> {
  let lo = Math.max(0, latestBlock - MAX_LOOKBACK);
  let hi = latestBlock;

  // Check if balance was different at lookback point
  const oldBalance = await getBalance(rpcUrl, tokenAddress, depositAddress, lo);
  if (oldBalance === currentBalance) {
    // Balance hasn't changed in lookback range — return lo as best guess
    return lo;
  }

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const bal = await getBalance(rpcUrl, tokenAddress, depositAddress, mid);
    if (bal === currentBalance) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return hi;
}

// ── Get logs for deposit transactions ──────────────────────────

interface LogEntry {
  transactionHash: string;
  blockNumber: string;
  data: string;
  topics: string[];
}

async function getTransferLogs(
  rpcUrl: string,
  tokenAddress: string,
  depositAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<LogEntry[]> {
  const result = await rpcCall(rpcUrl, "eth_getLogs", [{
    address: tokenAddress,
    topics: [TRANSFER_TOPIC, null, padAddress(depositAddress)],
    fromBlock: numberToHex(fromBlock),
    toBlock: numberToHex(toBlock),
  }]);
  return (result as LogEntry[]) || [];
}

// ── Main scan function ─────────────────────────────────────────

export async function scanDeposits(
  depositAddress: string,
  chains: ChainConfig[],
): Promise<DepositTx[]> {
  const allDeposits: DepositTx[] = [];

  for (const chain of chains) {
    for (const token of chain.tokens) {
      try {
        // 1. Check current balance
        const balance = await getBalance(chain.rpcUrl, token.address, depositAddress);
        if (balance === 0n) continue;

        // 2. Get latest block number
        const latestHex = (await rpcCall(chain.rpcUrl, "eth_blockNumber", [])) as string;
        const latestBlock = hexToNumber(latestHex);

        // 3. Binary search for balance change block
        const changeBlock = await findBalanceChangeBlock(
          chain.rpcUrl, token.address, depositAddress, latestBlock, balance,
        );

        // 4. Get logs in tight range around change block
        const fromBlock = Math.max(0, changeBlock - LOG_RANGE);
        const toBlock = Math.min(latestBlock, changeBlock + LOG_RANGE);
        const logs = await getTransferLogs(
          chain.rpcUrl, token.address, depositAddress, fromBlock, toBlock,
        );

        // 5. Parse deposits from logs
        for (const log of logs) {
          const amount = Number(BigInt(log.data));
          allDeposits.push({
            txHash: log.transactionHash,
            amount,
            decimals: token.decimals,
            token: token.symbol,
            chain: chain.name,
            blockNumber: hexToNumber(log.blockNumber),
          });
        }
      } catch {
        // RPC error for this chain+token — skip silently
      }
    }
  }

  return allDeposits;
}
