import { RelaviumError } from '@relavium/shared';
import {
  type DocumentOptions,
  type LineCounter,
  type ParseOptions,
  type ParsedNode,
  type SchemaOptions,
  type ToJSOptions,
  type YAMLError,
  YAMLParseError,
  isScalar,
  parse as parseYaml,
  parseDocument,
} from 'yaml';

/**
 * The longest source (in characters) that is decoded with the library's own duplicate-key check, `uniqueKeys: true`.
 * That check compares every new key with every key already in its map, so its cost is quadratic in the keys of one
 * map; a source this short holds at most ~680 keys (a key, its `:` and a line break take three characters at the
 * least), which is ~230,000 comparisons and a few milliseconds. A longer source takes {@link duplicateKeyCheck} instead.
 */
export const LIBRARY_CHECK_MAX_CHARS = 2048;

/**
 * The most structural tokens one source may hold ({@link countYamlTokens}), 120,000. A source's size is bounded by its character cap
 * (2 MiB), and that alone does NOT bound what the library spends on it: its cost follows the NUMBER OF NODES, not the characters. Measured
 * here on 2 MiB sources (before this budget, with the map-key budget this replaced): `[{a,b},{a,b},…]` 3.9 s of CPU and 1.2 GB, `- {a,b}`
 * lines 3.3 s and 0.9 GB, `- {a}` lines 1.8 s and 0.7 GB, `- a` lines 1.5 s and 0.5 GB (an independent run of the same shapes under load:
 * 4.9 to 8.9 s), against 0.2 to 0.4 s for the same bytes of prose; and a catalog scan decodes up to eight such sources one after the other on
 * the Home's UI thread (51 s and 2.75 GB measured). The count is made BEFORE the library composes anything, in one linear pass of about 3 ms
 * for 2 MiB, and a source over the budget is refused with a `YAMLParseError` (code `RESOURCE_EXHAUSTION`, a fixed message with no authored
 * text and no position). Every key after the first of its map needs a line break or a comma before it, so the number of map keys the check
 * answers is at most the number of tokens: this one budget bounds the duplicate check's per-key errors as well.
 *
 * At 120,000 tokens a decode costs 0.2 to 0.5 s of CPU and about 150 to 240 MB on this machine (the worst shape, a flow sequence of maps;
 * 3 to 7 microseconds a token, up to 17 under load), so one file is two seconds at the most. A legitimate file is far below it: the
 * repo's own workflows and agents are 66 to 223 tokens, the largest example in the docs is 223, a workflow at every admission ceiling
 * (500 nodes, 2,000 edges) is 16,000, and the largest legitimate documents of the parser, graph, limits and engine tests are 26,048.
 * Ordinary prose is 3.5 to 5.3 tokens in 100 characters, so even a prompt of the full 2 MiB character cap passes; a source denser than about
 * 5.7% structure (a list of short items) does not. It bounds one decode; the sum over a catalog scan is the catalog's own token budget.
 */
export const MAX_YAML_TOKENS = 120_000;

/** The fixed, source-free message of the refusal above (the catalog's own reason style: nothing authored in it). */
const TOO_LARGE = 'the document is too large to read safely';

/**
 * How many structural tokens `text` holds, counted in one linear pass of character codes: every line break (`\n`, `\r`), `,` `:` `-` `[` and `{`.
 * A token is NOT a node, it is a sound UPPER BOUND on the nodes the library builds: every map entry after the first needs a line break or a
 * comma before it, every sequence item a `-`, every flow collection a `[` or `{`, every `key: value` pair a `:`; text inside a scalar (a hyphen in
 * a word, a comma in prose) is counted too, which only over-counts. So a count over the budget is never a refusal of a smaller document.
 *
 * Stops as soon as the count passes `limit` and returns `limit + 1`, so a caller that only asks "is it over?" pays for the prefix it needed.
 */
export function countYamlTokens(text: string, limit: number = Number.POSITIVE_INFINITY): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    switch (text.charCodeAt(index)) {
      case 10: // \n
      case 13: // \r
      case 44: // ,
      case 58: // :
      case 45: // -
      case 91: // [
      case 123: // {
        count += 1;
        if (count > limit) return count;
        break;
      default:
    }
  }
  return count;
}

/**
 * The single hardened, deterministic YAML 1.2-core decode profile (ADR-0035) every authored-YAML parser
 * shares — `parseWorkflow` ({@link ./parser.ts}) and `parseAgent` ({@link ./agent-parser.ts}). The decode
 * produces only plain JSON-like data on every surface (no `Date`/`Buffer`, no anchors/aliases, no merge
 * keys, duplicate keys rejected); strict Zod then enforces the actual contract. Throws the raw
 * `YAMLParseError` on a syntax fault — each parser normalizes it to its own typed, secret-free error, so the
 * profile stays one definition and can never drift between the two parsers.
 *
 * **Duplicate keys are rejected in linear time for a long source.** The library's own `uniqueKeys: true` is
 * quadratic: one authored file with tens of thousands of distinct keys froze the process for tens of seconds
 * (40,000 keys ~12 s, 80,000 ~41 s; the same ~1.1 MB parses in ~0.3 s without it). A source of at most
 * {@link LIBRARY_CHECK_MAX_CHARS} characters still uses it, as one `parse` call, exactly as before (the packed-CLI
 * symbolication control anchors on that call, `tools/cli-package/symbolicate.mjs`); a longer one is decoded with
 * `uniqueKeys` answered by {@link duplicateKeyCheck}. The rejection is the library's own error either way: the same
 * code, message, position and place among the other faults.
 */
export function decodeHardenedYaml(yamlText: string, lineCounter: LineCounter): unknown {
  // Before the library composes ANYTHING: its cost follows the nodes, not the characters (see MAX_YAML_TOKENS). No position, as the
  // refusal is about the whole document, not a place in it; both parsers file a position-less fault without a line and column.
  if (countYamlTokens(yamlText, MAX_YAML_TOKENS) > MAX_YAML_TOKENS) {
    throw new YAMLParseError([-1, -1], 'RESOURCE_EXHAUSTION', TOO_LARGE);
  }
  if (yamlText.length <= LIBRARY_CHECK_MAX_CHARS) {
    return parseYaml(yamlText, profile(lineCounter, true));
  }
  const check = duplicateKeyCheck();
  const options = profile(lineCounter, check.ask);
  // `parse()` is `parseDocument()` + "throw the first error" + `toJS()`; split so the false duplicates can be dropped.
  const document = parseDocument(yamlText, options);
  const [fault] = check.settle(document.errors);
  if (fault !== undefined) throw fault;
  return document.toJS(options);
}

/** The one decode profile; only the duplicate-key check differs between the two ways of running it. */
function profile(
  lineCounter: LineCounter,
  uniqueKeys: NonNullable<ParseOptions['uniqueKeys']>,
): ParseOptions & DocumentOptions & SchemaOptions & ToJSOptions {
  return {
    version: '1.2',
    schema: 'core', // YAML 1.2 core only — `!!timestamp`/`!!binary` never become a Date/Buffer
    resolveKnownTags: false, // an unknown `!!`-tag stays a string, never a platform object
    merge: false, // no YAML-1.1 `<<` merge keys
    uniqueKeys, // a duplicate map key is an error
    stringKeys: true, // complex/non-string keys are rejected (a deterministic object shape)
    maxAliasCount: 0, // anchors/aliases are not part of the authored contract — no alias-bomb expansion
    prettyErrors: false, // no source snippet in the message (secret-free); line/col via the LineCounter
    logLevel: 'error', // no `console.warn` — the parser stays a pure function (no I/O side effect)
    lineCounter,
  };
}

/**
 * The duplicate-key bookkeeping stopped matching the parser's own errors: a library change, or a bug here. An internal fault, not an
 * authored one, so it is its own type (a caller can tell it from a syntax fault) and its message is fixed and source-free. The
 * decode fails CLOSED with it rather than let a duplicate through; the two parsers file it as "not valid YAML".
 */
export class YamlDecodeInvariantError extends RelaviumError {
  constructor() {
    super('the YAML duplicate-key check no longer matches the YAML parser');
    this.name = 'YamlDecodeInvariantError';
  }
}

/** What {@link duplicateKeyCheck} hands the decode: the comparator for `uniqueKeys` and the settling of the errors. */
interface DuplicateKeyCheck {
  /** The `uniqueKeys` comparator: records whether `candidate` repeats a key of `first`'s map; returns `true`. */
  readonly ask: (first: ParsedNode, candidate: ParsedNode) => boolean;
  /** The document's errors with the false `DUPLICATE_KEY` errors removed, in their original order. */
  readonly settle: (errors: readonly YAMLError[]) => YAMLError[];
}

/**
 * The comparator the library calls as `uniqueKeys`, and the accounting that goes with it (one per decode).
 *
 * The library asks `uniqueKeys(first, candidate)` before it adds a key to a map that already has one: `first` is
 * the map's first key and `candidate` the new one. It stops asking at the first `true` and then raises
 * `DUPLICATE_KEY` (`Map keys must be unique`, at the key's own position, in the order it met the fault). The
 * quadratic cost is the other answer: on `false` it asks again for every earlier key of the map.
 *
 * So `ask` answers in O(1) from one `Set` of scalar keys per map (found by its `first` key, a distinct node per
 * map) and ALWAYS returns `true`, so the library asks exactly once per key; it remembers the real answer.
 * `settle` then drops the `DUPLICATE_KEY` errors whose answer was "not a duplicate" — the k-th such error answers
 * the k-th question, in order — and what is left is exactly the error list `uniqueKeys: true` would have produced:
 * the library's own error objects, with no walk of the document to re-derive a position or an order (an empty key,
 * a key that follows an empty value, and a flow map — which checks AFTER its value — each report differently, and
 * all of that stays the library's).
 *
 * Two keys are equal exactly when the library's default comparison said so: both are scalars with the same
 * `value` (a quoted `"a"` equals a plain `a`); a collection key and an alias equal nothing. Under `stringKeys` the
 * library resolves every scalar key AS A STRING (`compose-scalar.js`, `ctx.atKey`), even a tagged one (`!!float .nan`
 * keeps the string `'.nan'` and gets a `NON_STRING_KEY` error of its own), so no key's value is ever `NaN` and `Set`
 * (SameValueZero) and `===` agree on every key: two `.nan` keys are a duplicate for the library and for this check.
 *
 * It FAILS CLOSED: if the errors and the questions stop lining up (a library that asks differently, or not at
 * all), `settle` throws instead of letting a duplicate through.
 */
function duplicateKeyCheck(): DuplicateKeyCheck {
  const keysOfMap = new WeakMap<ParsedNode, Set<unknown>>();
  const answers: boolean[] = [];

  const ask = (first: ParsedNode, candidate: ParsedNode): boolean => {
    let keys = keysOfMap.get(first);
    if (keys === undefined) {
      // The first key of a map is never a candidate (nothing to compare it with), so it joins the set here.
      keys = new Set<unknown>();
      if (isScalar(first)) keys.add(first.value);
      keysOfMap.set(first, keys);
    }
    let duplicate = false;
    if (isScalar(candidate)) {
      duplicate = keys.has(candidate.value);
      keys.add(candidate.value);
    }
    answers.push(duplicate);
    return true; // always: a `false` would make the library ask again for every earlier key (the quadratic cost)
  };

  const settle = (errors: readonly YAMLError[]): YAMLError[] => {
    const faults: YAMLError[] = [];
    let asked = 0;
    for (const error of errors) {
      if (error.code !== 'DUPLICATE_KEY') {
        faults.push(error);
        continue;
      }
      const duplicate = answers[asked];
      asked += 1;
      if (duplicate === undefined) throw new YamlDecodeInvariantError();
      if (duplicate) faults.push(error);
    }
    // More questions than errors is only legitimate after a second document, which the library composes (and then
    // refuses with `MULTIPLE_DOCS`) after the first document's errors were already collected.
    if (asked < answers.length && !errors.some((error) => error.code === 'MULTIPLE_DOCS')) {
      throw new YamlDecodeInvariantError();
    }
    return faults;
  };

  return { ask, settle };
}
