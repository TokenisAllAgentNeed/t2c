/**
 * Cursor Connector
 *
 * Detects Cursor IDE installation and provides configuration instructions.
 */
import { accessSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import type { T2CConfig } from "../config.js";
import type { Connector } from "./interface.js";

function detectCursorInstallation(): boolean {
  const home = homedir();
  const plat = platform();
  const candidates: string[] = [];

  if (plat === "darwin") {
    candidates.push(join(home, "Library", "Application Support", "Cursor"));
  } else if (plat === "win32") {
    const appData = process.env.APPDATA;
    if (appData) candidates.push(join(appData, "Cursor"));
  } else {
    // Linux and others
    candidates.push(join(home, ".config", "Cursor"));
  }

  for (const p of candidates) {
    try {
      accessSync(p);
      return true;
    } catch {
      // not found
    }
  }
  return false;
}

export const cursorConnector: Connector = {
  id: "cursor",
  name: "Cursor",
  description: "Configure Cursor IDE for Token2Chat",

  async detect(): Promise<boolean> {
    return detectCursorInstallation();
  },

  async connect(_config: T2CConfig): Promise<void> {
    console.log("\n  Cursor Integration\n");
    console.log("   Configure Cursor manually:\n");
    console.log("   1. Open Cursor Settings (Cmd/Ctrl + ,)");
    console.log("   2. Search for 'OpenAI Base URL' and set:");
    console.log(`      http://127.0.0.1:${_config.proxyPort}/v1\n`);
    console.log("   3. Set 'OpenAI API Key' to your proxy secret:");
    console.log("      (find it with: t2c status --json)\n");
    console.log("   4. Use any model from the Gate, e.g.:");
    console.log("      anthropic/claude-sonnet-4\n");
  },

  async verify(): Promise<boolean> {
    return detectCursorInstallation();
  },
};
