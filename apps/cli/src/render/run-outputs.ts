import { MEMBER_MASK, maskText, maskedAsMember, scrubLeaves } from './output-masking.js';
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
 * field's into a false match. A leaf alone cannot show a shape whose name is the member's KEY (`"x-api-key": "…"`),
 * so each member with a primitive value, a top-level output included, also has its NAME read: as the one-member JSON
 * text `{"<key>":"v"}` with a stand-in value, the form the scrubber reads in a serialized object. When the scrubber
 * masks the stand-in, the member's value is masked whole, unless the name is a secret shape of its own that the
 * scrubber masks up to its end (`Basic plan`): that name is not a label. The value's own text never joins its name
 * or a neighbour, so it cannot turn a token already masked in place into a whole-value mask. Top-level keys are
 * authored ids, so they get the one-line {@link sanitizeInline}. A secret input the engine already masked (`{ secret: true, ref }`)
 * is rendered as that masked object, never unwrapped. The masking rules themselves live in `output-masking.ts`, the one
 * seam this summary and the node page's output preview both mask through.
 *
 * Outputs are the run's deliverable, not a diagnostic, so they do NOT get `sanitizeUntrusted`'s whole-text
 * fallback, which blanks a diagnostic outright when its fragments join into a shape once whitespace is removed: on
 * ordinary prose (a bare `https://host` and a later `@handle`) that blanked the whole result. The shared scrubber's
 * own normalized views still apply. A value that was masked says so, with the same pointer to the exact record.
 *
 * **Bounded.** A value shows at most {@link MAX_VALUE_LINES} lines and {@link MAX_VALUE_CHARS} code points, and
 * the values of the whole block at most {@link MAX_TOTAL_CHARS} code points between them; what is cut is counted and
 * points at the full record (`relavium logs <runId> --json`). The bound is on VALUE text, as the reference states it
 * (commands.md: "12,000 characters per run"): a key is the workflow's own output id, shown as written on one row
 * ({@link sanitizeInline}), so the labels are not counted, and a key the budget has no room for is still listed, with
 * `…`, so that no output disappears unsaid. Every value line is indented under its key, so a hard line break in a value
 * cannot forge a row at the summary's own indentation. A row longer than the terminal is wide still soft-wraps to
 * column 0; wrapping value rows at the terminal width is a recorded follow-up (deferred-tasks.md).
 */

/** Lines shown per output value before the rest is counted, not printed. */
export const MAX_VALUE_LINES = 40;
/** Code points shown per output value. */
export const MAX_VALUE_CHARS = 4000;
/** Code points of VALUE text shown across every output of one run; the keys are not counted. */
export const MAX_TOTAL_CHARS = 12_000;
/** What a value that is empty (an empty string, or only newlines) shows beside its key, so a key never ends in a bare colon. */
const EMPTY_VALUE = '(empty)';

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
    const output = renderOutput(key, outputs[key], label, indent, budget);
    for (const line of output.lines) lines.push(line);
    budget -= output.chars;
    masked ||= output.masked;
    truncated ||= output.truncated;
  }
  if (truncated || masked) {
    const id = runId === undefined ? '<runId>' : sanitizeInline(runId);
    lines.push(
      `${indent}  (outputs ${noteCause(truncated, masked)} — the full record: \`relavium logs ${id} --json\`)`,
    );
  }
  return lines;
}

/** What one output contributes to the block: its lines, the value text it spent, and whether it was cut or masked. */
interface RenderedOutput {
  readonly lines: readonly string[];
  readonly chars: number;
  readonly truncated: boolean;
  readonly masked: boolean;
}

/** One output under `label`: a value that fits on one row sits beside its key, any other goes below it, indented, with a cut marked. */
function renderOutput(
  key: string,
  value: unknown,
  label: string,
  indent: string,
  budget: number,
): RenderedOutput {
  const display = displayValue(key, value);
  // A final newline ends the value; it is not an empty last row, and it does not count toward the line bound.
  const shown = clip(withoutFinalNewlines(display.text), Math.min(MAX_VALUE_CHARS, budget));
  const spent = { chars: shown.chars, truncated: shown.truncated, masked: display.masked };
  const rows = shown.text.split('\n');
  if (rows.length === 1 && !shown.truncated) {
    const row = rows[0] ?? '';
    return { ...spent, lines: [`${label} ${row === '' ? EMPTY_VALUE : row}`] };
  }
  const lines = [label, ...rows.map((row) => `${indent}    ${row}`)];
  if (shown.truncated) lines.push(`${indent}    …`);
  return { ...spent, lines };
}

/**
 * `text` without its final run of newlines. A loop, not `/\n+$/`: that pattern retries from every newline of a long
 * run that is NOT at the end, which is quadratic in the run's length.
 */
function withoutFinalNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.codePointAt(end - 1) === 0x0a) end -= 1;
  return text.slice(0, end);
}

/** What the closing note says happened to the block. */
function noteCause(truncated: boolean, masked: boolean): string {
  if (truncated && masked) return 'shortened and masked';
  return truncated ? 'shortened' : 'masked';
}

/**
 * Output `key`'s value as display text: secret shapes masked on the original text, then terminal controls stripped.
 * A string is itself; anything else is compact JSON over a copy whose every string — keys included — was masked
 * first (see the module note). A primitive value's output key is also read, as a nested member's is.
 * `masked` says whether anything was masked.
 */
function displayValue(
  key: string,
  value: unknown,
): { readonly text: string; readonly masked: boolean } {
  let masked = false;
  const onMask = (): void => {
    masked = true;
  };
  const scrub = (text: string): string => maskText(text, onMask);
  if (typeof value === 'string') {
    const shown = maskedAsMember(key, scrub(value), onMask);
    return { text: stripTerminalControls(typeof shown === 'string' ? shown : MEMBER_MASK), masked };
  }
  try {
    const json = JSON.stringify(
      maskedAsMember(key, scrubLeaves(value, scrub, onMask, new Set()), onMask),
    );
    return { text: stripTerminalControls(json ?? String(value)), masked };
  } catch {
    // A value JSON cannot represent (a cycle, a BigInt, nesting too deep) — said, not thrown: the summary must
    // still print.
    return { text: '[unrepresentable value]', masked: false };
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
