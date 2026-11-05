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
 * field's into a false match. A leaf alone cannot show a shape whose name is the member's KEY (`"x-api-key": "…"`),
 * so each member with a primitive value, a top-level output included, also has its NAME read: as the one-member JSON
 * text `{"<key>":"v"}` with a stand-in value, the form the scrubber reads in a serialized object. When the scrubber
 * masks the stand-in, the member's value is masked whole, unless the name is a secret shape of its own that the
 * scrubber masks up to its end (`Basic plan`): that name is not a label. The value's own text never joins its name
 * or a neighbour, so it cannot turn a token already masked in place into a whole-value mask. Top-level keys are
 * authored ids, so they get the one-line {@link sanitizeInline}. A secret input the engine already masked (`{ secret: true, ref }`)
 * is rendered as that masked object, never unwrapped.
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

/** The text a member masked whole shows — the shared scrubber's own mask. */
const MEMBER_MASK = '[REDACTED]';
/** The stand-in value a member's name is read with: one character, which the scrubber's header rule masks. */
const NAME_PROBE = 'v';

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
    const value = displayValue(key, outputs[key]);
    masked ||= value.masked;
    // A final newline ends the value; it is not an empty last row, and it does not count toward the line bound.
    const shown = clip(withoutFinalNewlines(value.text), Math.min(MAX_VALUE_CHARS, budget));
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

/**
 * `text` without its final run of newlines. A loop, not `/\n+$/`: that pattern retries from every newline of a long
 * run that is NOT at the end, which is quadratic in the run's length.
 */
function withoutFinalNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x0a) end -= 1;
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
  const scrub = (text: string): string => {
    const out = scrubSecrets(text);
    if (out !== text) onMask();
    return out;
  };
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

/**
 * A copy of `value` with every string, and every object key, passed through `scrub`, and every object member with a
 * primitive value masked whole when its name labels a credential (see the module note). It follows `JSON.stringify`'s
 * own reading of an object that defines `toJSON`, and throws on a cycle, as `JSON.stringify` would.
 */
function scrubLeaves(
  value: unknown,
  scrub: (text: string) => string,
  onMask: () => void,
  ancestors: Set<object>,
): unknown {
  if (typeof value === 'string') return scrub(value);
  if (typeof value !== 'object' || value === null) return value;
  if (hasToJson(value)) return scrubLeaves(value.toJSON(), scrub, onMask, ancestors);
  if (ancestors.has(value)) throw new TypeError('a cyclic output value');
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => scrubLeaves(item, scrub, onMask, ancestors));
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const member = scrubLeaves(item, scrub, onMask, ancestors);
      // `defineProperty`, not assignment: an own `__proto__` member (JSON.parse makes one) would otherwise hit the
      // prototype setter and vanish from the display. Two keys masked to the same text keep the later one; the
      // block's note then says it was masked.
      Object.defineProperty(copy, scrub(key), {
        value: maskedAsMember(key, member, onMask),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * `member` (already masked leaf by leaf), or {@link MEMBER_MASK} in its place when its name labels a credential
 * ({@link namesCredential}); `onMask` is told. Only a value JSON prints as itself is read this way: an object or
 * array is read member by member by the walk itself, and `JSON.stringify` drops `undefined`, a function or a symbol.
 */
function maskedAsMember(key: string, member: unknown, onMask: () => void): unknown {
  if (typeof member === 'object' && member !== null) return member;
  if (member === undefined || typeof member === 'function' || typeof member === 'symbol') {
    return member;
  }
  if (!namesCredential(key)) return member;
  onMask();
  return MEMBER_MASK;
}

/**
 * Whether `key` labels a credential: read as the one-member JSON text `{"<key>":"v"}`, the form the scrubber sees in
 * a serialized object, with a stand-in value, the scrubber masks that value. Only the name decides. The member's own
 * text never enters this view, so its JSON escapes (`\n` for a newline) cannot stretch a token the leaf pass already
 * masked at a line end into a whole-value mask.
 *
 * A name the scrubber masks up to its end on its own (`Basic plan`, `Bearer token`, a URL ending in `?key=1`) is
 * itself a secret shape, not a label: its token has nothing after it in the name, so in the serialized view the
 * token runs on over the closing quote into the stand-in. It is shown masked and masks only itself, not its value.
 */
function namesCredential(key: string): boolean {
  const own = scrubSecrets(key);
  if (own !== key && own.endsWith(MEMBER_MASK)) return false;
  const tail = `:${JSON.stringify(NAME_PROBE)}}`;
  return !scrubSecrets(JSON.stringify({ [key]: NAME_PROBE })).endsWith(tail);
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
