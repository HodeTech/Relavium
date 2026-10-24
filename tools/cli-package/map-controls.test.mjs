import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cutInsideValue,
  encodeMappings,
  rotateSources,
  shiftColumns,
  shiftLines,
  shiftOriginalColumns,
} from './map-controls.mjs';
import { SourceMapError, decodeMappings } from './source-map.mjs';

// Importing the runner runs no control: only its command-line entry point does.
const COUNTS = { sources: 3, names: 2 };
const refuses = (code) => (error) => error instanceof Error && error.message === code;

/** Deterministic mappings with empty lines, unmapped and named segments and backward moves. */
function sample() {
  let seed = 11;
  const next = (bound) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    // The high bits: an LCG's low bits cycle and would never draw some kinds.
    return Math.floor(seed / 65536) % bound;
  };
  const lines = [];
  for (let line = 0; line < 30; line += 1) {
    const segments = [];
    let column = next(3);
    for (let index = next(12); index > 0; index -= 1) {
      column += 1 + next(400);
      const kind = next(4);
      if (kind === 0) segments.push({ generatedColumn: column });
      else {
        const segment = {
          generatedColumn: column,
          source: next(3),
          originalLine: next(200),
          originalColumn: kind === 1 ? 0 : next(120),
        };
        if (kind === 3) segment.name = next(2);
        segments.push(segment);
      }
    }
    lines.push(segments);
  }
  // Every kind of segment the encoder must write is present.
  const all = lines.flat();
  assert.ok(all.some((segment) => segment.source === undefined));
  assert.ok(all.some((segment) => segment.name !== undefined));
  assert.ok(all.some((segment) => segment.originalColumn > 0));
  assert.ok(all.some((segment) => segment.originalColumn === 0));
  assert.ok(lines.some((segments) => segments.length === 0));
  return lines;
}

test('the encoder writes back exactly what the strict decoder reads', () => {
  const lines = sample();
  const mappings = encodeMappings(lines);
  assert.deepEqual(decodeMappings(mappings, COUNTS), lines);
  // Canonical input re-encodes to the same text, empty lines included.
  assert.equal(encodeMappings(decodeMappings(mappings, COUNTS)), mappings);
  assert.equal(encodeMappings(decodeMappings(';;AAAA;', COUNTS)), ';;AAAA;');
});

test('a shifted map moves every original column after a line start one left, and nothing else', () => {
  const lines = sample();
  const shifted = decodeMappings(shiftOriginalColumns(encodeMappings(lines), COUNTS), COUNTS);
  assert.equal(shifted.length, lines.length);
  lines.forEach((segments, line) =>
    segments.forEach((segment, index) => {
      const moved = shifted[line][index];
      assert.equal(moved.generatedColumn, segment.generatedColumn);
      assert.equal(moved.source, segment.source);
      assert.equal(moved.originalLine, segment.originalLine);
      assert.equal(moved.name, segment.name);
      assert.equal(
        moved.originalColumn,
        segment.originalColumn === undefined || segment.originalColumn === 0
          ? segment.originalColumn
          : segment.originalColumn - 1,
      );
    }),
  );
  // A map with nothing to shift refuses rather than leaving the control hollow.
  assert.throws(
    () => shiftOriginalColumns('AAAA;CAAA', COUNTS),
    refuses('PACKED_CLI_MAP_CONTROL_NOTHING_SHIFTED'),
  );
});

test('rotated sources leave no source at its index', () => {
  for (const sources of [
    ['a.ts', 'b.ts'],
    ['a.ts', 'b.ts', 'c.ts'],
    ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
  ]) {
    const rotated = rotateSources(sources);
    assert.deepEqual([...rotated].sort(), [...sources].sort());
    assert.ok(rotated.every((source, index) => source !== sources[index]));
  }
  for (const sources of [[], ['a.ts'], ['a.ts', 'a.ts']]) {
    assert.throws(() => rotateSources(sources), refuses('PACKED_CLI_MAP_CONTROL_SOURCES'));
  }
});

test('the JS moves one line or one column, keeping a hashbang on the first line', () => {
  assert.equal(shiftLines('a();\nb();\n'), '\na();\nb();\n');
  assert.equal(shiftLines('#!/usr/bin/env node\na();\n'), '#!/usr/bin/env node\n\na();\n');
  assert.throws(
    () => shiftLines('#!/usr/bin/env node'),
    refuses('PACKED_CLI_MAP_CONTROL_HASHBANG'),
  );
  assert.equal(shiftColumns('a();\nb();\n'), ' a();\n b();\n ');
  assert.equal(shiftColumns('#!/usr/bin/env node\na();'), '#!/usr/bin/env node\n a();');
});

test('a value cut after its first continuation digit never ends', () => {
  const mappings = encodeMappings(sample());
  const cut = cutInsideValue(mappings);
  assert.ok(mappings.startsWith(cut));
  assert.match(cut.at(-1), /[g-z0-9+/]/u);
  assert.throws(
    () => decodeMappings(cut, COUNTS),
    (error) => error instanceof SourceMapError && error.code === 'MAPPINGS_TRUNCATED',
  );
  assert.throws(
    () => cutInsideValue('AAAA;CAAA'),
    refuses('PACKED_CLI_MAP_CONTROL_NO_CONTINUATION'),
  );
});
