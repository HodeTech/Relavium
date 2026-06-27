import type { McpContentPart, McpToolResult } from './connection.js';

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
  for (const item of rawContent) {
    if (isRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string') {
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
