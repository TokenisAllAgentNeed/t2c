/**
 * Environment adapter - Generate env vars for generic OpenAI-compatible tools
 */
import type { T2CConfig, AdapterConfigOptions } from "../config.js";

export async function envAdapter(t2cConfig: T2CConfig, opts: AdapterConfigOptions): Promise<void> {
  const baseUrl = `http://127.0.0.1:${t2cConfig.proxyPort}/v1`;
  const apiKey = opts.proxySecret ?? "t2c-local";

  if (opts.json) {
    console.log(JSON.stringify({
      OPENAI_API_KEY: apiKey,
      OPENAI_BASE_URL: baseUrl,
    }, null, 2));
    return;
  }

  console.log("\n🎟️  Environment Variables\n");
  console.log("For any OpenAI-compatible tool, set these environment variables:\n");
  console.log(`  export OPENAI_API_KEY=${apiKey}`);
  console.log(`  export OPENAI_BASE_URL=${baseUrl}\n`);
  console.log("Or in a .env file:\n");
  console.log(`  OPENAI_API_KEY=${apiKey}`);
  console.log(`  OPENAI_BASE_URL=${baseUrl}\n`);
  console.log("Model format: provider/model (e.g., anthropic/claude-sonnet-4)\n");
  console.log("These work with tools like:");
  console.log("  - LangChain");
  console.log("  - LlamaIndex");
  console.log("  - Continue.dev");
  console.log("  - Aider");
  console.log("  - Any OpenAI SDK-based application\n");
}
