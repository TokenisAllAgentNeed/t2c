/**
 * t2c configuration management
 */
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";

export interface T2CConfig {
  gateUrl: string;
  mintUrl: string;
  walletPath: string;
  proxyPort: number;
  lowBalanceThreshold: number;
  autoDiscover: boolean;
  discoveryUrl: string;
}

// Keep in sync with plugin/src/index.ts
export const DEFAULT_CONFIG: T2CConfig = {
  gateUrl: "https://gate.token2chat.com",
  mintUrl: "https://mint.token2chat.com",
  walletPath: "~/.t2c/wallet.json",
  proxyPort: 10402,
  lowBalanceThreshold: 1000,
  autoDiscover: false,
  discoveryUrl: "https://token2.cash/gates.json",
};

export const CONFIG_DIR = path.join(os.homedir(), ".t2c");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const WALLET_PATH = path.join(CONFIG_DIR, "wallet.json");
export const PID_PATH = path.join(CONFIG_DIR, "proxy.pid");
export const LOG_PATH = path.join(CONFIG_DIR, "proxy.log");
export const PROXY_SECRET_PATH = path.join(CONFIG_DIR, "proxy-secret");

export function resolveHome(p: string): string {
  let resolved = p;
  if (resolved.startsWith("~/")) {
    resolved = path.join(os.homedir(), resolved.slice(2));
  }
  // Normalize to prevent path traversal via .. segments
  return path.resolve(resolved);
}

export async function ensureConfigDir(): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Load or create the proxy authentication secret.
 * Used by the local proxy to authenticate requests.
 */
export async function loadOrCreateProxySecret(): Promise<string> {
  try {
    const secret = (await fs.readFile(PROXY_SECRET_PATH, "utf-8")).trim();
    if (secret.length > 0) return secret;
  } catch {
    // File doesn't exist or unreadable — create a new one
  }
  await ensureConfigDir();
  const secret = `t2c-${crypto.randomBytes(24).toString("hex")}`;
  await fs.writeFile(PROXY_SECRET_PATH, secret + "\n", { mode: 0o600 });
  return secret;
}

/**
 * Load config with automatic recovery from corruption
 */
export async function loadConfig(): Promise<T2CConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    const saved = JSON.parse(raw) as Partial<T2CConfig>;

    // Validate the loaded config
    const merged = { ...DEFAULT_CONFIG, ...saved };

    // Basic sanity checks
    if (
      typeof merged.proxyPort !== "number" ||
      merged.proxyPort < 1 ||
      merged.proxyPort > 65535
    ) {
      console.warn(
        `Warning: Invalid proxy port in config (${merged.proxyPort}), using default`
      );
      merged.proxyPort = DEFAULT_CONFIG.proxyPort;
    }

    if (typeof merged.gateUrl !== "string" || !merged.gateUrl.startsWith("http")) {
      console.warn(`Warning: Invalid gate URL in config, using default`);
      merged.gateUrl = DEFAULT_CONFIG.gateUrl;
    }

    if (typeof merged.mintUrl !== "string" || !merged.mintUrl.startsWith("http")) {
      console.warn(`Warning: Invalid mint URL in config, using default`);
      merged.mintUrl = DEFAULT_CONFIG.mintUrl;
    }

    return merged;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;

    // File doesn't exist - return defaults
    if (err.code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }

    // File exists but is corrupted
    if (err instanceof SyntaxError || err.message?.includes("JSON")) {
      console.warn("Warning: Config file corrupted, attempting recovery...");

      // Try to backup corrupted file
      try {
        const backupPath = `${CONFIG_PATH}.corrupted.${Date.now()}`;
        await fs.rename(CONFIG_PATH, backupPath);
        console.warn(`  Backed up corrupted config to: ${backupPath}`);
      } catch {
        // Couldn't backup, that's ok
      }

      console.warn("  Using default configuration");
      return { ...DEFAULT_CONFIG };
    }

    // Other error (permissions, etc)
    console.error(`Error reading config: ${err.message}`);
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: T2CConfig): Promise<void> {
  await ensureConfigDir();

  // Validate before saving
  if (config.proxyPort < 1 || config.proxyPort > 65535) {
    throw new Error(`Invalid proxy port: ${config.proxyPort}`);
  }
  if (!config.gateUrl.startsWith("http")) {
    throw new Error(`Invalid gate URL: ${config.gateUrl}`);
  }
  if (!config.mintUrl.startsWith("http")) {
    throw new Error(`Invalid mint URL: ${config.mintUrl}`);
  }

  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function configExists(): Promise<boolean> {
  try {
    await fs.access(CONFIG_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * Custom error classes for better error handling
 */
/**
 * Format units (1 unit = $0.00001) as USD string.
 * 100000 units = $1.00
 */
export function formatUnits(units: number): string {
  const dollars = units / 100000;
  if (dollars >= 1 || dollars === 0) {
    return "$" + dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // For sub-dollar: show enough decimal places to be meaningful
  const str = dollars.toFixed(5).replace(/0+$/, "");
  // Ensure at least 2 decimal places
  const parts = str.split(".");
  const decimals = parts[1] || "";
  const padded = decimals.length < 2 ? decimals.padEnd(2, "0") : decimals;
  return "$" + parts[0] + "." + padded;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly recoverable: boolean = false
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export class NetworkError extends Error {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

export class WalletError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INSUFFICIENT_BALANCE"
      | "WALLET_NOT_FOUND"
      | "WALLET_CORRUPTED"
      | "PROOF_SELECTION_FAILED"
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/** Shared options for adapter config generation commands */
export interface AdapterConfigOptions {
  apply?: boolean;
  json?: boolean;
  proxySecret?: string;
}

// ── Failed token persistence (shared by proxy + recover) ──────────

/** Simple async mutex to serialize failed-token file writes */
let _failedTokenLock: Promise<void> = Promise.resolve();
function withFailedTokenLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _failedTokenLock;
  let resolve: () => void;
  _failedTokenLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

export const FAILED_TOKENS_PATH = path.join(CONFIG_DIR, "failed-tokens.json");

export interface FailedToken {
  token: string;
  type: "change" | "refund";
  timestamp: number;
  error: string;
}

interface FailedTokensFile {
  tokens: FailedToken[];
}

export async function loadFailedTokens(): Promise<FailedTokensFile> {
  try {
    const raw = await fs.readFile(FAILED_TOKENS_PATH, "utf-8");
    return JSON.parse(raw) as FailedTokensFile;
  } catch {
    return { tokens: [] };
  }
}

export async function saveFailedTokens(data: FailedTokensFile): Promise<void> {
  await fs.mkdir(path.dirname(FAILED_TOKENS_PATH), { recursive: true, mode: 0o700 });
  await fs.writeFile(FAILED_TOKENS_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function appendFailedToken(token: string, type: "change" | "refund", error: string): Promise<void> {
  return withFailedTokenLock(async () => {
    const data = await loadFailedTokens();
    data.tokens.push({ token, type, timestamp: Date.now(), error });
    await saveFailedTokens(data);
  });
}

// ── Transaction log (JSONL — one record per proxy request) ────────

export const TRANSACTIONS_LOG_PATH = path.join(CONFIG_DIR, "transactions.jsonl");

export interface TransactionRecord {
  id: string;
  timestamp: number;
  model: string;
  priceSat: number;
  changeSat: number;
  refundSat: number;
  gateStatus: number;
  balanceBefore: number;
  balanceAfter: number;
  durationMs: number;
  error?: string;
}

export async function appendTransaction(record: TransactionRecord): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.appendFile(TRANSACTIONS_LOG_PATH, JSON.stringify(record) + "\n", { mode: 0o600 });
}

export async function loadTransactions(limit?: number): Promise<TransactionRecord[]> {
  try {
    const raw = await fs.readFile(TRANSACTIONS_LOG_PATH, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const records = lines.map((l) => JSON.parse(l) as TransactionRecord);
    if (limit && limit > 0) return records.slice(-limit);
    return records;
  } catch {
    return [];
  }
}

// ── Connectivity checks (shared by init, setup, doctor, status) ───

export async function checkGateHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkMintHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/info`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}
