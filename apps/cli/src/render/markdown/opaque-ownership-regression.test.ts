import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';
import type { MarkdownDisplayLine } from './types.js';

const forms = [
  { name: 'bare', before: '[', after: ']' },
  { name: 'link', before: '[', after: '](url)' },
  { name: 'image', before: '![', after: '](url)' },
  { name: 'reference', before: '[', after: '][ref]' },
];

const units = (rows: readonly MarkdownDisplayLine[]): string[] =>
  rows.flatMap((row) =>
    row.spans
      .flatMap(({ text, ...flags }) =>
        Array.from(text, (character) => JSON.stringify([character, flags])),
      )
      .concat('\n'),
  );

describe('multiline literal bracket ownership', () => {
  for (const marker of ['*', '**', '***', '_', '__', '~~']) {
    it.each(forms)(
      `preserves a $name group inside ${marker} after the wrapper leaves the live window`,
      ({ before, after }) => {
        const prefix = `p ${marker}${'x'.repeat(4100)} `;
        const suffix = `${before}a\n${marker}b${after}${marker}\tEND`;
        const source = prefix + suffix;
        const cold = layoutMarkdown(parseMarkdown(source), 10_000);
        for (const chunk of [1, 7]) {
          const stream = new MarkdownStream();
          stream.append(prefix);
          stream.tail(80, 12);
          for (let at = 0; at < suffix.length; at += chunk) {
            stream.append(suffix.slice(at, at + chunk));
            stream.tail(80, 12);
          }
          // The bounded view can rewrap its clipped prefix. A wide layout
          // isolates exact source/style/newline/tab parity from that rewrap.
          const actual = stream.tail(10_000, 12);
          expect(units(actual)).toEqual(units(cold).slice(-units(actual).length));
          expect(actual.at(-1)).toEqual(cold.at(-1));
          expect(stream.sourceTail()).toBe(source.slice(-4000));
          expect(stream.finish()).toEqual(parseMarkdown(source));
        }
      },
    );
  }

  it.each(forms)('keeps $name tab geometry without clipping', ({ before, after }) => {
    const source = `p ** ${before}a\n**b${after}**\tEND`;
    const cold = layoutMarkdown(parseMarkdown(source), 80);
    for (let split = 0; split <= source.length; split++) {
      const stream = new MarkdownStream();
      stream.append(source.slice(0, split));
      stream.tail(80, 12);
      stream.append(source.slice(split));
      expect(stream.tail(80, 12)).toEqual(cold);
      expect(stream.sourceTail()).toBe(source);
    }
  });

  it.each(['[a](\n***b)', '[a][\n***b]'])(
    'reactivates delimiter queries after a provisional rule inside %j reopens the paragraph',
    (group) => {
      // The LF is in the destination/reference, so label expiration alone
      // cannot explain this independent fixed-scope query-custody regression.
      const source = `p ***${'x'.repeat(4100)} ${group}***\tEND`;
      const split = source.indexOf('\n');
      const stream = new MarkdownStream();
      stream.append(source.slice(0, split));
      for (const character of source.slice(split)) {
        stream.append(character);
        stream.tail(80, 12);
      }
      const actual = stream.tail(10_000, 12);
      const cold = layoutMarkdown(parseMarkdown(source), 10_000);
      expect(units(actual)).toEqual(units(cold).slice(-units(actual).length));
      expect(actual.at(-1)).toEqual(cold.at(-1));
      expect(stream.finish()).toEqual(parseMarkdown(source));
    },
  );
});

describe('nested opaque owner replacement', () => {
  it.each([
    { name: 'crossing code', prefix: 'p ~~', suffix: '``[``<a@b.c>_]', ending: '\tEND' },
    { name: 'reopened bare group', prefix: 'p ', suffix: '[*<a@b.c>*](', ending: '' },
    { name: 'code inside a bare group', prefix: 'p \n', suffix: '`[`<a@b.c>x]', ending: '\tEND' },
  ])('keeps autolink angles literal after $name', ({ prefix, suffix, ending }) => {
    const start = `${prefix}${'x'.repeat(4050)} `;
    const tail = suffix + ending;
    const source = start + tail;
    const cold = layoutMarkdown(parseMarkdown(source), 10_000);
    expect(cold.map((row) => row.text).join('\n')).toContain('<a@b.c>');
    for (const chunk of [1, 7, suffix.length]) {
      const stream = new MarkdownStream();
      stream.append(start);
      for (let at = 0; at < tail.length; at += chunk) {
        stream.append(tail.slice(at, at + chunk));
        stream.tail(80, 12);
      }
      const actual = stream.tail(10_000, 12);
      expect(units(actual)).toEqual(units(cold).slice(-units(actual).length));
      expect(stream.sourceTail()).toBe(source.slice(-4000));
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });
});
