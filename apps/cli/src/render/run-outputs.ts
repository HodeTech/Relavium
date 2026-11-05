import { sanitizeInline, sanitizeUntrusted } from './sanitize.js';

/**
 * The workflow's outputs on the HUMAN surfaces (MVP-A1): the `run` TUI final summary, the plain (no-TTY) line
 * renderer and `relavium logs <runId>`. `--json` is untouched — `run:completed` there already carries
 * `outputs` verbatim.
 *
 * **A new terminal sink for untrusted content, so it gets the whole floor.** An output value is whatever the
 * last node produced — model text, a tool result, an authored literal — so every value goes through
 * {@link sanitizeUntrusted} (secret shapes masked on the ORIGINAL text, then terminal controls stripped) before
 * it is laid out. Keys are authored ids, so they get the one-line {@link sanitizeInline}. A secret input the
 * engine already masked (`{ secret: true, ref }`) is rendered as that masked object, never unwrapped.
 *
 * **Bounded.** A value shows at most {@link MAX_VALUE_LINES} lines and {@link MAX_VALUE_CHARS} code points,
 * and the whole block at most {@link MAX_TOTAL_CHARS}; what is cut is counted and points at the full record
 * (`relavium logs <runId> --json`). Every value line is indented under its key, so a multi-line value cannot
 * forge a row at the summary's own indentation.
 */

/** Lines shown per output value before the rest is counted, not printed. */
export const MAX_VALUE_LINES = 40;
/** Code points shown per output value. */
export const MAX_VALUE_CHARS = 4000;
/** Code points shown across every output value of one run. */
export const MAX_TOTAL_CHARS = 12_000;

/**
 * The outputs block as lines, each already prefixed with `indent`. Empty when there are no outputs. `runId`
 * names the full record in a truncation note; absent ⇒ the note names `relavium logs <runId> --json`.
 */
export function formatRunOutputs(
  outputs: Readonly<Record<string, unknown>>,
  indent: string,
  runId?: string,
): string[] {
  const keys = Object.keys(outputs);
  if (keys.length === 0) return [];
  const lines = [`${indent}outputs:`];
  let budget = MAX_TOTAL_CHARS;
  let truncated = false;
  for (const key of keys) {
    const label = `${indent}  ${sanitizeInline(key)}:`;
    if (budget <= 0) {
      lines.push(`${label} …`);
      truncated = true;
      continue;
    }
    const text = sanitizeUntrusted(valueText(outputs[key]));
    const shown = clip(text, Math.min(MAX_VALUE_CHARS, budget));
    budget -= shown.chars;
    truncated ||= shown.truncated;
    const rows = shown.text.split('\n');
    if (rows.length === 1 && !shown.truncated) {
      lines.push(`${label} ${rows[0] ?? ''}`);
      continue;
    }
    lines.push(label);
    for (const row of rows) lines.push(`${indent}    ${row}`);
    if (shown.truncated) lines.push(`${indent}    …`);
  }
  if (truncated) {
    const id = runId === undefined ? '<runId>' : sanitizeInline(runId);
    lines.push(`${indent}  (outputs shortened — the full record: \`relavium logs ${id} --json\`)`);
  }
  return lines;
}

/** A string as itself; anything else as compact JSON (a masked secret stays the masked object). */
function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A value JSON cannot represent (a cycle, a BigInt) — said, not thrown: the summary must still print.
    return '[unrepresentable value]';
  }
}

/** Keep at most `maxChars` code points and {@link MAX_VALUE_LINES} lines, never splitting a code point. */
function clip(
  text: string,
  maxChars: number,
): { readonly text: string; readonly chars: number; readonly truncated: boolean } {
  const points = Array.from(text);
  let end = Math.min(points.length, Math.max(maxChars, 0));
  let newlines = 0;
  for (let index = 0; index < end; index += 1) {
    if (points[index] === '\n' && ++newlines === MAX_VALUE_LINES) {
      end = index;
      break;
    }
  }
  return { text: points.slice(0, end).join(''), chars: end, truncated: end < points.length };
}
