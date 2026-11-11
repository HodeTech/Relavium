import { describe, expect, it } from 'vitest';
import { PositionIndex } from './position-index.js';

function verify(
  index: PositionIndex<number>,
  reference: ReadonlyMap<number, number>,
  extra: readonly number[] = [],
): void {
  const keys = [...reference.keys()].sort((a, b) => a - b);
  expect(index.size).toBe(keys.length);
  for (const query of [
    0,
    1,
    255,
    256,
    65_535,
    2 ** 32 - 1,
    2 ** 32,
    2 ** 40,
    Number.MAX_SAFE_INTEGER,
    ...extra,
  ]) {
    const before = index.visits;
    expect(index.floor(query)).toBe(reference.get(keys.filter((key) => key <= query).at(-1) ?? -1));
    expect(index.ceiling(query)).toBe(reference.get(keys.find((key) => key >= query) ?? -1));
    expect(index.visits - before).toBeLessThanOrEqual(256);
  }
}

describe('fixed-depth source position index', () => {
  it('orders full safe-integer offsets, overwrites values and prunes deleted paths', () => {
    const index = new PositionIndex<number>();
    const reference = new Map<number, number>();
    const positions = [
      0,
      1,
      255,
      256,
      65_535,
      2 ** 32 - 1,
      2 ** 32,
      2 ** 40 + 128,
      Number.MAX_SAFE_INTEGER,
    ];
    for (const position of positions) {
      index.set(position, position);
      reference.set(position, position);
      verify(index, reference);
    }
    index.set(256, 999);
    reference.set(256, 999);
    verify(index, reference);
    for (const position of positions.reverse()) {
      index.delete(position);
      reference.delete(position);
      verify(index, reference);
    }
    index.delete(123);
    expect(index.retained).toBe(1);
  });

  it('keeps snapshots isolated through writes and deletes in either version', () => {
    const original = new PositionIndex<number>();
    original.set(1, 10);
    original.set(2 ** 40, 20);
    const snapshot = original.snapshot();
    original.set(2, 30);
    original.delete(1);
    verify(
      snapshot,
      new Map([
        [1, 10],
        [2 ** 40, 20],
      ]),
    );
    snapshot.set(3, 40);
    snapshot.delete(2 ** 40);
    verify(
      original,
      new Map([
        [2, 30],
        [2 ** 40, 20],
      ]),
    );
    verify(
      snapshot,
      new Map([
        [1, 10],
        [3, 40],
      ]),
    );
  });

  it('splices a range with correct counts and keeps the source version independent', () => {
    const destination = new PositionIndex<number>();
    destination.set(300, 300);
    const source = new PositionIndex<number>();
    source.set(1, 10);
    source.set(2, 20);
    destination.replaceRange(0, 256, source);
    verify(
      destination,
      new Map([
        [1, 10],
        [2, 20],
        [300, 300],
      ]),
    );
    source.set(3, 30);
    source.delete(1);
    verify(
      destination,
      new Map([
        [1, 10],
        [2, 20],
        [300, 300],
      ]),
    );
    destination.set(4, 40);
    verify(
      source,
      new Map([
        [2, 20],
        [3, 30],
      ]),
    );
  });

  it('updates counts through an in-place partial branch replacement', () => {
    const destination = new PositionIndex<number>();
    destination.set(1, 1);
    const source = new PositionIndex<number>();
    for (const key of [2, 3, 4]) source.set(key, key);
    destination.replaceRange(1, 5, source);
    verify(
      destination,
      new Map([
        [2, 2],
        [3, 3],
        [4, 4],
      ]),
    );
    destination.replaceRange(0, 2 ** 53, new PositionIndex<number>());
    verify(destination, new Map());
    expect(destination.retained).toBe(1);
  });

  it('bounds range-splice traversal independently of the number of stored entries', () => {
    for (const count of [256, 2_048, 8_192]) {
      const destination = new PositionIndex<number>();
      const source = new PositionIndex<number>();
      const reference = new Map<number, number>();
      for (let at = 0; at < count; at++) {
        destination.set(at, at);
        source.set(at, -at);
        reference.set(at, at >= 13 && at < count - 17 ? -at : at);
      }
      const before = destination.visits;
      destination.replaceRange(13, count - 17, source);
      expect(destination.visits - before).toBeLessThanOrEqual(16_384);
      verify(destination, reference);
    }
  });

  it('matches reference maps across persistent range splices and later mutations', () => {
    let seed = 78_127;
    const random = (limit: number): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % limit;
    };
    const bases = [0, 2 ** 32, 2 ** 40, 2 ** 48, Number.MAX_SAFE_INTEGER - 1_024];
    const position = (): number => (bases[random(bases.length)] ?? 0) + random(256);
    const destination = new PositionIndex<number>();
    const source = new PositionIndex<number>();
    const expected = new Map<number, number>();
    const incoming = new Map<number, number>();
    const fold = destination.createFold(
      (value) => `${value};`,
      (left, right) => left + right,
      '',
    );
    const ordered = (values: ReadonlyMap<number, number>): string =>
      [...values]
        .sort(([left], [right]) => left - right)
        .map(([, value]) => `${value};`)
        .join('');
    const snapshots: { index: PositionIndex<number>; expected: ReadonlyMap<number, number> }[] = [];
    for (let step = 0; step < 300; step++) {
      const key = position();
      switch (random(6)) {
        case 0:
          destination.set(key, step);
          expected.set(key, step);
          break;
        case 1:
          destination.delete(key);
          expected.delete(key);
          break;
        case 2:
          source.set(key, -step);
          incoming.set(key, -step);
          break;
        case 3:
          source.delete(key);
          incoming.delete(key);
          break;
        case 4: {
          const other = position();
          const start = Math.min(key, other),
            end = Math.max(key, other) + 1;
          destination.replaceRange(start, end, source);
          for (const entry of expected.keys())
            if (entry >= start && entry < end) expected.delete(entry);
          for (const [entry, value] of incoming)
            if (entry >= start && entry < end) expected.set(entry, value);
          break;
        }
        default:
          snapshots.push({ index: destination.snapshot(), expected: new Map(expected) });
      }
      verify(destination, expected, [key, position()]);
      verify(source, incoming, [key]);
      expect(fold(destination)).toBe(ordered(expected));
      expect(fold(source)).toBe(ordered(incoming));
      const saved = snapshots[random(snapshots.length)];
      if (saved) {
        verify(saved.index, saved.expected, [key]);
        expect(fold(saved.index)).toBe(ordered(saved.expected));
      }
    }
    for (const saved of snapshots) verify(saved.index, saved.expected);
    destination.replaceRange(0, 2 ** 53, destination);
    verify(destination, expected);
  });

  it('counts half-open ranges over safe-integer positions and cached subtrees', () => {
    const index = new PositionIndex<number>();
    const keys = [0, 1, 255, 256, 257, 2 ** 32, Number.MAX_SAFE_INTEGER];
    for (const key of keys) index.set(key, key);
    for (const [start, end] of [
      [0, 0],
      [0, 1],
      [1, 256],
      [256, 258],
      [2 ** 32, 2 ** 32 + 1],
      [Number.MAX_SAFE_INTEGER, 2 ** 53],
      [0, 2 ** 53],
    ]) {
      if (start === undefined || end === undefined) throw new Error('Range fixture incomplete.');
      expect(index.countRange(start, end)).toBe(
        keys.filter((key) => key >= start && key < end).length,
      );
    }
    for (let key = 300; key < 8_192; key++) index.set(key, key);
    const before = index.visits;
    expect(index.countRange(13, 8_175)).toBe(7_875 + 3);
    expect(index.visits - before).toBeLessThanOrEqual(4_096);
  });

  it('folds in source order and reuses unchanged branch summaries across versions', () => {
    const index = new PositionIndex<string>();
    const values = Array.from({ length: 8_192 }, (_, key) => `[${key}]`);
    for (const [key, value] of [...values.entries()].reverse()) index.set(key, value);
    let mapped = 0;
    const fold = index.createFold(
      (value) => {
        mapped++;
        return value;
      },
      (left, right) => left + right,
      '',
    );
    const original = values.join('');
    expect(fold(index)).toBe(original);
    expect(mapped).toBe(values.length);
    const snapshot = index.snapshot();
    const cachedWork = index.visits;
    expect(fold(index)).toBe(original);
    expect(index.visits - cachedWork).toBe(1);
    expect(fold(snapshot)).toBe(original);
    expect(mapped).toBe(values.length);
    index.set(17, '[changed]');
    values[17] = '[changed]';
    const before = mapped;
    expect(fold(index)).toBe(values.join(''));
    expect(mapped - before).toBeLessThanOrEqual(256);
    expect(fold(snapshot)).toBe(original);
    index.delete(31);
    values[31] = '';
    expect(fold(index)).toBe(values.join(''));
    index.replaceRange(0, 512, snapshot);
    expect(fold(index)).toBe(original);
    expect(fold(snapshot)).toBe(original);
  });

  it('invalidates a fold after explicitly updating an existing value object', () => {
    const index = new PositionIndex<{ text: string }>();
    const value = { text: 'before' };
    index.set(0, value);
    const fold = index.createFold(
      (entry) => entry.text,
      (left, right) => left + right,
      '',
    );
    expect(fold(index)).toBe('before');
    value.text = 'after';
    index.set(0, value);
    expect(fold(index)).toBe('after');
  });

  it('activates only the identical owner at a shared position across persistent versions', () => {
    const left = new PositionIndex<{ id: string }>();
    const right = new PositionIndex<{ id: string }>();
    const shared = { id: 'shared' };
    const other = { id: 'same contents' };
    left.set(3, shared);
    left.set(256, other);
    right.set(3, shared);
    right.set(256, { id: 'same contents' });
    const oldRight = right.snapshot();
    const seen: number[] = [];
    left.forEachSharedIdentity(right, 0, 300, (_value, position) => {
      seen.push(position);
      left.delete(position);
    });
    expect(seen).toEqual([3]);
    expect(left.size).toBe(1);
    right.set(256, other);
    left.forEachSharedIdentity(oldRight, 0, 300, () => {
      throw new Error('A different object must remain hidden');
    });
    left.forEachSharedIdentity(right, 0, 256, () => {
      throw new Error('The end of the range is exclusive');
    });
    const restored: number[] = [];
    left.forEachSharedIdentity(right, 0, 300, (_value, position) => restored.push(position));
    expect(restored).toEqual([256]);
  });

  it('reuses disjoint branch-pair results as versions change outside their range', () => {
    const hidden = new PositionIndex<{ id: number }>();
    const active = new PositionIndex<{ id: number }>();
    for (let position = 0; position < 4096; position++) {
      hidden.set(position, { id: position });
      active.set(position, { id: position });
    }
    hidden.forEachSharedIdentity(active, 0, 4096, () => {
      throw new Error('Equal data does not imply the same owner');
    });
    const before = hidden.visits;
    for (let change = 0; change < 32; change++) {
      active.set(8192 + change, { id: change });
      hidden.forEachSharedIdentity(active, 0, 4096, () => {
        throw new Error('No suspended owner has become active');
      });
    }
    expect(hidden.visits - before).toBeLessThan(32 * 1_000);
  });
});
