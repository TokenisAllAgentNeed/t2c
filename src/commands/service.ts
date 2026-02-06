/**
 * t2c service - Manage the local proxy service
 */
import fs from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  loadConfig,
  PID_PATH,
  LOG_PATH,
  ensureConfigDir,
  CONFIG_DIR,
} from "../config.js";
import { startProxy } from "../proxy.js";

interface ServiceOptions {
  foreground?: boolean;
  follow?: boolean;
  lines?: string;
}

// Platform-specific paths
const LAUNCHD_PLIST_NAME = "com.token2chat.proxy.plist";
const LAUNCHD_PLIST_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  LAUNCHD_PLIST_NAME
);
const SYSTEMD_UNIT_NAME = "t2c-proxy.service";
const SYSTEMD_UNIT_PATH = path.join(
  os.homedir(),
  ".config",
  "systemd",
  "user",
  SYSTEMD_UNIT_NAME
);

async function getPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(PID_PATH, "utf-8");
    const pid = parseInt(raw.trim(), 10);
    if (isNaN(pid)) return null;
    // Check if process exists
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // Process doesn't exist, clean up stale PID file
      await fs.unlink(PID_PATH).catch(() => {});
      return null;
    }
  } catch {
    return null;
  }
}

async function writePid(pid: number): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(PID_PATH, String(pid), { mode: 0o600 });
}

async function removePid(): Promise<void> {
  await fs.unlink(PID_PATH).catch(() => {});
}

async function isProxyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function startForeground(): Promise<void> {
  const config = await loadConfig();

  // Check if already running
  if (await isProxyRunning(config.proxyPort)) {
    console.log(`Proxy already running on port ${config.proxyPort}`);
    return;
  }

  console.log("Starting proxy in foreground (Ctrl+C to stop)...\n");

  const handle = await startProxy(config);

  // Handle shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    handle.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    handle.stop();
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

async function startDaemon(): Promise<void> {
  const config = await loadConfig();

  // Check if already running
  const existingPid = await getPid();
  if (existingPid) {
    console.log(`Proxy already running (PID: ${existingPid})`);
    return;
  }

  if (await isProxyRunning(config.proxyPort)) {
    console.log(`Proxy already running on port ${config.proxyPort}`);
    return;
  }

  await ensureConfigDir();

  // Find t2c executable path
  const t2cPath = process.argv[1];

  // Spawn detached process
  const logStream = await fs.open(LOG_PATH, "a");
  const child = spawn(process.execPath, [t2cPath, "service", "start", "-f"], {
    detached: true,
    stdio: ["ignore", logStream.fd, logStream.fd],
    env: { ...process.env, T2C_DAEMON: "1" },
  });

  child.unref();
  await logStream.close();

  if (child.pid) {
    await writePid(child.pid);
    console.log(`Proxy started (PID: ${child.pid})`);
    console.log(`Logs: ${LOG_PATH}`);
  } else {
    console.error("Failed to start proxy");
    process.exit(1);
  }
}

async function stopService(): Promise<void> {
  const pid = await getPid();
  if (!pid) {
    console.log("Proxy not running");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopping proxy (PID: ${pid})...`);

    // Wait for process to exit
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        process.kill(pid, 0);
      } catch {
        // Process exited
        await removePid();
        console.log("Proxy stopped");
        return;
      }
    }

    // Force kill
    process.kill(pid, "SIGKILL");
    await removePid();
    console.log("Proxy killed");
  } catch (e) {
    console.error(`Failed to stop proxy: ${e}`);
    await removePid();
  }
}

async function restartService(): Promise<void> {
  await stopService();
  await new Promise((r) => setTimeout(r, 500));
  await startDaemon();
}

async function showLogs(opts: ServiceOptions): Promise<void> {
  const lines = parseInt(opts.lines || "50", 10);

  try {
    const content = await fs.readFile(LOG_PATH, "utf-8");
    const allLines = content.split("\n");
    const lastLines = allLines.slice(-lines).join("\n");
    console.log(lastLines);

    if (opts.follow) {
      console.log("\n--- Following logs (Ctrl+C to stop) ---\n");
      const tail = spawn("tail", ["-f", LOG_PATH], { stdio: "inherit" });
      process.on("SIGINT", () => {
        tail.kill();
        process.exit(0);
      });
      await new Promise(() => {});
    }
  } catch {
    console.log("No logs found");
  }
}

// ── Install/Uninstall for system service managers ──────────────────

function generateLaunchdPlist(config: { proxyPort: number }): string {
  // Find t2c executable
  const t2cPath = getT2CExecutablePath();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.token2chat.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${t2cPath}</string>
    <string>service</string>
    <string>start</string>
    <string>-f</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${CONFIG_DIR}</string>
</dict>
</plist>`;
}

function generateSystemdUnit(config: { proxyPort: number }): string {
  const t2cPath = getT2CExecutablePath();

  return `[Unit]
Description=Token2Chat Proxy Service
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${t2cPath} service start -f
Restart=on-failure
RestartSec=5
StandardOutput=append:${LOG_PATH}
StandardError=append:${LOG_PATH}
WorkingDirectory=${CONFIG_DIR}

[Install]
WantedBy=default.target
`;
}

function getT2CExecutablePath(): string {
  // If running from npm, use the bin path
  // Otherwise use the current script path
  return process.argv[1];
}

async function installService(): Promise<void> {
  const config = await loadConfig();
  const platform = os.platform();

  if (platform === "darwin") {
    // macOS: launchd
    const plistContent = generateLaunchdPlist(config);
    const plistDir = path.dirname(LAUNCHD_PLIST_PATH);

    await fs.mkdir(plistDir, { recursive: true });
    await fs.writeFile(LAUNCHD_PLIST_PATH, plistContent);

    console.log(`✅ Installed launchd service: ${LAUNCHD_PLIST_PATH}\n`);
    console.log("To load and start the service:");
    console.log(`  launchctl load ${LAUNCHD_PLIST_PATH}\n`);
    console.log("To check status:");
    console.log(`  launchctl list | grep com.token2chat\n`);
    console.log("The service will auto-start on login.");
  } else if (platform === "linux") {
    // Linux: systemd (user service)
    const unitContent = generateSystemdUnit(config);
    const unitDir = path.dirname(SYSTEMD_UNIT_PATH);

    await fs.mkdir(unitDir, { recursive: true });
    await fs.writeFile(SYSTEMD_UNIT_PATH, unitContent);

    console.log(`✅ Installed systemd user service: ${SYSTEMD_UNIT_PATH}\n`);
    console.log("To enable and start the service:");
    console.log("  systemctl --user daemon-reload");
    console.log(`  systemctl --user enable ${SYSTEMD_UNIT_NAME}`);
    console.log(`  systemctl --user start ${SYSTEMD_UNIT_NAME}\n`);
    console.log("To check status:");
    console.log(`  systemctl --user status ${SYSTEMD_UNIT_NAME}\n`);
    console.log("The service will auto-start on login.");
  } else {
    console.error(`Unsupported platform for service installation: ${platform}`);
    console.error("Use 't2c service start' to run manually.");
    process.exit(1);
  }
}

async function uninstallService(): Promise<void> {
  const platform = os.platform();

  if (platform === "darwin") {
    // macOS: launchd
    try {
      // Try to unload first
      try {
        execSync(`launchctl unload ${LAUNCHD_PLIST_PATH}`, { stdio: "ignore" });
      } catch {
        // May not be loaded
      }

      await fs.unlink(LAUNCHD_PLIST_PATH);
      console.log(`✅ Uninstalled launchd service`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        console.log("Service not installed");
      } else {
        throw e;
      }
    }
  } else if (platform === "linux") {
    // Linux: systemd
    try {
      // Try to stop and disable first
      try {
        execSync(`systemctl --user stop ${SYSTEMD_UNIT_NAME}`, { stdio: "ignore" });
        execSync(`systemctl --user disable ${SYSTEMD_UNIT_NAME}`, { stdio: "ignore" });
      } catch {
        // May not be running
      }

      await fs.unlink(SYSTEMD_UNIT_PATH);
      execSync("systemctl --user daemon-reload", { stdio: "ignore" });
      console.log(`✅ Uninstalled systemd user service`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        console.log("Service not installed");
      } else {
        throw e;
      }
    }
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
}

async function showServiceStatus(): Promise<void> {
  const config = await loadConfig();
  const platform = os.platform();
  const running = await isProxyRunning(config.proxyPort);
  const pid = await getPid();

  console.log("\n🎟️  Service Status\n");
  console.log(`Platform:   ${platform}`);
  console.log(`Proxy:      ${running ? "✅ Running" : "❌ Not running"}${pid ? ` (PID: ${pid})` : ""}`);
  console.log(`Port:       ${config.proxyPort}`);

  // Check if installed as system service
  if (platform === "darwin") {
    try {
      await fs.access(LAUNCHD_PLIST_PATH);
      console.log(`launchd:    ✅ Installed (${LAUNCHD_PLIST_PATH})`);
    } catch {
      console.log(`launchd:    ❌ Not installed (run 't2c service install')`);
    }
  } else if (platform === "linux") {
    try {
      await fs.access(SYSTEMD_UNIT_PATH);
      console.log(`systemd:    ✅ Installed (${SYSTEMD_UNIT_PATH})`);
    } catch {
      console.log(`systemd:    ❌ Not installed (run 't2c service install')`);
    }
  }

  console.log(`\nLogs:       ${LOG_PATH}`);
  console.log("");
}

export async function serviceCommand(
  action: "start" | "stop" | "restart" | "logs" | "install" | "uninstall" | "status",
  opts: ServiceOptions
): Promise<void> {
  switch (action) {
    case "start":
      if (opts.foreground || process.env.T2C_DAEMON === "1") {
        await startForeground();
      } else {
        await startDaemon();
      }
      break;
    case "stop":
      await stopService();
      break;
    case "restart":
      await restartService();
      break;
    case "logs":
      await showLogs(opts);
      break;
    case "install":
      await installService();
      break;
    case "uninstall":
      await uninstallService();
      break;
    case "status":
      await showServiceStatus();
      break;
  }
}
