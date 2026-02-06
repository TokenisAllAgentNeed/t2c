/**
 * SSE stream parser that extracts cashu-change events.
 *
 * The Gate emits change tokens via `event: cashu-change` SSE events
 * during streaming responses. This parser intercepts those events,
 * extracts the token, and filters them out so they are not forwarded
 * to the AI tool.
 */

export interface SSEFilterResult {
  /** The filtered stream with cashu-change events removed. */
  filtered: ReadableStream<Uint8Array>;
  /** Returns the extracted change token (available after stream is consumed). */
  changeToken: () => string | undefined;
}

/**
 * Create a TransformStream that filters out `event: cashu-change` SSE events
 * and captures the token data.
 */
export function extractCashuChangeFromSSE(
  input: ReadableStream<Uint8Array>,
): SSEFilterResult {
  let token: string | undefined;
  const decoder = new TextDecoder();
  let buffer = "";

  const filtered = new ReadableStream<Uint8Array>({
    async start() {},
    async pull(controller) {
      // This is handled via piping below
    },
    cancel() {},
  });

  // Use a TransformStream approach
  const encoder = new TextEncoder();
  let resolveReady: (() => void) | null = null;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // Process complete SSE blocks (separated by \n\n)
      while (true) {
        const blockEnd = buffer.indexOf("\n\n");
        if (blockEnd === -1) break;

        const block = buffer.slice(0, blockEnd + 2);
        buffer = buffer.slice(blockEnd + 2);

        // Check if this block is a cashu-change event
        if (isCashuChangeBlock(block)) {
          // Extract the token from "data: <token>\n"
          const dataMatch = block.match(/^data:\s*(.+)$/m);
          if (dataMatch && !token) {
            token = dataMatch[1].trim();
          }
          // Don't forward this block
          continue;
        }

        // Forward non-cashu-change blocks
        controller.enqueue(encoder.encode(block));
      }
    },

    flush(controller) {
      // Flush any remaining buffer
      if (buffer.length > 0) {
        // Check if remaining buffer is a cashu-change event
        if (isCashuChangeBlock(buffer)) {
          const dataMatch = buffer.match(/^data:\s*(.+)$/m);
          if (dataMatch && !token) {
            token = dataMatch[1].trim();
          }
        } else {
          controller.enqueue(encoder.encode(buffer));
        }
        buffer = "";
      }
    },
  });

  const outputStream = input.pipeThrough(transform);

  return {
    filtered: outputStream,
    changeToken: () => token,
  };
}

/**
 * Check if an SSE block is a cashu-change event.
 */
function isCashuChangeBlock(block: string): boolean {
  // An SSE block with event: cashu-change
  return /^event:\s*cashu-change\s*$/m.test(block);
}
