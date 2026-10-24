import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FIXED_CONTROLS,
  cutInsideValue,
  encodeMappings,
  report,
  rotateSources,
  shiftColumns,
  shiftLines,
  shiftOriginalColumns,
  verdict,
} from './map-controls-core.mjs';
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

/** A passing run's results: every fixed control and four for each of `chunks` anchor-bearing chunks. */
function passing(chunks) {
  const ids = [
    ...FIXED_CONTROLS,
    ...Array.from({ length: chunks }, (_, index) =>
      ['js-line', 'js-column', 'map-line', 'sources-rotated'].map((kind) => `${kind}-${index + 1}`),
    ).flat(),
  ];
  return ids.map((id) => ({ id, expected: 'CODE', observed: 'CODE' }));
}

test('the verdict passes only a complete run whose every control had its expected outcome', () => {
  assert.equal(verdict({ results: passing(2), chunks: 2 }).passed, true);
  assert.equal(verdict({ results: passing(2), chunks: 2 }).expected, FIXED_CONTROLS.length + 8);
  // No anchor-bearing chunk.
  assert.equal(verdict({ results: passing(0), chunks: 0 }).passed, false);
  // A control that did not run, here a fixed one and a per-chunk one.
  for (const id of ['dist-plain-chunk', 'sources-rotated-2']) {
    const judged = verdict({ results: passing(2).filter((result) => result.id !== id), chunks: 2 });
    assert.deepEqual([judged.passed, judged.missing], [false, [id]]);
  }
  // A control that ran twice, or one that is not expected.
  const twice = verdict({
    results: [...passing(1), { id: 'restoration', expected: 'A', observed: 'A' }],
    chunks: 1,
  });
  assert.deepEqual([twice.passed, twice.unexpected], [false, ['restoration']]);
  const stray = verdict({
    results: [...passing(1), { id: 'js-line-2', expected: 'A', observed: 'A' }],
    chunks: 1,
  });
  assert.deepEqual([stray.passed, stray.unexpected], [false, ['js-line-2']]);
  // An observed outcome other than the expected one.
  const results = passing(1);
  results[3] = { ...results[3], observed: 'OTHER' };
  const failed = verdict({ results, chunks: 1 });
  assert.deepEqual([failed.passed, failed.failed], [false, [results[3].id]]);
});

test('the report prints one summary and returns 0 only for a passing run', () => {
  const run = (outcome) => {
    const written = [];
    const warned = [];
    const code = report(outcome, {
      seconds: 3,
      write: (line) => written.push(line),
      warn: (line) => warned.push(line),
    });
    return { code, written, warned };
  };
  const passed = run({ source: 'a'.repeat(40), dirty: false, results: passing(1), chunks: 1 });
  assert.deepEqual([passed.code, passed.warned], [0, []]);
  assert.equal(passed.written.length, 1);
  const summary = JSON.parse(passed.written[0]);
  assert.deepEqual(
    [summary.failed, summary.missing, summary.unexpected, summary.chunks],
    [[], [], [], 1],
  );
  const results = passing(1).filter((result) => result.id !== 'seal-verify');
  results[0] = { ...results[0], observed: 'OTHER' };
  const failed = run({ source: 'a'.repeat(40), dirty: false, results, chunks: 1 });
  assert.equal(failed.code, 1);
  assert.deepEqual(failed.warned, [
    `✗ CLI product map controls failed: ${results[0].id}, seal-verify (missing)`,
  ]);
  const empty = run({ source: 'a'.repeat(40), dirty: false, results: [], chunks: 0 });
  assert.equal(empty.code, 1);
  assert.equal(empty.warned.length, 1);
});

test('the required control set is exactly the seventeen the contract names', () => {
  assert.deepEqual(
    [...FIXED_CONTROLS],
    [
      'second-prepack',
      're-seal-receipt',
      're-seal-staging',
      're-recorded-baseline',
      'source-clean',
      'source-dirty',
      'sealed-dist',
      'dist-plain-chunk',
      'dist-rebuilt',
      'upstream-missing',
      'upstream-shape',
      'upstream-index',
      'upstream-cut-bytes',
      'upstream-cut-value',
      'upstream-shifted',
      'seal-verify',
      'restoration',
    ],
  );
  assert.equal(Object.isFrozen(FIXED_CONTROLS), true);
});

test('the entry point exits with the verdict and prints only fixed lines when the run fails', () => {
  // The real entry point beside a stand-in core whose run returns or throws as each case needs; the
  // report itself is the real one.
  const here = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'relavium-map-controls-entry-'));
  try {
    copyFileSync(here('map-controls.mjs'), join(directory, 'map-controls.mjs'));
    copyFileSync(here('production-failure.mjs'), join(directory, 'production-failure.mjs'));
    const outcome = (results) => ({ source: 'a'.repeat(40), dirty: false, results, chunks: 1 });
    const broken = passing(1);
    broken[0] = { ...broken[0], observed: 'OTHER' };
    for (const [label, body, status, stderr] of [
      ['a passing run', `return ${JSON.stringify(outcome(passing(1)))};`, 0, /^$/u],
      [
        'a failed control',
        `return ${JSON.stringify(outcome(broken))};`,
        1,
        /^✗ CLI product map controls failed: second-prepack\n$/u,
      ],
      [
        'a missing control',
        `return ${JSON.stringify(outcome(passing(1).slice(1)))};`,
        1,
        /^✗ CLI product map controls failed: second-prepack \(missing\)\n$/u,
      ],
      [
        'a run that throws',
        "throw new Error('PACKED_CLI_MAP_CONTROL_ORIGIN at /private/host/path');",
        1,
        /^✗ CLI package production failed: PACKED_CLI_MAP_CONTROL_ORIGIN\n$/u,
      ],
    ]) {
      writeFileSync(
        join(directory, 'map-controls-core.mjs'),
        `export { report } from ${JSON.stringify(pathToFileURL(here('map-controls-core.mjs')).href)};\n` +
          `export async function runMapControls() {\n  ${body}\n}\n`,
      );
      const run = spawnSync(process.execPath, [join(directory, 'map-controls.mjs')], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(run.status, status, label);
      assert.match(run.stderr, stderr, label);
      // A completed run prints one summary line; a run that throws prints none.
      assert.equal(
        run.stdout.split('\n').filter(Boolean).length,
        label === 'a run that throws' ? 0 : 1,
        label,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
