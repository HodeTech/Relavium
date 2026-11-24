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
 * The most map keys one long source may hold, counting a key only when another key of its map comes before it (the first key
 * of every map is free). The linear duplicate check ({@link duplicateKeyCheck}) makes the library build one `DUPLICATE_KEY`
 * error per counted key, to be dropped afterwards, so the work and the memory of a decode grow with the keys: measured on a 2 MiB
 * source of 357,523 distinct keys, 1.9 s and about 575 MB of heap (the same source takes 0.95 s and 290 MB with no check at all),
 * and a catalog scan decodes up to eight such sources one after the other on the Home's UI thread. A source over the budget is
 * refused with a `YAMLParseError` (code `RESOURCE_EXHAUSTION`, a fixed message with no authored text) the moment the key past it
 * is met, before the library builds another error for it or composes the rest of that map.
 *
 * 100,000 is several times the keys of the largest workflow the admission ceilings describe in practice (500 nodes of ~15 keys
 * and 2,000 edges are ~14,000), and above the 60,000-key map the decode tests parse. It bounds one decode, not a scan: a scan's
 * total is the catalog's own byte budget.
 */
export const MAX_MAP_KEYS = 100_000;

/** The fixed, source-free message of the refusal above. */
const TOO_MANY_KEYS = `the document has more than ${String(MAX_MAP_KEYS)} mapping keys`;

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
 * At most {@link MAX_MAP_KEYS} questions are answered; the next one throws a `YAMLParseError` (`RESOURCE_EXHAUSTION`,
 * {@link TOO_MANY_KEYS}). The library catches a throw from a collection's composition and files it as an error of its own
 * with the same message, then goes on with the rest of the document; every later question throws the same fault at once, so
 * no key past the budget costs a comparison or an answer, and `settle` hands the refusal back like any other error
 * (a fault before it in the document still comes first). A library that let the throw escape would escape with this error.
 *
 * It FAILS CLOSED: if the errors and the questions stop lining up (a library that asks differently, or not at
 * all), `settle` throws instead of letting a duplicate through.
 */
function duplicateKeyCheck(): DuplicateKeyCheck {
  const keysOfMap = new WeakMap<ParsedNode, Set<unknown>>();
  const answers: boolean[] = [];
  let overBudget: YAMLParseError | undefined;

  const ask = (first: ParsedNode, candidate: ParsedNode): boolean => {
    if (overBudget === undefined && answers.length >= MAX_MAP_KEYS) {
      overBudget = new YAMLParseError(
        [candidate.range[0], candidate.range[1]],
        'RESOURCE_EXHAUSTION',
        TOO_MANY_KEYS,
      );
    }
    if (overBudget !== undefined) throw overBudget;
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
