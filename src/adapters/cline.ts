/**
 * Cline adapter - Generate config for Cline VS Code extension
 */
import type { T2CConfig, AdapterConfigOptions } from "../config.js";

export async function clineAdapter(
  t2cConfig: T2CConfig,
  opts: AdapterConfigOptions
): Promise<void> {
  const baseUrl = `http://127.0.0.1:${t2cConfig.proxyPort}/v1`;
  const apiKey = opts.proxySecret ?? "t2c-local";

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          "cline.apiProvider": "openai-compatible",
          "cline.openAiCompatibleApiBaseUrl": baseUrl,
          "cline.openAiCompatibleApiKey": apiKey,
          "cline.openAiCompatibleModelId": "anthropic/claude-sonnet-4",
        },
        null,
        2
      )
    );
    return;
  }

  console.log("\n🎟️  Cline Configuration\n");
  console.log("Add to your VS Code settings.json:\n");
  console.log("  ~/.vscode/settings.json (global)");
  console.log("  .vscode/settings.json (workspace)\n");
  console.log("```json");
  console.log("{");
  console.log('  "cline.apiProvider": "openai-compatible",');
  console.log(`  "cline.openAiCompatibleApiBaseUrl": "${baseUrl}",`);
  console.log(`  "cline.openAiCompatibleApiKey": "${apiKey}",`);
  console.log('  "cline.openAiCompatibleModelId": "anthropic/claude-sonnet-4"');
  console.log("}");
  console.log("```\n");
  console.log("Or configure via Cline extension settings UI:\n");
  console.log("  1. Open Cline settings (click gear icon)");
  console.log('  2. Set API Provider to "OpenAI Compatible"');
  console.log(`  3. Base URL: ${baseUrl}`);
  console.log(`  4. API Key: ${apiKey}`);
  console.log("  5. Model ID: anthropic/claude-sonnet-4\n");
  console.log("Available models: anthropic/claude-opus-4, openai/gpt-4o, etc.\n");
}
