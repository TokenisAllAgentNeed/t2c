/**
 * Continue adapter - Generate config for Continue.dev VS Code extension
 */
import type { T2CConfig, AdapterConfigOptions } from "../config.js";

export async function continueAdapter(
  t2cConfig: T2CConfig,
  opts: AdapterConfigOptions
): Promise<void> {
  const baseUrl = `http://127.0.0.1:${t2cConfig.proxyPort}/v1`;
  const apiKey = opts.proxySecret ?? "t2c-local";

  const modelConfig = {
    title: "Token2Chat",
    provider: "openai",
    model: "anthropic/claude-sonnet-4",
    apiBase: baseUrl,
    apiKey,
  };

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          models: [modelConfig],
        },
        null,
        2
      )
    );
    return;
  }

  console.log("\n🎟️  Continue Configuration\n");
  console.log("Add to ~/.continue/config.json:\n");
  console.log("```json");
  console.log("{");
  console.log('  "models": [');
  console.log("    {");
  console.log('      "title": "Token2Chat",');
  console.log('      "provider": "openai",');
  console.log('      "model": "anthropic/claude-sonnet-4",');
  console.log(`      "apiBase": "${baseUrl}",`);
  console.log(`      "apiKey": "${apiKey}"`);
  console.log("    }");
  console.log("  ]");
  console.log("}");
  console.log("```\n");
  console.log("For chat + autocomplete, add to tabAutocompleteModel as well:\n");
  console.log("```json");
  console.log("{");
  console.log('  "tabAutocompleteModel": {');
  console.log('    "title": "Token2Chat Autocomplete",');
  console.log('    "provider": "openai",');
  console.log('    "model": "anthropic/claude-sonnet-4",');
  console.log(`    "apiBase": "${baseUrl}",`);
  console.log('    "apiKey": "t2c-local"');
  console.log("  }");
  console.log("}");
  console.log("```\n");
  console.log("Available models: anthropic/claude-opus-4, openai/gpt-4o, etc.\n");
}
