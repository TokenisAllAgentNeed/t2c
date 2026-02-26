#!/usr/bin/env node
/**
 * t2c - Token2Chat CLI
 *
 * Pay-per-request LLM access via Cashu ecash
 */
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { connectCommand } from "./commands/connect.js";
import { setupCommand } from "./commands/setup.js";
import { statusCommand } from "./commands/status.js";
import { serviceCommand } from "./commands/service.js";
import { configCommand } from "./commands/config.js";
import { mintCommand } from "./commands/mint.js";
import { recoverCommand } from "./commands/recover.js";
import { doctorCommand } from "./commands/doctor.js";
import { balanceCommand } from "./commands/balance.js";
import { auditCommand } from "./commands/audit.js";
import { monitorCommand } from "./commands/monitor.js";
import { uninstallCommand } from "./commands/uninstall.js";
// debug command is loaded dynamically — excluded from npm package

const program = new Command();

program
  .name("t2c")
  .description("Pay-per-request LLM access via Cashu ecash")
  .version("0.1.0");

// t2c init - Core initialization
program
  .command("init")
  .description("Initialize Token2Chat")
  .option("-f, --force", "Reinitialize even if already configured")
  .action((opts) => initCommand(opts));

// t2c connect <app> - Connect to AI tools
program
  .command("connect [app]")
  .description("Connect to an AI tool (openclaw, cursor, env)")
  .action(connectCommand);

// t2c setup - Interactive setup wizard (legacy, points to init)
program
  .command("setup")
  .description("Interactive setup wizard (alias for init)")
  .action(setupCommand);

// t2c status - Show service status and wallet balance
program
  .command("status")
  .description("Show service status and wallet balance")
  .option("--json", "Output as JSON")
  .action(statusCommand);

// t2c service - Manage the local proxy service
const service = program
  .command("service")
  .description("Manage the local proxy service");

service
  .command("start")
  .description("Start the proxy service")
  .option("-f, --foreground", "Run in foreground (don't daemonize)")
  .action((opts) => serviceCommand("start", opts));

service
  .command("stop")
  .description("Stop the proxy service")
  .action(() => serviceCommand("stop", {}));

service
  .command("restart")
  .description("Restart the proxy service")
  .action(() => serviceCommand("restart", {}));

service
  .command("status")
  .description("Show detailed service status")
  .action(() => serviceCommand("status", {}));

service
  .command("logs")
  .description("Show service logs")
  .option("-f, --follow", "Follow log output")
  .option("-n, --lines <n>", "Number of lines to show", "50")
  .action((opts) => serviceCommand("logs", opts));

service
  .command("install")
  .description("Install as system service (launchd on macOS, systemd on Linux)")
  .action(() => serviceCommand("install", {}));

service
  .command("uninstall")
  .description("Uninstall system service")
  .action(() => serviceCommand("uninstall", {}));

// t2c mint - Add funds to wallet
program
  .command("mint [amount]")
  .description("Show deposit address or mint ecash from pending deposits")
  .option("--check", "Check for pending deposits and mint")
  .option("--scan", "Scan EVM chains for recent USDC/USDT deposits")
  .option("--usdc", "Mint ecash from on-chain USDC/USDT deposit")
  .action(mintCommand);

// t2c recover - Recover failed tokens
program
  .command("recover")
  .description("Recover failed change/refund tokens")
  .action(recoverCommand);

// t2c doctor - Self-diagnostic command
program
  .command("doctor")
  .description("Run diagnostics and check all components")
  .action(doctorCommand);

// t2c balance - Simple balance display
program
  .command("balance")
  .description("Show wallet balance")
  .option("--json", "Output as JSON")
  .action(balanceCommand);

// t2c audit - Full-chain fund visualization
program
  .command("audit")
  .description("Full-chain fund audit: wallet + mint + gate + transactions")
  .option("--json", "Output as JSON")
  .option("-n, --lines <n>", "Number of recent transactions to show", "20")
  .action(auditCommand);

// t2c monitor - Live TUI dashboard
program
  .command("monitor")
  .description("Live TUI dashboard for Gate, Mint, Proxy, and Funds")
  .option("-r, --refresh <seconds>", "Refresh interval in seconds", "5")
  .action(monitorCommand);

// t2c uninstall - Remove t2c (preserving wallet)
program
  .command("uninstall")
  .description("Uninstall t2c: stop service, remove config/data (wallet preserved)")
  .option("-y, --yes", "Skip confirmation prompt")
  .option("--remove-openclaw", "Also remove token2chat provider from OpenClaw config")
  .action((opts) => uninstallCommand({ yes: !!opts.yes, removeOpenclaw: !!opts.removeOpenclaw }));

// t2c config - Generate config for AI tools
const config = program
  .command("config")
  .description("Generate config for AI tools");

config
  .command("openclaw")
  .description("Generate OpenClaw configuration")
  .option("--apply", "Apply config directly to openclaw.json")
  .option("--json", "Output as JSON (for manual editing)")
  .action((opts) => configCommand("openclaw", opts));

config
  .command("cursor")
  .description("Generate Cursor configuration")
  .action((opts) => configCommand("cursor", opts));

config
  .command("cline")
  .description("Generate Cline VS Code extension configuration")
  .option("--json", "Output as JSON")
  .action((opts) => configCommand("cline", opts));

config
  .command("continue")
  .description("Generate Continue.dev configuration")
  .option("--json", "Output as JSON")
  .action((opts) => configCommand("continue", opts));

config
  .command("aider")
  .description("Generate Aider configuration")
  .option("--json", "Output as JSON")
  .action((opts) => configCommand("aider", opts));

config
  .command("env")
  .description("Output environment variables for generic OpenAI-compatible tools")
  .action((opts) => configCommand("env", opts));

config
  .command("list")
  .description("List supported AI tools")
  .action(() => configCommand("list", {}));

// t2c debug — dev-only commands, dynamically loaded (excluded from npm package)
try {
  const { debugCommand } = await import("./commands/debug.js");
  const debug = program
    .command("debug")
    .description("⚠️ Debug/testing commands (dev only)")
    .action(() => debugCommand("help"));

  debug
    .command("force")
    .description("Force OpenClaw to use token2chat as sole provider")
    .action(() => debugCommand("force"));

  debug
    .command("rollback")
    .description("Restore original OpenClaw config")
    .action(() => debugCommand("rollback"));

  debug
    .command("logs")
    .description("Show auth profiles, cooldowns, and recent model errors")
    .option("-n, --lines <n>", "Number of log lines to show", "30")
    .action((opts: Record<string, string>) => debugCommand("logs", opts));

  debug
    .command("topup")
    .description("Transfer ecash from Gate to local plugin wallet")
    .requiredOption("--amount <units>", "Amount in units to withdraw from Gate")
    .action((opts: Record<string, string>) => debugCommand("topup", opts));
} catch {
  // debug module not available (stripped from npm package) — skip silently
}

program.parse();
