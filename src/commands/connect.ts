/**
 * t2c connect <app> - Connect to a specific AI tool
 *
 * Uses the connector system to integrate with various tools.
 */
import { loadConfig, configExists, ConfigError } from "../config.js";
import { connectors, listConnectorIds, getConnector } from "../connectors/index.js";

export async function connectCommand(app: string): Promise<void> {
  // If no app specified or empty, list available connectors
  if (!app || app.trim() === "") {
    console.log("\n🎟️  Token2Chat Connect\n");
    console.log("Usage: t2c connect <app>\n");
    console.log("Available connectors:\n");

    for (const [id, connector] of connectors) {
      const detected = await connector.detect();
      const status = detected ? "✅" : "⚪";
      const desc = connector.description ? ` - ${connector.description}` : "";
      console.log(`  ${status} ${id.padEnd(12)} ${connector.name}${desc}`);
    }

    console.log("\nExamples:\n");
    console.log("  t2c connect openclaw   # Configure OpenClaw integration");
    console.log("  t2c connect env        # Show environment variables");
    console.log("  t2c connect cursor     # Configure Cursor IDE\n");
    return;
  }

  // Check if t2c is initialized
  const hasConfig = await configExists();
  if (!hasConfig) {
    throw new ConfigError(
      "Token2Chat not initialized. Run 't2c init' first to configure gate, mint, and wallet.",
      true // recoverable
    );
  }

  // Load config
  const config = await loadConfig();

  // Find the connector
  const connector = getConnector(app);
  if (!connector) {
    const available = listConnectorIds().join(", ");
    throw new ConfigError(
      `Unknown connector: ${app}. Available connectors: ${available}. Run 't2c connect' to see all options.`,
      true // recoverable
    );
  }

  // Run the connector
  await connector.connect(config);
}
