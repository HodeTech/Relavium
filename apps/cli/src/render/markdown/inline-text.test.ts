import { describe, expect, it } from 'vitest';
import { displayWidth } from '../tui/viewport.js';
import { InlineTextFactory, type InlineTextNode, type InlineTextWork } from './inline-text.js';

function setup(source: () => string): { factory: InlineTextFactory; work: InlineTextWork } {
  const work = {
    nodes: 0,
    visits: 0,
    sourceUnits: 0,
    measuredUnits: 0,
    cacheKeyUnits: 0,
    constructedUnits: 0,
  };
  const factory = new InlineTextFactory((start, end) => source().slice(start, end), work);
  return { factory, work };
}

describe('immutable inline text aggregation', () => {
  it('calculates tab stops across source leaves and reuses interned nodes', () => {
    const source = 'abcd\tef\tZ';
    const { factory } = setup(() => source);
    const first = factory.raw(0, 4);
    expect(factory.raw(0, 4)).toBe(first);
    const node = factory.concat([first, factory.raw(4, 7), factory.raw(7, source.length)]);
    expect(factory.tabSpaces(node, 0, source.length)).toEqual([
      { position: 4, spaces: 4 },
      { position: 7, spaces: 6 },
    ]);
    expect(factory.tabSpaces(node, 7, source.length)).toEqual([{ position: 7, spaces: 6 }]);
  });
  it('counts initial columns and resets after newline, and flattens one inline value', () => {
    const source = 'a\tb\nc\t';
    const { factory } = setup(() => source);
    expect(factory.tabSpaces(factory.raw(0, source.length), 0, source.length, 3)).toEqual([
      { position: 1, spaces: 4 },
      { position: 5, spaces: 7 },
    ]);
    expect(factory.tabSpaces(factory.raw(0, source.length), 0, source.length, 3, 2)).toEqual([
      { position: 1, spaces: 4 },
      { position: 5, spaces: 5 },
    ]);
    const label = 'a\t\tb\tz';
    const other = setup(() => label).factory;
    expect(
      other.tabSpaces(
        other.concat([other.raw(0, 4, true), other.raw(4, label.length)]),
        0,
        label.length,
      ),
    ).toEqual([{ position: 4, spaces: 5 }]);
  });
  it('keeps full Unicode graphemes across arbitrary source splits', () => {
    for (const cluster of ['e' + '\u0301'.repeat(500), '👩‍'.repeat(80) + '💻', '🇺'.repeat(101)]) {
      const source = cluster + '\tEND';
      const { factory } = setup(() => source);
      const nodes = Array.from({ length: cluster.length }, (_, index) =>
        factory.raw(index, index + 1),
      );
      const node = factory.concat([...nodes, factory.raw(cluster.length, source.length)]);
      expect(factory.tabSpaces(node, cluster.length, source.length)).toEqual([
        { position: cluster.length, spaces: 8 - (displayWidth(cluster) % 8) },
      ]);
    }
  });
  it('matches terminal widths across varied codepoint and surrogate boundaries', () => {
    const units = ['a', '中', '🇺', '👩', '\u200d', '\ufe0f', '\u0301', '\u0600', 'क', '\u094d'];
    let seed = 0x39123;
    for (let example = 0; example < 200; example++) {
      let prefix = '';
      for (let at = 0; at < 30; at++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        prefix += units[seed % units.length];
      }
      const source = prefix + '\t';
      const { factory } = setup(() => source);
      const parts = Array.from({ length: source.length }, (_, at) => factory.raw(at, at + 1));
      expect(factory.tabSpaces(factory.concat(parts), prefix.length, source.length)).toEqual([
        { position: prefix.length, spaces: 8 - (displayWidth(prefix) % 8) },
      ]);
    }
  });
  it('measures a growing cross-leaf cluster once at its first tab', () => {
    for (const n of [100, 200, 400, 800]) {
      const source = 'e' + '\u0301'.repeat(n) + '\t';
      const { factory, work } = setup(() => source);
      const parts = Array.from({ length: source.length }, (_, at) => factory.raw(at, at + 1));
      const root = factory.concat(parts);
      expect(factory.tabSpaces(root, source.length - 1, source.length)).toEqual([
        { position: source.length - 1, spaces: 7 },
      ]);
      expect(work.measuredUnits).toBeLessThanOrEqual(source.length * 2);
      // Anchor indexing reads the immutable source once in addition to the existing scans.
      expect(work.sourceUnits).toBeLessThanOrEqual(source.length * 5);
      // Control detection and width traversal each charge visits; both are linear.
      expect(work.visits).toBeLessThanOrEqual(source.length * 30);
    }
  });
  it('keeps exact Unicode widths across literal backtick synchronization points', () => {
    const contexts = [
      '\u0600',
      '\u0d4e',
      '\u0301',
      '\u200d💻',
      '🇺',
      '🇺🇸',
      '👩\u0301\u200d💻',
      'क\u094dक',
      '각',
      'ｶﾞ',
      '\ud800',
      '\udc00',
      'e' + '\u0301'.repeat(8_100),
    ];
    for (const left of contexts)
      for (const right of contexts) {
        const source = left + '``' + right + '``' + left + '\t';
        const { factory } = setup(() => source);
        const parts = Array.from({ length: source.length }, (_, at) => factory.raw(at, at + 1));
        expect(factory.tabSpaces(factory.concat(parts), source.length - 1, source.length)).toEqual([
          { position: source.length - 1, spaces: 8 - (displayWidth(source.slice(0, -1)) % 8) },
        ]);
      }
  });
  it.each([128, 256, 512, 1_024])(
    'reuses anchored raw interiors beyond bounded interner capacity at %i repetitions',
    (n) => {
      const source = '👩' + '``🇺'.repeat(n) + 'e' + '\u0301'.repeat(n * 16) + '\t';
      const end = source.length - 1;
      // Ticks isolate each regional indicator. Removing a complete unit subtracts
      // its width without remeasuring the unchanged long combining cluster per node.
      const initialWidth = displayWidth(source.slice(0, end));
      const unitWidth = displayWidth('``🇺');
      const { factory, work } = setup(() => source);
      for (let index = 0; index < n; index++) {
        const start = 2 + index * 4;
        const node = factory.concat([
          factory.raw(0, 2),
          factory.raw(start, end),
          factory.raw(end, source.length),
        ]);
        const expected = 8 - ((initialWidth - index * unitWidth) % 8);
        expect(factory.tabSpaces(node, end, source.length)).toEqual([
          { position: end, spaces: expected },
        ]);
      }
      expect(work.measuredUnits).toBeLessThan(source.length * 2);
      expect(work.sourceUnits).toBeLessThan(source.length * 8);
      expect(work.visits).toBeLessThan(source.length * 12);
    },
  );
  it('trims prior raw and replacement units without losing source mapping', () => {
    const source = 'a\t\tb';
    const { factory } = setup(() => source);
    const node = factory.concat([factory.raw(0, 1), factory.text(' ', 1, 3), factory.raw(3, 4)]);
    const shortened = factory.trimEnd(node, 2);
    expect(shortened.renderLength).toBe(1);
    expect(factory.tabSpaces(shortened, 0, source.length)).toEqual([]);
    const flattened = factory.raw(0, 4, true);
    expect(flattened.renderLength).toBe(3);
    expect(factory.trimEnd(flattened, 2).renderLength).toBe(1);
  });
  it('reuses source-range summaries as wrapper and suffix both change', () => {
    for (const n of [25, 50, 100, 200]) {
      let source = '*' + 'x'.repeat(4_000 + n * 40);
      const { factory, work } = setup(() => source);
      for (let at = 0; at < n; at++) {
        source += '[label*](url)\t';
        const body = factory.raw(1, source.length);
        const withMarker = factory.concat([factory.raw(0, 1), body]);
        const lastTab = source.length - 1;
        const previousTab = source.lastIndexOf('\t', lastTab - 1);
        for (const [node, first] of [
          [withMarker, 0],
          [body, 1],
        ] satisfies readonly (readonly [InlineTextNode, number])[]) {
          const segment = source.slice(previousTab < 0 ? first : previousTab + 1, lastTab);
          expect(factory.tabSpaces(node, lastTab, source.length)).toEqual([
            { position: lastTab, spaces: 8 - (displayWidth(segment) % 8) },
          ]);
        }
      }
      expect(work.sourceUnits).toBeLessThan(source.length * 5);
      expect(work.measuredUnits).toBeLessThan(source.length * 3);
      expect(work.visits).toBeLessThan(source.length * 5);
      expect(work.nodes).toBeLessThan(source.length);
      expect(work.cacheKeyUnits).toBeLessThan(source.length * 3);
      // Cache-key construction is counted too; the bound scales with source size.
      expect(work.constructedUnits).toBeLessThan(source.length * 10);
    }
  });
  it('bounds strong caches for one-unit growing ranges without truncating source', () => {
    const source = 'x'.repeat(10_000);
    const { factory } = setup(() => source);
    let latest: InlineTextNode | undefined;
    for (let end = 1; end <= source.length; end++) {
      const raw = factory.raw(0, end);
      latest = factory.concat([raw, factory.text('!', end, end + 1)]);
      if (end % 10 === 0) factory.tabSpaces(latest, end - 1, end + 1);
    }
    expect(latest?.renderLength).toBe(source.length + 1);
    expect(factory.cacheStats.recentRaw).toBeLessThanOrEqual(512);
    expect(factory.cacheStats.recentText).toBeLessThanOrEqual(512);
    expect(factory.cacheStats.recentConcat).toBeLessThanOrEqual(512);
    expect(factory.cacheStats.recentContiguous).toBeLessThanOrEqual(512);
    expect(factory.cacheStats.sourceAnchors).toBeLessThanOrEqual(source.length / 2);
    expect(factory.cacheStats.sourceAnchorPages).toBeLessThanOrEqual(
      Math.ceil(source.length / 4096),
    );
    expect(factory.cacheStats.alignedRaw).toBeLessThanOrEqual(
      2 * Math.ceil(source.length / 64) + 64,
    );
  });
  it('indexes expanding raw ASCII ranges before a Unicode tab boundary', () => {
    for (const depth of [48, 96, 192, 384]) {
      const runs = Array.from({ length: depth }, (_, at) => '`'.repeat(at + 1));
      const unicodeTail = ' 👩‍💻é';
      const prefix = 'p ' + runs.join(' ') + unicodeTail;
      const source = prefix + '\t';
      const { factory, work } = setup(() => source);
      let start = 2;
      const positions: number[] = [];
      for (const run of runs) {
        positions.push(start);
        start += run.length + 1;
      }
      for (const at of positions.reverse()) {
        const node = factory.concat([
          factory.raw(0, 2),
          factory.raw(at, prefix.length),
          factory.raw(prefix.length, source.length),
        ]);
        const asciiUnits = prefix.length - unicodeTail.length - at;
        const expected = 8 - ((2 + asciiUnits + displayWidth(unicodeTail)) % 8);
        expect(factory.tabSpaces(node, prefix.length, source.length)).toEqual([
          { position: prefix.length, spaces: expected },
        ]);
      }
      expect(work.sourceUnits).toBeLessThan(source.length * 8);
      expect(work.measuredUnits).toBeLessThan(source.length * 2);
      expect(work.visits).toBeLessThan(source.length * 20);
    }
  });
  it('retains exact pair widths beyond summary and interner churn', () => {
    for (const count of [32, 33, 512, 513]) {
      const source = '*' + '\u0301'.repeat(400) + '\t';
      const { factory, work } = setup(() => source);
      const body = factory.raw(1, source.length - 1);
      const tab = factory.raw(source.length - 1, source.length);
      const leads = Array.from({ length: count }, (_, at) => factory.text(`v${at}`, 0, 1));
      const check = (): void => {
        for (let at = 0; at < leads.length; at++) {
          const lead = leads[at];
          if (!lead) continue;
          const node = factory.concat([lead, body, tab]);
          expect(factory.tabSpaces(node, source.length - 1, source.length)).toEqual([
            {
              position: source.length - 1,
              spaces: 8 - (displayWidth(`v${at}` + '\u0301'.repeat(400)) % 8),
            },
          ]);
        }
      };
      check();
      const measured = work.measuredUnits;
      check();
      expect(work.measuredUnits).toBe(measured);
      expect(factory.cacheStats.recentConcat).toBeLessThanOrEqual(512);
    }
  });
  it('reuses a long immutable prefix when a suffix changes repeatedly', () => {
    for (const n of [25, 50, 100]) {
      let source = 'x'.repeat(4_000 + n * 40);
      const { factory, work } = setup(() => source);
      let root = factory.raw(0, source.length);
      for (let at = 0; at < n; at++) {
        const start = source.length;
        source += '\t';
        root = factory.concat([root, factory.raw(start, source.length)]);
        expect(factory.tabSpaces(root, start, source.length)).toHaveLength(1);
      }
      expect(work.sourceUnits).toBeLessThan(source.length * 4);
      expect(work.measuredUnits).toBeLessThan(source.length * 8);
    }
  });
});
