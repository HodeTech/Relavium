import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MarkdownStream } from './stream.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';

const makeSource = (n: number): string => '*' + 'x'.repeat(4500) + '[a*](url)\t'.repeat(n);

describe('provisional wrapper snapshot ownership', () => {
  it.each([1, 7, 13, 17, 100_000])('reuses saved bodies without drawing, chunk size %i', (size) => {
    for (const n of [200, 400, 800]) {
      const source = makeSource(n);
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += size) stream.append(source.slice(at, at + size));
      const work = stream.checkpointWork;
      expect(work.decisions).toBeLessThan(source.length * 3);
      expect(work.copied).toBeLessThan(source.length * 4);
      expect(work.indexed).toBeLessThan(source.length * 250);
      expect(work.cache).toBeLessThan(source.length * 1_000);
      expect(work.retained).toBeLessThan(source.length * 3);
      expect(work.indexRetained).toBeLessThan(source.length * 3);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });

  it('retains linear actual heap across isolated unaligned no-draw streams', () => {
    const fixture = fileURLToPath(new URL('./fixtures/saved-snapshot-heap.mjs', import.meta.url));
    const loader = fileURLToPath(
      new URL('../../engine/fixtures/ts-resolve-hook.mjs', import.meta.url),
    );
    const bytes = [400, 800, 1600].map((n) => {
      const output = execFileSync(
        process.execPath,
        [
          '--max-old-space-size=256',
          '--expose-gc',
          '--no-warnings',
          '--experimental-strip-types',
          '--loader',
          loader,
          fixture,
          String(n),
        ],
        { encoding: 'utf8', timeout: 15_000 },
      );
      const value: unknown = JSON.parse(output);
      if (
        typeof value !== 'object' ||
        value === null ||
        !('bytes' in value) ||
        typeof value.bytes !== 'number'
      )
        throw new Error('Invalid heap measurement');
      return value.bytes;
    });
    expect(bytes[0]).toBeGreaterThan(0);
    expect(bytes[1]).toBeLessThan((bytes[0] ?? 0) * 3);
    expect(bytes[2]).toBeLessThan((bytes[1] ?? 0) * 3);
  });

  it.each([50, 100, 200])(
    'keeps overlapping mixed syntax bounded after a long prefix (%i)',
    (n) => {
      const fragment = '**`\\[a*](url)*[x ] x[a*](url)_🇺x[( \\[***`\\[a*](url)])_🇺_**[a*](url)';
      const source = '*' + 'x'.repeat(4500) + fragment.repeat(n);
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += 13) stream.append(source.slice(at, at + 13));
      const work = stream.checkpointWork;
      expect(work.decisions).toBeLessThan(source.length * 3);
      expect(work.copied).toBeLessThan(source.length * 3);
      expect(work.indexed).toBeLessThan(source.length * 200);
      expect(work.cache).toBeLessThan(source.length * 200);
      expect(work.retained).toBeLessThan(source.length * 3);
      expect(work.scopeRetained).toBeLessThan(source.length * 3);
      const units = (lines: ReturnType<typeof stream.tail>): string[] =>
        lines.flatMap((line) =>
          line.spans.flatMap(({ text, ...flags }) =>
            Array.from(text, (character) => JSON.stringify([character, flags])),
          ),
        );
      const actual = units(stream.tail(100_000, 5));
      const expected = units(layoutMarkdown(parseMarkdown(source), 100_000));
      expect(expected.slice(-actual.length)).toEqual(actual);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    },
  );

  it('preserves styled output as provisional wrappers open, extend, and retract', () => {
    const samples = [
      '*' + 'x'.repeat(100) + '[a*](url)\t'.repeat(20),
      '*xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx**`\\[a*](url)*[x ] x[a*](url)_🇺x[( \\[***`\\[a*](url)])_🇺_**[a*](url)',
      '**a [b*](url) tail** [c](https://example.test) ~~next~~',
    ];
    for (const source of samples)
      for (const size of [1, 7, 13, 17]) {
        const stream = new MarkdownStream();
        let prefix = '';
        for (let at = 0; at < source.length; at += size) {
          const fragment = source.slice(at, at + size);
          prefix += fragment;
          stream.append(fragment);
          expect(stream.tail(10_000, 4)).toEqual(layoutMarkdown(parseMarkdown(prefix), 10_000));
        }
        expect(stream.finish()).toEqual(parseMarkdown(source));
      }
  });
});
