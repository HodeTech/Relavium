import { describe, expect, it } from 'vitest';

import { looksLikeProviderKey } from './provider-key-shape.js';

/**
 * The predicate that decides whether a typed line is a pasted provider key (ADR-0146 §6). It is the real key formats and nothing wider:
 * the diagnostic scrubber it replaced discarded `Explain Basic auth` as a key and missed a key that followed a word character. The rules
 * added in MVP-11 Step 2's review rounds: the invisible and look-alike characters a terminal draws as nothing, the OpenRouter, `sk-None-`,
 * Groq, xAI and generic `sk-<word>-` shapes, an assignment in any case with a credential-shaped value, and a word start before the
 * unspecific prefixes. Every key below is built from pieces, so no file holds one whole.
 */

const FILL = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY';
interface KeyCase {
  readonly key: string;
  /** A prefix specific enough to be found glued to a letter (`xsk-ant-...`); the unspecific ones need a word start (B2). */
  readonly specific: boolean;
}
const KEYS: Readonly<Record<string, KeyCase>> = {
  anthropic: { key: `sk-ant-api03-${FILL}${FILL}-_AA`, specific: true },
  'openai project': { key: `sk-proj-${FILL}${FILL}`, specific: true },
  'openai service account': { key: `sk-svcacct-${FILL}${FILL}`, specific: true },
  'openai admin': { key: `sk-admin-${FILL}${FILL}`, specific: true },
  'openai None': { key: `sk-None-${FILL}${FILL}`, specific: true },
  openrouter: { key: `sk-or-v1-${'0123456789abcdef'.repeat(4)}`, specific: true },
  'openai legacy': { key: `sk-${FILL}${FILL.slice(0, 16)}`, specific: false },
  deepseek: { key: `sk-${'0123456789abcdef'.repeat(2)}`, specific: false },
  'a generic sk-<word>- key': { key: `sk-custom-${FILL}${FILL}`, specific: false },
  'a generic sk-<word>-v<digits>- key': { key: `sk-acme-v2-${FILL}${FILL}`, specific: false },
  gemini: { key: `AIza${FILL}_-x`, specific: false },
  groq: { key: `gsk_${FILL}${FILL}`, specific: false },
  xai: { key: `xai-${FILL}${FILL}`, specific: false },
};
// Built from code points, never written as the characters: an invisible character in a source file is the hazard this predicate guards against.
const ZWSP = String.fromCharCode(0x200b);
const ZWJ = String.fromCharCode(0x200d);
const SHY = String.fromCharCode(0x00ad);
const BOM = String.fromCharCode(0xfeff);
const RLO = String.fromCharCode(0x202e);
const CGJ = String.fromCharCode(0x034f); // combining grapheme joiner
const VS16 = String.fromCharCode(0xfe0f); // variation selector-16
const HANGUL_FILLERS = [0x115f, 0x1160, 0x3164, 0xffa0].map((code) => String.fromCharCode(code));
const TAG_SPACE = String.fromCodePoint(0xe0020); // a tag character: invisible
const VS_SUPPLEMENT = String.fromCodePoint(0xe0100); // a variation selector of the supplementary plane
const ACUTE = String.fromCharCode(0x0301); // a combining acute accent
const NON_BREAKING_HYPHEN = String.fromCharCode(0x2011);
const MINUS_SIGN = String.fromCharCode(0x2212);
const EN_DASH = String.fromCharCode(0x2013);
const FULLWIDTH_HYPHEN = String.fromCharCode(0xff0d);

/** Every printable ASCII character as its fullwidth form (`sk-` becomes `ｓｋ－`): what a Japanese input method pastes. */
const fullwidth = (text: string): string =>
  [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x21 && code <= 0x7e ? String.fromCharCode(code + 0xfee0) : char;
    })
    .join('');

/** Where a key can sit in what a person types or pastes. `glued` marks a form that attaches a letter to the prefix, which only a specific prefix survives. */
const FORMS: readonly (readonly [string, (key: string) => string])[] = [
  ['alone', (key) => key],
  ['quoted', (key) => `"${key}"`],
  ['single-quoted', (key) => `'${key}'`],
  ['in a sentence', (key) => `here is my key ${key} please use it`],
  ['as an assignment', (key) => `ANTHROPIC_API_KEY=${key}`],
  ['as an exported assignment', (key) => `export OPENAI_API_KEY="${key}"`],
  ['after a newline', (key) => `first line\n${key}`],
  ['after a word character', (key) => `mykey_${key}`],
  ['after punctuation', (key) => `key:${key}`],
  [
    'with a zero-width space inside the first characters',
    (key) => `${key[0]}${ZWSP}${key.slice(1)}`,
  ],
  [
    'with a zero-width joiner and a soft hyphen inside the prefix',
    (key) => `${key.slice(0, 2)}${ZWJ}${key.slice(2, 4)}${SHY}${key.slice(4)}`,
  ],
  ['with a byte order mark and a bidi mark before it', (key) => `${BOM}${RLO}${key}`],
  // The characters a terminal draws as nothing, or as something that is not a letter of the prefix (round 2, K1/B1).
  [
    'with a combining grapheme joiner inside the prefix',
    (key) => `${key.slice(0, 1)}${CGJ}${key.slice(1)}`,
  ],
  [
    'with variation selectors inside the prefix',
    (key) => `${key.slice(0, 1)}${VS16}${key.slice(1, 3)}${VS_SUPPLEMENT}${key.slice(3)}`,
  ],
  ...HANGUL_FILLERS.map((filler): readonly [string, (key: string) => string] => [
    `with the Hangul filler U+${filler.charCodeAt(0).toString(16).toUpperCase()} inside the prefix`,
    (key) => `${key.slice(0, 2)}${filler}${key.slice(2)}`,
  ]),
  [
    'with a tag character inside the prefix',
    (key) => `${key.slice(0, 2)}${TAG_SPACE}${key.slice(2)}`,
  ],
  [
    'with a combining accent on the first letter',
    (key) => `${key.slice(0, 1)}${ACUTE}${key.slice(1)}`,
  ],
  ['in fullwidth forms', fullwidth],
  [
    'with a non-breaking hyphen for its first hyphen',
    (key) => key.replace('-', NON_BREAKING_HYPHEN),
  ],
  ['with a minus sign for its first hyphen', (key) => key.replace('-', MINUS_SIGN)],
  ['with an en dash for its first hyphen', (key) => key.replace('-', EN_DASH)],
  ['with a fullwidth hyphen for its first hyphen', (key) => key.replace('-', FULLWIDTH_HYPHEN)],
];

describe('looksLikeProviderKey', () => {
  describe.each(Object.entries(KEYS))('%s', (_provider, { key, specific }) => {
    it.each(FORMS)('finds a key %s', (_form, build) => {
      expect(looksLikeProviderKey(build(key))).toBe(true);
    });

    it(
      specific
        ? 'finds a key glued to a letter: its prefix is specific enough to be found anywhere'
        : 'does not find a key glued to a letter: its prefix is short enough to sit inside a word (B2)',
      () => {
        expect(looksLikeProviderKey(`x${key}`)).toBe(specific);
        expect(looksLikeProviderKey(`k3${key}`)).toBe(specific);
      },
    );
  });

  describe('a pasted .env assignment', () => {
    // A value of 20 or more characters of letters, digits and `_-./+=` (round 2, B1/B2); the name is anything that ends in API_KEY, in any case.
    const VALUE = 'abcdefghijklmnopqrst'; // 20
    it.each([
      `MY_SERVICE_API_KEY = ${VALUE}`,
      `API_KEY=${VALUE}`,
      `GEMINI_API_KEY=\t"${VALUE}"`,
      `GEMINI_API_KEY='${VALUE}'`,
      `openai_api_key=${VALUE}`,
      `myAPI_KEY=${VALUE}`,
      `Api_Key = ${VALUE}`,
      `export OPENAI_API_KEY=${VALUE}`,
      `API_KEY=${VALUE}/with+base64==padding.and-more_chars`,
      `x API_KEY=${VALUE}`,
      `MY_API_KEY=${fullwidth('abcdefghijklmnopqrst')}`,
    ])('finds %j', (line) => {
      expect(looksLikeProviderKey(line)).toBe(true);
    });

    it('pins the boundary of the value: 20 characters is a credential, 19 and 11 are not', () => {
      expect(looksLikeProviderKey(`API_KEY=${'a'.repeat(20)}`)).toBe(true);
      expect(looksLikeProviderKey(`API_KEY=${'a'.repeat(19)}`)).toBe(false);
      expect(looksLikeProviderKey('API_KEY=abcdefghijk')).toBe(false); // 11
      expect(looksLikeProviderKey('MY_SERVICE_API_KEY = hunter2hunter2')).toBe(false); // 13
    });
  });

  describe('ordinary text is not a key', () => {
    it.each([
      'What is the basic idea of a monad?',
      'Explain Basic auth',
      'the bearer of bad news',
      'https://user@example.com',
      'https://example.com/path?token=abc',
      'what does x-api-key: header do',
      'sk-learn-intelex-2024-02',
      'install sk-learn-intelex-2024-02 with pip',
      'task-management-and-planning-tool',
      'my desk-organizer-with-many-compartments is full',
      'sk-ant-short',
      'sk-proj-short',
      'sk-None-short',
      'sk-or-v1-short',
      'AIza',
      'AIzaShort',
      'gsk_short',
      'xai-short',
      'OPENAI_API_KEY',
      'export OPENAI_API_KEY=',
      'OPENAI_API_KEY=short',
      'set the OPENAI_API_KEY variable first',
      'Authorization: Bearer abc',
      'password: hunter2',
      'sk-',
      '',
      // The assignment's value must look like a credential, not code or prose (B2).
      'const API_KEY = getKey(config)',
      'the variable API_KEY = process.env.X',
      'API_KEY = os.environ["KEY"]',
      'if (API_KEY === undefined) throw new Error("no key")',
      'API_KEY=a b c d e f g h i j k l m n o p q r s t',
    ])('%j', (line) => {
      expect(looksLikeProviderKey(line)).toBe(false);
    });

    // The prefix of an unspecific form sits inside ordinary words: 20 letters after `task-`, `risk-`, `disk-` and `flask-` are text (B2).
    it.each(['task', 'risk', 'disk', 'flask', 'ask', 'desk', 'brisk'])(
      'a word that ends in sk, %s-, followed by twenty-odd letters is not a key',
      (word) => {
        expect(looksLikeProviderKey(`${word}-abcdefghijklmnopqrstuvwx`)).toBe(false);
        expect(looksLikeProviderKey(`${word}-${'a1'.repeat(20)}`)).toBe(false);
        expect(looksLikeProviderKey(`the ${word}-${'abcdefghij'.repeat(3)} list`)).toBe(false);
      },
    );

    it.each([
      // A key-looking word of the `sk-<word>-` form needs a letter AND a digit among 32 characters.
      ['letters only', `sk-custom-${'abcdefghij'.repeat(4)}`],
      ['digits only', `sk-custom-${'0123456789'.repeat(4)}`],
      ['too short', `sk-custom-${FILL.slice(0, 31)}`],
      ['a package name with a year', 'sk-learn-intelex-2024-02'],
      ['a long dashed phrase with no digit', `sk-management-and-planning-tool-for-large-teams`],
      ['a word before it', `risk-custom-${FILL}${FILL}`],
      [
        'an uppercase word is not a word of letters and a hyphen: a space breaks it',
        `sk-custom- ${FILL}${FILL}`,
      ],
    ])('the generic sk-<word>- rule needs 32 mixed characters: %s', (_why, line) => {
      expect(looksLikeProviderKey(line)).toBe(false);
    });

    it('is not fooled by an invisible character in plain prose either', () => {
      expect(looksLikeProviderKey(`Explain${ZWSP} Basic${ZWSP} auth`)).toBe(false);
      expect(
        looksLikeProviderKey(`task${CGJ}-${VS16}management${HANGUL_FILLERS[2] ?? ''}-and-planning`),
      ).toBe(false);
      expect(looksLikeProviderKey(fullwidth('task-management-and-planning-tool'))).toBe(false);
    });

    it('does not join whitespace: a prefix split by spaces or a dash phrase stays prose', () => {
      expect(
        looksLikeProviderKey(`task - management${' '}and${'  '}planning tool ${FILL}${FILL}`),
      ).toBe(false);
    });
  });

  it('does not find a key split by a newline or a space inside its first 20 characters: an accepted limit, pinned (the header says why)', () => {
    const key = `sk-ant-api03-${FILL}${FILL}`;
    // Whitespace is never joined: that would read `task - management ...` as `sk-management ...` and discard ordinary messages.
    expect(looksLikeProviderKey(`${key.slice(0, 10)}\n${key.slice(10)}`)).toBe(false);
    expect(looksLikeProviderKey(`${key.slice(0, 10)} ${key.slice(10)}`)).toBe(false);
    // Past the 16 characters the prefix form needs, the first half alone already is one: the split must be INSIDE the first 20.
    expect(looksLikeProviderKey(`${key.slice(0, 7 + 16)}\n${key.slice(7 + 16)}`)).toBe(true);
  });

  it('runs in time linear in the line, on the inputs that make a backtracking pattern blow up', () => {
    const hostile = [
      'A'.repeat(1_000_000),
      `${'A_'.repeat(500_000)}x`,
      'API_KEY'.repeat(150_000),
      `API_KEY${' '.repeat(1_000_000)}`,
      `API_KEY=${' '.repeat(1_000_000)}`,
      `API_KEY=${'='.repeat(1_000_000)}`,
      `${'sk-'.repeat(300_000)}`,
      `sk-${'a-'.repeat(500_000)}`,
      `sk-${'a'.repeat(1_000_000)}`,
      `${'sk-a-'.repeat(200_000)}`,
      `${'sk-a-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb '.repeat(30_000)}`,
      `sk-aa-${'-'.repeat(1_000_000)}`,
      `AIza${'_'.repeat(5)}${ZWSP.repeat(1_000_000)}`,
      `${'A '.repeat(500_000)}`,
      `${'xai-'.repeat(250_000)}`,
      `${'gsk_'.repeat(250_000)}`,
      `${'s' + CGJ}${'k' + VS16}`.repeat(250_000),
      `${ACUTE.repeat(1_000_000)}`,
      fullwidth('sk-'.repeat(150_000)),
    ];
    const started = performance.now();
    for (const line of hostile) looksLikeProviderKey(line);
    expect(
      performance.now() - started,
      `${hostile.length} hostile lines of about 1 MB`,
    ).toBeLessThan(6000);
  });
});
