/**
 * Gate discovery + failover tests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GateRegistry, type GateEntry } from "../src/gate-discovery.js";

const PRIMARY_URL = "https://gate.token2chat.com";

// Mock fetch to control responses
const mockGates: GateEntry[] = [
  {
    name: "primary",
    url: "https://gate.token2chat.com",
    mint: "https://mint.token2chat.com",
    providers: ["openai", "openrouter"],
    models: ["gpt-4o-mini", "gpt-4o", "claude-sonnet-4", "*"],
    markup: "0%",
    description: "Primary gate",
  },
  {
    name: "backup",
    url: "https://backup-gate.example.com",
    mint: "https://backup-mint.example.com",
    providers: ["openrouter"],
    models: ["gpt-4o-mini", "*"],
    markup: "5%",
    description: "Backup gate",
  },
];

describe("GateRegistry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns primary URL when discovery fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const registry = new GateRegistry(PRIMARY_URL);
    const urls = await registry.selectGate("gpt-4o-mini");
    expect(urls).toContain(PRIMARY_URL);
    vi.unstubAllGlobals();
  });

  it("discovers gates from token2.cash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ gates: mockGates }),
      }),
    );

    const registry = new GateRegistry(PRIMARY_URL);
    const gates = await registry.discover();
    expect(gates).toHaveLength(2);
    expect(gates[0].name).toBe("primary");
    expect(gates[1].name).toBe("backup");
    vi.unstubAllGlobals();
  });

  it("selects primary gate first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ gates: mockGates }),
      }),
    );

    const registry = new GateRegistry(PRIMARY_URL);
    const urls = await registry.selectGate("gpt-4o-mini");
    expect(urls[0]).toBe(PRIMARY_URL);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    vi.unstubAllGlobals();
  });

  it("marks failed gate and falls back to alternatives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ gates: mockGates }),
      }),
    );

    const registry = new GateRegistry(PRIMARY_URL);

    // Mark primary as failed multiple times
    registry.markFailed(PRIMARY_URL);
    registry.markFailed(PRIMARY_URL);
    registry.markFailed(PRIMARY_URL);

    const urls = await registry.selectGate("gpt-4o-mini");
    // Backup should come first since primary is unhealthy
    expect(urls[0]).toBe("https://backup-gate.example.com");
    // Primary should still be available as last resort
    expect(urls).toContain(PRIMARY_URL);
    vi.unstubAllGlobals();
  });

  it("marks success resets health", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ gates: mockGates }),
      }),
    );

    const registry = new GateRegistry(PRIMARY_URL);

    registry.markFailed(PRIMARY_URL);
    registry.markFailed(PRIMARY_URL);
    registry.markFailed(PRIMARY_URL);
    registry.markSuccess(PRIMARY_URL);

    const urls = await registry.selectGate("gpt-4o-mini");
    // Primary should be first again after success
    expect(urls[0]).toBe(PRIMARY_URL);
    vi.unstubAllGlobals();
  });

  it("ensures primary is always in gate list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          gates: [
            {
              name: "other",
              url: "https://other-gate.example.com",
              mint: "",
              providers: [],
              models: ["*"],
              markup: "0%",
              description: "Other",
            },
          ],
        }),
      }),
    );

    const registry = new GateRegistry(PRIMARY_URL);
    const gates = await registry.discover();
    expect(gates.some((g) => g.url === PRIMARY_URL)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("getAll returns gates with health status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ gates: mockGates }),
      }),
    );

    const registry = new GateRegistry(PRIMARY_URL);
    await registry.discover();
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all[0]).toHaveProperty("healthy");
    expect(all[0].healthy).toBe(true);
    vi.unstubAllGlobals();
  });

  it("caches discovery results", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ gates: mockGates }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const registry = new GateRegistry(PRIMARY_URL);
    await registry.discover();
    await registry.discover();

    // Should only fetch once due to caching
    expect(mockFetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
