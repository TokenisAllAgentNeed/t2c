/**
 * Tests for SSE stream parser that extracts cashu-change events.
 */
import { describe, it, expect } from "vitest";
import { extractCashuChangeFromSSE } from "../src/proxy/sse-parser.js";

/**
 * Helper: encode a string into a Uint8Array.
 */
function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Helper: create a ReadableStream from an array of chunks.
 */
function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Helper: consume a ReadableStream into a single string.
 */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const parts: string[] = [];
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(decoder.decode(value, { stream: true }));
  }
  return parts.join("");
}

describe("extractCashuChangeFromSSE", () => {
  it("passes through a stream with no cashu-change events", async () => {
    const input = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n",
      "data: [DONE]\n\n",
    ];
    const stream = streamFromChunks(input.map(encode));

    const { filtered, changeToken } = extractCashuChangeFromSSE(stream);
    const output = await readAll(filtered);

    expect(output).toBe(input.join(""));
    expect(changeToken()).toBeUndefined();
  });

  it("extracts cashu-change event and removes it from stream", async () => {
    const input = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n",
      "event: cashu-change\ndata: cashuBchangeTokenABC123\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"!\"}}]}\n\n",
      "data: [DONE]\n\n",
    ];
    const stream = streamFromChunks(input.map(encode));

    const { filtered, changeToken } = extractCashuChangeFromSSE(stream);
    const output = await readAll(filtered);

    expect(output).not.toContain("cashu-change");
    expect(output).not.toContain("cashuBchangeTokenABC123");
    expect(output).toContain("Hi");
    expect(output).toContain("[DONE]");
    expect(changeToken()).toBe("cashuBchangeTokenABC123");
  });

  it("handles cashu-change event split across chunks", async () => {
    const chunks = [
      encode("data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\n"),
      encode("event: cashu-ch"),
      encode("ange\ndata: tokenXYZ\n\n"),
      encode("data: [DONE]\n\n"),
    ];
    const stream = streamFromChunks(chunks);

    const { filtered, changeToken } = extractCashuChangeFromSSE(stream);
    const output = await readAll(filtered);

    expect(changeToken()).toBe("tokenXYZ");
    expect(output).not.toContain("tokenXYZ");
    expect(output).toContain("[DONE]");
  });

  it("handles cashu-change event at the very end of stream", async () => {
    const input = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"done\"}}]}\n\n",
      "data: [DONE]\n\n",
      "event: cashu-change\ndata: lastToken\n\n",
    ];
    const stream = streamFromChunks(input.map(encode));

    const { filtered, changeToken } = extractCashuChangeFromSSE(stream);
    const output = await readAll(filtered);

    expect(changeToken()).toBe("lastToken");
    expect(output).not.toContain("lastToken");
  });

  it("handles empty stream", async () => {
    const stream = streamFromChunks([]);

    const { filtered, changeToken } = extractCashuChangeFromSSE(stream);
    const output = await readAll(filtered);

    expect(output).toBe("");
    expect(changeToken()).toBeUndefined();
  });

  it("flushes remaining buffer as non-cashu-change content", async () => {
    // Buffer that doesn't end with \n\n — triggers flush path
    const chunks = [
      encode("data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\n"),
      encode("data: partial"),  // No trailing \n\n — stays in buffer until flush
    ];
    const stream = streamFromChunks(chunks);

    const { filtered, changeToken } = extractCashuChangeFromSSE(stream);
    const output = await readAll(filtered);

    expect(output).toContain("data: partial");
    expect(changeToken()).toBeUndefined();
  });

  it("flushes remaining buffer containing cashu-change event", async () => {
    // cashu-change in buffer without trailing \n\n — triggers flush cashu-change path
    const chunks = [
      encode("data: hello\n\n"),
      encode("event: cashu-change\ndata: flushedToken"),  // No trailing \n\n
    ];
    const stream = streamFromChunks(chunks);

    const { filtered, changeToken } = extractCashuChangeFromSSE(stream);
    const output = await readAll(filtered);

    expect(output).toContain("hello");
    expect(output).not.toContain("flushedToken");
    expect(changeToken()).toBe("flushedToken");
  });

  it("handles token with leading/trailing whitespace", async () => {
    const input = [
      "event: cashu-change\ndata:   spacedToken   \n\n",
      "data: [DONE]\n\n",
    ];
    const stream = streamFromChunks(input.map(encode));

    const { filtered, changeToken } = extractCashuChangeFromSSE(stream);
    await readAll(filtered);

    expect(changeToken()).toBe("spacedToken");
  });

  it("handles multiple blocks in single chunk", async () => {
    const combined = "data: first\n\ndata: second\n\ndata: [DONE]\n\n";
    const stream = streamFromChunks([encode(combined)]);

    const { filtered, changeToken } = extractCashuChangeFromSSE(stream);
    const output = await readAll(filtered);

    expect(output).toContain("first");
    expect(output).toContain("second");
    expect(output).toContain("[DONE]");
    expect(changeToken()).toBeUndefined();
  });

  it("only extracts the first cashu-change event", async () => {
    const input = [
      "event: cashu-change\ndata: first\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
      "event: cashu-change\ndata: second\n\n",
      "data: [DONE]\n\n",
    ];
    const stream = streamFromChunks(input.map(encode));

    const { filtered, changeToken } = extractCashuChangeFromSSE(stream);
    const output = await readAll(filtered);

    expect(changeToken()).toBe("first");
    // Second cashu-change should also be stripped
    expect(output).not.toContain("cashu-change");
    expect(output).not.toContain("first");
    expect(output).not.toContain("second");
  });
});
