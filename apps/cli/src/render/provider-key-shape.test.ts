import { describe, expect, it } from 'vitest';

import { looksLikeProviderKey } from './provider-key-shape.js';

/**
 * The predicate that decides whether a typed line is a pasted provider key (ADR-0146 §6). It is the four providers' real key formats and
 * nothing wider: the diagnostic scrubber it replaced discarded `Explain Basic auth` as a key and missed a key that followed a word character.
 * Every key below is built from pieces, so no file holds one whole.
 */

const FILL = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY';
const KEYS = {
  anthropic: `sk-ant-api03-${FILL}${FILL}-_AA`,
  'openai project': `sk-proj-${FILL}${FILL}`,
  'openai service account': `sk-svcacct-${FILL}${FILL}`,
  'openai admin': `sk-admin-${FILL}${FILL}`,
  'openai legacy': `sk-${FILL}${FILL.slice(0, 16)}`,
  deepseek: `sk-${'0123456789abcdef'.repeat(2)}`,
  gemini: `AIza${FILL}_-x`,
} as const;
// Built from code points, never written as the characters: an invisible character in a source file is the hazard this predicate guards against.
const ZWSP = String.fromCharCode(0x200b);
const ZWJ = String.fromCharCode(0x200d);
const SHY = String.fromCharCode(0x00ad);
const BOM = String.fromCharCode(0xfeff);
const RLO = String.fromCharCode(0x202e);

/** Where a key can sit in what a person types or pastes. */
const FORMS: readonly (readonly [string, (key: string) => string])[] = [
  ['alone', (key) => key],
  ['quoted', (key) => `"${key}"`],
  ['single-quoted', (key) => `'${key}'`],
  ['in a sentence', (key) => `here is my key ${key} please use it`],
  ['as an assignment', (key) => `ANTHROPIC_API_KEY=${key}`],
  ['as an exported assignment', (key) => `export OPENAI_API_KEY="${key}"`],
  ['after a newline', (key) => `first line\n${key}`],
  ['after a word character', (key) => `mykey_${key}`],
  ['glued to a letter', (key) => `x${key}`],
  [
    'with a zero-width space inside the first characters',
    (key) => `${key[0]}${ZWSP}${key.slice(1)}`,
  ],
  [
    'with a zero-width joiner and a soft hyphen inside the prefix',
    (key) => `${key.slice(0, 2)}${ZWJ}${key.slice(2, 4)}${SHY}${key.slice(4)}`,
  ],
  ['with a byte order mark and a bidi mark before it', (key) => `${BOM}${RLO}${key}`],
];

describe('looksLikeProviderKey', () => {
  describe.each(Object.entries(KEYS))('%s', (_provider, key) => {
    it.each(FORMS)('finds a key %s', (_form, build) => {
      expect(looksLikeProviderKey(build(key))).toBe(true);
    });
  });

  it('finds a pasted .env assignment whatever the variable is called, with spaces around the equals sign', () => {
    expect(looksLikeProviderKey('MY_SERVICE_API_KEY = hunter2hunter2')).toBe(true);
    expect(looksLikeProviderKey('API_KEY=abcdefghijkl')).toBe(true);
    expect(looksLikeProviderKey('GEMINI_API_KEY=\t"abcdefghijklmnop"')).toBe(true);
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
      'AIza',
      'AIzaShort',
      'OPENAI_API_KEY',
      'export OPENAI_API_KEY=',
      'OPENAI_API_KEY=short',
      'set the OPENAI_API_KEY variable first',
      'Authorization: Bearer abc',
      'password: hunter2',
      'sk-',
      '',
    ])('%j', (line) => {
      expect(looksLikeProviderKey(line)).toBe(false);
    });

    it('is not fooled by an invisible character in plain prose either', () => {
      expect(looksLikeProviderKey(`Explain${ZWSP} Basic${ZWSP} auth`)).toBe(false);
    });
  });

  it('runs in time linear in the line, on the inputs that make a backtracking pattern blow up', () => {
    const hostile = [
      'A'.repeat(200_000),
      `${'A_'.repeat(100_000)}x`,
      'API_KEY'.repeat(30_000),
      `API_KEY${' '.repeat(200_000)}`,
      `API_KEY=${' '.repeat(200_000)}`,
      `${'sk-'.repeat(60_000)}`,
      `sk-${'a-'.repeat(100_000)}`,
      `AIza${'_'.repeat(5)}${ZWSP.repeat(200_000)}`,
      `${'A '.repeat(100_000)}`,
    ];
    const started = performance.now();
    for (const line of hostile) looksLikeProviderKey(line);
    expect(performance.now() - started, 'nine 200 KB hostile lines').toBeLessThan(1500);
  });
});
