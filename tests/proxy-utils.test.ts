/**
 * Unit tests for proxy.ts pure utility functions:
 * - transformModelId: dash→slash model ID transformation
 * - parseRetryAfter: Retry-After header parsing
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transformModelId, parseRetryAfter } from "../src/proxy.js";

describe("transformModelId", () => {
  it("transforms anthropic model", () => {
    expect(transformModelId("anthropic-claude-sonnet-4.5")).toBe(
      "anthropic/claude-sonnet-4.5"
    );
  });

  it("transforms openai model", () => {
    expect(transformModelId("openai-gpt-4o")).toBe("openai/gpt-4o");
  });

  it("transforms google model", () => {
    expect(transformModelId("google-gemini-2.0-flash")).toBe(
      "google/gemini-2.0-flash"
    );
  });

  it("transforms deepseek model", () => {
    expect(transformModelId("deepseek-chat")).toBe("deepseek/chat");
  });

  it("transforms qwen model", () => {
    expect(transformModelId("qwen-qwen-2.5-72b")).toBe("qwen/qwen-2.5-72b");
  });

  it("transforms meta-llama model", () => {
    expect(transformModelId("meta-llama-llama-3.3-70b")).toBe(
      "meta-llama/llama-3.3-70b"
    );
  });

  it("transforms mistralai model", () => {
    expect(transformModelId("mistralai-mistral-large")).toBe(
      "mistralai/mistral-large"
    );
  });

  it("transforms nvidia model", () => {
    expect(transformModelId("nvidia-llama-3.1-nemotron")).toBe(
      "nvidia/llama-3.1-nemotron"
    );
  });

  it("transforms cohere model", () => {
    expect(transformModelId("cohere-command-r")).toBe("cohere/command-r");
  });

  it("transforms perplexity model", () => {
    expect(transformModelId("perplexity-sonar-pro")).toBe(
      "perplexity/sonar-pro"
    );
  });

  it("transforms moonshotai model", () => {
    expect(transformModelId("moonshotai-moonlight-16b")).toBe(
      "moonshotai/moonlight-16b"
    );
  });

  it("returns model unchanged if no known prefix", () => {
    expect(transformModelId("custom-model-v1")).toBe("custom-model-v1");
  });

  it("returns model unchanged if already has slash", () => {
    expect(transformModelId("anthropic/claude-sonnet-4.5")).toBe(
      "anthropic/claude-sonnet-4.5"
    );
  });

  it("returns empty string unchanged", () => {
    expect(transformModelId("")).toBe("");
  });

  it("only replaces first dash after prefix", () => {
    // "anthropic-claude-3-opus" should become "anthropic/claude-3-opus"
    expect(transformModelId("anthropic-claude-3-opus")).toBe(
      "anthropic/claude-3-opus"
    );
  });

  it("does not match partial prefix", () => {
    // "anthropicx-model" should not match "anthropic"
    expect(transformModelId("anthropicx-model")).toBe("anthropicx-model");
  });

  it("requires dash after prefix", () => {
    // Just the prefix alone, no dash → no match
    expect(transformModelId("anthropic")).toBe("anthropic");
  });
});

describe("parseRetryAfter", () => {
  it("returns null for null input", () => {
    expect(parseRetryAfter(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRetryAfter("")).toBeNull();
  });

  it("parses integer seconds", () => {
    const result = parseRetryAfter("5");
    expect(result).toBe(5000);
  });

  it("parses float seconds", () => {
    const result = parseRetryAfter("1.5");
    expect(result).toBe(1500); // Math.ceil(1500) = 1500
  });

  it("parses zero seconds", () => {
    const result = parseRetryAfter("0");
    expect(result).toBe(0);
  });

  it("clamps negative to zero", () => {
    const result = parseRetryAfter("-5");
    expect(result).toBe(0);
  });

  it("parses HTTP date format", () => {
    const futureDate = new Date(Date.now() + 10_000);
    const result = parseRetryAfter(futureDate.toUTCString());
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(11_000);
  });

  it("returns 0 for past HTTP date", () => {
    const pastDate = new Date(Date.now() - 10_000);
    const result = parseRetryAfter(pastDate.toUTCString());
    expect(result).toBe(0);
  });

  it("returns null for non-numeric non-date string", () => {
    expect(parseRetryAfter("not-a-number-or-date")).toBeNull();
  });

  it("handles Infinity", () => {
    // parseFloat("Infinity") returns Infinity, which is !isFinite
    expect(parseRetryAfter("Infinity")).toBeNull();
  });

  it("handles NaN string", () => {
    expect(parseRetryAfter("NaN")).toBeNull();
  });

  it("parses large integer seconds", () => {
    const result = parseRetryAfter("120");
    expect(result).toBe(120_000);
  });
});
