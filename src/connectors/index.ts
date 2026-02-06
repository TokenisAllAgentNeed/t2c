/**
 * Connectors index
 *
 * Registry of all available connectors for t2c connect
 */
export type { Connector } from "./interface.js";
export { openclawConnector } from "./openclaw.js";
export { cursorConnector } from "./cursor.js";
export { envConnector } from "./env.js";

import { openclawConnector } from "./openclaw.js";
import { cursorConnector } from "./cursor.js";
import { envConnector } from "./env.js";
import type { Connector } from "./interface.js";

/**
 * Registry of all available connectors.
 * Maps connector ID to connector instance.
 */
export const connectors = new Map<string, Connector>([
  [openclawConnector.id, openclawConnector],
  [cursorConnector.id, cursorConnector],
  [envConnector.id, envConnector],
]);

/**
 * Get a connector by its ID.
 * @param id - The unique identifier of the connector
 * @returns The connector instance, or undefined if not found
 */
export function getConnector(id: string): Connector | undefined {
  return connectors.get(id);
}

/**
 * List all available connector IDs.
 * @returns Array of connector IDs
 */
export function listConnectorIds(): string[] {
  return Array.from(connectors.keys());
}
