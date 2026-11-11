import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MarkdownStream } from './stream.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';

describe('suspended inline owner restoration', () => {
  it('keeps physical retained heap proportional to independently measured source sizes', () => {
    const fixture = fileURLToPath(new URL('./fixtures/suspended-owner-heap.mjs', import.meta.url));
    const loader = fileURLToPath(
      new URL('../../engine/fixtures/ts-resolve-hook.mjs', import.meta.url),
    );
    const bytes = [128, 256, 512].map((n) => {
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
      const result: unknown = JSON.parse(output);
      if (
        typeof result !== 'object' ||
        result === null ||
        !('bytes' in result) ||
        typeof result.bytes !== 'number'
      )
        throw new Error('Invalid heap measurement');
      return result.bytes;
    });
    expect(bytes[0]).toBeGreaterThan(0);
    expect(bytes[1]).toBeLessThan((bytes[0] ?? 0) * 3);
    expect(bytes[2]).toBeLessThan((bytes[1] ?? 0) * 3);
  });
  it.each([1, 7, 13, 17])('visits only restored owners without drawing (chunk %i)', (size) => {
    for (const n of [128, 256, 512]) {
      const source = '**' + 'a* [c](u/**r**)'.repeat(n);
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += size) stream.append(source.slice(at, at + size));
      const work = stream.checkpointWork;
      expect(work.indexed).toBeLessThan(source.length * 400);
      expect(work.cache).toBeLessThan(source.length * 600);
      expect(work.copied).toBeLessThan(source.length * 6);
      expect(work.decisions).toBeLessThan(source.length * 3);
      expect(work.retained).toBeLessThan(source.length * 2);
      expect(work.indexRetained).toBeLessThan(source.length * 2);
      expect(work.scopeRetained).toBeLessThan(source.length);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });

  it.each([1, 3, 7, 13])(
    'keeps static text and styling as hidden owners reactivate (chunk %i)',
    (size) => {
      const source = '**' + 'a* [c](u/**r**)'.repeat(12) + '** tail';
      const stream = new MarkdownStream();
      let prefix = '';
      for (let at = 0; at < source.length; at += size) {
        const fragment = source.slice(at, at + size);
        prefix += fragment;
        stream.append(fragment);
        expect(stream.tail(10_000, 4)).toEqual(layoutMarkdown(parseMarkdown(prefix), 10_000));
      }
      expect(stream.finish()).toEqual(parseMarkdown(source));
    },
  );
});
