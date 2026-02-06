/**
 * Environment Variables Connector
 *
 * Outputs environment variables for use with any OpenAI-compatible tool.
 */
import { type T2CConfig, loadOrCreateProxySecret } from "../config.js";
import type { Connector } from "./interface.js";

export const envConnector: Connector = {
  id: "env",
  name: "Environment Variables",
  description: "Show environment variables for OpenAI-compatible tools",

  async detect(): Promise<boolean> {
    // Always available
    return true;
  },

  async connect(config: T2CConfig): Promise<void> {
    const baseUrl = `http://127.0.0.1:${config.proxyPort}/v1`;
    const apiKey = await loadOrCreateProxySecret();

    console.log("\n🎟️  Environment Variables\n");
    console.log("   Add these to your shell profile (~/.bashrc, ~/.zshrc):\n");
    console.log(`   export OPENAI_API_BASE="${baseUrl}"`);
    console.log(`   export OPENAI_BASE_URL="${baseUrl}"`);
    console.log(`   export OPENAI_API_KEY="${apiKey}"\n`);
    console.log("   Or set them in a .env file:\n");
    console.log(`   OPENAI_API_BASE=${baseUrl}`);
    console.log(`   OPENAI_BASE_URL=${baseUrl}`);
    console.log(`   OPENAI_API_KEY=${apiKey}\n`);
    console.log("   Compatible with:\n");
    console.log("   - LangChain / LangGraph");
    console.log("   - LlamaIndex");
    console.log("   - Aider");
    console.log("   - Continue.dev");
    console.log("   - Any OpenAI SDK-based tool\n");
  },

  async verify(): Promise<boolean> {
    const secret = await loadOrCreateProxySecret();
    return process.env.OPENAI_API_KEY === secret;
  },
};
