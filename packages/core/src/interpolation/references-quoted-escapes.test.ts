import { describe, expect, it } from 'vitest';

import { parseTemplate, type InterpolationReference } from './references.js';
import { resolveTemplate } from './resolve.js';

function referenceOf(text: string): InterpolationReference {
  const first = parseTemplate(text)[0];
  if (first?.kind !== 'reference') throw new Error('expected reference');
  return first.reference;
}

const quotedCases = [
  { name: 'double matching quote', argument: String.raw`"say \"hi\""`, expected: 'say "hi"' },
  { name: 'single matching quote', argument: String.raw`'it\'s fine'`, expected: "it's fine" },
  { name: 'backslash', argument: String.raw`"a\\b"`, expected: String.raw`a\b` },
  { name: 'other single quote', argument: String.raw`"a\'b"`, expected: String.raw`a\'b` },
  { name: 'other double quote', argument: String.raw`'a\"b'`, expected: String.raw`a\"b` },
  {
    name: 'Windows single backslashes',
    argument: String.raw`"C:\temp\name"`,
    expected: String.raw`C:\temp\name`,
  },
  {
    name: 'Windows doubled backslashes',
    argument: String.raw`"C:\\temp\\name"`,
    expected: String.raw`C:\temp\name`,
  },
  {
    name: 'unknown escapes',
    argument: String.raw`"\n\t\r\u0041\x41\q\/"`,
    expected: String.raw`\n\t\r\u0041\x41\q\/`,
  },
  { name: 'trailing backslash', argument: String.raw`"tail\\"`, expected: 'tail' + '\\' },
  { name: 'structural delimiters', argument: String.raw`"a|b,c}}d\"}}"`, expected: 'a|b,c}}d"}}' },
  { name: 'odd backslash parity', argument: String.raw`"a\\\"b"`, expected: 'a\\"b' },
];

describe('quoted filter finite decoding (#82)', () => {
  it.each(quotedCases)(
    'matching quoted escapes reach the runtime default value: $name',
    async ({ argument, expected }) => {
      const raw = `{{inputs.x | default(${argument})}}`;
      const template = raw + ' suffix';
      expect(
        referenceOf(template),
        'raw reference and delimiter structure survive decoding',
      ).toEqual({
        kind: 'inputs',
        identifier: 'x',
        path: '',
        raw,
        filters: [{ name: 'default', args: [{ type: 'string', value: expected }] }],
      });
      expect(parseTemplate(template)[1]).toEqual({ kind: 'literal', text: ' suffix' });
      expect(
        await resolveTemplate(template, { inputs: {}, ctx: {}, outputs: {} }),
        'matching quoted escapes reach the runtime default value',
      ).toBe(expected + ' suffix');
      expect(
        await resolveTemplate(template, { inputs: { x: 'live value' }, ctx: {}, outputs: {} }),
      ).toBe('live value suffix');
    },
  );

  it('unknown escapes preserve Windows path bytes', async () => {
    const text = String.raw`{{inputs.x | default("C:\temp\name\q\n")}}`;
    expect(await resolveTemplate(text, { inputs: {}, ctx: {}, outputs: {} })).toBe(
      String.raw`C:\temp\name\q\n`,
    );
  });

  it('preserves multi-filter and mixed argument boundaries without evaluating arbitrary filters', () => {
    const text = String.raw`{{inputs.x | f("a\\b,|}}", true, -1.25, 0x10, 1e3, Infinity) | length}} tail`;
    expect(referenceOf(text).filters).toEqual([
      {
        name: 'f',
        args: [
          { type: 'string', value: String.raw`a\b,|}}` },
          { type: 'boolean', value: true },
          { type: 'number', value: -1.25 },
          { type: 'string', value: '0x10' },
          { type: 'string', value: '1e3' },
          { type: 'string', value: 'Infinity' },
        ],
      },
      { name: 'length', args: [] },
    ]);
  });

  it('keeps a truly unterminated quote literal', () => {
    const text = String.raw`{{inputs.x | default("unterminated\")}} tail`;
    expect(parseTemplate(text)).toEqual([{ kind: 'literal', text }]);
  });
});
