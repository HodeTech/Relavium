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
  CREDENTIAL_MEMBER_NAMES,
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
 * (`x-api-key`) and the query form (`?token=`). These are the names the scrubber masks the stand-in value behind, so they mask every
 * primitive value, a boolean and a null included.
 *
 * Until PR #102's review (P1-14) this list was also the WHOLE rule, and a name such as `Authorization` or `password` was deliberately
 * "not a label": the scrubber does not mask the stand-in behind it, so neither surface masked that member on the strength of its name,
 * and an opaque value in it reached the terminal in the clear. The exact-name list ({@link LISTED_NAMES}) now masks those too; the
 * names below are unchanged, so the differential cases built on them still prove the scrubber-label path.
 */
const HEADER_NAMES: readonly string[] = ['x-api-key', 'X-API-KEY', 'api-key', 'x-goog-api-key'];
const QUERY_NAMES: readonly string[] = ['?token=', '?key=', '&token=', '?api_key='];
const CREDENTIAL_NAMES: readonly string[] = [...HEADER_NAMES, ...QUERY_NAMES];

/**
 * Member names only the exact list knows (`CREDENTIAL_MEMBER_NAMES`): no scrubber rule reads them as a label, because the value behind
 * a JSON member such as `"apiKey"` has no shape of its own. Several spellings of each, as a JSON document writes them.
 */
const LISTED_NAMES: readonly string[] = [
  'apiKey',
  'api_key',
  'API_KEY',
  'Api Key',
  'api.key',
  'x_api_key',
  'apiSecret',
  'api_secret',
  'secret',
  'Secret',
  'secretKey',
  'secret_key',
  'client_secret',
  'clientSecret',
  'Client-Secret',
  'private_key',
  'privateKey',
  'access_key',
  'accessKey',
  'password',
  'Password',
  'PASSWORD',
  'passwd',
  'passphrase',
  'authorization',
  'Authorization',
  'credential',
  'credentials',
  'Credentials',
  'token',
  'Token',
  'accessToken',
  'access_token',
  'authToken',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'bearer_token',
  'bearerToken',
  'sessionToken',
];
/** Names a broader rule would mask and ordinary data uses: the list is exact, so every one of these stays visible. */
const TOO_BROAD_NAMES: readonly string[] = [
  'key',
  'Key',
  'tokens',
  'max_tokens',
  'token_count',
  'tokenizer',
  'author',
  'authority',
  'auth',
  'passwordless',
  'password_hint',
  'api_key_id',
  'apiKeyName',
  'secretary',
  'secrets',
  'public_key',
  'keyword',
  'monkey',
  'pass',
];

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
    const preview = buildOutputPreview(document);
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
    const preview = buildOutputPreview(document);
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
function summaryShows(
  value: unknown,
  key = 'out',
): { text: string; masked: boolean; truncated: boolean } {
  const lines = formatRunOutputs({ [key]: value }, '');
  const note = lines.at(-1)?.startsWith('  (outputs ') === true ? lines.pop() : undefined;
  const rest = lines.slice(1);
  const masked = note?.includes('masked') === true;
  const first = rest[0] ?? '';
  if (first.startsWith(`  ${key}: `)) {
    const shown = first.slice(`  ${key}: `.length);
    // An empty string prints `(empty)` beside its key, so the line never ends in a bare colon; the page shows it as empty.
    return { text: value === '' && shown === '(empty)' ? '' : shown, masked, truncated: false };
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
  // Neither surface lets a control through (T09-1): an escape sequence, a bell and a bidirectional override are stripped from every text
  // each one shows, whatever else it masks or cuts. Without this the differential would pass while one surface printed a control.
  for (const control of [ESC, BEL, RLO]) {
    expect([label, 'summary', 'control', summary.text.includes(control)]).toEqual([
      label,
      'summary',
      'control',
      false,
    ]);
    expect([label, 'preview', 'control', preview.text.includes(control)]).toEqual([
      label,
      'preview',
      'control',
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
  // Past the caps the two texts differ (a compact serialization against an indented one), so only the masks and the strip are compared.
  'an over-long string output with controls early in it': `${'o'.repeat(40)}${RLO}${ESC}[2J${BEL}${'o'.repeat(9_000)}`,
  'an over-long value under a credential-named key': { 'x-api-key': 'opaqueMEMBER'.repeat(1_000) },
  'an over-long value with a secret in it': {
    note: `${'z '.repeat(2_500)}${SECRET}`,
    'x-api-key': 'opaqueMEMBER',
  },
  'listed credential names, at the top and below it': {
    apiKey: 'opaqueSECRETvalue',
    config: { password: 'opaqueOTHERvalue', host: 'db.internal' },
    users: [
      { name: 'a', client_secret: 'opaqueNESTEDvalue' },
      { name: 'b', Authorization: 12_345 },
    ],
    max_tokens: 4096,
  },
  'a control character beside a listed name': {
    token: `opaqueMEMBER${ESC}[31m`,
    note: `x${RLO}y${BEL}`,
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
      'an over-long string output with controls early in it': 'cut',
      'an over-long value under a credential-named key': 'same',
      'an over-long value with a secret in it': 'cut',
      'listed credential names, at the top and below it': 'same',
      'a control character beside a listed name': 'same',
      'a plain document': 'same',
      'a bare number': 'same',
      'an empty string': 'same',
    });
  });

  it('masks the value of an output whose NAME labels a credential on both surfaces: the page is given the node id the summary reads as the output key', () => {
    for (const name of CREDENTIAL_NAMES) {
      for (const value of ['opaqueMEMBER', 12_345, false, null]) {
        const preview = buildOutputPreview(JSON.stringify(value), name);
        const summary = summaryShows(value, name);
        expect([name, value, preview.text.includes('opaqueMEMBER')]).toEqual([name, value, false]);
        expect([name, value, summary.text.includes('opaqueMEMBER')]).toEqual([name, value, false]);
        expect([name, value, preview.masked, summary.masked]).toEqual([name, value, true, true]);
        expect([name, value, preview.text]).toEqual([name, value, summary.text]);
      }
    }
    // An output name that labels nothing leaves the value alone on both.
    expect(buildOutputPreview(JSON.stringify('plain'), 'title').text).toBe(
      summaryShows('plain', 'title').text,
    );
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

// ---- P1-14: a member NAMED like a credential is masked whole, by the exact list ---------------------------------------------------

describe('a member named like a credential is masked whole, by an exact list of names (PR #102 review P1-14)', () => {
  it('reads every listed spelling as a label, however it is cased or separated', () => {
    for (const name of LISTED_NAMES) expect([name, namesCredential(name)]).toEqual([name, true]);
  });

  it('masks a string or a number under a listed name, keeps a boolean and a null, and leaves an object to its own walk', () => {
    for (const name of LISTED_NAMES) {
      const told: string[] = [];
      const onMask = (): void => {
        told.push(name);
      };
      expect(maskedAsMember(name, 'opaqueSECRETvalue', onMask)).toBe(MEMBER_MASK);
      expect(maskedAsMember(name, 12_345, onMask)).toBe(MEMBER_MASK);
      expect(maskedAsMember(name, 12n, onMask)).toBe(MEMBER_MASK);
      expect(told).toEqual([name, name, name]);
      // A flag or a null carries no credential, and `{ secret: true, ref }` is how a masked secret input is already shown.
      expect(maskedAsMember(name, true, never)).toBe(true);
      expect(maskedAsMember(name, false, never)).toBe(false);
      expect(maskedAsMember(name, null, never)).toBeNull();
      expect(maskedAsMember(name, { nested: 'opaqueSECRETvalue' }, never)).toEqual({
        nested: 'opaqueSECRETvalue',
      });
      expect(maskedAsMember(name, undefined, never)).toBeUndefined();
    }
    // The scrubber's own labels keep masking a flag and a null, as they always did.
    expect(maskedAsMember('x-api-key', false, () => undefined)).toBe(MEMBER_MASK);
    expect(maskedAsMember('x-api-key', null, () => undefined)).toBe(MEMBER_MASK);
  });

  it('keeps a name that only looks like a label visible: the list is exact, not a pattern', () => {
    for (const name of TOO_BROAD_NAMES) {
      expect([name, namesCredential(name)]).toEqual([name, false]);
      expect(maskedAsMember(name, 'plain text', never)).toBe('plain text');
      expect(maskedAsMember(name, 4096, never)).toBe(4096);
    }
  });

  it('keeps a name the scrubber reads as a secret shape of its own as it was: masked itself, its value kept', () => {
    // `Bearer token` normalizes to the listed `bearertoken`, but the scrubber masks it up to its end, so it is a shape and not a label.
    expect(namesCredential('Bearer token')).toBe(false);
    expect(maskedAsMember('Bearer token', 'supported', never)).toBe('supported');
    expect(namesCredential('bearer_token')).toBe(true);
  });

  it('masks at every depth and in an array of members, on the eager walk', () => {
    const told: string[] = [];
    const onMask = (): void => {
      told.push('masked');
    };
    const scrub = (text: string): string => maskText(text, onMask);
    const copy = scrubLeaves(
      {
        apiKey: 'opaqueSECRETvalue',
        config: { db: { password: 'opaqueOTHERvalue', host: 'db.internal' } },
        users: [
          { name: 'a', client_secret: 'opaqueNESTEDvalue' },
          { name: 'b', Authorization: 'opaqueMEMBER-1', token: 12_345 },
          [{ passphrase: 'opaqueMEMBER-2' }],
        ],
        max_tokens: 4096,
        tokens: 'plain-tokens',
        key: 'plain-key',
        secret: true,
      },
      scrub,
      onMask,
      new Set(),
    );
    expect(copy).toEqual({
      apiKey: MEMBER_MASK,
      config: { db: { password: MEMBER_MASK, host: 'db.internal' } },
      users: [
        { name: 'a', client_secret: MEMBER_MASK },
        { name: 'b', Authorization: MEMBER_MASK, token: MEMBER_MASK },
        [{ passphrase: MEMBER_MASK }],
      ],
      max_tokens: 4096,
      tokens: 'plain-tokens',
      key: 'plain-key',
      secret: true,
    });
    expect(told).toHaveLength(6);
  });

  it('shows the same masked document on the summary and on the page, and says it masked', () => {
    const document = {
      apiKey: 'opaqueSECRETvalue',
      config: { db: { password: 'opaqueOTHERvalue', host: 'db.internal' } },
      users: [
        { name: 'a', client_secret: 'opaqueNESTEDvalue' },
        { name: 'b', Authorization: 'opaqueMEMBER-1' },
      ],
      max_tokens: 4096,
      key: 'plain-key',
    };
    const masked = {
      apiKey: MEMBER_MASK,
      config: { db: { password: MEMBER_MASK, host: 'db.internal' } },
      users: [
        { name: 'a', client_secret: MEMBER_MASK },
        { name: 'b', Authorization: MEMBER_MASK },
      ],
      max_tokens: 4096,
      key: 'plain-key',
    };
    const summary = summaryShows(document);
    const preview = buildOutputPreview(JSON.stringify(document));
    for (const leak of LEAKS) {
      expect([leak, summary.text.includes(leak)]).toEqual([leak, false]);
      expect([leak, preview.text.includes(leak)]).toEqual([leak, false]);
    }
    expect(JSON.parse(summary.text)).toEqual(masked);
    expect(JSON.parse(preview.text)).toEqual(masked);
    expect([summary.masked, preview.masked]).toEqual([true, true]);
  });

  it('masks a top-level output whose id is a listed name, on both surfaces', () => {
    for (const name of ['password', 'api-key', 'client-secret', 'access-token', 'credentials']) {
      for (const value of ['opaqueMEMBER', 12_345]) {
        const preview = buildOutputPreview(JSON.stringify(value), name);
        const summary = summaryShows(value, name);
        // A string output shows the mask itself; any other value shows it as the JSON text of a string, as it does under a header name.
        const shown = typeof value === 'string' ? MEMBER_MASK : JSON.stringify(MEMBER_MASK);
        expect([name, value, preview.text, summary.text]).toEqual([name, value, shown, shown]);
        expect([name, value, preview.masked, summary.masked]).toEqual([name, value, true, true]);
      }
    }
    // An id that only looks like one, and a flag under a listed id, are left alone.
    expect(summaryShows('plain', 'max-tokens').text).toBe('plain');
    expect(summaryShows(true, 'token').text).toBe('true');
  });

  it('masks the value whole BEFORE any cap: a long value, and a member that sits past the cut, never reach the terminal', () => {
    // A listed member holding far more than the character bound shows the mask, not the first 4,000 characters of it.
    const long = buildOutputPreview(JSON.stringify({ apiKey: 'q'.repeat(10_000), after: 1 }));
    expect(long.text).toBe(`{\n  "apiKey": "${MEMBER_MASK}",\n  "after": 1\n}`);
    expect(long).toMatchObject({ masked: true, truncated: false });
    const summaryLong = formatRunOutputs({ out: { password: 'q'.repeat(10_000) } }, '');
    expect(summaryLong.join('\n')).not.toContain('qqqq');
    expect(summaryLong[1]).toBe(`  out: {"password":"${MEMBER_MASK}"}`);
    expect(formatRunOutputs({ password: 'q'.repeat(10_000) }, '')[1]).toBe(
      `  password: ${MEMBER_MASK}`,
    );

    // A listed member that comes after a sibling which fills the bound: the page stops before it, the summary reads it, and neither shows it.
    const document = { filler: 'f '.repeat(2_500), apiKey: 'opaqueMEMBER', token: 'opaqueOTHER' };
    const cut = buildOutputPreview(JSON.stringify(document));
    expect(cut.truncated).toBe(true);
    expect(cut.text).not.toContain('opaque');
    const summary = summaryShows(document);
    expect(summary.text).not.toContain('opaque');
    expect([summary.masked, summary.truncated]).toEqual([true, true]);
  });
});

describe('the rule only adds masks: nothing masked before the exact list is unmasked after it (the marker oracle)', () => {
  /** The rule as it stood before the exact list: the scrubber's own reading of the name, and nothing else. */
  const legacyNamesCredential = (key: string): boolean => {
    const own = scrubModule.scrubSecrets(key);
    if (own !== key && own.endsWith(MEMBER_MASK)) return false;
    return !scrubModule
      .scrubSecrets(JSON.stringify({ [key]: 'v' }))
      .endsWith(`:${JSON.stringify('v')}}`);
  };

  /** A primitive leaf of a document: the marker it carries (a string or a number) and the NAME of the member that holds it. */
  interface MarkedLeaf {
    readonly name: string;
    readonly marker: string | number;
  }

  const NAME_POOL: readonly string[] = [
    ...CREDENTIAL_NAMES,
    ...LISTED_NAMES,
    ...TOO_BROAD_NAMES,
    'title',
    'note',
    'items',
    'Bearer token',
    'Basic plan',
    'x-api-key ',
    'https://h.example/a?token=',
  ];

  /** `build(depth)` documents whose every primitive leaf is a unique marker, and the list of those leaves with their member names. */
  function corpus(seed: number, count: number): { document: unknown; leaves: MarkedLeaf[] }[] {
    let state = seed >>> 0;
    const next = (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    };
    let serial = 0;
    const documents: { document: unknown; leaves: MarkedLeaf[] }[] = [];
    for (let at = 0; at < count; at += 1) {
      const leaves: MarkedLeaf[] = [];
      const build = (depth: number, name: string): unknown => {
        const roll = next();
        if (depth === 0 || roll < 0.5) {
          serial += 1;
          const marker = roll < 0.25 ? `MARKER-${String(serial)}-zz` : 9_000_000 + serial;
          leaves.push({ name, marker });
          return marker;
        }
        // An item of an array is not a member: no name labels it, whatever the member that holds the array is called.
        if (roll < 0.65)
          return Array.from({ length: 1 + Math.floor(next() * 3) }, () => build(depth - 1, ''));
        const names = [...NAME_POOL].sort(() => next() - 0.5).slice(0, 1 + Math.floor(next() * 5));
        return Object.fromEntries(names.map((member) => [member, build(depth - 1, member)]));
      };
      documents.push({ document: { root: build(4, 'root') }, leaves });
    }
    return documents;
  }

  /** The markers a masking function hides: every leaf of `document` whose marker is missing from what it shows. */
  const hiddenMarkers = (
    document: unknown,
    leaves: readonly MarkedLeaf[],
    show: (document: unknown) => string,
  ): Set<string | number> => {
    const shown = show(document);
    return new Set(
      leaves.filter(({ marker }) => !shown.includes(String(marker))).map(({ marker }) => marker),
    );
  };

  const realShow = (document: unknown): string =>
    JSON.stringify(
      scrubLeaves(
        document,
        (text) => maskText(text, () => undefined),
        () => undefined,
        new Set(),
      ),
    );

  /** Every marker the BEFORE rule hides that `show` does not hide, as `name: marker` strings. */
  const violations = (
    documents: readonly { document: unknown; leaves: MarkedLeaf[] }[],
    show: (document: unknown) => string,
  ): string[] =>
    documents.flatMap(({ document, leaves }) => {
      const hidden = hiddenMarkers(document, leaves, show);
      return leaves
        .filter(({ name, marker }) => legacyNamesCredential(name) && !hidden.has(marker))
        .map(({ name, marker }) => `${name}: ${String(marker)}`);
    });

  it('hides, after the change, every leaf the old rule hid, on 400 seeded documents of every kind of member name', () => {
    const documents = corpus(20_261_124, 400);
    // The corpus must reach the case: leaves under the scrubber's labels, under listed names, and under names that stay visible.
    const names = documents.flatMap(({ leaves }) => leaves.map(({ name }) => name));
    expect(names.filter((name) => legacyNamesCredential(name)).length).toBeGreaterThan(100);
    expect(names.filter((name) => LISTED_NAMES.includes(name)).length).toBeGreaterThan(100);
    expect(names.filter((name) => TOO_BROAD_NAMES.includes(name)).length).toBeGreaterThan(100);
    expect(violations(documents, realShow)).toEqual([]);
  });

  it('hides a leaf under a listed name that the old rule left visible, and still shows a flag-free plain name', () => {
    const documents = corpus(20_261_125, 200);
    let hiddenByTheList = 0;
    for (const { document, leaves } of documents) {
      const hidden = hiddenMarkers(document, leaves, realShow);
      for (const { name, marker } of leaves) {
        if (LISTED_NAMES.includes(name) && !legacyNamesCredential(name)) {
          expect([name, marker, hidden.has(marker)]).toEqual([name, marker, true]);
          hiddenByTheList += 1;
        }
        if (['title', 'note', 'items', ...TOO_BROAD_NAMES].includes(name)) {
          expect([name, marker, hidden.has(marker)]).toEqual([name, marker, false]);
        }
      }
    }
    expect(hiddenByTheList).toBeGreaterThan(50);
  });

  it('is a real oracle: a rule that dropped the scrubber reading, keeping only the list, is caught by it', () => {
    const documents = corpus(20_261_124, 400);
    // The KNOWN-BAD version: names the exact list knows are masked, and the header and query names the old rule masked are not.
    const listOnly = (document: unknown): string =>
      JSON.stringify(
        JSON.parse(JSON.stringify(document), function (this: unknown, key: string, value: unknown) {
          return CREDENTIAL_MEMBER_NAMES.has(key.toLowerCase().replaceAll(/[\s._-]/gu, '')) &&
            (typeof value === 'string' || typeof value === 'number')
            ? MEMBER_MASK
            : value;
        }),
      );
    expect(violations(documents, listOnly).length).toBeGreaterThan(50);
  });
});

// ---- P2: a cut never ends in a lone surrogate -------------------------------------------------------------------------------------

describe('the cut falls on a code point, not inside one (PR #102 review, maskThenCut)', () => {
  const EMOJI = String.fromCodePoint(0x1f600);
  const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

  it('leaves an emoji at the limit out whole instead of ending in half of it', () => {
    expect(maskThenCut(`ab${EMOJI}cd`, 3, never)).toEqual({ text: 'ab', cut: true });
    expect(maskThenCut(`ab${EMOJI}cd`, 4, never)).toEqual({ text: `ab${EMOJI}`, cut: true });
    expect(maskThenCut(`ab${EMOJI}cd`, 2, never)).toEqual({ text: 'ab', cut: true });
    // The first character is the emoji and the limit is inside it: nothing fits, and nothing broken is shown.
    expect(maskThenCut(`${EMOJI}x`, 1, never)).toEqual({ text: '', cut: true });
    expect(maskThenCut(`${EMOJI}x`, 0, never)).toEqual({ text: '', cut: true });
    // A text that fits is untouched, an emoji at its very end included.
    expect(maskThenCut(`ab${EMOJI}`, 4, never)).toEqual({ text: `ab${EMOJI}`, cut: false });
  });

  it('never returns a lone surrogate, whatever the limit', () => {
    const text = `a${EMOJI}b${EMOJI}${EMOJI}c`;
    for (let limit = 0; limit <= text.length; limit += 1) {
      const { text: shown } = maskThenCut(text, limit, never);
      expect([limit, loneSurrogate.test(shown)]).toEqual([limit, false]);
      expect(text.startsWith(shown)).toBe(true);
      expect(shown.length).toBeLessThanOrEqual(limit);
      expect(shown.length).toBeGreaterThanOrEqual(limit - 1);
    }
  });

  it('shows nothing for a limit of zero, a negative limit or one that is not a number, and says it cut', () => {
    for (const limit of [0, -1, -50, Number.NaN]) {
      expect([limit, maskThenCut(`ab${EMOJI}cd`, limit, never)]).toEqual([
        limit,
        { text: '', cut: true },
      ]);
    }
  });

  it('keeps a lone surrogate that is already in the text as it is: it is not a pair to protect', () => {
    const lone = String.fromCharCode(0xd83d);
    expect(maskThenCut(`ab${lone}cd`, 3, never)).toEqual({ text: `ab${lone}`, cut: true });
  });

  it('still masks before it cuts when the secret and an emoji straddle the limit', () => {
    const text = `${EMOJI.repeat(3)}${'a'.repeat(10)}${USERINFO_URL}`;
    for (const limit of [5, 7, 16, 25]) {
      const told: string[] = [];
      const cut = maskThenCut(text, limit, () => told.push('masked'));
      expect(cut.text).not.toContain('S3cr3t');
      expect(loneSurrogate.test(cut.text)).toBe(false);
      expect(told).toEqual(['masked']);
    }
  });
});
