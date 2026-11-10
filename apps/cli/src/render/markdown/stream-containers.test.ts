import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

const prefixes = ['', '- ', '1. ', '  - ', '> ', '> - ', '- > ', '- 1. '];
const bodies = [
  'a',
  '*x*',
  '`x`',
  '[x](u)',
  '\tb\t',
  '  b',
  '    b',
  '- b',
  '1. b',
  '> b',
  '# b',
  '---',
  '```',
  '~~~',
];

function appendScheduled(stream: MarkdownStream, source: string, chunk: number): void {
  for (let at = 0; at < source.length; at += chunk) {
    stream.append(source.slice(at, at + chunk));
    if (chunk === 3) stream.tail(11, 30);
  }
}

describe('streamed container composition', () => {
  it.each(prefixes)('matches canonical blocks and spans after %j', (prefix) => {
    for (const first of bodies)
      for (const separator of ['\n', '\n\n'])
        for (const second of bodies) {
          const source = prefix + first + separator + second;
          const expected = layoutMarkdown(parseMarkdown(source), 40);
          for (const chunk of [source.length, 1, 3]) {
            const stream = new MarkdownStream();
            appendScheduled(stream, source, chunk);
            expect(stream.tail(40, 100), JSON.stringify({ source, chunk })).toEqual(expected);
            expect(stream.sourceTail()).toBe(source);
          }
        }
  });

  it.each(prefixes)('retracts provisional list prefixes before a tab after %j', (prefix) => {
    const source = prefix + '\t';
    for (const chunk of [1, 3, source.length]) {
      const stream = new MarkdownStream();
      appendScheduled(stream, source, chunk);
      expect(stream.tail(80, 20)).toEqual(layoutMarkdown(parseMarkdown(source), 80));
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });

  it.each(['1. ', '- ', '> - ', '- 1. '])(
    'retains list continuation tab positions beyond the source cut after %j',
    (prefix) => {
      for (const size of [3990, 4000, 4010, 8000]) {
        const source = prefix + 'x'.repeat(size) + '\n\tb\t';
        const expected = layoutMarkdown(parseMarkdown(source), 100_000);
        for (const chunk of [1, 17, source.length]) {
          const stream = new MarkdownStream();
          appendScheduled(stream, source, chunk);
          // The first visible row retains its list marker; the final physical
          // continuation row must still have the exact canonical prefix and tab.
          expect(stream.tail(100_000, 8).at(-1)).toEqual(expected.at(-1));
          expect(stream.sourceTail()).toBe(source.slice(-4000));
          expect(stream.finish()).toEqual(parseMarkdown(source));
        }
      }
    },
  );

  it.each(['1. a\n\t', '- a\n\t', '> - a\n> \t', '12345. # h\n\t'])(
    'projects a clipped styled continuation using its canonical scope after %j',
    (prefix) => {
      const source = prefix + '**' + 'x'.repeat(5000) + '**\tEND\n\tb\t';
      const expected = layoutMarkdown(parseMarkdown(source), 100_000);
      for (const chunk of [1, 17, source.length]) {
        const stream = new MarkdownStream();
        appendScheduled(stream, source, chunk);
        const actual = stream.tail(100_000, 20);
        expect(actual.at(-1)?.text.slice(-80)).toBe(expected.at(-1)?.text.slice(-80));
        expect(actual.flatMap((line) => line.spans).some((span) => span.strong)).toBe(true);
        expect(actual.find((line) => line.text.includes('END'))?.text.slice(-40)).toBe(
          expected.find((line) => line.text.includes('END'))?.text.slice(-40),
        );
        expect(stream.sourceTail()).toBe(source.slice(-4000));
        expect(stream.finish()).toEqual(parseMarkdown(source));
      }
    },
  );

  it.each([
    { count: 300, cadence: 1 },
    { count: 600, cadence: 2 },
    { count: 900, cadence: 3 },
  ])('shares $count quoted lines with a draw every $cadence lines', ({ count }) =>
    nativeQuoteProbe(count),
  );

  it('keeps the native 500-line quote probe below a 256 MB heap cap', () => {
    nativeQuoteProbe(500);
  });
});

function nativeQuoteProbe(count: number): void {
  const child = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=256',
      '--expose-gc',
      '--no-warnings',
      '--experimental-strip-types',
      '--loader',
      new URL('../../engine/fixtures/ts-resolve-hook.mjs', import.meta.url).href,
      fileURLToPath(new URL('./fixtures/stream-quote-retention.mjs', import.meta.url)),
      String(count),
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.signal, child.stderr).toBeNull();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim()).toBe(`quote retention passed: ${count}`);
}
