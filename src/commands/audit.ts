/**
 * t2c audit — Full-chain fund visualization
 *
 * Unified view: local wallet + Mint + Gate + transaction log.
 * Cross-references data and highlights anomalies.
 */
import {
  loadConfig,
  resolveHome,
  loadFailedTokens,
  loadTransactions,
  formatUnits,
  type TransactionRecord,
  type FailedToken,
} from "../config.js";
import { CashuStore } from "../cashu-store.js";
import { GateRegistry, type GateEntry } from "../gate-discovery.js";

interface AuditOptions {
  json?: boolean;
  lines?: string;
}

interface MintInfo {
  reachable: boolean;
  name?: string;
  version?: string;
  nuts?: Record<string, unknown>;
  keysetIds?: string[];
  error?: string;
}

interface GateInfo {
  reachable: boolean;
  mints?: string[];
  models?: string[];
  pricing?: Record<string, { input_per_million?: number; output_per_million?: number; per_request?: number }>;
  error?: string;
}

interface ProofBreakdown {
  [denomination: number]: number; // denomination -> count
}

export interface Anomaly {
  severity: "error" | "warn" | "info";
  message: string;
}

interface DiscoveredGate {
  name: string;
  url: string;
  mint: string;
  models: string[];
  healthy: boolean;
}

export interface AuditReport {
  timestamp: number;
  wallet: {
    balance: number;
    proofCount: number;
    proofBreakdown: ProofBreakdown;
    mint: string;
  } | null;
  mint: MintInfo;
  gate: GateInfo;
  discoveredGates: DiscoveredGate[];
  transactions: {
    total: number;
    shown: number;
    totalSpent: number;
    totalChange: number;
    totalRefund: number;
    netCost: number;
    errorCount: number;
    recent: TransactionRecord[];
  };
  failedTokens: FailedToken[];
  anomalies: Anomaly[];
}

async function fetchMintInfo(mintUrl: string): Promise<MintInfo> {
  try {
    const [infoRes, keysetsRes] = await Promise.all([
      fetch(`${mintUrl}/v1/info`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${mintUrl}/v1/keysets`, { signal: AbortSignal.timeout(8000) }),
    ]);

    const info: MintInfo = { reachable: infoRes.ok };
    if (infoRes.ok) {
      const data = (await infoRes.json()) as Record<string, unknown>;
      info.name = data.name as string | undefined;
      info.version = data.version as string | undefined;
      info.nuts = data.nuts as Record<string, unknown> | undefined;
    }
    if (keysetsRes.ok) {
      const data = (await keysetsRes.json()) as { keysets?: { id: string; active: boolean }[] };
      info.keysetIds = data.keysets?.filter((k) => k.active).map((k) => k.id);
    }
    return info;
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchGateInfo(gateUrl: string): Promise<GateInfo> {
  try {
    const [healthRes, pricingRes] = await Promise.all([
      fetch(`${gateUrl}/health`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${gateUrl}/v1/pricing`, { signal: AbortSignal.timeout(8000) }),
    ]);

    const info: GateInfo = { reachable: healthRes.ok };
    if (healthRes.ok) {
      const data = (await healthRes.json()) as { mints?: string[]; models?: string[] };
      info.mints = data.mints;
      info.models = data.models;
    }
    if (pricingRes.ok) {
      const data = (await pricingRes.json()) as { models?: Record<string, Record<string, unknown>> };
      info.pricing = data.models as GateInfo["pricing"];
    }
    return info;
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function detectAnomalies(report: AuditReport): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // Wallet anomalies
  if (report.wallet) {
    if (report.wallet.balance === 0) {
      anomalies.push({ severity: "error", message: "Wallet balance is 0 — cannot make requests" });
    } else if (report.wallet.balance < 500) {
      anomalies.push({ severity: "warn", message: `Low wallet balance: ${formatUnits(report.wallet.balance)}` });
    }
    if (report.wallet.proofCount > 100) {
      anomalies.push({ severity: "warn", message: `High proof count (${report.wallet.proofCount}) — consider consolidating via swap` });
    }
  } else {
    anomalies.push({ severity: "error", message: "No wallet found — run 't2c init'" });
  }

  // Mint anomalies
  if (!report.mint.reachable) {
    anomalies.push({ severity: "error", message: `Mint unreachable: ${report.mint.error ?? "connection failed"}` });
  }
  if (report.mint.keysetIds && report.mint.keysetIds.length === 0) {
    anomalies.push({ severity: "error", message: "Mint has no active keysets" });
  }

  // Gate anomalies
  if (!report.gate.reachable) {
    anomalies.push({ severity: "error", message: `Gate unreachable: ${report.gate.error ?? "connection failed"}` });
  }
  if (report.gate.reachable && report.gate.mints && report.wallet) {
    if (!report.gate.mints.includes(report.wallet.mint)) {
      anomalies.push({
        severity: "error",
        message: `Wallet mint (${report.wallet.mint}) not in Gate's trusted mints: ${report.gate.mints.join(", ")}`,
      });
    }
  }

  // Transaction anomalies
  if (report.transactions.errorCount > 0) {
    anomalies.push({
      severity: "warn",
      message: `${report.transactions.errorCount} failed transaction(s) in history`,
    });
  }
  const lossRate = report.transactions.totalSpent > 0
    ? ((report.transactions.totalSpent - report.transactions.totalChange - report.transactions.totalRefund) / report.transactions.totalSpent * 100)
    : 0;
  if (report.transactions.totalSpent > 0 && lossRate > 50) {
    anomalies.push({
      severity: "warn",
      message: `High fund loss rate: ${lossRate.toFixed(1)}% of spent funds not returned as change/refund`,
    });
  }

  // Failed token anomalies
  if (report.failedTokens.length > 0) {
    const totalLost = report.failedTokens.length;
    anomalies.push({
      severity: "error",
      message: `${totalLost} failed token(s) pending recovery — run 't2c recover'`,
    });
  }

  // Balance consistency check
  if (report.wallet && report.transactions.recent.length > 0) {
    const last = report.transactions.recent[report.transactions.recent.length - 1];
    if (last.balanceAfter !== report.wallet.balance) {
      anomalies.push({
        severity: "info",
        message: `Balance drift: last tx recorded ${formatUnits(last.balanceAfter)}, wallet now ${formatUnits(report.wallet.balance)} (may indicate manual changes)`,
      });
    }
  }

  return anomalies;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function printReport(report: AuditReport): void {
  const config = report;
  console.log("\n========================================");
  console.log("       t2c Audit Report");
  console.log(`       ${formatTime(report.timestamp)}`);
  console.log("========================================\n");

  // ── Wallet ──
  console.log("--- Wallet ---");
  if (report.wallet) {
    console.log(`  Balance:     ${formatUnits(report.wallet.balance)}`);
    console.log(`  Proofs:      ${report.wallet.proofCount}`);
    console.log(`  Mint:        ${report.wallet.mint}`);
    const denominations = Object.entries(report.wallet.proofBreakdown)
      .sort(([a], [b]) => Number(b) - Number(a));
    if (denominations.length > 0) {
      console.log("  Breakdown:");
      for (const [denom, count] of denominations) {
        console.log(`    ${formatUnits(Number(denom))} x ${count} = ${formatUnits(Number(denom) * (count as number))}`);
      }
    }
  } else {
    console.log("  (no wallet found)");
  }

  // ── Mint ──
  console.log("\n--- Mint ---");
  console.log(`  Status:      ${report.mint.reachable ? "reachable" : "UNREACHABLE"}`);
  if (report.mint.name) console.log(`  Name:        ${report.mint.name}`);
  if (report.mint.version) console.log(`  Version:     ${report.mint.version}`);
  if (report.mint.nuts) {
    console.log(`  NUTs:        ${Object.keys(report.mint.nuts).sort().join(", ")}`);
  }
  if (report.mint.keysetIds) {
    console.log(`  Keysets:     ${report.mint.keysetIds.join(", ") || "(none active)"}`);
  }

  // ── Gate ──
  console.log("\n--- Gate ---");
  console.log(`  Status:      ${report.gate.reachable ? "reachable" : "UNREACHABLE"}`);
  if (report.gate.mints) {
    console.log(`  Mints:       ${report.gate.mints.join(", ")}`);
  }
  if (report.gate.models) {
    console.log(`  Models:      ${report.gate.models.join(", ")}`);
  }
  if (report.gate.pricing) {
    console.log("  Pricing:");
    for (const [model, rule] of Object.entries(report.gate.pricing)) {
      const parts: string[] = [];
      if (rule.input_per_million) parts.push(`in:${rule.input_per_million}/M`);
      if (rule.output_per_million) parts.push(`out:${rule.output_per_million}/M`);
      if (rule.per_request) parts.push(`req:${rule.per_request}`);
      console.log(`    ${model}: ${parts.join(", ")}`);
    }
  }

  // ── Discovered Gates ──
  if (report.discoveredGates.length > 0) {
    console.log("\n--- Discovered Gates ---");
    for (const g of report.discoveredGates) {
      const status = g.healthy ? "OK" : "DOWN";
      console.log(`  [${status}] ${g.name} — ${g.url}`);
      if (g.mint) console.log(`         Mint: ${g.mint}`);
      if (g.models.length > 0) console.log(`         Models: ${g.models.join(", ")}`);
    }
  }

  // ── Transactions ──
  console.log("\n--- Transactions ---");
  if (report.transactions.total === 0) {
    console.log("  (no transactions recorded yet)");
  } else {
    console.log(`  Total:       ${report.transactions.total} requests`);
    console.log(`  Spent:       ${formatUnits(report.transactions.totalSpent)}`);
    console.log(`  Change:      +${formatUnits(report.transactions.totalChange)}`);
    console.log(`  Refund:      +${formatUnits(report.transactions.totalRefund)}`);
    console.log(`  Net cost:    ${formatUnits(report.transactions.netCost)}`);
    console.log(`  Errors:      ${report.transactions.errorCount}`);

    if (report.transactions.recent.length > 0) {
      console.log("\n  Recent transactions:");
      console.log("  " + "-".repeat(90));
      console.log("  " + padR("Time", 20) + padR("Model", 28) + padR("Paid", 8) + padR("Change", 8) + padR("Status", 8) + "Duration");
      console.log("  " + "-".repeat(90));
      for (const tx of report.transactions.recent) {
        const time = new Date(tx.timestamp).toLocaleTimeString();
        const model = tx.model.length > 26 ? tx.model.slice(0, 24) + ".." : tx.model;
        const status = tx.error ? `ERR` : `${tx.gateStatus}`;
        console.log(
          "  " +
          padR(time, 20) +
          padR(model, 28) +
          padR(`${tx.priceSat}`, 8) +
          padR(`+${tx.changeSat}`, 8) +
          padR(status, 8) +
          formatDuration(tx.durationMs)
        );
      }
      console.log("  " + "-".repeat(90));
    }
  }

  // ── Failed Tokens ──
  if (report.failedTokens.length > 0) {
    console.log("\n--- Failed Tokens ---");
    for (const ft of report.failedTokens) {
      console.log(`  [${ft.type}] ${formatTime(ft.timestamp)} — ${ft.error}`);
      console.log(`    Token: ${ft.token.slice(0, 40)}...`);
    }
  }

  // ── Anomalies ──
  console.log("\n--- Anomalies ---");
  if (report.anomalies.length === 0) {
    console.log("  No anomalies detected.");
  } else {
    for (const a of report.anomalies) {
      const icon = a.severity === "error" ? "!!" : a.severity === "warn" ? " !" : " i";
      console.log(`  [${icon}] ${a.message}`);
    }
  }

  console.log("\n========================================\n");
}

function padR(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

export async function auditCommand(opts: AuditOptions): Promise<void> {
  const config = await loadConfig();
  const limit = parseInt(opts.lines || "20", 10);

  // Gather data in parallel
  const [mintInfo, gateInfo, transactions, failedTokensData, walletResult, discoveredGates] = await Promise.all([
    fetchMintInfo(config.mintUrl),
    fetchGateInfo(config.gateUrl),
    loadTransactions(),
    loadFailedTokens(),
    (async () => {
      try {
        const walletPath = resolveHome(config.walletPath);
        const store = await CashuStore.load(walletPath, config.mintUrl);
        const data = store.exportData();
        const breakdown: ProofBreakdown = {};
        for (const p of data.proofs) {
          breakdown[p.amount] = (breakdown[p.amount] || 0) + 1;
        }
        return {
          balance: store.balance,
          proofCount: store.proofCount,
          proofBreakdown: breakdown,
          mint: data.mint,
        };
      } catch {
        return null;
      }
    })(),
    (async (): Promise<DiscoveredGate[]> => {
      try {
        const registry = new GateRegistry(config.gateUrl, config.discoveryUrl);
        await registry.discover();
        return registry.getAll().map((g) => ({
          name: g.name,
          url: g.url,
          mint: g.mint,
          models: g.models,
          healthy: g.healthy,
        }));
      } catch {
        return [];
      }
    })(),
  ]);

  // Compute transaction summaries
  const totalSpent = transactions.reduce((s, t) => s + t.priceSat, 0);
  const totalChange = transactions.reduce((s, t) => s + t.changeSat, 0);
  const totalRefund = transactions.reduce((s, t) => s + t.refundSat, 0);
  const errorCount = transactions.filter((t) => t.error).length;
  const recent = transactions.slice(-limit);

  const report: AuditReport = {
    timestamp: Date.now(),
    wallet: walletResult,
    mint: mintInfo,
    gate: gateInfo,
    discoveredGates,
    transactions: {
      total: transactions.length,
      shown: recent.length,
      totalSpent,
      totalChange,
      totalRefund,
      netCost: totalSpent - totalChange - totalRefund,
      errorCount,
      recent,
    },
    failedTokens: failedTokensData.tokens,
    anomalies: [],
  };

  report.anomalies = detectAnomalies(report);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}
