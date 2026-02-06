/**
 * Gate auto-discovery and failover.
 *
 * Fetches available Gates from token2.cash/gates.json,
 * tracks health per Gate, and selects the best one per request.
 */

export interface GateEntry {
  name: string;
  url: string;
  mint: string;
  providers: string[];
  models: string[];
  markup: string;
  description: string;
}

interface GateHealth {
  healthy: boolean;
  failCount: number;
  lastFailure: number;
  lastSuccess: number;
}

const DISCOVERY_URL = "https://token2.cash/gates.json";
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const CIRCUIT_OPEN_MS = 60_000; // 1 minute circuit breaker
const MAX_FAIL_COUNT = 3;

export class GateRegistry {
  private gates: GateEntry[] = [];
  private health = new Map<string, GateHealth>();
  private lastFetch = 0;
  private primaryUrl: string;
  private discoveryUrl: string;

  constructor(primaryUrl: string, discoveryUrl: string = DISCOVERY_URL) {
    this.primaryUrl = primaryUrl;
    this.discoveryUrl = discoveryUrl;
  }

  /**
   * Fetch gates.json and update registry.
   * Cached for CACHE_TTL_MS.
   */
  async discover(): Promise<GateEntry[]> {
    const now = Date.now();
    if (this.gates.length > 0 && now - this.lastFetch < CACHE_TTL_MS) {
      return this.gates;
    }

    try {
      const res = await fetch(this.discoveryUrl, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = (await res.json()) as { gates?: GateEntry[] };
        if (data.gates && Array.isArray(data.gates)) {
          this.gates = data.gates;
          this.lastFetch = now;
        }
      }
    } catch {
      // Discovery failed — keep existing cache or fall back to primary
    }

    // Ensure primary gate is always in the list
    if (!this.gates.some((g) => g.url === this.primaryUrl)) {
      this.gates.unshift({
        name: "primary",
        url: this.primaryUrl,
        mint: "",
        providers: [],
        models: ["*"],
        markup: "0%",
        description: "Configured primary gate",
      });
    }

    return this.gates;
  }

  /**
   * Select the best gate for a given model.
   * Priority: primary gate > healthy gates that support the model > any healthy gate.
   */
  async selectGate(model?: string): Promise<string[]> {
    await this.discover();

    const now = Date.now();
    const candidates: GateEntry[] = [];

    // Primary first if healthy
    const primaryEntry = this.gates.find((g) => g.url === this.primaryUrl);
    if (primaryEntry && this.isHealthy(primaryEntry.url, now)) {
      candidates.push(primaryEntry);
    }

    // Then other healthy gates
    for (const gate of this.gates) {
      if (gate.url === this.primaryUrl) continue;
      if (!this.isHealthy(gate.url, now)) continue;

      // Check model support
      if (model && gate.models.length > 0) {
        const supports = gate.models.some(
          (m) => m === "*" || m.includes("*") || model.includes(m) || m.includes(model.split("/").pop()!),
        );
        if (!supports) continue;
      }

      candidates.push(gate);
    }

    // If primary was unhealthy, add it as last resort
    if (primaryEntry && !this.isHealthy(primaryEntry.url, now)) {
      candidates.push(primaryEntry);
    }

    // Ensure at least primary is returned
    if (candidates.length === 0) {
      return [this.primaryUrl];
    }

    return candidates.map((g) => g.url);
  }

  /**
   * Mark a gate as having failed.
   */
  markFailed(gateUrl: string): void {
    const h = this.getHealth(gateUrl);
    h.healthy = false;
    h.failCount++;
    h.lastFailure = Date.now();
  }

  /**
   * Mark a gate as having succeeded.
   */
  markSuccess(gateUrl: string): void {
    const h = this.getHealth(gateUrl);
    h.healthy = true;
    h.failCount = 0;
    h.lastSuccess = Date.now();
  }

  /**
   * Get list of all known gates with health status.
   */
  getAll(): Array<GateEntry & { healthy: boolean }> {
    const now = Date.now();
    return this.gates.map((g) => ({
      ...g,
      healthy: this.isHealthy(g.url, now),
    }));
  }

  private isHealthy(gateUrl: string, now: number): boolean {
    const h = this.health.get(gateUrl);
    if (!h) return true; // Unknown = healthy (optimistic)
    if (h.healthy) return true;
    // Circuit breaker: re-try after CIRCUIT_OPEN_MS
    if (h.failCount >= MAX_FAIL_COUNT && now - h.lastFailure < CIRCUIT_OPEN_MS) {
      return false;
    }
    return true; // Half-open: allow retry
  }

  private getHealth(gateUrl: string): GateHealth {
    let h = this.health.get(gateUrl);
    if (!h) {
      h = { healthy: true, failCount: 0, lastFailure: 0, lastSuccess: 0 };
      this.health.set(gateUrl, h);
    }
    return h;
  }
}
