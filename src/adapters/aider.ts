/**
 * Aider adapter - Generate config for Aider AI coding assistant
 */
import type { T2CConfig, AdapterConfigOptions } from "../config.js";

export async function aiderAdapter(
  t2cConfig: T2CConfig,
  opts: AdapterConfigOptions
): Promise<void> {
  const baseUrl = `http://127.0.0.1:${t2cConfig.proxyPort}/v1`;
  const apiKey = opts.proxySecret ?? "t2c-local";

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          OPENAI_API_KEY: apiKey,
          OPENAI_API_BASE: baseUrl,
        },
        null,
        2
      )
    );
    return;
  }

  console.log("\n🎟️  Aider Configuration\n");
  console.log("Option 1: Environment variables\n");
  console.log(`  export OPENAI_API_KEY=${apiKey}`);
  console.log(`  export OPENAI_API_BASE=${baseUrl}\n`);
  console.log("  Then run:");
  console.log("  aider --model openai/anthropic/claude-sonnet-4\n");
  console.log("Option 2: Command line arguments\n");
  console.log(`  aider --openai-api-key ${apiKey} \\`);
  console.log(`        --openai-api-base ${baseUrl} \\`);
  console.log("        --model openai/anthropic/claude-sonnet-4\n");
  console.log("Option 3: .aider.conf.yml (project root)\n");
  console.log("```yaml");
  console.log(`openai-api-key: ${apiKey}`);
  console.log(`openai-api-base: ${baseUrl}`);
  console.log("model: openai/anthropic/claude-sonnet-4");
  console.log("```\n");
  console.log("Note: Aider uses 'openai/' prefix for OpenAI-compatible endpoints.");
  console.log("Available models: openai/anthropic/claude-opus-4, openai/openai/gpt-4o, etc.\n");
}
