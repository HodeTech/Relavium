import { LineCounter, YAMLParseError, parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentParseError, parseAgent } from './agent-parser.js';
import { WorkflowSyntaxError } from './errors.js';
import { parseWorkflow } from './parser.js';
import {
  LIBRARY_CHECK_MAX_CHARS,
  MAX_MAP_KEYS,
  YamlDecodeInvariantError,
  decodeHardenedYaml,
} from './yaml-decode.js';

/** What a parser's caller sees of a YAML fault: the library's code and message, its offsets, its line/column. */
interface Fault {
  readonly code: string;
  readonly message: string;
  readonly pos: readonly [number, number];
  readonly line: number;
  readonly column: number;
}

/** Decode `text` and describe the `YAMLParseError` it throws (failing the test when it throws anything else). */
function faultOf(decode: (text: string, lineCounter: LineCounter) => unknown, text: string): Fault {
  const lineCounter = new LineCounter();
  try {
    decode(text, lineCounter);
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error;
    const { line, col } = lineCounter.linePos(error.pos[0]);
    return { code: error.code, message: error.message, pos: error.pos, line, column: col };
  }
  throw new Error('the document decoded without a fault');
}

/**
 * The decode profile as it was BEFORE the linear duplicate check (ADR-0035): the library's own
 * `uniqueKeys: true`, which is quadratic but is the reference for every code, message, position and order.
 */
function libraryDecode(text: string, lineCounter: LineCounter): unknown {
  return parseYaml(text, {
    version: '1.2',
    schema: 'core',
    resolveKnownTags: false,
    merge: false,
    uniqueKeys: true,
    stringKeys: true,
    maxAliasCount: 0,
    prettyErrors: false,
    logLevel: 'error',
    lineCounter,
  });
}

/** The decoded value, or the fault, of `text` — so two decoders can be compared whole. */
function outcomeOf(
  decode: (text: string, lineCounter: LineCounter) => unknown,
  text: string,
): { readonly value: unknown } | { readonly fault: Fault } {
  try {
    return { value: decode(text, new LineCounter()) };
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error;
    return { fault: faultOf(decode, text) };
  }
}

/**
 * A source up to {@link LIBRARY_CHECK_MAX_CHARS} is decoded with the library's own duplicate check, a longer one with the
 * linear check; the same documents must come out the same either way, so each runs as written and behind a comment line
 * that takes it over the limit (one line, so every offset moves by the length of `pad` and every line by `lines`).
 */
const WAYS = [
  { way: "a short source (the library's own check)", pad: '', lines: 0 },
  {
    way: 'a long source (the linear check)',
    pad: `# ${'x'.repeat(LIBRARY_CHECK_MAX_CHARS)}\n`,
    lines: 1,
  },
] as const;

describe.each(WAYS)(
  'decodeHardenedYaml — a duplicate key is rejected where the library put it: $way',
  ({ pad, lines }) => {
    // Pinned from the library's own `uniqueKeys: true` output, so these do not follow the implementation.
    it.each([
      // [label, text, offsets of the rejected key, line, column]
      ['a top-level map', 'id: first\nid: second\n', [10, 11], 2, 1],
      ['a nested map', 'a:\n  x: 1\n  y: 2\n  x: 3\n', [19, 20], 4, 3],
      ['a flow map', 'a: { p: 1, q: 2, p: 3 }\n', [17, 18], 1, 18],
      [
        'a key after an empty value (the library reports the end of the empty value)',
        'a: \na: 1\n',
        [3, 4],
        1,
        4,
      ],
      ['empty keys', ': 1\n: 2\n', [4, 5], 2, 1],
      ['a quoted key that equals a plain one', 'a: 1\n"a": 2\n', [5, 6], 2, 1],
      ['an escaped key that equals a plain one', '"\\x41": 1\nA: 2\n', [10, 11], 2, 1],
      ['a tagged key (the position is after the tag)', '!!str a: 1\na: 2\n', [11, 12], 2, 1],
      ['an explicit key', '? a\n: 1\n? a\n: 2\n', [10, 11], 3, 3],
      ['the first of two duplicates', 'a: 1\na: 2\nb: 1\nb: 2\n', [5, 6], 2, 1],
      ['a duplicate before a later syntax fault', 'a: 1\na: 2\nb: [\n', [5, 6], 2, 1],
      ['a duplicate in the first of two documents', 'a: 1\na: 2\n---\nx: 1\n', [5, 6], 2, 1],
    ] as const)('%s', (_label, text, pos, line, column) => {
      expect(faultOf(decodeHardenedYaml, pad + text)).toEqual({
        code: 'DUPLICATE_KEY',
        message: 'Map keys must be unique',
        pos: [pos[0] + pad.length, pos[1] + pad.length],
        line: line + lines,
        column,
      });
    });

    // The oracle: the pre-change profile. Every fault, in every order, must be the one the library raised first.
    it.each([
      ['a fault that comes before the duplicate', 'b: [\na: 1\na: 2\n'],
      ['a flow map, which checks a key after its value', '{a: 1, b: {{x: 1}: 1}, a: 2}'],
      ['a flow map whose duplicate comes after a value fault', '{a: 1, b: "\\q", a: 2}'],
      ['a duplicate in the second document only', 'a: 1\n---\nb: 1\nb: 2\n'],
      ['a duplicate in both documents', 'a: 1\na: 2\n---\nb: 1\nb: 2\n'],
      ['a key with no value, then the same key', 'a\na: 1\n'],
      ['an anchored duplicate', '&x a: 1\na: 2\n'],
      ['a non-string key before a duplicate', '? {x: 1}\n: 1\na: 1\na: 2\n'],
      // Under `stringKeys` a key is always a string, even a tagged one, so `.nan` is never NaN: `Set` and `===` agree.
      ['two `.nan` keys (strings under stringKeys)', '.nan: 1\n.nan: 2\n'],
      ['two tagged `!!float .nan` keys', '!!float .nan: 1\n!!float .nan: 2\na: 1\na: 2\n'],
      ['the same keys in one map and in its flow child', 'a: 1\nb: {a: 1, a: 2}\n'],
      ['a nested duplicate before an outer one', 'a:\n  x: 1\n  x: 2\na: 3\n'],
      ['an empty-keyed pair after an empty value', 'a:\n: 1\n: 2\n'],
      ['two flow maps in a list', '- {a: 1, a: 2}\n- {b: 1, b: 2}\n'],
      ['a block map inside a flow sequence', '[a: 1, b: 2, a: 3]'],
      ['a number and its quoted spelling (every key is a string)', '1: a\n"1": b\n'],
      ['a boolean and its quoted spelling', 'true: a\n"true": b\n'],
      ['an empty document', ''],
      ['a comment-only document', '# nothing\n'],
    ])('matches the library: %s', (_label, text) => {
      expect(outcomeOf(decodeHardenedYaml, pad + text)).toEqual(
        outcomeOf(libraryDecode, pad + text),
      );
    });

    it('does not call the same key in different maps a duplicate', () => {
      const text = [
        'a:',
        '  k: 1',
        'b:',
        '  k: 2',
        'list:',
        '  - {id: 1, k: 1}',
        '  - {id: 2, k: 2}',
        '  - id: 3',
        '    k: 3',
        'seq: [x: 1, x: 2]',
        'k: top',
        '',
      ].join('\n');
      expect(decodeHardenedYaml(pad + text, new LineCounter())).toEqual({
        a: { k: 1 },
        b: { k: 2 },
        list: [
          { id: 1, k: 1 },
          { id: 2, k: 2 },
          { id: 3, k: 3 },
        ],
        seq: [{ x: 1 }, { x: 2 }],
        k: 'top',
      });
    });

    it('keeps keys that differ only in case, spacing or leading zeros apart', () => {
      expect(
        decodeHardenedYaml(`${pad}a: 1\nA: 2\n"a ": 3\n1: 4\n01: 5\n`, new LineCounter()),
      ).toEqual({
        a: 1,
        A: 2,
        'a ': 3,
        '1': 4,
        '01': 5,
      });
    });

    it('surfaces through parseAgent and parseWorkflow with the same message, line and column', () => {
      try {
        parseAgent(`${pad}id: x\nid: y\nmodel: m\n`);
        expect.unreachable('a duplicate key must be rejected');
      } catch (error) {
        if (!(error instanceof AgentParseError)) throw error;
        expect(error.code).toBe('agent_syntax');
        expect(error.message).toBe(`Map keys must be unique (line ${String(2 + lines)}, column 1)`);
        expect([error.line, error.column]).toEqual([2 + lines, 1]);
      }
      try {
        parseWorkflow(`${pad}schema_version: '1.0'\nworkflow:\n  id: w\n  id: v\n`);
        expect.unreachable('a duplicate key must be rejected');
      } catch (error) {
        if (!(error instanceof WorkflowSyntaxError)) throw error;
        expect(error.message).toBe('Map keys must be unique');
        expect([error.line, error.column]).toEqual([4 + lines, 3]);
      }
    });
  },
);

describe('decodeHardenedYaml — a large map is not quadratic', () => {
  // The library's own `uniqueKeys: true` needs ~25 s for 60,000 keys here, so the default test timeout is the bound
  // (no clock is read): these tests fail by timing out if the check ever becomes quadratic again.
  const KEYS = 60_000;

  function flatMap(count: number, indent: string): string {
    return Array.from({ length: count }, (_, index) => `${indent}k${index}: ${index}`).join('\n');
  }

  it('parses and validates a workflow whose metadata holds 60,000 distinct keys', () => {
    const text = [
      "schema_version: '1.0'",
      'workflow:',
      '  id: big-metadata',
      '  metadata:',
      flatMap(KEYS, '    '),
      '  nodes:',
      '    - id: only',
      '      type: input',
      '  edges: []',
      '',
    ].join('\n');
    const metadata = parseWorkflow(text).workflow.metadata;
    expect(Object.keys(metadata ?? {})).toHaveLength(KEYS);
    expect(metadata?.['k59999']).toBe(59_999);
  });

  it('still finds a duplicate that comes after 59,999 distinct keys, at its own position', () => {
    const text = `${flatMap(KEYS - 1, '')}\nk0: again\n`;
    const fault = faultOf(decodeHardenedYaml, text);
    expect(fault.code).toBe('DUPLICATE_KEY');
    expect(fault.message).toBe('Map keys must be unique');
    expect(fault.pos[0]).toBe(text.lastIndexOf('\nk0:') + 1);
    expect(fault.line).toBe(KEYS);
    expect(fault.column).toBe(1);
  });

  it('checks a flow map in linear time too, and finds a duplicate at its end', () => {
    const flow = (count: number): string =>
      `{${Array.from({ length: count }, (_, index) => `k${index}: ${index}`).join(', ')}`;
    expect(
      Object.keys(decodeHardenedYaml(`${flow(40_000)}}`, new LineCounter()) as object),
    ).toHaveLength(40_000);
    const text = `${flow(40_000)}, k0: again}`;
    const fault = faultOf(decodeHardenedYaml, text);
    expect(fault.code).toBe('DUPLICATE_KEY');
    expect(fault.pos[0]).toBe(text.lastIndexOf('k0:'));
  });

  it('keeps one set per map: 30,000 small maps that share their key names are not duplicates', () => {
    const text = Array.from({ length: 30_000 }, (_, index) => `- {a: ${index}, b: ${index}}`).join(
      '\n',
    );
    expect(decodeHardenedYaml(text, new LineCounter())).toHaveLength(30_000);
  });
});

describe('decodeHardenedYaml — a source has a budget of map keys', () => {
  // Each test decodes sources of 100,000 keys and more; a loaded CI worker needs more than the default five seconds.
  const SLOW = 30_000;
  const TOO_MANY = `the document has more than ${String(MAX_MAP_KEYS)} mapping keys`;

  function flat(count: number, indent = ''): string {
    return `${Array.from({ length: count }, (_, index) => `${indent}k${index}: ${index}`).join('\n')}\n`;
  }

  it(
    'admits a map of exactly the budget and refuses it one key later',
    () => {
      // The first key of a map is free: MAX_MAP_KEYS + 1 keys put MAX_MAP_KEYS questions to the check.
      expect(
        Object.keys(decodeHardenedYaml(flat(MAX_MAP_KEYS + 1), new LineCounter()) as object),
      ).toHaveLength(MAX_MAP_KEYS + 1);
      const fault = faultOf(decodeHardenedYaml, flat(MAX_MAP_KEYS + 2));
      expect(fault.code).toBe('RESOURCE_EXHAUSTION');
      expect(fault.message).toBe(TOO_MANY);
    },
    SLOW,
  );

  it(
    'counts the keys of a flow map the same way',
    () => {
      const flow = (count: number): string =>
        `{${Array.from({ length: count }, (_, index) => `k${index}: ${index}`).join(', ')}}`;
      expect(
        Object.keys(decodeHardenedYaml(flow(MAX_MAP_KEYS + 1), new LineCounter()) as object),
      ).toHaveLength(MAX_MAP_KEYS + 1);
      expect(faultOf(decodeHardenedYaml, flow(MAX_MAP_KEYS + 2)).message).toBe(TOO_MANY);
    },
    SLOW,
  );

  it(
    'counts the keys of every map of the document together, not of each map alone',
    () => {
      // Three keys in each of the maps: two questions each, so 50,000 maps are exactly the budget and one more map is over it.
      const maps = (count: number): string =>
        Array.from({ length: count }, (_, index) => `- {a: ${index}, b: 1, c: 2}`).join('\n');
      expect(decodeHardenedYaml(maps(MAX_MAP_KEYS / 2), new LineCounter())).toHaveLength(
        MAX_MAP_KEYS / 2,
      );
      expect(faultOf(decodeHardenedYaml, maps(MAX_MAP_KEYS / 2 + 1)).message).toBe(TOO_MANY);
    },
    SLOW,
  );

  it(
    'keeps a fault that comes before the budget as the fault',
    () => {
      // The first error in the document wins, as it does for `uniqueKeys: true`: a real duplicate at the second key is it.
      const fault = faultOf(decodeHardenedYaml, `a: 1\na: 2\n${flat(MAX_MAP_KEYS + 50)}`);
      expect(fault.code).toBe('DUPLICATE_KEY');
      expect(fault.line).toBe(2);
    },
    SLOW,
  );

  it(
    'refuses through parseWorkflow and parseAgent with the fixed sentence and the position, and no authored text',
    () => {
      const agent = `id: a\nmodel: m\nmetadata:\n${flat(MAX_MAP_KEYS + 50, '  ')}`;
      try {
        parseAgent(agent, { source: 'agents/a.agent.yaml' });
        expect.unreachable('a source over the key budget must be refused');
      } catch (error) {
        if (!(error instanceof AgentParseError)) throw error;
        expect(error.code).toBe('agent_syntax');
        expect(error.message).toMatch(
          new RegExp(`^${TOO_MANY} \\(agents/a\\.agent\\.yaml — line \\d+, column \\d+\\)$`),
        );
        expect(error.message).not.toContain('k0');
      }
      try {
        parseWorkflow(
          `schema_version: '1.0'\nworkflow:\n  id: w\n  metadata:\n${flat(MAX_MAP_KEYS + 50, '    ')}`,
        );
        expect.unreachable('a source over the key budget must be refused');
      } catch (error) {
        if (!(error instanceof WorkflowSyntaxError)) throw error;
        expect(error.message).toBe(TOO_MANY);
        expect(error.line).toBeGreaterThan(0);
      }
    },
    SLOW,
  );
});

describe('decodeHardenedYaml — the linear duplicate check fails closed', () => {
  const LONG_PAD = `# ${'x'.repeat(LIBRARY_CHECK_MAX_CHARS)}\n`;

  afterEach(() => {
    vi.doUnmock('yaml');
    vi.resetModules();
  });

  /** `yaml-decode` over a `yaml` whose `parseDocument` hands back a document changed by `tamper`. */
  async function decodeWithTamperedDocument(
    tamper: (document: { errors: unknown[] }, actual: typeof import('yaml')) => void,
  ): Promise<typeof import('./yaml-decode.js')> {
    vi.resetModules();
    vi.doMock('yaml', async (importOriginal) => {
      const actual = await importOriginal<typeof import('yaml')>();
      return {
        ...actual,
        parseDocument: (...args: Parameters<typeof actual.parseDocument>) => {
          const document = actual.parseDocument(...args);
          tamper(document, actual);
          return document;
        },
      };
    });
    return import('./yaml-decode.js');
  }

  it('throws when the library reports a duplicate its comparator was never asked about', async () => {
    const { decodeHardenedYaml: decode, YamlDecodeInvariantError: Invariant } =
      await decodeWithTamperedDocument((document, actual) => {
        document.errors.push(
          new actual.YAMLParseError([0, 1], 'DUPLICATE_KEY', 'Map keys must be unique'),
        );
      });
    const attempt = (): unknown => decode(`${LONG_PAD}a: 1\n`, new LineCounter());
    expect(attempt).toThrow(/no longer matches/);
    // A typed internal fault, not a bare `Error` and not a syntax fault: a caller can tell it from a YAML mistake.
    expect(attempt).toThrow(Invariant);
  });

  it('throws when the comparator was asked about a duplicate the library never reported', async () => {
    const { decodeHardenedYaml: decode, YamlDecodeInvariantError: Invariant } =
      await decodeWithTamperedDocument((document) => {
        document.errors.length = 0;
      });
    const attempt = (): unknown => decode(`${LONG_PAD}a: 1\na: 2\n`, new LineCounter());
    expect(attempt).toThrow(/no longer matches/);
    expect(attempt).toThrow(Invariant);
  });

  it('does not build a library error per key past the key budget', async () => {
    let built = -1;
    const { decodeHardenedYaml: decode } = await decodeWithTamperedDocument((document) => {
      built = document.errors.length;
    });
    const keys = Array.from({ length: 3 * MAX_MAP_KEYS }, (_, index) => `k${index}: ${index}`);
    expect(() => decode(`${keys.join('\n')}\n`, new LineCounter())).toThrow(/mapping keys/);
    // One DUPLICATE_KEY error per answered question, and the refusal: never one for each of the 300,000 keys.
    expect(built).toBeLessThanOrEqual(MAX_MAP_KEYS + 1);
  }, 30_000);
});

describe('YamlDecodeInvariantError', () => {
  it('is a typed internal fault with a fixed, source-free message', () => {
    const error = new YamlDecodeInvariantError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('YamlDecodeInvariantError');
    expect(error.message).toBe('the YAML duplicate-key check no longer matches the YAML parser');
  });
});
