/**
 * Structured, **un-evaluated** interpolation references (1.L).
 *
 * An authored template field (a prompt, a context value, a gate message) may carry `{{ … }}`
 * occurrences. 1.L turns each into a typed reference for the DAG builder (1.M) — it does NOT
 * evaluate anything. The run-scope lookup, the pipe-filter registry, and the eager-once snapshot
 * belong to the runtime resolver (1.L2); the secret-taint rejection is a parse-time **static** gate
 * (1.L2, run in the parser after schema validation, never at runtime); and `condition`/`transform`/
 * `merge_fn` belong to the JS sandbox (1.AB). This module is a pure lexer: text in, structured
 * segments out. It reads no files, touches no environment, and holds no state.
 *
 * The authored namespaces (workflow-yaml-spec.md §Context-and-interpolation):
 *   - `{{ inputs.<name> }}`            → kind `inputs`
 *   - `{{ ctx.<key> }}`                → kind `ctx`
 *   - `{{ run.outputs["<node-id>"] }}` → kind `node`   (the roadmap's informal `{{ node.output }}`)
 *   - `{{ run.id }}`                   → kind `run`    (the run id; 1.AF/D16 — the `save_to` namespace)
 * The lexer additionally recognizes `{{ secrets.<name> }}` → kind `secrets` ONLY so the resolver and
 * the taint gate can reject it with a precise typed error — it is not an authored v1.0 namespace.
 * Anything else is carried as `unknown` (the resolver, not this lexer, judges validity).
 *
 * `run.id` is recognized here but resolves only where the {@link RunScope} carries a `runId` — today
 * that is the engine's `output`-node `save_to` resolution (1.AF/D16, ADR-0044 §2); a `{{ run.id }}` in a
 * scope without it surfaces a typed `unresolved_reference`, never a silent empty string.
 */

/** Which run-scope namespace a reference reads from. */
export type ReferenceKind = 'inputs' | 'ctx' | 'node' | 'run' | 'secrets' | 'unknown';

/** A literal argument to a pipe filter (e.g. `default("not required")` → one string arg). */
export type FilterArg =
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'boolean'; readonly value: boolean };

/** One pipe filter, parsed but **not** applied (1.L2 owns the filter registry + evaluation). */
export interface PipeFilter {
  readonly name: string;
  readonly args: readonly FilterArg[];
}

/** A single `{{ … }}` reference, resolved to structure but not evaluated. */
export interface InterpolationReference {
  readonly kind: ReferenceKind;
  /** Head identifier: input name / ctx key / node id / secret name; the raw head for `unknown`. */
  readonly identifier: string;
  /** The property/index access after the head, verbatim (e.g. `.score`, `.issues`); `''` if none. */
  readonly path: string;
  /** Ordered pipe filters, parsed but not applied. */
  readonly filters: readonly PipeFilter[];
  /** The full `{{ … }}` occurrence, verbatim — preserved for round-trip and error messages. */
  readonly raw: string;
}

/** A template is an ordered list of literal text and reference segments. */
export type TemplateSegment =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'reference'; readonly reference: InterpolationReference };

const OPEN = '{{';
const CLOSE = '}}';

/**
 * Parse a template string into ordered literal/reference segments. A field with no `{{ … }}` yields
 * a single literal segment; an unterminated `{{` is left as literal text (the resolver never sees a
 * malformed reference). Pure and total — never throws.
 */
export function parseTemplate(text: string): readonly TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf(OPEN, pos);
    if (start === -1) {
      pushLiteral(segments, text.slice(pos));
      break;
    }
    const end = findClose(text, start + OPEN.length);
    if (end === -1) {
      // An unterminated `{{` — structurally not a reference; the rest is one literal run.
      pushLiteral(segments, text.slice(pos));
      break;
    }
    pushLiteral(segments, text.slice(pos, start));
    const inner = text.slice(start + OPEN.length, end);
    const raw = text.slice(start, end + CLOSE.length);
    segments.push({ kind: 'reference', reference: parseReference(inner, raw) });
    pos = end + CLOSE.length;
  }
  return segments;
}

/** Just the references in a template, in order — the common case for the DAG builder. */
export function templateReferences(text: string): readonly InterpolationReference[] {
  const refs: InterpolationReference[] = [];
  for (const segment of parseTemplate(text)) {
    if (segment.kind === 'reference') {
      refs.push(segment.reference);
    }
  }
  return refs;
}

function pushLiteral(segments: TemplateSegment[], text: string): void {
  if (text.length > 0) {
    segments.push({ kind: 'literal', text });
  }
}

/**
 * Index of the first **top-level** `}}` at or after `from` — skipping any inside quotes or `[]`/`()`,
 * so a literal `}}` inside `default("}}")` or `run.outputs["a}}b"]` does not truncate the reference.
 * Returns -1 if none (an unterminated `{{`). Mirrors {@link splitTopLevel}'s state machine.
 */
function findClose(text: string, from: number): number {
  let quote: string | undefined;
  let depth = 0;
  let escaped = false;
  for (let i = from; i < text.length - 1; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== undefined) {
      if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = undefined;
      }
    } else if (isQuoteChar(ch)) {
      quote = ch;
    } else if (ch === '[' || ch === '(') {
      depth += 1;
    } else if (ch === ']' || ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && ch === '}' && text[i + 1] === '}') {
      return i;
    }
  }
  return -1;
}

function parseReference(inner: string, raw: string): InterpolationReference {
  const parts = splitTopLevel(inner, '|');
  const head = (parts[0] ?? '').trim();
  const { kind, identifier, path } = parseHead(head);
  const filters = parts.slice(1).map(parseFilter);
  return { kind, identifier, path, filters, raw };
}

// The `s` (dotAll) flag replaces `[\s\S]` throughout — avoids the character-class alternation that
// Sonar flags as a potential super-linear backtracking risk. Inputs are bounded by the 2 MiB parse
// cap, but dotAll is simpler and faster regardless.
const NODE_OUTPUT = /^run\.outputs\[\s*(['"])([^'"]*?)\1\s*\](.*)$/s;
const NAMESPACED = /^(inputs|ctx|secrets)\.([A-Za-z0-9_-]+)(.*)$/s;
// `run.id` only (the negative lookahead stops `run.identity`/`run.id_x` from being read as `run.id`);
// `run.outputs[…]` is matched first above, so there is no collision. A trailing `.x`/`[0]` is carried
// as `path` and resolves to nothing (run.id is a flat string) → a typed `unresolved_reference`.
const RUN_ID = /^run\.id(?![A-Za-z0-9_])(.*)$/s;

function parseHead(head: string): Pick<InterpolationReference, 'kind' | 'identifier' | 'path'> {
  const nodeMatch = NODE_OUTPUT.exec(head);
  if (nodeMatch?.[2] !== undefined) {
    return { kind: 'node', identifier: nodeMatch[2], path: (nodeMatch[3] ?? '').trim() };
  }
  const runMatch = RUN_ID.exec(head);
  if (runMatch !== null) {
    return { kind: 'run', identifier: 'id', path: (runMatch[1] ?? '').trim() };
  }
  const nsMatch = NAMESPACED.exec(head);
  if (nsMatch?.[1] !== undefined && nsMatch[2] !== undefined) {
    const kind = nsMatch[1] as 'inputs' | 'ctx' | 'secrets';
    return { kind, identifier: nsMatch[2], path: (nsMatch[3] ?? '').trim() };
  }
  return { kind: 'unknown', identifier: head, path: '' };
}

const FILTER = /^([A-Za-z_]\w*)\s*(?:\((.*)\))?$/s;

function parseFilter(part: string): PipeFilter {
  const trimmed = part.trim();
  const match = FILTER.exec(trimmed);
  if (match?.[1] === undefined) {
    return { name: trimmed, args: [] };
  }
  const rawArgs = match[2];
  if (rawArgs === undefined || rawArgs.trim() === '') {
    return { name: match[1], args: [] };
  }
  const args: FilterArg[] = [];
  for (const piece of splitTopLevel(rawArgs, ',')) {
    const arg = parseArg(piece);
    if (arg !== undefined) {
      args.push(arg);
    }
  }
  return { name: match[1], args };
}

const QUOTED = /^(['"])([\s\S]*)\1$/;

function parseArg(piece: string): FilterArg | undefined {
  const trimmed = piece.trim();
  if (trimmed === '') {
    return undefined;
  }
  const quoted = QUOTED.exec(trimmed);
  if (quoted?.[2] !== undefined) {
    return { type: 'string', value: quoted[2] };
  }
  if (trimmed === 'true' || trimmed === 'false') {
    return { type: 'boolean', value: trimmed === 'true' };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return { type: 'number', value: Number(trimmed) };
  }
  // A bareword (incl. `0x10`, `1e3`, `Infinity`, leading-dot) — kept verbatim as a string, never
  // coerced to a number; 1.L2 owns evaluation, so the lexer must not over-interpret arguments.
  return { type: 'string', value: trimmed };
}

/** Returns true for the two quote characters that delimit filter string arguments. */
function isQuoteChar(ch: string | undefined): boolean {
  return ch === '"' || ch === "'";
}

/**
 * Split `s` on top-level occurrences of `delim`, ignoring delimiters inside quotes or `[]`/`()`.
 * Keeps `default("a|b")` and `run.outputs["x|y"]` intact when splitting on `|`.
 */
interface SplitState {
  buf: string;
  quote: string | undefined;
  depth: number;
  escaped: boolean;
}

function splitTopLevel(s: string, delim: string): string[] {
  const out: string[] = [];
  const st: SplitState = { buf: '', quote: undefined, depth: 0, escaped: false };
  for (const ch of s) {
    splitStep(st, ch, delim, out);
  }
  out.push(st.buf);
  return out;
}

/** One character of the top-level split: handle an escape / inside-a-quote, else dispatch by char. */
function splitStep(st: SplitState, ch: string, delim: string, out: string[]): void {
  if (st.escaped) {
    st.buf += ch;
    st.escaped = false;
    return;
  }
  if (st.quote !== undefined) {
    st.buf += ch;
    if (ch === '\\') {
      st.escaped = true;
    } else if (ch === st.quote) {
      st.quote = undefined;
    }
    return;
  }
  splitStepOutsideQuote(st, ch, delim, out);
}

/** A character outside any quote: open/close a quote or bracket, split on a top-level delimiter, or buffer. */
function splitStepOutsideQuote(st: SplitState, ch: string, delim: string, out: string[]): void {
  if (isQuoteChar(ch)) {
    st.quote = ch;
    st.buf += ch;
  } else if (ch === '[' || ch === '(') {
    st.depth += 1;
    st.buf += ch;
  } else if (ch === ']' || ch === ')') {
    st.depth = Math.max(0, st.depth - 1);
    st.buf += ch;
  } else if (ch === delim && st.depth === 0) {
    out.push(st.buf);
    st.buf = '';
  } else {
    st.buf += ch;
  }
}
