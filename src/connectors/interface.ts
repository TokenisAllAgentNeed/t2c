/**
 * Connector interface for t2c connect command
 *
 * Connectors handle integration with specific AI tools.
 */
import type { T2CConfig } from "../config.js";

export interface Connector {
  /** Unique identifier (used in CLI) */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description for --help output */
  description?: string;

  /** Check if this tool is installed/available */
  detect(): Promise<boolean>;

  /** Connect t2c to this tool (configure, patch, etc.) */
  connect(config: T2CConfig): Promise<void>;

  /** Verify the connection works (optional) */
  verify?(): Promise<boolean>;
}
