/**
 * t2c monitor — Live TUI dashboard
 *
 * Real-time monitoring of Gate, Mint, Proxy, and Funds.
 * Uses blessed-contrib for terminal UI.
 */
import blessed from "blessed";
import contrib from "blessed-contrib";
import { loadConfig, resolveHome, loadTransactions, formatUnits, type TransactionRecord } from "../config.js";
import { CashuStore } from "../cashu-store.js";

/** Mint /stats response shape */
export interface MintStats {
  totalMintedSats: number;
  totalMeltedSats: number;
  mintCount: number;
  meltCount: number;
}

/** Gate /stats response summary shape */
export interface GateStatsSummary {
  total_requests: number;
  success_count: number;
  error_count: number;
  ecash_received: number;
  model_breakdown: Record<string, { count: number; ecash_in: number; errors: number }>;
  error_breakdown: Record<string, number>;
}

export interface GateStats {
  generated_at: string;
  today: GateStatsSummary;
  last_7_days: GateStatsSummary;
}

/**
 * Fetch Gate statistics from the /stats endpoint.
 * Returns null on error (network, parse, etc).
 */
export async function fetchGateStats(gateUrl: string): Promise<GateStats | null> {
  try {
    const res = await fetch(`${gateUrl}/stats`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json() as GateStats;
    return data;
  } catch {
    return null;
  }
}

/**
 * Fetch Mint statistics from the /stats endpoint.
 * Returns null on error (network, parse, etc).
 */
export async function fetchMintStats(mintUrl: string): Promise<MintStats | null> {
  try {
    const res = await fetch(`${mintUrl}/stats`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json() as MintStats;
    return data;
  } catch {
    return null;
  }
}

/**
 * Format sats with thousands separators.
 */
export function formatSats(sats: number): string {
  return sats.toLocaleString("en-US");
}

/**
 * Format a transaction record for TUI display.
 */
function formatTransaction(tx: TransactionRecord, maxWidth: number): string {
  const time = new Date(tx.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  
  // Status indicator with color
  const statusIcon = tx.error 
    ? "{red-fg}✗{/red-fg}" 
    : tx.gateStatus === 200 
      ? "{green-fg}✓{/green-fg}" 
      : `{yellow-fg}${tx.gateStatus}{/yellow-fg}`;
  
  // Cost display
  const cost = formatUnits(tx.priceSat).padStart(8);

  // Truncate model name to fit available space
  const modelMaxLen = Math.max(10, maxWidth - 26);
  const model = tx.model.length > modelMaxLen
    ? tx.model.slice(0, modelMaxLen - 2) + ".."
    : tx.model;

  return `  ${time} ${statusIcon} ${cost} ${model}`;
}

/**
 * Build proxy panel content from transaction history.
 */
export async function buildProxyContent(maxLines: number, maxWidth: number): Promise<string> {
  const transactions = await loadTransactions();
  
  if (transactions.length === 0) {
    return "{center}No transactions yet{/center}\n\n" +
           "  Run requests through the proxy\n" +
           "  to see activity here.";
  }
  
  // Show most recent first
  const recent = transactions.slice().reverse();
  
  // Calculate summary stats
  const totalSpent = transactions.reduce((s, t) => s + t.priceSat, 0);
  const totalChange = transactions.reduce((s, t) => s + t.changeSat, 0);
  const errorCount = transactions.filter((t) => t.error).length;
  const netCost = totalSpent - totalChange;
  
  const lines: string[] = [
    `  Requests: ${transactions.length} | Spent: ${formatUnits(netCost)}`,
    errorCount > 0 
      ? `  {red-fg}Errors: ${errorCount}{/red-fg}`
      : `  {green-fg}All OK{/green-fg}`,
    "  " + "─".repeat(Math.min(36, maxWidth - 4)),
  ];
  
  // Add recent transactions (leave room for header)
  const displayCount = Math.min(recent.length, Math.max(1, maxLines - 5));
  for (let i = 0; i < displayCount; i++) {
    lines.push(formatTransaction(recent[i], maxWidth));
  }
  
  if (recent.length > displayCount) {
    lines.push(`  ... +${recent.length - displayCount} more`);
  }
  
  return lines.join("\n");
}

export interface MonitorOptions {
  refresh?: string;
}

/** Low balance threshold for warning highlight */
const LOW_BALANCE_THRESHOLD = 500;

/** Default refresh interval in milliseconds */
const DEFAULT_REFRESH_MS = 5000;

/**
 * Create and run the TUI monitor dashboard.
 * Layout: 2x2 grid with Gate, Mint, Proxy, Funds panels.
 */
export async function monitorCommand(opts: MonitorOptions): Promise<void> {
  // Parse refresh interval
  const refreshMs = opts.refresh 
    ? parseInt(opts.refresh, 10) * 1000 
    : DEFAULT_REFRESH_MS;

  // Create the main screen
  const screen = blessed.screen({
    smartCSR: true,
    title: "t2c monitor",
    fullUnicode: true,
  });

  // Create a 2x2 grid layout
  const grid = new contrib.grid({
    rows: 2,
    cols: 2,
    screen: screen,
  });

  // ── Gate Panel (top-left) ──
  const gateBox = grid.set(0, 0, 1, 1, blessed.box, {
    label: " Gate ",
    border: { type: "line" },
    style: {
      border: { fg: "cyan" },
      label: { fg: "cyan", bold: true },
    },
    content: "{center}Loading...{/center}",
    tags: true,
  });

  // ── Mint Panel (top-right) ──
  const mintBox = grid.set(0, 1, 1, 1, blessed.box, {
    label: " Mint ",
    border: { type: "line" },
    style: {
      border: { fg: "green" },
      label: { fg: "green", bold: true },
    },
    content: "{center}Loading...{/center}",
    tags: true,
  });

  // ── Proxy Panel (bottom-left) ──
  const proxyBox = grid.set(1, 0, 1, 1, blessed.box, {
    label: " Proxy ",
    border: { type: "line" },
    style: {
      border: { fg: "yellow" },
      label: { fg: "yellow", bold: true },
    },
    content: "{center}Loading...{/center}",
    tags: true,
  });

  // ── Funds Panel (bottom-right) ──
  const fundsBox = grid.set(1, 1, 1, 1, blessed.box, {
    label: " Funds ",
    border: { type: "line" },
    style: {
      border: { fg: "magenta" },
      label: { fg: "magenta", bold: true },
    },
    content: "{center}Loading...{/center}",
    tags: true,
  });

  // Status bar at the bottom
  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    style: {
      bg: "blue",
      fg: "white",
    },
    content: ` t2c monitor | q: quit | r: refresh | interval: ${refreshMs / 1000}s `,
    tags: true,
  });

  // Reference to refresh timer for cleanup
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  // Key bindings for clean exit
  screen.key(["escape", "q", "C-c"], () => {
    cleanup();
  });

  // Refresh key
  screen.key(["r"], () => {
    updatePanels();
  });

  // Cleanup function
  function cleanup(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    screen.destroy();
    process.exit(0);
  }

  // Handle process signals for clean exit
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Panel update function
  async function updatePanels(): Promise<void> {
    const now = new Date().toLocaleTimeString();
    
    // Calculate available lines for proxy panel (rough estimate)
    const panelHeight = Math.floor((screen.height as number) / 2) - 3;
    const panelWidth = Math.floor((screen.width as number) / 2) - 4;
    
    // Load config for panel updates
    const config = await loadConfig();

    // Update Gate panel with stats
    await updateGatePanel(gateBox, config.gateUrl, now);

    // Update Mint panel with stats
    const mintStats = await fetchMintStats(config.mintUrl);
    if (mintStats) {
      const netFlow = mintStats.totalMintedSats - mintStats.totalMeltedSats;
      const netFlowColor = netFlow >= 0 ? "green-fg" : "red-fg";
      const netFlowSign = netFlow >= 0 ? "+" : "";
      mintBox.setContent(
        `{center}Mint Statistics{/center}\n\n` +
        `  {bold}Minted:{/bold}  ${formatUnits(mintStats.totalMintedSats)} (${mintStats.mintCount} ops)\n` +
        `  {bold}Melted:{/bold}  ${formatUnits(mintStats.totalMeltedSats)} (${mintStats.meltCount} ops)\n` +
        `  {bold}Net:{/bold}     {${netFlowColor}}${netFlowSign}${formatUnits(netFlow)}{/${netFlowColor}}\n\n` +
        `{right}Updated: ${now}{/right}`
      );
    } else {
      mintBox.setContent(
        `{center}Mint Statistics{/center}\n\n` +
        `  {red-fg}●{/red-fg} Unable to fetch stats\n` +
        `  URL: ${config.mintUrl}\n\n` +
        `{right}Updated: ${now}{/right}`
      );
    }

    // Update Proxy panel with real transaction data
    try {
      const proxyContent = await buildProxyContent(panelHeight, panelWidth);
      proxyBox.setContent(proxyContent + `\n\n{right}${now}{/right}`);
    } catch (err) {
      proxyBox.setContent(
        `{center}Proxy Events{/center}\n\n` +
        `  {red-fg}Error loading transactions{/red-fg}\n` +
        `  ${err instanceof Error ? err.message : String(err)}\n\n` +
        `{right}${now}{/right}`
      );
    }

    // Update Funds panel with wallet balance and fund flow statistics
    await updateFundsPanel(fundsBox, now);

    screen.render();
  }

  /** Update the Funds panel with wallet balance and fund flow statistics */
  async function updateFundsPanel(box: blessed.Widgets.BoxElement, now: string): Promise<void> {
    try {
      const config = await loadConfig();
      const walletPath = resolveHome(config.walletPath);
      
      // Load wallet and transactions in parallel
      const [store, transactions] = await Promise.all([
        CashuStore.load(walletPath, config.mintUrl),
        loadTransactions(),
      ]);

      const balance = store.balance;
      const proofCount = store.proofCount;

      // Calculate fund flow statistics from transactions
      const totalSpent = transactions.reduce((s, t) => s + t.priceSat, 0);
      const totalChange = transactions.reduce((s, t) => s + t.changeSat, 0);
      const totalRefund = transactions.reduce((s, t) => s + t.refundSat, 0);
      const netCost = totalSpent - totalChange - totalRefund;

      // Format balance with low balance warning
      const balanceColor = balance < LOW_BALANCE_THRESHOLD ? "red" : "green";
      const balanceWarning = balance < LOW_BALANCE_THRESHOLD ? " {red-fg}⚠ LOW{/red-fg}" : "";
      const balanceStr = `{${balanceColor}-fg}${formatUnits(balance)}{/${balanceColor}-fg}${balanceWarning}`;

      box.setContent(
        `{center}Wallet Funds{/center}\n\n` +
        `  Balance: ${balanceStr}\n` +
        `  Proofs:  ${proofCount}\n\n` +
        `  {bold}Fund Flow{/bold}\n` +
        `  Spent:   ${formatUnits(totalSpent)}\n` +
        `  Change:  +${formatUnits(totalChange)}\n` +
        `  Refund:  +${formatUnits(totalRefund)}\n` +
        `  Net:     ${formatUnits(netCost)}\n\n` +
        `{right}Updated: ${now}{/right}`
      );
    } catch (err) {
      box.setContent(
        `{center}Wallet Funds{/center}\n\n` +
        `  {red-fg}Error loading wallet{/red-fg}\n` +
        `  ${err instanceof Error ? err.message : String(err)}\n\n` +
        `{right}Updated: ${now}{/right}`
      );
    }
  }

  /** Update the Gate panel with stats from /stats endpoint */
  async function updateGatePanel(
    box: blessed.Widgets.BoxElement,
    gateUrl: string,
    now: string
  ): Promise<void> {
    const stats = await fetchGateStats(gateUrl);

    if (!stats) {
      box.setContent(
        `{center}Gate Statistics{/center}\n\n` +
        `  Status: {red-fg}●{/red-fg} Unreachable\n` +
        `  URL: ${gateUrl}\n\n` +
        `{right}Updated: ${now}{/right}`
      );
      return;
    }

    const today = stats.today;
    const week = stats.last_7_days;

    // Format error count with red highlight if > 0
    const todayErrors = today.error_count > 0
      ? `{red-fg}${today.error_count}{/red-fg}`
      : `${today.error_count}`;
    const weekErrors = week.error_count > 0
      ? `{red-fg}${week.error_count}{/red-fg}`
      : `${week.error_count}`;

    // Calculate success rate
    const todayRate = today.total_requests > 0
      ? ((today.success_count / today.total_requests) * 100).toFixed(1)
      : "100.0";
    const weekRate = week.total_requests > 0
      ? ((week.success_count / week.total_requests) * 100).toFixed(1)
      : "100.0";

    // Build content
    let content = `{center}Gate Statistics{/center}\n\n`;
    content += `  {bold}Today{/bold}\n`;
    content += `  Total: ${formatSats(today.total_requests)}  `;
    content += `OK: ${formatSats(today.success_count)}  `;
    content += `Err: ${todayErrors}\n`;
    content += `  Rate: ${todayRate}%  `;
    content += `Ecash: ${formatUnits(today.ecash_received)}\n\n`;

    content += `  {bold}Last 7 Days{/bold}\n`;
    content += `  Total: ${formatSats(week.total_requests)}  `;
    content += `OK: ${formatSats(week.success_count)}  `;
    content += `Err: ${weekErrors}\n`;
    content += `  Rate: ${weekRate}%  `;
    content += `Ecash: ${formatUnits(week.ecash_received)}\n`;

    // Show error breakdown if any errors today
    if (today.error_count > 0 && Object.keys(today.error_breakdown).length > 0) {
      content += `\n  {bold}{red-fg}Errors Today{/red-fg}{/bold}\n`;
      for (const [code, count] of Object.entries(today.error_breakdown)) {
        content += `  {red-fg}• ${code}: ${count}{/red-fg}\n`;
      }
    }

    content += `\n{right}Updated: ${now}{/right}`;

    box.setContent(content);
  }

  // Initial render
  await updatePanels();
  screen.render();

  // Set up auto-refresh
  refreshTimer = setInterval(() => {
    updatePanels().catch(() => {
      // Ignore refresh errors, will retry next interval
    });
  }, refreshMs);
}
