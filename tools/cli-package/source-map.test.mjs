import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { SourceMap, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  SourceMapError,
  assertGeneratedRange,
  assertOriginalRange,
  decodeMappings,
  lineLengths,
  segmentAt,
} from './source-map.mjs';

// The exact esbuild behind the installed tsup builds the fixtures; no product build runs here.
const cliRequire = createRequire(new URL('../../apps/cli/package.json', import.meta.url));
const { build } = createRequire(cliRequire.resolve('tsup/package.json'))('esbuild');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-source-map-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encode one signed value as base64 VLQ, as a source map writer does. */
function vlq(value) {
  let rest = value < 0 ? -value * 2 + 1 : value * 2;
  let out = '';
  do {
    let digit = rest % 32;
    rest = Math.floor(rest / 32);
    if (rest > 0) digit += 32;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
}

/** Encode absolute segments ([column] or [column, source, line, column, name?]) per line. */
function encode(lines) {
  let source = 0;
  let line = 0;
  let column = 0;
  let name = 0;
  return lines
    .map((segments) => {
      let generated = 0;
      return segments
        .map((segment) => {
          let out = vlq(segment[0] - generated);
          generated = segment[0];
          if (segment.length >= 4) {
            out += vlq(segment[1] - source) + vlq(segment[2] - line) + vlq(segment[3] - column);
            [source, line, column] = [segment[1], segment[2], segment[3]];
          }
          if (segment.length === 5) {
            out += vlq(segment[4] - name);
            name = segment[4];
          }
          return out;
        })
        .join(',');
    })
    .join(';');
}

const refuses = (code) => (error) => error instanceof SourceMapError && error.code === code;
const COUNTS = { sources: 2, names: 2 };

test('decodes every segment exactly as Node’s own source map does', () => {
  // A deterministic map with long lines, empty lines, unmapped and named segments and backward
  // original moves, decoded strictly and compared with node:module at every segment start.
  let seed = 7;
  const next = (bound) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % bound;
  };
  const lines = [];
  for (let line = 0; line < 40; line += 1) {
    const segments = [];
    let column = next(3);
    const count = next(30);
    for (let index = 0; index < count; index += 1) {
      column += 1 + next(5000);
      const kind = next(5);
      if (kind === 0) segments.push([column]);
      else if (kind === 1) segments.push([column, next(2), next(400), next(300)]);
      else segments.push([column, next(2), next(400), next(300), next(2)]);
    }
    lines.push(segments);
  }
  const map = { version: 3, sources: ['a.ts', 'b.ts'], names: ['x', 'y'], mappings: encode(lines) };
  const decoded = decodeMappings(map.mappings, COUNTS);
  const oracle = new SourceMap(map);
  let checked = 0;
  decoded.forEach((segments, line) => {
    assert.equal(segments.length, lines[line].length);
    segments.forEach((segment, index) => {
      const expected = lines[line][index];
      assert.equal(segment.generatedColumn, expected[0]);
      assert.equal(segmentAt(decoded, line, segment.generatedColumn), segment);
      if (expected.length === 1) {
        assert.equal(segment.source, undefined);
        return;
      }
      const entry = oracle.findEntry(line, segment.generatedColumn);
      assert.equal(entry.generatedLine, line);
      assert.equal(entry.generatedColumn, segment.generatedColumn);
      assert.equal(entry.originalSource, map.sources[segment.source]);
      assert.equal(entry.originalLine, segment.originalLine);
      assert.equal(entry.originalColumn, segment.originalColumn);
      assert.equal(entry.name, segment.name === undefined ? undefined : map.names[segment.name]);
      checked += 1;
    });
  });
  assert.ok(checked > 200, 'the fixture exercises many mapped segments');
});

test('maps a real esbuild frame below a hashbang and past astral characters to its original column', async () => {
  const source = [
    '#!/usr/bin/env node',
    "const label: string = '😀 ✓ — ü';",
    'const template = `one',
    '',
    'three`;',
    'export function fail(reason: string): never {',
    '  const note = reason;',
    "  void '😀😀'; throw new Error(note + label + template);",
    '}',
    "fail('x');",
    '',
  ].join('\n');
  writeFileSync(join(scratch, 'frame.ts'), source);
  const built = await build({
    absWorkingDir: scratch,
    entryPoints: ['frame.ts'],
    outdir: 'out',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    bundle: true,
    minify: true,
    sourcemap: 'external',
    sourcesContent: false,
    write: false,
    logLevel: 'silent',
  });
  const js = built.outputFiles.find((file) => file.path.endsWith('.js')).text;
  const map = JSON.parse(built.outputFiles.find((file) => file.path.endsWith('.map')).text);
  writeFileSync(join(scratch, 'frame.mjs'), js);
  const decoded = decodeMappings(map.mappings, {
    sources: map.sources.length,
    names: map.names.length,
  });
  // The hashbang stays on line 1 with no mapping, so code mappings start on line 2.
  assert.match(js, /^#!\/usr\/bin\/env node\n/u);
  assert.deepEqual(decoded[0], []);
  assertGeneratedRange(decoded, lineLengths(js));
  assertOriginalRange(decoded, [lineLengths(source)]);
  // Run it and read the throw site's 1-based line and column from V8's own structured call site.
  const run = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `Error.prepareStackTrace = (_, sites) => sites;
try { await import(${JSON.stringify(pathToFileURL(join(scratch, 'frame.mjs')).href)}); }
catch (error) { const site = error.stack.find((s) => s.getFileName()?.endsWith('frame.mjs'));
  process.stdout.write(JSON.stringify([site.getLineNumber(), site.getColumnNumber()])); }`,
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  assert.equal(run.status, 0, run.stderr);
  const [line, column] = JSON.parse(run.stdout);
  assert.ok(line >= 2);
  const segment = segmentAt(decoded, line - 1, column - 1);
  assert.ok(segment !== undefined, 'the throw site starts an exact segment');
  // `new` on source line 8, in UTF-16 code units: the two astral characters before it count twice.
  assert.deepEqual(
    [basename(map.sources[segment.source]), segment.originalLine + 1, segment.originalColumn + 1],
    ['frame.ts', 8, 22],
  );
  // One column off is no mapping at all, never the nearest preceding segment.
  assert.equal(segmentAt(decoded, line - 1, column), undefined);
});

test('accepts empty maps, empty lines and unmapped segments', () => {
  assert.deepEqual(decodeMappings('', COUNTS), [[]]);
  assert.deepEqual(decodeMappings(';;', COUNTS), [[], [], []]);
  assert.deepEqual(decodeMappings('A;C', COUNTS), [
    [{ generatedColumn: 0 }],
    [{ generatedColumn: 1 }],
  ]);
  assert.deepEqual(decodeMappings('AAAA,CCCCC;', COUNTS), [
    [
      { generatedColumn: 0, source: 0, originalLine: 0, originalColumn: 0 },
      { generatedColumn: 1, source: 1, originalLine: 1, originalColumn: 1, name: 1 },
    ],
    [],
  ]);
});

test('refuses every malformed mapping with its own code', () => {
  const largest = vlq(2 ** 31 - 1);
  assert.equal(decodeMappings(largest, COUNTS)[0][0].generatedColumn, 2 ** 31 - 1);
  for (const [mappings, code, counts = COUNTS] of [
    ['AAAA!', 'MAPPINGS_CHARACTER'],
    ['AAéA', 'MAPPINGS_CHARACTER'],
    ['A A', 'MAPPINGS_CHARACTER'],
    ['g', 'MAPPINGS_TRUNCATED'],
    ['AAAg', 'MAPPINGS_TRUNCATED'],
    ['AA', 'MAPPINGS_FIELDS'],
    ['AAA', 'MAPPINGS_FIELDS'],
    ['AAAAAA', 'MAPPINGS_FIELDS'],
    [',', 'MAPPINGS_EMPTY_SEGMENT'],
    ['A,', 'MAPPINGS_EMPTY_SEGMENT'],
    ['A,,A', 'MAPPINGS_EMPTY_SEGMENT'],
    ['A,;A', 'MAPPINGS_EMPTY_SEGMENT'],
    [';,A', 'MAPPINGS_EMPTY_SEGMENT'],
    ['D', 'MAPPINGS_RANGE'],
    ['ADAA', 'MAPPINGS_RANGE'],
    ['AEAA', 'MAPPINGS_RANGE'],
    ['AADA', 'MAPPINGS_RANGE'],
    ['AAAD', 'MAPPINGS_RANGE'],
    ['AAAAE', 'MAPPINGS_RANGE'],
    ['AAAAD', 'MAPPINGS_RANGE'],
    ['AAAA', 'MAPPINGS_RANGE', { sources: 0, names: 0 }],
    [vlq(2 ** 32), 'MAPPINGS_RANGE'],
    ['C,A', 'MAPPINGS_ORDER'],
    ['E,D', 'MAPPINGS_ORDER'],
  ]) {
    assert.throws(() => decodeMappings(mappings, counts), refuses(code), mappings);
  }
  assert.throws(() => decodeMappings(undefined, COUNTS), refuses('MAPPINGS_TYPE'));
  assert.throws(() => decodeMappings('!', COUNTS), {
    name: 'SourceMapError',
    code: 'MAPPINGS_CHARACTER',
    message: 'source map refused: MAPPINGS_CHARACTER',
  });
  // A refusal never quotes the mappings it read.
  assert.throws(
    () => decodeMappings('secretAAAA!', COUNTS),
    (error) => !error.message.includes('secret'),
  );
});

test('bounds every value at exactly 0xffffffff in at most seven digits, and only base64 decodes', () => {
  // The largest admitted value, 0xffffffff, is an original-line delta of -(2^31 - 1).
  const back = `AA${vlq(2 ** 31 - 1)}A,CA${vlq(-(2 ** 31 - 1))}A`;
  assert.equal(decodeMappings(back, COUNTS)[0][1].originalLine, 0);
  // Seven digits decode; zero-payload padding past them refuses rather than growing the scale to
  // Infinity, which would decode NaN and pass every later comparison.
  assert.equal(decodeMappings(`${'g'.repeat(6)}A`, COUNTS)[0][0].generatedColumn, 0);
  for (const [label, mappings, counts = COUNTS] of [
    ['one past the bound', vlq(2 ** 31)],
    ['eight digits', `${'g'.repeat(7)}A`],
    ['seven full digits and more', `${'/'.repeat(7)}${'g'.repeat(198)}A`],
    ['a padded generated column', `${'g'.repeat(205)}A`],
    ['a padded original column', `AAA${'g'.repeat(205)}A`],
    ['a padded name index', `AAAA${'g'.repeat(205)}A`, { sources: 1, names: 0 }],
  ]) {
    assert.throws(() => decodeMappings(mappings, counts), refuses('MAPPINGS_RANGE'), label);
  }
  // DEL and the first non-ASCII code unit are no digits.
  for (const code of [0x7f, 0x80]) {
    assert.throws(
      () => decodeMappings(String.fromCharCode(code), COUNTS),
      refuses('MAPPINGS_CHARACTER'),
    );
  }
  // A column behind the previous segment refuses even when it is ahead of the line's first.
  assert.throws(() => decodeMappings('A,K,F', COUNTS), refuses('MAPPINGS_ORDER'));
});

test('finds only the segment that starts exactly at a position', () => {
  const lines = decodeMappings('A,EAAE,KAEC;;GAAA', COUNTS);
  assert.equal(segmentAt(lines, 0, 0).generatedColumn, 0);
  assert.equal(segmentAt(lines, 0, 2).originalColumn, 2);
  assert.equal(segmentAt(lines, 0, 7).originalLine, 2);
  for (const [line, column] of [
    [0, 1],
    [0, 3],
    [0, 8],
    [1, 0],
    [2, 0],
    [2, 2],
    [3, 0],
    [-1, 0],
  ]) {
    assert.equal(segmentAt(lines, line, column), undefined, `${line}:${column}`);
  }
  // A line's only segment is found exactly.
  assert.equal(segmentAt(decodeMappings('A;;GAAA', COUNTS), 2, 3).generatedColumn, 3);
});

test('counts lines and UTF-16 columns as V8 and TypeScript do', () => {
  assert.deepEqual(lineLengths('ab\ncd\r\nefg\rh 😀 '), [2, 2, 3, 1, 2, 0]);
  assert.deepEqual(lineLengths(''), [0]);
  // U+2028 and U+2029 end a line; NEL (U+0085) does not.
  const [nel, ls, ps] = [0x85, 0x2028, 0x2029].map((code) => String.fromCharCode(code));
  assert.deepEqual(lineLengths(`a${ls}b${ps}c`), [1, 1, 1]);
  assert.deepEqual(lineLengths(`a${nel}b`), [3]);
});

test('requires generated and original positions inside their texts', () => {
  const lines = decodeMappings('A,EAAE;CACA', COUNTS);
  assertGeneratedRange(lines, [2, 1]);
  assert.throws(() => assertGeneratedRange(lines, [1, 1]), refuses('GENERATED_RANGE'));
  assert.throws(() => assertGeneratedRange(lines, [2]), refuses('GENERATED_RANGE'));
  // Original positions (0, 2) and (1, 2) of source 0; a column at a line's end is a caret position.
  assertOriginalRange(lines, [[2, 2], []]);
  assert.throws(() => assertOriginalRange(lines, [[2, 1], []]), refuses('ORIGINAL_RANGE'));
  assert.throws(() => assertOriginalRange(lines, [[1, 2], []]), refuses('ORIGINAL_RANGE'));
  assert.throws(() => assertOriginalRange(lines, [[2], []]), refuses('ORIGINAL_RANGE'));
  assert.throws(() => assertOriginalRange(lines, [[], []]), refuses('ORIGINAL_RANGE'));
  // Unmapped segments name no source and pass.
  assertOriginalRange(decodeMappings('A,C', COUNTS), []);
  // Each original position is checked against its own source's lines, and a source with none
  // refuses.
  assertOriginalRange(decodeMappings('ACAA,CAAE', COUNTS), [[], [2]]);
  assert.throws(
    () => assertOriginalRange(decodeMappings('ACAE', COUNTS), [[5], [1]]),
    refuses('ORIGINAL_RANGE'),
  );
  assert.throws(
    () => assertOriginalRange(decodeMappings('AAAA', COUNTS), []),
    refuses('ORIGINAL_RANGE'),
  );
});
