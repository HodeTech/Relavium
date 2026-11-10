import { describe, expect, it, vi } from 'vitest';
import { MarkdownStream } from './stream.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import * as parser from './parser.js';
import * as layout from './layout.js';

const rows = (stream: MarkdownStream, columns = 80, count = 12): string[] =>
  stream.tail(columns, count).map((line) => line.text);

function oneByteAtATime(source: string): MarkdownStream {
  const stream = new MarkdownStream();
  for (const character of source) stream.append(character);
  return stream;
}

describe('incremental markdown stream', () => {
  it.each([100, 200, 400])(
    'projects completed soft paragraph lines without retaining prefix views (%i lines)',
    (cycles) => {
      const stream = new MarkdownStream();
      let source = 'p ' + 'x'.repeat(4000 + cycles * 40) + '\n';
      stream.append(source);
      for (let line = 0; line < cycles; line++) {
        const addition = 'x *a*\tvalue\n';
        source += addition;
        stream.append(addition);
        stream.tail(80, 8);
      }
      const expected = layoutMarkdown(parseMarkdown(source), 100_000)
        .map((line) => line.text)
        .join('');
      const actual = stream
        .tail(100_000, 8)
        .map((line) => line.text)
        .join('');
      expect(expected.endsWith(actual)).toBe(true);
      expect(stream.checkpointWork.decisions).toBeLessThan(cycles * 6 + 10);
      expect(stream.checkpointWork.retained).toBeLessThan(cycles * 6 + 10);
      expect(stream.checkpointWork.copied).toBeLessThan(cycles * 6 + 10);
      expect(stream.checkpointWork.indexed).toBeLessThan(source.length * 16);
      // Each draw may visit its 4,000-unit visible window; ingestion must not
      // construct or reinterpret an ever-growing paragraph-prefix view.
      expect(stream.checkpointWork.cache).toBeLessThan(cycles * 6_000);
      expect(stream.geometryWork.sourceUnits).toBeLessThan(source.length * 2);
      expect(stream.geometryWork.measuredUnits).toBeLessThan(source.length);
      expect(stream.geometryWork.visits).toBeLessThan(cycles * 4_000 * 4);
      expect(stream.geometryWork.constructedUnits).toBeLessThan(cycles * 4_000 * 10);
    },
  );

  it.each(['a  ', 'a\\', '\\', '*a*  ', '**a**\\', '`a`', '[label](url)', '𝑥_𝑦_'])(
    'preserves terminal-newline interpretation after %j',
    (ending) => {
      for (const prefix of ['', 'x'.repeat(4001) + ' ']) {
        const stream = new MarkdownStream();
        stream.append(prefix);
        const source = prefix + ending + '\n';
        for (const unit of ending + '\n') {
          stream.append(unit);
          stream.tail(80, 8);
        }
        const expected = layoutMarkdown(parseMarkdown(source), 100_000);
        const actual = stream.tail(100_000, 8);
        if (!prefix) expect(actual).toEqual(expected);
        else
          expect(
            expected
              .map((line) => line.text)
              .join('')
              .endsWith(actual.map((line) => line.text).join('')),
          ).toBe(true);
        const before = stream.checkpointWork.decisions;
        stream.append(' ');
        stream.tail(40, 8);
        stream.append(' ');
        stream.tail(80, 8);
        expect(stream.checkpointWork.decisions).toBeLessThanOrEqual(before + 2);
        expect(stream.finish()).toEqual(parseMarkdown(source + '  '));
      }
    },
  );

  it.each(
    ['*', '**', '~~', '`'].flatMap((marker) =>
      [1, 2, 3, 17, 64].map((chunk) => ({ marker, chunk })),
    ),
  )('clips rendered RI pairs with $marker syntax in $chunk-unit chunks', ({ marker, chunk }) => {
    const source = '🇺' + marker + '🇸'.repeat(2401) + marker + '\tEND';
    const stream = new MarkdownStream();
    for (let at = 0; at < source.length; at += chunk) stream.append(source.slice(at, at + chunk));
    const raw = stream.sourceTail();
    const expected = layoutMarkdown(parseMarkdown(source), 100_000)
      .map((line) => line.text)
      .join('');
    const actual = stream
      .tail(100_000, 8)
      .map((line) => line.text)
      .join('');
    const start = expected.lastIndexOf(actual);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(
      [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(expected)].some(
        (segment) => segment.index === start,
      ),
    ).toBe(true);
    expect(actual.length).toBeGreaterThan(3900);
    expect(actual.match(/ +END$/)?.[0]).toBe(expected.match(/ +END$/)?.[0]);
    expect(stream.sourceTail()).toBe(raw);
  });

  it.each([
    { kind: 'RI', prefix: '🇺', separator: '🇺' },
    { kind: 'ZWJ', prefix: '👩', separator: '\u200d💻' },
    { kind: 'Extend', prefix: 'e', separator: '\u0301' },
    { kind: 'growing cluster', prefix: 'p ', separator: ' ' },
  ])('bounds reverse-backtick geometry with $kind boundaries', ({ kind, prefix, separator }) => {
    let previous: { units: number; measured: number } | undefined;
    for (const depth of [48, 96, 192]) {
      const runs = Array.from({ length: depth }, (_, index) => '`'.repeat(index + 1));
      const cluster = kind === 'growing cluster' ? 'e' + '\u0301'.repeat(depth * depth) : 'é👩‍💻';
      let source = prefix + runs.join(separator) + ' ' + cluster + '\t' + 'x'.repeat(8003) + 'é👩‍💻';
      const stream = new MarkdownStream();
      stream.append(source);
      stream.tail(80, 5);
      for (const run of runs.toReversed()) {
        source += ' ' + run;
        stream.append(' ' + run);
        stream.tail(80, 5);
      }
      source += '\tEND';
      stream.append('\tEND');
      const expected = layoutMarkdown(parseMarkdown(source), 1_000_000).at(-1)?.text;
      const actual = stream.tail(1_000_000, 5).at(-1)?.text;
      expect(actual?.match(/ +END$/)?.[0]).toBe(expected?.match(/ +END$/)?.[0]);
      const geometry = stream.geometryWork;
      const checkpoint = stream.checkpointWork;
      expect(geometry.measuredUnits).toBeLessThan(source.length * 8);
      expect(geometry.sourceUnits).toBeLessThan(source.length * 16);
      expect(geometry.visits).toBeLessThan(source.length * 128);
      expect(geometry.constructedUnits).toBeLessThan(source.length * 128);
      expect(geometry.cacheKeyUnits).toBeLessThan(source.length * 64);
      expect(checkpoint.decisions).toBeLessThan(source.length * 4);
      expect(checkpoint.indexed).toBeLessThan(source.length * 128);
      expect(checkpoint.cache).toBeLessThan(source.length * 256);
      expect(checkpoint.retained).toBeLessThan(depth * 8 + 32);
      if (previous)
        expect(geometry.measuredUnits / source.length).toBeLessThan(
          (previous.measured / previous.units) * 2.5,
        );
      previous = { units: source.length, measured: geometry.measuredUnits };
    }
  });

  it.each(
    [4001, 10001].flatMap((digits) =>
      ['', '> ', '- ', '  - ', '> - '].map((container) => ({ digits, container })),
    ),
  )(
    'keeps literal fallback for $digits-digit ordinal after "$container"',
    ({ digits, container }) => {
      const source = container + '9'.repeat(digits) + '. **value**\tEND';
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += 17) {
        stream.append(source.slice(at, at + 17));
        if (at % 170 === 0) stream.tail(80, 12);
      }
      const tail = stream.tail(80, 12);
      const expected = layoutMarkdown(parseMarkdown(source), 80)
        .map((line) => line.text)
        .join('');
      const actual = tail.map((line) => line.text).join('');
      expect(actual).toContain('**value**');
      expect(expected.endsWith(actual)).toBe(true);
      expect(tail.flatMap((line) => line.spans).some((span) => span.strong)).toBe(false);
      expect(stream.sourceTail()).toBe(source.slice(-4000));
      expect(stream.checkpointWork.decisions).toBeLessThan(source.length * 2);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    },
  );

  it('retains raw tab stops across semantic stable-block reads and resizes', () => {
    const source = '```\n' + '界'.repeat(4001) + '\tEND\n```\n';
    const stream = new MarkdownStream();
    for (let at = 0; at < source.length; at += 17) stream.append(source.slice(at, at + 17));
    const semantic = stream.tail(80, 12);
    const plain = stream.plainTail(80, 12);
    expect(plain.find((line) => line.text.includes('END'))?.text).toMatch(/ {6}END$/);
    stream.tail(40, 12);
    expect(stream.tail(80, 12)).toEqual(semantic);
    expect(stream.plainTail(80, 12)).toEqual(plain);
  });

  it.each([25, 50, 100, 200])(
    'reuses revoked wrapper bodies with a growing prefix (%i cycles)',
    (cycles) => {
      const stream = new MarkdownStream();
      let source = '*' + 'x'.repeat(4000 + 40 * cycles);
      stream.append(source);
      for (let cycle = 0; cycle < cycles; cycle++) {
        stream.append('[label*');
        source += '[label*';
        stream.tail(80, 5);
        stream.append('](url)\t');
        source += '](url)\t';
        stream.tail(80, 5);
      }
      stream.append('END');
      source += 'END';
      const expected = layoutMarkdown(parseMarkdown(source), 100_000).at(-1)?.text;
      const actual = stream.tail(100_000, 5).at(-1)?.text;
      expect(actual?.match(/ +END$/)?.[0]).toBe(expected?.match(/ +END$/)?.[0]);
      expect(stream.checkpointWork.decisions).toBeLessThan(cycles * 20 + 100);
      expect(stream.columnWork.units).toBeLessThan(source.length * 2);
      expect(stream.geometryWork.measuredUnits).toBeLessThan(source.length * 8 + cycles * 256);
      expect(stream.geometryWork.sourceUnits).toBeLessThan(source.length * 20 + cycles * 512);
    },
  );

  it('shares canonical delimiter decisions for live tab geometry across every short split', () => {
    for (const suffix of ['******', '**\\**', '**🇺*', '*[**x**](**x**)', '**_*', '__`_', '*\t**']) {
      const source = 'p ' + suffix + '\tEND';
      const expected = layoutMarkdown(parseMarkdown(source), 100_000);
      for (let split = 0; split <= source.length; split++) {
        const stream = new MarkdownStream();
        stream.append(source.slice(0, split));
        stream.tail(80, 8);
        stream.append(source.slice(split));
        expect(stream.tail(100_000, 20), `${suffix} split ${split}`).toEqual(expected);
      }
    }
  });

  it('uses canonical Setext eligibility before finalizing an underline as a rule', () => {
    for (const source of ['    x\n---\n\nEND', '    x\n===\n\nEND', 'x\n--\n\nEND']) {
      const expected = layoutMarkdown(parseMarkdown(source), 80);
      for (let split = 0; split <= source.length; split++) {
        const stream = new MarkdownStream();
        stream.append(source.slice(0, split));
        stream.tail(80, 20);
        stream.append(source.slice(split));
        expect(stream.tail(80, 20)).toEqual(expected);
      }
    }
  });

  it('retains tab columns from omitted prose and source prefixes', () => {
    for (const prefix of [
      'x'.repeat(4_001),
      '**' + 'x'.repeat(4_001) + '**',
      '\\*' + 'x'.repeat(4_001),
      '[x](https://example.test)' + 'x'.repeat(4_001),
      '界'.repeat(2_001),
      'e\u0301'.repeat(4_001),
      '🇺'.repeat(4_000),
    ]) {
      const source = prefix + '\tEND';
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += 13) {
        stream.append(source.slice(at, at + 13));
        if (at % 130 === 0) stream.tail(80, 7);
      }
      const expected = layoutMarkdown(parseMarkdown(source), 100_000)
        .map((line) => line.text)
        .join('\n');
      const actual = stream
        .tail(100_000, 7)
        .map((line) => line.text)
        .join('\n');
      expect(actual.match(/ +END$/)?.[0]).toBe(expected.match(/ +END$/)?.[0]);
      const plain = stream
        .plainTail(100_000, 7)
        .map((line) => line.text)
        .join('\n');
      const raw = layoutMarkdown([{ kind: 'literal', source, text: source }], 100_000)
        .map((line) => line.text)
        .join('\n');
      expect(plain.match(/ +END$/)?.[0]).toBe(raw.match(/ +END$/)?.[0]);
    }
  });

  it('retains omitted code columns including its gutter', () => {
    const stream = new MarkdownStream();
    stream.append('```\n' + 'x'.repeat(4_001) + '\tEND');
    expect(stream.tail(100_000, 5).at(-1)?.text).toMatch(/ {5}END$/);
    expect(stream.plainTail(100_000, 5).at(-1)?.text).toMatch(/ {7}END$/);
  });

  it('does not interpret block-looking text exposed by a mid-line source cut', () => {
    for (const marker of ['# hello', '- hello', ' ```\n']) {
      const source = 'x'.repeat(10) + marker + 'x'.repeat(3_993);
      const stream = new MarkdownStream();
      stream.append(source);
      const visible = stream.tail(100_000, 5);
      expect(visible.map((line) => line.text).join('')).toContain(marker.trimEnd());
      expect(visible.flatMap((line) => line.spans).some((span) => span.heading || span.code)).toBe(
        false,
      );
    }
  });

  it('keeps arbitrary distinct backtick candidates canonical with bounded column work', () => {
    for (const depth of [16, 48, 96]) {
      const runs = Array.from({ length: depth }, (_, index) => '`'.repeat(index + 1));
      const stream = new MarkdownStream();
      let source = 'prose ' + runs.join(' ') + ' 👩‍💻e\u0301\t' + 'x'.repeat(8_003) + 'e\u0301👩‍💻';
      for (let at = 0; at < source.length; at += 79) stream.append(source.slice(at, at + 79));
      stream.tail(80, 5);
      for (const run of [...runs].reverse()) {
        source += ' ' + run;
        stream.append(' ' + run);
        stream.tail(80, 5);
      }
      source += '\tEND';
      stream.append('\tEND');
      const expected = layoutMarkdown(parseMarkdown(source), 100_000).at(-1)?.text;
      const actual = stream.tail(100_000, 5).at(-1)?.text;
      expect(actual?.match(/ +END$/)?.[0]).toBe(expected?.match(/ +END$/)?.[0]);
      expect(actual).toBe(expected?.slice(-(actual?.length ?? 0)));
      expect(stream.columnWork.units).toBeLessThan(source.length * 3);
      expect(stream.columnWork.interpretation).toBeLessThan(source.length * 8 + depth * 512);
      expect(stream.columnWork.width).toBeLessThan(source.length * 260 + depth * 512);
    }
  });

  it('updates hidden columns once when an old delimiter finally closes', () => {
    const stream = new MarkdownStream();
    stream.append('**👩' + '\u200d💻x'.repeat(2_001));
    stream.tail(80, 5);
    stream.append('**\tEND');
    const source = '**👩' + '\u200d💻x'.repeat(2_001) + '**\tEND';
    const expected = layoutMarkdown(parseMarkdown(source), 100_000).at(-1)?.text;
    expect(
      stream
        .tail(100_000, 5)
        .at(-1)
        ?.text.match(/ +END$/)?.[0],
    ).toBe(expected?.match(/ +END$/)?.[0]);
    expect(stream.columnWork.units).toBeLessThan(source.length * 3);
  });

  it('keeps soft paragraph newlines and hard/code line resets distinct for tabs', () => {
    for (const separator of ['\n', '  \n', '\\\n']) {
      const source = 'x'.repeat(4_001) + separator + 'yz\tEND';
      const stream = new MarkdownStream();
      stream.append(source);
      const expected = layoutMarkdown(parseMarkdown(source), 100_000).at(-1)?.text;
      expect(
        stream
          .tail(100_000, 5)
          .at(-1)
          ?.text.match(/ +END$/)?.[0],
      ).toBe(expected?.match(/ +END$/)?.[0]);
    }
    const source = '```\n' + 'x'.repeat(8_001) + '\tEND\n```\n# after';
    const stream = new MarkdownStream();
    stream.append(source);
    const line = stream.tail(100_000, 5).find((line) => line.text.includes('END'));
    expect(line?.text).toMatch(/ {5}END$/);
  });

  it('keeps added parentheses for links/images and omits autolink delimiters at the cut', () => {
    for (const [before, after, ending] of [
      ['[label](', ') end', ') end'],
      ['![label](', ') end', ') end'],
      ['<https://example.test/', '> end', ' end'],
    ]) {
      const stream = new MarkdownStream();
      stream.append((before ?? '') + 'x'.repeat(4_100) + (after ?? ''));
      const text = stream
        .tail(100_000, 5)
        .map((line) => line.text)
        .join('');
      expect(text.endsWith(ending ?? '')).toBe(true);
      if ((before ?? '').startsWith('<')) expect(text).not.toContain('>');
    }
    const target = 'https://example.test/' + 'x'.repeat(4_100);
    const stream = new MarkdownStream();
    stream.append('[' + target + '](' + target + ') end');
    expect(
      stream
        .tail(100_000, 5)
        .map((line) => line.text)
        .join(''),
    ).toBe(' end');
  });

  it('preserves paragraph identity at exact and overflowing budgets across lexical split boundaries', () => {
    for (const marker of ['# hello', '- hello', ' ```\n']) {
      for (const size of [4_000, 4_001, 4_010]) {
        const source =
          'x'.repeat(10) + marker + 'x'.repeat(size - 10 - marker.length) + '\n# genuine';
        const splits = new Set([
          0,
          1,
          9,
          10,
          11,
          12,
          13,
          10 + marker.length - 1,
          10 + marker.length,
          size - 1,
          size,
          source.length,
        ]);
        for (const split of splits) {
          const stream = new MarkdownStream();
          stream.append(source.slice(0, split));
          stream.append(source.slice(split));
          const lines = stream.tail(100_000, 5);
          expect(lines.at(-1)?.text).toBe('genuine');
          const content = lines.slice(0, -1).flatMap((line) => line.spans);
          expect(content.some((span) => span.heading || span.code)).toBe(false);
        }
      }
    }
  });

  it('measures whole unbounded Unicode clusters once when a visible tab closes the segment', () => {
    const cluster = '👩' + '\u0301'.repeat(12_000) + '\u200d💻';
    for (const source of [
      cluster + 'x'.repeat(4_001) + '\tEND',
      'x'.repeat(4_001) + cluster + '\tEND',
      '**' + cluster + '**' + 'x'.repeat(4_001) + '\tEND',
    ]) {
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += 97) {
        stream.append(source.slice(at, at + 97));
        if (at % 970 === 0) stream.tail(80, 5);
      }
      const expected = layoutMarkdown(parseMarkdown(source), 100_000).at(-1)?.text;
      expect(
        stream
          .tail(100_000, 5)
          .at(-1)
          ?.text.match(/ +END$/)?.[0],
      ).toBe(expected?.match(/ +END$/)?.[0]);
      const before = stream.columnWork;
      for (const character of ' extra') {
        stream.append(character);
        stream.tail(80, 5);
      }
      expect(stream.columnWork.width - before.width).toBeLessThan(100);
      expect(stream.columnWork.width).toBeLessThan(source.length * 30);
    }
  });

  it('settles provisional closing runs without mutating their future interpretation', () => {
    for (const marker of ['**', '`', '``']) {
      const stream = new MarkdownStream();
      const prefix = marker + 'x'.repeat(8_001) + '\tEND';
      stream.append(prefix);
      stream.tail(80, 5);
      stream.append(marker);
      let expected = layoutMarkdown(parseMarkdown(prefix + marker), 100_000).at(-1)?.text;
      expect(stream.tail(100_000, 5).at(-1)?.text.match(/ +END/)?.[0]).toBe(
        expected?.match(/ +END/)?.[0],
      );
      stream.append(marker[0] ?? '');
      expected = layoutMarkdown(parseMarkdown(prefix + marker + (marker[0] ?? '')), 100_000).at(
        -1,
      )?.text;
      expect(stream.tail(100_000, 5).at(-1)?.text.match(/ +END/)?.[0]).toBe(
        expected?.match(/ +END/)?.[0],
      );
    }
  });

  it('keeps code boundary probes exact for an unbounded Unicode grapheme', () => {
    const runs = Array.from({ length: 48 }, (_, index) => '`'.repeat(index + 1));
    const stream = new MarkdownStream();
    let source = 'prose ' + runs.join(' ') + ' 👩' + '\u0301'.repeat(12_000) + '\u200d💻\tEND';
    stream.append(source);
    stream.tail(80, 5);
    for (const run of [...runs].reverse()) {
      source += ' ' + run;
      stream.append(' ' + run);
      stream.tail(80, 5);
    }
    const expected = layoutMarkdown(parseMarkdown(source), 100_000).at(-1)?.text;
    const actual = stream.tail(100_000, 5).at(-1)?.text;
    expect(actual?.match(/ +END/)?.[0]).toBe(expected?.match(/ +END/)?.[0]);
    expect(stream.columnWork.interpretation).toBeLessThan(source.length * 20);
    expect(stream.columnWork.width).toBeLessThan(source.length * 40);
  });

  it('keeps complete intraword underscore runs literal across every surrogate split', () => {
    for (const source of [
      '𝑥_𝑦_𝑧',
      '𐐀_𐐀_𐐀',
      '𝟙_𝟚_𝟛',
      '𝑥__𝑦__𝑧',
      '𐐀__a__𝟙',
      'a__𝑦__𐐀',
      '𝑥___𝑦___𝑧',
    ]) {
      for (let split = 0; split <= source.length; split++) {
        const stream = new MarkdownStream();
        stream.append(source.slice(0, split));
        const provisional = stream.tail(80, 5);
        expect(
          provisional.flatMap((line) => line.spans).some((span) => span.strong || span.emphasis),
        ).toBe(false);
        stream.append(source.slice(split));
        const lines = stream.tail(80, 5);
        expect(lines.map((line) => line.text).join('')).toBe(source);
        expect(
          lines.flatMap((line) => line.spans).some((span) => span.strong || span.emphasis),
        ).toBe(false);
      }
    }
  });

  it('preserves a literal intraword run when the source cut hides its left code point', () => {
    for (const [left, marker] of [
      ['𝑥', '_'],
      ['𐐀', '__'],
      ['𝟙', '___'],
    ]) {
      const source =
        (left ?? '') + marker + 'y'.repeat(4_000 - 2 * (marker?.length ?? 0) - 1) + marker + ' ';
      for (const split of [0, 1, 2, 3, 4, 5, source.length - 2, source.length]) {
        const stream = new MarkdownStream();
        stream.append(source.slice(0, split));
        stream.append(source.slice(split));
        const lines = stream.tail(10_000, 5);
        expect(lines.map((line) => line.text).join('')).toBe(stream.sourceTail());
        expect(
          lines.flatMap((line) => line.spans).some((span) => span.strong || span.emphasis),
        ).toBe(false);
      }
    }
  });

  it('defers a possible intraword closer until its supplementary neighbor is complete', () => {
    for (const marker of ['_', '__']) {
      const stream = new MarkdownStream();
      const prefix = marker + 'x'.repeat(4_100) + marker;
      stream.append(prefix + '𝑦'.slice(0, 1));
      expect(
        stream
          .tail(10_000, 5)
          .flatMap((line) => line.spans)
          .some((span) => span.strong || span.emphasis),
      ).toBe(false);
      stream.append('𝑦'.slice(1));
      const expected = layoutMarkdown(parseMarkdown(prefix + '𝑦'), 10_000).at(-1)?.text;
      expect(stream.tail(10_000, 5).at(-1)?.text).toBe(
        expected?.slice(-stream.sourceTail().length),
      );
      expect(
        stream
          .tail(10_000, 5)
          .flatMap((line) => line.spans)
          .some((span) => span.strong || span.emphasis),
      ).toBe(false);
    }
    for (const neighbor of ['👩', '\ud835 ']) {
      const stream = new MarkdownStream();
      stream.append('_text_' + neighbor.slice(0, 1));
      expect(
        stream
          .tail(80, 5)
          .flatMap((line) => line.spans)
          .some((span) => span.emphasis),
      ).toBe(false);
      stream.append(neighbor.slice(1));
      expect(stream.tail(80, 5)).toEqual(layoutMarkdown(parseMarkdown('_text_' + neighbor), 80));
    }
    const source = '𝑥 _𝑦_ 𐐀 __𝟙__';
    for (let split = 0; split <= source.length; split++) {
      const stream = new MarkdownStream();
      stream.append(source.slice(0, split));
      stream.append(source.slice(split));
      expect(stream.tail(80, 5)).toEqual(layoutMarkdown(parseMarkdown(source), 80));
    }
  });

  it('reports geometry elision independently of the source tail budget', () => {
    const stream = new MarkdownStream();
    stream.append('x'.repeat(2_000));
    expect(stream.elided).toBe(false);
    expect(stream.tail(80, 7)).toHaveLength(7);
    expect(stream.elided).toBe(true);
    stream.tail(80, 100);
    expect(stream.elided).toBe(false);
    stream.reset();
    expect(stream.elided).toBe(false);
  });

  it('keeps completed tables literal until a blank or unambiguous block closes them', () => {
    const stream = oneByteAtATime('| h |\n| --- |\n| x |');
    expect(rows(stream)).toEqual(['| h |', '| --- |', '| x |']);
    stream.append('\n\n');
    expect(rows(stream)[0]).toBe('┌───┐');
    stream.append('# next\n');
    expect(rows(stream)).toContain('next');
  });

  it('retains code-fence state before the visible source window', () => {
    const stream = oneByteAtATime('```ts\n' + 'x'.repeat(12_000));
    expect(stream.elided).toBe(true);
    const lines = stream.tail(40, 4);
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.text.startsWith('│ '))).toBe(true);
    expect(lines.every((line) => line.spans.some((span) => span.code))).toBe(true);
    expect(stream.sourceTail()).toHaveLength(4_000);
    stream.append('\n```\n# next\n');
    expect(rows(stream)).toContain('next');
  });

  it('matches delimiters whose opener has left the visible tail', () => {
    for (const marker of ['**', '*', '__', '_', '~~', '`', '``']) {
      const stream = oneByteAtATime(marker + 'a '.repeat(5_000));
      stream.append(marker);
      const spans = stream.tail(60, 3).flatMap((line) => line.spans);
      const flag =
        marker[0] === '`'
          ? 'code'
          : marker === '~~'
            ? 'strike'
            : marker.length === 2
              ? 'strong'
              : 'emphasis';
      expect(spans.some((span) => span[flag])).toBe(true);
      expect(spans.map((span) => span.text).join('')).not.toContain(marker);
    }
  });

  it('retains a visible target when the link label has left the tail', () => {
    const stream = oneByteAtATime('[label](https://example.test/' + 'x'.repeat(9_000));
    stream.append(')');
    const lines = stream.tail(60, 2);
    expect(
      lines
        .flatMap((line) => line.spans)
        .some((span) => span.linkURL?.startsWith('https://example.test/')),
    ).toBe(true);
    expect(lines.map((line) => line.text).join('')).toContain(')');
  });

  it('retains container fences before the tail and deindents admitted body lines', () => {
    for (const [opening, body, closing, prefix] of [
      ['> ```ts\n', '> ' + 'x'.repeat(5_000), '\n> ```\n', '│ │ '],
      ['- ```ts\n', '  ' + 'x'.repeat(5_000), '\n  ```\n', '  │ '],
      ['  ```ts\n', '  x\n'.repeat(2_000), '  ```\n', '│ '],
    ]) {
      const stream = oneByteAtATime((opening ?? '') + (body ?? ''));
      expect(stream.tail(40, 3).every((line) => line.text.startsWith(prefix ?? ''))).toBe(true);
      stream.append(closing ?? '');
      stream.append('# next\n');
      expect(rows(stream)).toContain('next');
    }
  });

  it('preserves historical delimiters inside link labels and always shows the complete target', () => {
    for (const [marker, flag] of [
      ['**', 'strong'],
      ['*', 'emphasis'],
      ['~~', 'strike'],
      ['`', 'code'],
      ['``', 'code'],
    ]) {
      const stream = new MarkdownStream();
      stream.append('[' + marker + 'x'.repeat(8_000) + marker + '](https://x.test)');
      const spans = stream.tail(80, 3).flatMap((line) => line.spans);
      const label = spans.find(
        (span) => span.text.includes('x') && span.linkURL === 'https://x.test',
      );
      expect(label).toMatchObject({ [flag ?? 'strong']: true, linkURL: 'https://x.test' });
      expect(spans.map((span) => span.text).join('')).toContain(' (https://x.test)');
      expect(spans.map((span) => span.text).join('')).not.toContain(marker);
    }
  });

  it('keeps tab-indented list-fence bodies literal after the opener leaves the live tail', () => {
    const stream = new MarkdownStream();
    stream.append('- ```\n');
    for (let row = 0; row < 1_000; row++) stream.append('\t**literal**\n');
    const literalRows = stream.tail(80, 5).filter((line) => line.text.includes('literal'));
    expect(literalRows.length).toBeGreaterThan(0);
    for (const line of literalRows) {
      expect(line.text).toContain('│       **literal**');
      expect(line.spans.some((span) => span.code)).toBe(true);
      expect(line.spans.some((span) => span.strong)).toBe(false);
    }
    stream.append('\n\t```\n');
    expect(stream.tail(80, 5).some((line) => line.text.includes('│       ```'))).toBe(true);
    stream.append('# next');
    const next = stream.tail(80, 5).find((line) => line.text === 'next');
    expect(next?.spans.some((span) => span.heading === 1 && !span.code)).toBe(true);
  });

  it('accepts a tabbed closer when only one structural cell remains after list indentation', () => {
    const stream = new MarkdownStream();
    stream.append('12345. ```\n' + '\t**literal**\n'.repeat(1_000));
    const literalRows = stream.tail(80, 5).filter((line) => line.text.includes('literal'));
    expect(literalRows.length).toBeGreaterThan(0);
    expect(literalRows.every((line) => line.text.includes('│  **literal**'))).toBe(true);
    stream.append('\t```\n# next');
    const lines = stream.tail(80, 5);
    expect(lines.some((line) => line.text.includes('```'))).toBe(false);
    expect(
      lines
        .find((line) => line.text === 'next')
        ?.spans.some((span) => span.heading === 1 && !span.code),
    ).toBe(true);
  });

  it('retains autolink context before the tail', () => {
    const stream = oneByteAtATime('<https://example.test/' + 'x'.repeat(8_000));
    stream.append('>');
    const spans = stream.tail(60, 2).flatMap((line) => line.spans);
    expect(spans.some((span) => span.linkURL?.startsWith('https://example.test/'))).toBe(true);
    expect(spans.map((span) => span.text).join('')).not.toContain('>');
  });

  it('caches a finalized table grid across following token frames and invalidates on resize', () => {
    const stream = new MarkdownStream();
    stream.append('| h |\n| --- |\n| x |\n\n');
    const draw = vi.spyOn(layout, 'layoutMarkdown');
    stream.tail(80, 12);
    for (const character of 'following words') {
      stream.append(character);
      stream.tail(80, 12);
    }
    expect(
      draw.mock.calls.filter(([blocks]) => blocks.some((block) => block.kind === 'table')),
    ).toHaveLength(1);
    stream.tail(40, 12);
    expect(
      draw.mock.calls.filter(([blocks]) => blocks.some((block) => block.kind === 'table')),
    ).toHaveLength(2);
    draw.mockRestore();
  });

  it('consumes long delimiter runs once rather than growing a rescanned lexer buffer', () => {
    const stream = oneByteAtATime('`'.repeat(30_000));
    expect(stream.work.lexical).toBe(30_000);
    stream.tail(80, 3);
    expect(stream.work.lexical).toBe(30_000);
    stream.append('x');
    expect(stream.work.lexical).toBe(30_001);
  });

  it('keeps Unicode clusters intact when the source budget cuts through them', () => {
    for (const cluster of ['界', 'e\u0301', '👩‍💻', '🇹🇷']) {
      const stream = new MarkdownStream();
      stream.append('prefix '.repeat(1_000) + cluster + 'x'.repeat(3_999));
      expect(stream.sourceTail()).toBe((cluster.length === 1 ? cluster : '') + 'x'.repeat(3_999));
      expect(
        stream
          .tail(60, 2)
          .map((line) => line.text)
          .join(''),
      ).toMatch(/^x+$/);
    }
  });

  it('does not leak inline styles out of historical code and strong delimiters', () => {
    const stream = new MarkdownStream();
    stream.append('**`' + 'x'.repeat(8_000) + '`** plain');
    const spans = stream.tail(80, 2).flatMap((line) => line.spans);
    expect(spans.some((span) => span.code && span.strong)).toBe(true);
    expect(spans.find((span) => span.text.includes('plain'))?.strong).not.toBe(true);
    expect(spans.map((span) => span.text).join('')).not.toContain('**');
  });

  it('holds a quoted table body and finalizes it before a following quoted heading', () => {
    const stream = oneByteAtATime('> | h |\n> | --- |\n> | x |');
    expect(rows(stream).join('')).not.toContain('┌');
    stream.append('\n> # next\n');
    expect(rows(stream).join('')).toContain('┌');
    expect(rows(stream).join('')).toContain('x');
  });

  it('preserves a heading prefix outside a long unfinished line', () => {
    const stream = oneByteAtATime('# ' + 'word '.repeat(2_000));
    expect(
      stream
        .tail(60, 2)
        .flatMap((line) => line.spans)
        .some((span) => span.heading === 1),
    ).toBe(true);
  });

  it('does not hand an accumulated unfinished line or paragraph to the block parser per frame', () => {
    const parse = vi.spyOn(parser, 'parseMarkdown');
    const stream = new MarkdownStream();
    const source = '**' + 'word '.repeat(2_000);
    for (let at = 0; at < source.length; at++) {
      stream.append(source[at] ?? '');
      if (at % 31 === 0) stream.tail(80, 8);
    }
    expect(Math.max(...parse.mock.calls.map(([source]) => source.length))).toBeLessThanOrEqual(
      4_001,
    );
    expect(stream.work.lexical).toBeLessThan(source.length * 3);
    expect(stream.work.blocks).toBe(0);
    stream.append('\n' + 'more words\n'.repeat(2_000));
    const before = stream.work;
    stream.tail(80, 8);
    stream.tail(40, 8);
    expect(stream.work).toEqual(before);
    stream.append('\n');
    expect(stream.work.blocks).toBeLessThan(source.length + 25_000);
    expect(stream.work.inline).toBeLessThan(source.length + 25_000);
    parse.mockRestore();
  });

  it('bounds unfinished table layout even after row and source overflow', () => {
    const stream = new MarkdownStream();
    stream.append('| h |\n| --- |\n');
    const parse = vi.spyOn(parser, 'parseMarkdown');
    for (let i = 0; i < 160; i++) {
      stream.append('| ' + 'x'.repeat(500) + ' |\n');
      const before = stream.work;
      expect(stream.tail(80, 5)).toHaveLength(5);
      expect(stream.work).toEqual(before);
    }
    expect(parse).not.toHaveBeenCalled();
    stream.append('\n');
    expect(rows(stream).join('')).not.toContain('┌');
    expect(stream.work.blocks).toBeLessThan(90_000);
    parse.mockRestore();
  });

  it('caches the bounded layout and preserves canonical final parsing at every split', () => {
    const source = 'Title\n---\n\n- one\n  - two\n\n```ts\n**x**\n```\n\n| h |\n| --- |\n| x |';
    for (let at = 0; at <= source.length; at++) {
      const stream = new MarkdownStream();
      stream.append(source.slice(0, at));
      stream.append(source.slice(at));
      expect(stream.tail(40, 8)).toBe(stream.tail(40, 8));
      expect(layoutMarkdown(stream.finish(), 40)).toEqual(
        layoutMarkdown(parseMarkdown(source), 40),
      );
    }
  });

  it('clears all fence, delimiter and source-tail state at reset and finish', () => {
    const stream = new MarkdownStream();
    stream.append('```\n' + 'x'.repeat(5_000));
    stream.reset();
    expect(stream.sourceTail()).toBe('');
    expect(stream.elided).toBe(false);
    stream.append('**next**');
    expect(rows(stream)).toEqual(['next']);
    stream.finish();
    stream.append('# next');
    expect(rows(stream)).toEqual(['next']);
  });
});
