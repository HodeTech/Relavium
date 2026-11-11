import { describe, expect, it } from 'vitest';
import { streamCorpusBatches } from './fixtures/stream-corpus.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

describe('seeded incremental markdown stream (99173)', () => {
  const batches = streamCorpusBatches(99173);

  it.each(batches)(
    'matches canonical tabs for seed $seed, samples $first onward',
    ({ seed, cases }) => {
      for (const { source, chunks, sample } of cases) {
        const stream = new MarkdownStream();
        for (const { at, amount, draw } of chunks) {
          stream.append(source.slice(at, at + amount));
          if (draw) stream.tail(80, 8);
        }
        const expected = layoutMarkdown(parseMarkdown(source), 100_000)
          .map((line) => line.text)
          .join('\n');
        const actual = stream
          .tail(100_000, 100)
          .map((line) => line.text)
          .join('\n');
        expect(
          actual.match(/ +END$/)?.[0],
          `seed ${seed}, sample ${sample}: ${JSON.stringify(source.slice(4000))}`,
        ).toBe(expected.match(/ +END$/)?.[0]);
      }
    },
  );
});
