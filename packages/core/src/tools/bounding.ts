/**
 * Model-facing result bounding (1.T — the deferred tool-output-gate). Bounds the result that re-enters
 * the next `LlmRequest` so one oversized `read_file` / `http_request` / MCP result cannot blow the next
 * request's context window (a cost/DoS surface the pre-egress governor — ADR-0028 — cannot see). The
 * bound is **model-facing only**: the registry applies `output_mapping` to the FULL result first, so
 * workflow state keeps the real value; only the model-facing copy is bounded here. The ceiling is a
 * **byte/line** bound (no token count — that needs a provider tokenizer, breaking engine purity). Over
 * the ceiling, the full text is spilled to the host's run-scoped output store (reclaimed at the run's
 * terminal event) and the model gets a bounded preview + an explicit truncation marker + the spill path.
 * See [tool-registry.md](../../../../docs/reference/shared-core/tool-registry.md#result-bounding-and-spill-to-file).
 */

import type { AbortSignalLike } from '@relavium/shared';

import type { ToolHost, ToolResultLimits } from './types.js';

export interface BoundedResult {
  /** The model-facing value: the original result when within limits, else a preview string + marker. */
  readonly value: unknown;
  readonly truncated: boolean;
  /** A short, single-line display summary for the event `outputSummary` (always bounded). */
  readonly summary: string;
}

/** Display cap (chars) for the event `outputSummary` — distinct from the model-facing ceiling. */
const SUMMARY_MAX = 500;

/** UTF-8 byte length without `TextEncoder` (kept dependency- and global-free for engine purity). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // a surrogate pair encodes one 4-byte code point
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) {
      lines++;
    }
  }
  return lines;
}

/** Render any result to the text the model would see (a string is itself; else compact JSON). */
function toText(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (result === undefined) {
    return '';
  }
  try {
    // JSON.stringify returns undefined for a value with no JSON form (a bare function/symbol); the `??`
    // keeps a string without falling back to a `[object Object]`-style default stringification.
    return JSON.stringify(result) ?? '[unserializable]';
  } catch {
    return '[unserializable]'; // circular reference / throwing toJSON
  }
}

function makeSummary(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= SUMMARY_MAX ? oneLine : `${oneLine.slice(0, SUMMARY_MAX)}…`;
}

function makePreview(text: string, limits: ToolResultLimits): string {
  // A char budget proxies the byte ceiling for the preview (the model only needs a readable window).
  const budget = Math.max(0, limits.maxBytes);
  if (text.length <= budget) {
    return text;
  }
  const head = text.slice(0, Math.floor(budget * 0.7));
  const tail = text.slice(text.length - Math.floor(budget * 0.3));
  return `${head}\n…\n${tail}`;
}

/**
 * Bound the model-facing result. Within the ceiling → the original result, untouched. Over the ceiling
 * → a preview + marker; the full text is spilled to `host.outputStore` (its own capability, so bounding
 * works even on a host with no filesystem). The full result for `output_mapping` is handled by the
 * registry, never here.
 *
 * Note: a genuinely streamed huge source is bounded by its host capability at the boundary (it returns
 * an already-bounded payload); this helper bounds the in-memory result a `dispatch` returns.
 */
export async function boundForModel(
  result: unknown,
  limits: ToolResultLimits,
  host: ToolHost,
  signal?: AbortSignalLike,
): Promise<BoundedResult> {
  const text = toText(result);
  const summary = makeSummary(text);
  const bytes = utf8ByteLength(text);
  const lines = countLines(text);

  if (bytes <= limits.maxBytes && lines <= limits.maxLines) {
    return { value: result, truncated: false, summary };
  }

  let ref: string | undefined;
  if (host.outputStore) {
    const spilled = await host.outputStore.spill(text, limits, signal);
    ref = spilled.ref;
  }
  const marker =
    ref === undefined
      ? `\n\n[… truncated: ${bytes} bytes / ${lines} lines; full output unavailable (no output store) …]`
      : `\n\n[… truncated: ${bytes} bytes / ${lines} lines; full output at ${ref} …]`;
  return { value: makePreview(text, limits) + marker, truncated: true, summary };
}
