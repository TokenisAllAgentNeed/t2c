/**
 * Cursor adapter - Generate config for Cursor IDE
 */
import type { T2CConfig, AdapterConfigOptions } from "../config.js";

export async function cursorAdapter(t2cConfig: T2CConfig, opts: AdapterConfigOptions): Promise<void> {
  const baseUrl = `http://127.0.0.1:${t2cConfig.proxyPort}/v1`;
  const apiKey = opts.proxySecret ?? "t2c-local";

  if (opts.json) {
    console.log(JSON.stringify({
      openai: {
        baseUrl,
        apiKey,
      },
    }, null, 2));
    return;
  }

  console.log("\n🎟️  Cursor Configuration\n");
  console.log("In Cursor Settings (Cmd/Ctrl + ,), configure:\n");
  console.log("  1. OpenAI Base URL:");
  console.log(`     ${baseUrl}\n`);
  console.log("  2. OpenAI API Key:");
  console.log(`     ${apiKey}\n`);
  console.log("  3. Model:");
  console.log("     anthropic/claude-sonnet-4  (or any OpenRouter model)\n");
  console.log("Note: Cursor uses OpenRouter-style model IDs (with /).");
  console.log("Available models: anthropic/claude-opus-4, openai/gpt-4o, etc.\n");
}
