import * as scrubModule from '@relavium/llm/scrub-secrets';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_KEY_SCRUB_CHARS,
  MAX_STORED_OUTPUT_BYTES,
  OUTPUT_PREVIEW_MAX_CHARS,
  OUTPUT_PREVIEW_MAX_LINES,
  buildOutputPreview,
} from '../history/node-detail-model.js';
import {
  MEMBER_MASK,
  maskText,
  maskThenCut,
  maskedAsMember,
  namesCredential,
  scrubLeaves,
} from './output-masking.js';
import { formatRunOutputs } from './run-outputs.js';

/**
 * The one masking seam for output (ADR-0140 §2 and §4, MVP-8 step 4): the final summary and the node page's preview mask through it, so
 * these cases prove what a value IS once masked, that no cap sees it before the scrubber has read it whole, that a 1 MiB document costs a
 * bound, and — the differential — that the page and the summary show the same masked values for a seeded set of outputs.
 */

// The real scrubber, counted: the work a preview does is the number of strings it hands the scrubber and their total length, which is
// the same on every machine under every load, where a clock is not.
vi.mock('@relavium/llm/scrub-secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof scrubModule>();
  return { ...actual, scrubSecrets: vi.fn(actual.scrubSecrets) };
});
const scrubWork = (): { readonly calls: number; readonly chars: number } => {
  const calls = vi.mocked(scrubModule.scrubSecrets).mock.calls;
  return { calls: calls.length, chars: calls.reduce((sum, [text]) => sum + text.length, 0) };
};

/** Built here because the characters themselves must not sit in a source file. */
const RLO = String.fromCharCode(0x202e);
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

const SECRET = `sk-ant-api03-${'A'.repeat(40)}`;
/** A URL whose userinfo password is the secret; a cut inside it, made before the scrubber reads it, leaves a prefix nothing recognizes. */
const USERINFO_URL = 'postgres://app:S3cr3tPassw0rdValue@db.internal';

/**
 * Names the scrubber's own rule reads as labels of a credential (`namesCredential` asks it, as the final summary does): the header form
 * (`x-api-key`) and the query form (`?token=`). A name such as `Authorization` or `password` is NOT in the list: the scrubber does not
 * mask the stand-in value behind it, so neither surface masks that member's value on the strength of its name.
 */
const HEADER_NAMES: readonly string[] = ['x-api-key', 'X-API-KEY', 'api-key', 'x-goog-api-key'];
const QUERY_NAMES: readonly string[] = ['?token=', '?key=', '&token=', '?api_key='];
const CREDENTIAL_NAMES: readonly string[] = [...HEADER_NAMES, ...QUERY_NAMES];

/** 3,984 characters of ordinary words: a secret that starts right after it straddles the 4,000 code-point cap. */
const FILLER = 'lorem ipsum '.repeat(332);

const never = (): void => {
  throw new Error('onMask was not expected');
};

describe('the seam: what a masked value is', () => {
  it('reports a mask to its caller, and only when the scrubber changed something', () => {
    const told: string[] = [];
    expect(maskText(`key ${SECRET}`, () => told.push('masked'))).not.toContain('sk-ant-api03');
    expect(told).toEqual(['masked']);
    expect(maskText('nothing secret here', never)).toBe('nothing secret here');
  });

  it('masks a member whose NAME labels a credential, whole, and keeps the value of a plain name', () => {
    const told: string[] = [];
    const onMask = (): void => {
      told.push('masked');
    };
    for (const key of CREDENTIAL_NAMES) {
      expect(namesCredential(key)).toBe(true);
      expect(maskedAsMember(key, 'opaqueSECRETvalue', onMask)).toBe(MEMBER_MASK);
      expect(maskedAsMember(key, 12_345, onMask)).toBe(MEMBER_MASK);
    }
    expect(told).toHaveLength(CREDENTIAL_NAMES.length * 2);
    for (const key of ['title', 'note', 'items', 'name']) {
      expect(namesCredential(key)).toBe(false);
      expect(maskedAsMember(key, 'plain text', never)).toBe('plain text');
    }
  });

  it('leaves an object, an array and a value JSON drops to their own walk, and does not take a secret-shaped name for a label', () => {
    expect(maskedAsMember('x-api-key', { nested: 1 }, never)).toEqual({ nested: 1 });
    expect(maskedAsMember('x-api-key', [1, 2], never)).toEqual([1, 2]);
    expect(maskedAsMember('x-api-key', undefined, never)).toBeUndefined();
    // A name the scrubber masks up to its end is a secret shape of its own, not a label: it is masked, and it masks only itself.
    expect(namesCredential(SECRET)).toBe(false);
    expect(maskedAsMember(SECRET, 'plain value', never)).toBe('plain value');
  });

  it('masks a value WHOLE and only then cuts it: a secret that straddles the cut is never shown in part', () => {
    const lead = 'a'.repeat(100);
    const text = `${lead}${USERINFO_URL}`;
    // Cuts inside the userinfo password, and just before and after the whole URL.
    for (const limit of [lead.length + 10, lead.length + 20, lead.length, lead.length + 5]) {
      const told: string[] = [];
      const cut = maskThenCut(text, limit, () => told.push('masked'));
      expect(cut.text).not.toContain('S3cr3t');
      expect(cut.text).not.toContain('Passw0rd');
      expect(told).toEqual(['masked']);
    }
    // A text that fits is kept whole and says it was not cut; one code unit over is cut and says so.
    expect(maskThenCut('abcd', 4, never)).toEqual({ text: 'abcd', cut: false });
    expect(maskThenCut('abcde', 4, never)).toEqual({ text: 'abcd', cut: true });
  });

  it('copies every leaf and key masked, follows toJSON, keeps an own `__proto__` member and refuses a cycle', () => {
    const told: string[] = [];
    const onMask = (): void => {
      told.push('masked');
    };
    const scrub = (text: string): string => maskText(text, onMask);
    const copy = scrubLeaves(
      { [SECRET]: 'plain', note: `held ${SECRET}`, 'x-api-key': 'opaque', list: [{ a: SECRET }] },
      scrub,
      onMask,
      new Set(),
    );
    expect(JSON.stringify(copy)).not.toContain('sk-ant-api03');
    expect(JSON.stringify(copy)).not.toContain('opaque');
    expect(JSON.stringify(copy)).toContain(`"x-api-key":"${MEMBER_MASK}"`);
    expect(scrubLeaves({ toJSON: () => ({ k: SECRET }) }, scrub, onMask, new Set())).toEqual({
      k: expect.not.stringContaining('sk-ant-api03') as unknown,
    });
    const own = scrubLeaves(
      JSON.parse('{"__proto__": {"x": 1}, "b": 2}'),
      scrub,
      onMask,
      new Set(),
    );
    expect(Object.keys(own as object)).toEqual(['__proto__', 'b']);
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(() => scrubLeaves(cycle, scrub, onMask, new Set())).toThrow(TypeError);
  });
});

describe('the preview masks through the seam', () => {
  it('masks a header-named key’s value, at the top level and below it, and says it masked', () => {
    const preview = buildOutputPreview(
      JSON.stringify({
        'x-api-key': 'opaqueOTHERvalue',
        '?token=': 'opaqueSECRETvalue',
        nested: { 'x-goog-api-key': 'opaqueNESTEDvalue', keep: 'plain text' },
        title: 'plain title',
      }),
    );
    for (const secret of ['opaqueOTHERvalue', 'opaqueSECRETvalue', 'opaqueNESTEDvalue'])
      expect(preview.text).not.toContain(secret);
    expect(preview.text).toContain(`"x-api-key": "${MEMBER_MASK}"`);
    expect(preview.text).toContain('"keep": "plain text"');
    expect(preview.text).toContain('"title": "plain title"');
    expect(preview.masked).toBe(true);
  });

  it('masks a value the caps would have cut, instead of showing the head of it', () => {
    // A credential-named member holding far more than the character bound: the page shows the mask, not the first 4,000 characters.
    const long = buildOutputPreview(JSON.stringify({ 'x-api-key': 'q'.repeat(10_000), after: 1 }));
    expect(long.text).toBe(`{\n  "x-api-key": "${MEMBER_MASK}",\n  "after": 1\n}`);
    expect(long.masked).toBe(true);
    expect(long.truncated).toBe(false);

    // A secret that straddles the 4,000 code-point cap of a string output, and the 40-line cap of a multi-line one.
    const straddlesChars = buildOutputPreview(
      JSON.stringify(`${FILLER}${SECRET} ${'tail '.repeat(100)}`),
    );
    expect(straddlesChars.text).not.toContain('sk-ant-');
    expect(straddlesChars).toMatchObject({ truncated: true, masked: true });

    const lines = Array.from(
      { length: OUTPUT_PREVIEW_MAX_LINES - 1 },
      (_, index) => `row ${index}`,
    );
    const straddlesLines = buildOutputPreview(
      JSON.stringify(`${lines.join('\n')}\nheld ${SECRET} end\ntail\nmore`),
    );
    expect(straddlesLines.text).not.toContain('sk-ant-');
    expect(straddlesLines).toMatchObject({ truncated: true, masked: true });

    // A document the walk stops in: a secret-shaped key and a credential-named member come before the leaf that fills the bound, and are masked.
    const keyed = buildOutputPreview(
      JSON.stringify({
        [SECRET]: 'x',
        'x-api-key': 'opaqueMEMBER',
        filler: 'f '.repeat(2_500),
        later: SECRET,
      }),
    );
    expect(keyed.text).not.toContain('sk-ant-');
    expect(keyed.text).not.toContain('opaqueMEMBER');
    expect(keyed.text).toContain(`"x-api-key": "${MEMBER_MASK}"`);
    expect(keyed.truncated).toBe(true);
  });

  it('refuses a stored document above 1 MiB with the fixed sentence, as it always did, and reads one at exactly 1 MiB', () => {
    const over = JSON.stringify('x'.repeat(MAX_STORED_OUTPUT_BYTES - 1));
    expect(Buffer.byteLength(over)).toBe(MAX_STORED_OUTPUT_BYTES + 1);
    vi.mocked(scrubModule.scrubSecrets).mockClear();
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const refused = buildOutputPreview(over);
      expect(refused).toMatchObject({
        text: `output too large to preview (${MAX_STORED_OUTPUT_BYTES + 1} bytes)`,
        truncated: false,
        masked: false,
        lines: 1,
      });
      expect(parse).not.toHaveBeenCalled();
      expect(scrubWork().calls).toBe(0);
    } finally {
      parse.mockRestore();
    }
    const atBound = JSON.stringify('x'.repeat(MAX_STORED_OUTPUT_BYTES - 2));
    expect(Buffer.byteLength(atBound)).toBe(MAX_STORED_OUTPUT_BYTES);
    expect(buildOutputPreview(atBound)).toMatchObject({
      text: 'x'.repeat(OUTPUT_PREVIEW_MAX_CHARS),
      truncated: true,
    });
  });
});

describe('a 1 MiB output costs a bound, not its size (the work is counted, not the time)', () => {
  /** A generous guard against a hang only: the claims below are the counts, which do not move with the load on the machine. */
  const HANG_GUARD_MS = 10_000;

  beforeEach(() => {
    vi.mocked(scrubModule.scrubSecrets).mockClear();
  });

  /**
   * What the walk may hand the scrubber for each line it shows: the line's key (read whole, once), the key's name (read as a name, at most
   * twice: the key, then its one-member JSON), and its leaf (once); plus the one pass over the text it has emitted. That is at most five
   * calls per line shown, so the calls are bounded by the line bound whatever the document holds.
   */
  const CALLS_PER_LINE = 5;
  const CALL_BOUND = CALLS_PER_LINE * OUTPUT_PREVIEW_MAX_LINES + 1;

  const fits = (document: string): void => {
    expect(Buffer.byteLength(document)).toBeLessThanOrEqual(MAX_STORED_OUTPUT_BYTES);
    expect(Buffer.byteLength(document)).toBeGreaterThan(MAX_STORED_OUTPUT_BYTES * 0.5);
  };

  it('hands the scrubber a bounded number of strings for 200,000 short leaves, however many the document holds', () => {
    const document = JSON.stringify(Array.from({ length: 200_000 }, () => 'ab'));
    fits(document);
    const started = performance.now();
    const preview = buildOutputPreview(document);
    expect(performance.now() - started).toBeLessThan(HANG_GUARD_MS);
    expect(preview).toMatchObject({ truncated: true, lines: OUTPUT_PREVIEW_MAX_LINES });
    const { calls, chars } = scrubWork();
    expect(calls).toBeLessThanOrEqual(CALL_BOUND);
    // Every string handed over is a leaf, or the one emitted text, which holds at most the bound's worth of text.
    expect(chars).toBeLessThanOrEqual(OUTPUT_PREVIEW_MAX_CHARS + 2 * CALL_BOUND);
  });

  it('hands the scrubber a bounded number of strings for 20,000 objects that each carry a credential-named key', () => {
    const document = JSON.stringify(
      Array.from({ length: 20_000 }, (_, index) => ({ k: `v${index}`, 'x-api-key': 'opaque' })),
    );
    fits(document);
    const preview = buildOutputPreview(document);
    expect(preview).toMatchObject({ truncated: true, masked: true });
    expect(preview.text).not.toContain('opaque');
    expect(scrubWork().calls).toBeLessThanOrEqual(CALL_BOUND);
  });

  it('reads one 1 MiB string a bounded number of times: once whole, then the cut text once', () => {
    const document = JSON.stringify('y'.repeat(MAX_STORED_OUTPUT_BYTES - 2));
    expect(Buffer.byteLength(document)).toBe(MAX_STORED_OUTPUT_BYTES);
    const preview = buildOutputPreview(document);
    expect(preview).toMatchObject({ truncated: true, chars: OUTPUT_PREVIEW_MAX_CHARS });
    const { calls, chars } = scrubWork();
    expect(calls).toBe(2);
    // The leaf is read whole (that is the point: the scrubber sees all of it before any cut), then the 32,768 code units kept are read again.
    expect(chars).toBe(MAX_STORED_OUTPUT_BYTES - 2 + 32_768);
  });

  it('reads one 1 MiB key a bounded number of times, each time whole, and never more than a constant times its size', () => {
    const key = 'k'.repeat(MAX_STORED_OUTPUT_BYTES - 20);
    const document = JSON.stringify({ [key]: 1 });
    expect(Buffer.byteLength(document)).toBeLessThanOrEqual(MAX_STORED_OUTPUT_BYTES);
    const started = performance.now();
    const preview = buildOutputPreview(document);
    expect(performance.now() - started).toBeLessThan(HANG_GUARD_MS);
    // The key is read whole and shown cut to 256 code points with its marker; the document itself fits the bounds.
    expect(preview.text).toBe(`{\n  "${'k'.repeat(MAX_KEY_SCRUB_CHARS)}…": 1\n}`);
    const { calls, chars } = scrubWork();
    // The key as a key, the key as a name (twice: bare, then inside its one-member JSON), and the emitted text.
    expect(calls).toBeLessThanOrEqual(5);
    expect(chars).toBeLessThanOrEqual(4 * MAX_STORED_OUTPUT_BYTES);
  });
});

// ---- The differential: the page and the summary mask the same values ----------------------------------------------------------

/** What the final summary shows for one output, read back from its lines (the key `out`, no indent). */
function summaryShows(value: unknown): { text: string; masked: boolean; truncated: boolean } {
  const lines = formatRunOutputs({ out: value }, '');
  const note = lines.at(-1)?.startsWith('  (outputs ') === true ? lines.pop() : undefined;
  const rest = lines.slice(1);
  const masked = note?.includes('masked') === true;
  const first = rest[0] ?? '';
  if (first.startsWith('  out: ')) {
    return { text: first.slice('  out: '.length), masked, truncated: false };
  }
  const rows = rest.slice(1);
  const truncated = rows.at(-1) === '    …';
  if (truncated) rows.pop();
  return { text: rows.map((row) => row.slice(4)).join('\n'), masked, truncated };
}

/** Every piece of a secret a masked text must not carry, whole or in part. */
const LEAKS: readonly string[] = [
  'sk-ant-',
  'S3cr3t',
  'Passw0rd',
  'opaqueMEMBER',
  'opaqueOTHER',
  'opaqueSECRET',
  'opaqueNESTED',
  'abc123abc123',
];

/**
 * Whether the page may DRAW `value` differently from the summary (see {@link expectSameMasking}): some object in it has a query-shaped
 * credential name, or a header-shaped credential name whose member is itself an object or an array.
 */
function mayBeDrawnDifferently(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return value.some(mayBeDrawnDifferently);
  return Object.entries(value).some(
    ([key, member]) =>
      QUERY_NAMES.includes(key) ||
      (HEADER_NAMES.includes(key) && typeof member === 'object' && member !== null) ||
      mayBeDrawnDifferently(member),
  );
}

/**
 * One output through both surfaces.
 *
 * Always: neither shows any piece of a secret, both say the same about masking, and both say the same about being cut. Under the caps both
 * show the same VALUE, text for text. Past them the two cut a different serialization (the summary a compact one, the page an indented
 * one), so there only the masks are compared.
 *
 * One known difference in how a masked value is DRAWN, never in what is masked: the page scrubs the text it has emitted once more as a
 * whole (a floor the page keeps, and `node-detail-model.test.ts` pins), and on its indented text the scrubber takes a credential name's
 * closing quote and its `: ` for the start of a value. For a query-shaped name (`?token=`) the page shows `"?token=[REDACTED] "[REDACTED]",`
 * where the summary shows `"?token=":"[REDACTED]"`, and for a header-shaped name that holds an object or an array it can drop the quotes
 * of a mask. The page masks MORE than the summary there, never less, so the text of a document that carries such a name is not compared
 * (see {@link mayBeDrawnDifferently}); a follow-up for the maintainer, since removing the pass edits the tests that pin it.
 */
function expectSameMasking(value: unknown, label: string): 'same' | 'cut' | 'masks-only' {
  const summary = summaryShows(value);
  const preview = buildOutputPreview(JSON.stringify(value));
  for (const leak of LEAKS) {
    expect([label, 'summary', leak, summary.text.includes(leak)]).toEqual([
      label,
      'summary',
      leak,
      false,
    ]);
    expect([label, 'preview', leak, preview.text.includes(leak)]).toEqual([
      label,
      'preview',
      leak,
      false,
    ]);
  }
  const isString = typeof value === 'string';
  // A string is one leaf, read whole by both. A document the page walked to its end has had every value read by both. A document the page
  // stopped in has not: the summary reads (and masks) the values past the cut that the page never reaches, so the page may say less, never
  // more.
  if (isString || !preview.truncated) {
    expect([label, 'masked', preview.masked]).toEqual([label, 'masked', summary.masked]);
  } else if (preview.masked) {
    expect([label, 'masked, the page implies the summary', summary.masked]).toEqual([
      label,
      'masked, the page implies the summary',
      true,
    ]);
  }
  // The page's indented text is longer than the summary's compact text, so it can be cut where the summary is not, never the reverse.
  if (isString)
    expect([label, 'cut', preview.truncated]).toEqual([label, 'cut', summary.truncated]);
  else if (summary.truncated)
    expect([label, 'cut', preview.truncated]).toEqual([label, 'cut', true]);
  if (summary.truncated || preview.truncated) return 'cut';
  if (mayBeDrawnDifferently(value)) return 'masks-only';
  if (isString) {
    expect([label, preview.text]).toEqual([label, summary.text]);
  } else {
    const onPage: unknown = JSON.parse(preview.text);
    const inSummary: unknown = JSON.parse(summary.text);
    expect([label, onPage]).toEqual([label, inSummary]);
  }
  return 'same';
}

const NAMED_OUTPUTS: Readonly<Record<string, unknown>> = {
  'a header-named key': {
    'x-api-key': 'opaqueOTHERvalue',
    'x-goog-api-key': 'opaqueNESTEDvalue',
    title: 'plain text',
  },
  'a query-named key': { '?token=': 'opaqueSECRETvalue', title: 'plain text' },
  'a header-named key below the top, with a number and a null': {
    outer: { 'x-api-key': 12_345, 'x-goog-api-key': null, keep: 12_345 },
  },
  'a bidi character in a leaf': { note: `before ${RLO}after`, list: [`${RLO}x`] },
  'a bidi character in a string output': `before ${RLO}after`,
  'an escape in a leaf': { note: `plain ${ESC}[31mred${ESC}[0m text${BEL}` },
  'an escape in a string output': `plain ${ESC}[2Jcleared${BEL}`,
  'a secret in a key and in a value': { [SECRET]: 'plain value', note: `held ${SECRET}` },
  'a secret after a line break inside a leaf': { note: `first line\n${SECRET}` },
  'a URL password in a string output': `connect to ${USERINFO_URL} now`,
  'an over-long string output': 'o'.repeat(9_000),
  'an over-long string output with a secret at the character cut': `${FILLER}${SECRET} ${'tail '.repeat(100)}`,
  'an over-long string output with a secret at the line cut': `${Array.from({ length: OUTPUT_PREVIEW_MAX_LINES - 1 }, (_, index) => `row ${index}`).join('\n')}\nheld ${SECRET} end\ntail\nmore`,
  'an over-long value under a credential-named key': { 'x-api-key': 'opaqueMEMBER'.repeat(1_000) },
  'an over-long value with a secret in it': {
    note: `${'z '.repeat(2_500)}${SECRET}`,
    'x-api-key': 'opaqueMEMBER',
  },
  'a plain document': { a: [1, 2], b: 'x', c: null, d: true, e: {}, f: [] },
  'a bare number': 42,
  'an empty string': '',
};

describe('the preview and the final summary mask the same values (the differential)', () => {
  it('agrees on the named outputs: a header-named key, a bidi character, an escape, a secret, an over-long value', () => {
    const verdicts = Object.fromEntries(
      Object.entries(NAMED_OUTPUTS).map(([label, value]) => [
        label,
        expectSameMasking(value, label),
      ]),
    );
    // `same`: shown whole by both, equal text for text. `cut`: past the caps, the masks compared. `masks-only`: a name the page draws
    // differently (see `mayBeDrawnDifferently`), the masks compared.
    expect(verdicts).toEqual({
      'a header-named key': 'same',
      'a query-named key': 'masks-only',
      'a header-named key below the top, with a number and a null': 'same',
      'a bidi character in a leaf': 'same',
      'a bidi character in a string output': 'same',
      'an escape in a leaf': 'same',
      'an escape in a string output': 'same',
      'a secret in a key and in a value': 'same',
      'a secret after a line break inside a leaf': 'same',
      'a URL password in a string output': 'same',
      'an over-long string output': 'cut',
      'an over-long string output with a secret at the character cut': 'cut',
      'an over-long string output with a secret at the line cut': 'cut',
      'an over-long value under a credential-named key': 'same',
      'an over-long value with a secret in it': 'cut',
      'a plain document': 'same',
      'a bare number': 'same',
      'an empty string': 'same',
    });
  });

  it('shows a header-named key’s value masked on both surfaces, and the query-named key’s too', () => {
    for (const name of CREDENTIAL_NAMES) {
      const value = { [name]: 'opaqueMEMBER', after: 'plain' };
      const preview = buildOutputPreview(JSON.stringify(value));
      const summary = summaryShows(value);
      expect([name, preview.text.includes('opaqueMEMBER')]).toEqual([name, false]);
      expect([name, summary.text.includes('opaqueMEMBER')]).toEqual([name, false]);
      expect([name, preview.masked, summary.masked]).toEqual([name, true, true]);
      expect([name, preview.text.includes('"after": "plain"')]).toEqual([name, true]);
    }
  });

  /** mulberry32: the same documents on every run and every machine. */
  const seeded = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    };
  };

  const LEAVES: readonly [unknown, ...unknown[]] = [
    'plain text',
    '',
    SECRET,
    `held ${SECRET} inside`,
    `first line\n${SECRET}`,
    USERINFO_URL,
    `Bearer ${'abc123'.repeat(5)}`,
    `before ${RLO}after`,
    `red ${ESC}[31mtext${ESC}[0m${BEL}`,
    'z '.repeat(2_500),
    `${FILLER}${SECRET}`,
    12_345,
    -1.5,
    true,
    false,
    null,
  ];
  /** Keys that stay distinct after masking, so the summary's "two keys masked to one keep the later" never applies. */
  const KEYS: readonly [string, ...string[]] = [
    'title',
    'note',
    'items',
    'name',
    'body',
    ...HEADER_NAMES,
    '?token=',
    '?key=',
  ];

  it('agrees on 300 seeded documents of nested objects, arrays and the leaves above', () => {
    const rng = seeded(20_261_123);
    const pick = <T>(items: readonly [T, ...T[]]): T =>
      items[Math.floor(rng() * items.length)] ?? items[0];
    const build = (depth: number): unknown => {
      const roll = rng();
      if (depth === 0 || roll < 0.45) return pick(LEAVES);
      if (roll < 0.65)
        return Array.from({ length: 1 + Math.floor(rng() * 4) }, () => build(depth - 1));
      const keys = [...KEYS].sort(() => rng() - 0.5).slice(0, 1 + Math.floor(rng() * 5));
      return Object.fromEntries(
        keys.map((key) => {
          const child = build(depth - 1);
          // A credential-named member that holds a string holds one the page and the summary must both mask whole.
          return [
            key,
            CREDENTIAL_NAMES.includes(key) && typeof child === 'string' ? 'opaqueMEMBER' : child,
          ];
        }),
      );
    };
    const tally = { same: 0, cut: 0, 'masks-only': 0, masked: 0 };
    for (let at = 0; at < 300; at += 1) {
      const document = build(3);
      tally[expectSameMasking(document, `seeded document ${at}`)] += 1;
      if (buildOutputPreview(JSON.stringify(document)).masked) tally.masked += 1;
    }
    // Neither bucket is empty, and the sample is not mostly one kind: whole documents compared text for text, cut ones compared by their
    // masks, and the ones that carry a query-shaped name.
    expect(tally.same).toBeGreaterThan(100);
    expect(tally.cut).toBeGreaterThan(5);
    expect(tally['masks-only']).toBeGreaterThan(5);
    expect(tally.masked).toBeGreaterThan(50);
  });
});
