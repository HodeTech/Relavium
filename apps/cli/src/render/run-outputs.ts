import { scrubSecrets } from '@relavium/llm/scrub-secrets';

import { sanitizeInline, stripTerminalControls } from './sanitize.js';

/**
 * The workflow's outputs on the HUMAN surfaces (MVP-A1): the `run` TUI final summary, the plain (no-TTY) line
 * renderer and `relavium logs <runId>`. `--json` is untouched — `run:completed` there already carries
 * `outputs` verbatim.
 *
 * **A new terminal sink for untrusted content.** An output value is whatever the last node produced — model text,
 * a tool result, an authored literal. Its secret shapes are masked by the shared scrubber on the ORIGINAL text,
 * and only then are terminal controls stripped. A value that is not a string is masked **leaf by leaf, before it is
 * serialized**: `JSON.stringify` turns a newline into the two characters `\n`, and a key right after it would then
 * have no word boundary for the scrubber to see. Masking leaves also keeps one field's text from joining the next
 * field's into a false match. Keys are authored ids, so they get the one-line {@link sanitizeInline}. A secret
 * input the engine already masked (`{ secret: true, ref }`) is rendered as that masked object, never unwrapped.
 *
 * Outputs are the run's deliverable, not a diagnostic, so they do NOT get `sanitizeUntrusted`'s whole-text
 * fallback, which blanks a diagnostic outright when its fragments join into a shape once whitespace is removed: on
 * ordinary prose (a bare `https://host` and a later `@handle`) that blanked the whole result. The shared scrubber's
 * own normalized views still apply. A value that was masked says so, with the same pointer to the exact record.
 *
 * **Bounded.** A value shows at most {@link MAX_VALUE_LINES} lines and {@link MAX_VALUE_CHARS} code points,
 * and the whole block at most {@link MAX_TOTAL_CHARS}; what is cut is counted and points at the full record
 * (`relavium logs <runId> --json`). Every value line is indented under its key, so a hard line break in a value
 * cannot forge a row at the summary's own indentation. A row longer than the terminal is wide still soft-wraps to
 * column 0; wrapping value rows at the terminal width is a recorded follow-up (deferred-tasks.md).
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
  let masked = false;
  for (const key of keys) {
    const label = `${indent}  ${sanitizeInline(key)}:`;
    if (budget <= 0) {
      lines.push(`${label} …`);
      truncated = true;
      continue;
    }
    const value = displayValue(outputs[key]);
    masked ||= value.masked;
    // A final newline ends the value; it is not an empty last row, and it does not count toward the line bound.
    const shown = clip(value.text.replace(/\n+$/u, ''), Math.min(MAX_VALUE_CHARS, budget));
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
  if (truncated || masked) {
    const id = runId === undefined ? '<runId>' : sanitizeInline(runId);
    lines.push(
      `${indent}  (outputs ${noteCause(truncated, masked)} — the full record: \`relavium logs ${id} --json\`)`,
    );
  }
  return lines;
}

/** What the closing note says happened to the block. */
function noteCause(truncated: boolean, masked: boolean): string {
  if (truncated && masked) return 'shortened and masked';
  return truncated ? 'shortened' : 'masked';
}

/**
 * One output value as display text: secret shapes masked on the original text, then terminal controls stripped. A
 * string is itself; anything else is compact JSON over a copy whose every string — keys included — was masked
 * first (see the module note). `masked` says whether the scrubber changed anything.
 */
function displayValue(value: unknown): { readonly text: string; readonly masked: boolean } {
  let masked = false;
  const scrub = (text: string): string => {
    const out = scrubSecrets(text);
    if (out !== text) masked = true;
    return out;
  };
  if (typeof value === 'string') return { text: stripTerminalControls(scrub(value)), masked };
  try {
    const json = JSON.stringify(scrubLeaves(value, scrub, new Set()));
    return { text: stripTerminalControls(json ?? String(value)), masked };
  } catch {
    // A value JSON cannot represent (a cycle, a BigInt, nesting too deep) — said, not thrown: the summary must
    // still print.
    return { text: '[unrepresentable value]', masked: false };
  }
}

/**
 * A copy of `value` with every string, and every object key, passed through `scrub`. It follows `JSON.stringify`'s
 * own reading of an object that defines `toJSON`, and throws on a cycle, as `JSON.stringify` would.
 */
function scrubLeaves(
  value: unknown,
  scrub: (text: string) => string,
  ancestors: Set<object>,
): unknown {
  if (typeof value === 'string') return scrub(value);
  if (typeof value !== 'object' || value === null) return value;
  if (hasToJson(value)) return scrubLeaves(value.toJSON(), scrub, ancestors);
  if (ancestors.has(value)) throw new TypeError('a cyclic output value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => scrubLeaves(item, scrub, ancestors));
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[scrub(key)] = scrubLeaves(item, scrub, ancestors);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function hasToJson(value: object): value is { toJSON: () => unknown } {
  return 'toJSON' in value && typeof value.toJSON === 'function';
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
