import type { McpContentPart, McpToolResult } from './connection.js';
import { McpError } from './errors.js';
import { INGRESS_BOUNDS, utf8ByteLength } from './ingress-bounds.js';

/**
 * Shape a raw `tools/call` result into the Relavium `McpToolResult` — a pure, SDK-type-free transform read
 * STRUCTURALLY from `unknown` (the SDK's result is a union including a legacy `{ toolResult }` variant, and a
 * tool result is server-influenced, so structural reads are the robust + seam-clean choice). Text parts are
 * carried verbatim; non-text parts (image/audio/resource/…) record only their `kind` (the bytes are a later
 * concern). A non-`true` / absent `isError` is treated as `false`.
 */
export function shapeToolResult(raw: unknown): McpToolResult {
  const obj = isRecord(raw) ? raw : {};
  const rawContent = Array.isArray(obj['content']) ? obj['content'] : [];
  const content: McpContentPart[] = [];
  let textBytes = 0;
  for (const item of rawContent) {
    if (isRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string') {
      // **Bounded across the WHOLE result, not per part** (`#288`, ADR-0088 §5). A server that returns a
      // thousand parts of a kilobyte each is the same megabyte as one part of a megabyte, and a per-part
      // bound would have missed it entirely.
      textBytes += utf8ByteLength(item['text']);
      if (textBytes > INGRESS_BOUNDS.toolResultTextBytes) {
        // REJECTED, not truncated. Half a tool result flowing into the model reads as a complete answer —
        // the same reason ADR-0087 §2 refuses a half node output. The engine's own 50 KiB model-facing bound
        // still does its (different) job with spill; this one stops the host admitting what it can never show.
        throw new McpError(
          `MCP tool result text exceeds the maximum of ${INGRESS_BOUNDS.toolResultTextBytes} bytes`,
        );
      }
      content.push({ type: 'text', text: item['text'] });
    } else {
      const kind = isRecord(item) && typeof item['type'] === 'string' ? item['type'] : 'unknown';
      content.push({ type: 'non_text', kind });
    }
  }
  return { content, isError: obj['isError'] === true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
