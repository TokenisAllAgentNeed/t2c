/**
 * t2c config - Generate config for AI tools
 */
import { loadConfig, loadOrCreateProxySecret, type AdapterConfigOptions } from "../config.js";
import { openclawAdapter } from "../adapters/openclaw.js";
import { cursorAdapter } from "../adapters/cursor.js";
import { envAdapter } from "../adapters/env.js";
import { clineAdapter } from "../adapters/cline.js";
import { continueAdapter } from "../adapters/continue.js";
import { aiderAdapter } from "../adapters/aider.js";

const ADAPTERS = {
  openclaw: {
    name: "OpenClaw",
    description: "Personal AI assistant with multi-channel support",
    adapter: openclawAdapter,
  },
  cursor: {
    name: "Cursor",
    description: "AI-powered code editor",
    adapter: cursorAdapter,
  },
  cline: {
    name: "Cline",
    description: "VS Code AI coding assistant extension",
    adapter: clineAdapter,
  },
  continue: {
    name: "Continue",
    description: "Open-source AI code assistant for VS Code/JetBrains",
    adapter: continueAdapter,
  },
  aider: {
    name: "Aider",
    description: "Terminal-based AI pair programming",
    adapter: aiderAdapter,
  },
  env: {
    name: "Environment Variables",
    description: "Generic OpenAI-compatible configuration",
    adapter: envAdapter,
  },
};

export async function configCommand(
  tool: string,
  opts: AdapterConfigOptions,
): Promise<void> {
  if (tool === "list") {
    console.log("\n🎟️  Supported AI Tools\n");
    for (const [id, info] of Object.entries(ADAPTERS)) {
      console.log(`  ${id.padEnd(12)} ${info.name}`);
      console.log(`  ${"".padEnd(12)} ${info.description}\n`);
    }
    console.log("Usage: t2c config <tool>\n");
    return;
  }

  const adapterInfo = ADAPTERS[tool as keyof typeof ADAPTERS];
  if (!adapterInfo) {
    console.error(`Unknown tool: ${tool}`);
    console.error(`Run 't2c config list' to see supported tools.`);
    process.exit(1);
  }

  const config = await loadConfig();
  const proxySecret = await loadOrCreateProxySecret();
  await adapterInfo.adapter(config, { ...opts, proxySecret });
}
