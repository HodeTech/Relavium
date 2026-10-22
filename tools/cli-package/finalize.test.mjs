import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { BundleClosureError } from '../bundle-closure/closure.mjs';
import { CandidateFinalizationError, finalizeCandidate, mapTrailer } from './finalize.mjs';

// The exact esbuild behind the installed tsup and the installed TypeScript compiler produce real
// upstream and final maps from tiny fixtures; tsup's writer is reproduced exactly (trailer appended
// to the chunk code, map JSON re-serialized beside it). No product build runs here.
const cliRequire = createRequire(new URL('../../apps/cli/package.json', import.meta.url));
const { build } = createRequire(cliRequire.resolve('tsup/package.json'))('esbuild');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-candidate-finalizer-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
const posixModes = process.platform !== 'win32';
let count = 0;

function write(path, contents, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  if (mode !== undefined) chmodSync(path, mode);
}

/** Every file below a directory, with its bytes, for unchanged-state assertions. */
function snapshot(directory) {
  const result = {};
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    result[relative(directory, path).split(sep).join('/')] = readFileSync(path).toString('base64');
  }
  return result;
}

/**
 * A candidate repository whose CLI imports an engine package through its compiled JS, as the
 * product does, built with splitting so it has shared chunks and both kinds of code-splitting
 * facade: a statically and dynamically imported module (no inputs) and a pure re-export module
 * (a zero-byte input).
 */
async function fixture({ upstreamMapAtBundle = true, sourcesContent = false } = {}) {
  count += 1;
  const root = join(scratch, `repository-${count}`);
  const core = join(root, 'packages', 'core');
  const cli = join(root, 'apps', 'cli');
  write(
    join(core, 'src', 'index.ts'),
    "export * from './types.js';\nexport const greet = (name: string): string => `hello ${name}`;\n",
  );
  write(join(core, 'src', 'types.ts'), 'export interface Shape {\n  size: number;\n}\n');
  const program = ts.createProgram([join(core, 'src', 'index.ts'), join(core, 'src', 'types.ts')], {
    rootDir: join(core, 'src'),
    outDir: join(core, 'dist'),
    sourceMap: true,
    inlineSources: false,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    types: [],
  });
  assert.equal(program.emit().emitSkipped, false);
  const upstreamMap = join(core, 'dist', 'index.js.map');
  const upstreamMapBytes = readFileSync(upstreamMap);
  if (!upstreamMapAtBundle) rmSync(upstreamMap);
  write(join(root, 'packages', 'db', 'drizzle', '0000_init.sql'), 'create table t (id integer);\n');
  write(join(cli, 'drizzle', '0000_init.sql'), 'create table t (id integer);\n');
  write(
    join(cli, 'package.json'),
    JSON.stringify({ name: 'relavium', version: '0.0.0', type: 'module', dependencies: {} }),
  );
  write(
    join(cli, 'src', 'index.ts'),
    "#!/usr/bin/env node\nimport { greet } from '../../../packages/core/dist/index.js';\n" +
      "import { later } from './lazy.js';\nconsole.log(greet('cli'), later());\n" +
      "export const lazy = () => import('./lazy.js');\nexport const facade = () => import('./facade.js');\n",
  );
  write(
    join(cli, 'src', 'lazy.ts'),
    "import { greet } from '../../../packages/core/dist/index.js';\n" +
      "export const later = (): string => greet('lazy');\n",
  );
  write(
    join(cli, 'src', 'facade.ts'),
    "export { greet } from '../../../packages/core/dist/index.js';\n",
  );
  const built = await build({
    absWorkingDir: cli,
    entryPoints: { index: 'src/index.ts' },
    outdir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    bundle: true,
    splitting: true,
    minify: true,
    metafile: true,
    write: false,
    sourcemap: 'external',
    sourcesContent,
    logLevel: 'silent',
  });
  const emitted = {};
  for (const output of built.outputFiles) {
    const name = basename(output.path);
    if (name.endsWith('.map')) {
      write(join(cli, 'dist', name), JSON.stringify(JSON.parse(output.text)));
    } else {
      emitted[name] = output.text;
      write(
        join(cli, 'dist', name),
        output.text + mapTrailer(name),
        name === 'index.js' ? 0o755 : 0o644,
      );
    }
  }
  write(join(cli, 'dist', 'metafile-esm.json'), JSON.stringify(built.metafile));
  if (!upstreamMapAtBundle) writeFileSync(upstreamMap, upstreamMapBytes);
  const staging = join(scratch, `staging-${count}`);
  mkdirSync(staging);
  chmodSync(staging, 0o700);
  return { root, core, cli, dist: join(cli, 'dist'), staging, metafile: built.metafile, emitted };
}

/** Refuses with `code` before writing anything: the package and staging stay exactly as they were. */
function refusesBeforeWriting(candidate, code) {
  const before = snapshot(candidate.root);
  assert.throws(
    () => finalizeCandidate({ repository: candidate.root, staging: candidate.staging }),
    (error) => error instanceof CandidateFinalizationError && error.code === code,
  );
  assert.deepEqual(snapshot(candidate.root), before);
  assert.deepEqual(readdirSync(candidate.staging), []);
}

function editJson(path, change) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  change(value);
  writeFileSync(path, JSON.stringify(value));
}

/** Runtime outputs to which no input contributes a byte: code-splitting facades. */
function facadeNames(candidate) {
  return Object.entries(candidate.metafile.outputs)
    .filter(
      ([key, output]) =>
        !key.endsWith('.map') &&
        Object.values(output.inputs).every((contribution) => contribution.bytesInOutput === 0),
    )
    .map(([key]) => basename(key))
    .sort();
}

test('finalizes a chained candidate into private repository-relative maps and public JS only', async () => {
  const candidate = await fixture();
  const original = Object.fromEntries(
    readdirSync(candidate.dist)
      .filter((name) => name.endsWith('.map'))
      .map((name) => [name, JSON.parse(readFileSync(join(candidate.dist, name), 'utf8'))]),
  );
  const metafileBytes = readFileSync(join(candidate.dist, 'metafile-esm.json'));
  const record = finalizeCandidate({ repository: candidate.root, staging: candidate.staging });

  const names = Object.keys(candidate.emitted).sort();
  assert.ok(names.length >= 4, 'fixture has an entry, a shared chunk, a lazy chunk and a facade');
  assert.deepEqual(readdirSync(candidate.dist).sort(), names);
  for (const name of names) {
    // Only the terminal trailer is gone; every executable byte, line and column is unchanged.
    assert.equal(readFileSync(join(candidate.dist, name), 'utf8'), candidate.emitted[name]);
  }
  assert.deepEqual(readdirSync(candidate.staging).sort(), [
    'finalized.json',
    'maps',
    'metafile-esm.json',
  ]);
  assert.ok(readFileSync(join(candidate.staging, 'metafile-esm.json')).equals(metafileBytes));
  assert.deepEqual(
    readdirSync(join(candidate.staging, 'maps')).sort(),
    names.map((name) => `${name}.map`),
  );
  const sources = new Set();
  for (const name of names) {
    const map = JSON.parse(readFileSync(join(candidate.staging, 'maps', `${name}.map`), 'utf8'));
    assert.equal('sourcesContent' in map, false);
    assert.equal(map.mappings, original[`${name}.map`].mappings);
    assert.deepEqual(map.names, original[`${name}.map`].names);
    for (const source of map.sources) sources.add(source);
  }
  assert.deepEqual([...sources].sort(), [
    'apps/cli/src/index.ts',
    'apps/cli/src/lazy.ts',
    'packages/core/src/index.ts',
  ]);
  assert.equal(record.upstreamMaps, 2);
  assert.deepEqual(
    JSON.parse(readFileSync(join(candidate.staging, 'finalized.json'), 'utf8')),
    record,
  );
  for (const output of record.outputs) {
    const bytes = readFileSync(join(candidate.cli, output.path));
    assert.equal(output.bytes, bytes.length);
  }
  const facades = facadeNames(candidate);
  assert.equal(facades.length, 2, 'both facade kinds are exercised');
  const inputs = (name) => Object.keys(candidate.metafile.outputs[`dist/${name}`].inputs).length;
  assert.deepEqual(facades.map(inputs).sort(), [0, 1]);
  if (posixModes) {
    assert.equal(statSync(candidate.staging).mode & 0o777, 0o700);
    assert.equal(statSync(join(candidate.staging, 'maps')).mode & 0o777, 0o700);
    for (const name of readdirSync(join(candidate.staging, 'maps'))) {
      assert.equal(statSync(join(candidate.staging, 'maps', name)).mode & 0o777, 0o600);
    }
    for (const name of names) {
      assert.equal(
        statSync(join(candidate.dist, name)).mode & 0o777,
        name === 'index.js' ? 0o755 : 0o644,
      );
    }
  }
});

test('refuses a missing upstream map before the bundler can fall back to compiled JS', async () => {
  const candidate = await fixture();
  rmSync(join(candidate.core, 'dist', 'index.js.map'));
  refusesBeforeWriting(candidate, 'UPSTREAM_MAP_MISSING');
});

test('refuses a final map that the bundler silently chained to compiled JS', async () => {
  // Bundled while the upstream map was absent, then restored: only the final source set shows it.
  const candidate = await fixture({ upstreamMapAtBundle: false });
  refusesBeforeWriting(candidate, 'MAP_SOURCE_NOT_ORIGINAL');
});

for (const [label, change, code] of [
  ['embedded sources', (map) => (map.sourcesContent = ['x']), 'UPSTREAM_MAP_SHAPE'],
  ['a source root', (map) => (map.sourceRoot = 'src'), 'UPSTREAM_MAP_SHAPE'],
  ['another version', (map) => (map.version = 2), 'UPSTREAM_MAP_SHAPE'],
  ['another file', (map) => (map.file = 'other.js'), 'UPSTREAM_MAP_SHAPE'],
  ['no sources', (map) => (map.sources = []), 'UPSTREAM_MAP_SHAPE'],
  ['malformed mappings', (map) => (map.mappings = 'AAAA!'), 'UPSTREAM_MAP_SHAPE'],
  ['a non-string name', (map) => (map.names = [1]), 'UPSTREAM_MAP_SHAPE'],
  // Only a module whose types all erase (`export {};`, as types.js is) may map nothing.
  ['no mappings for executable code', (map) => (map.mappings = ''), 'UPSTREAM_MAP_UNMAPPED'],
  [
    'a URL source',
    (map) => (map.sources = ['https://example.invalid/index.ts']),
    'MAP_SOURCE_PATH',
  ],
  ['an absolute source', (map) => (map.sources = ['/index.ts']), 'MAP_SOURCE_PATH'],
  ['a backslash source', (map) => (map.sources = ['..\\src\\index.ts']), 'MAP_SOURCE_PATH'],
  [
    'an escaping source',
    (map) => (map.sources = ['../../../../outside.ts']),
    'MAP_SOURCE_NOT_ORIGINAL',
  ],
  [
    'another package',
    (map) => (map.sources = ['../../shared/src/index.ts']),
    'MAP_SOURCE_NOT_ORIGINAL',
  ],
  ['a declaration', (map) => (map.sources = ['../src/index.d.ts']), 'MAP_SOURCE_NOT_ORIGINAL'],
  ['compiled JS', (map) => (map.sources = ['index.js']), 'MAP_SOURCE_NOT_ORIGINAL'],
  [
    'a JS file under the source root',
    (map) => (map.sources = ['../src/index.js']),
    'MAP_SOURCE_NOT_ORIGINAL',
  ],
  ['a missing source', (map) => (map.sources = ['../src/missing.ts']), 'MAP_SOURCE_MISSING'],
  [
    'more sources than the bound',
    (map) => (map.sources = Array.from({ length: 4097 }, (_, i) => `../src/s${i}.ts`)),
    'UPSTREAM_MAP_SHAPE',
  ],
]) {
  test(`refuses an upstream map with ${label}`, async () => {
    const candidate = await fixture();
    editJson(join(candidate.core, 'dist', 'index.js.map'), change);
    refusesBeforeWriting(candidate, code);
  });
}

test('refuses an upstream map source that exists but is not a file', async () => {
  const candidate = await fixture();
  mkdirSync(join(candidate.core, 'src', 'dir.ts'));
  editJson(
    join(candidate.core, 'dist', 'index.js.map'),
    (map) => (map.sources = ['../src/dir.ts']),
  );
  refusesBeforeWriting(candidate, 'MAP_SOURCE_MISSING');
});

test('refuses an unparsable upstream map and an inexact upstream map link', async () => {
  const unparsable = await fixture();
  writeFileSync(join(unparsable.core, 'dist', 'index.js.map'), '{');
  refusesBeforeWriting(unparsable, 'MALFORMED_JSON');
  for (const change of [
    (js) => js.slice(0, -mapTrailer('index.js').length),
    (js) => `${js}\n`,
    (js) => js.replace(mapTrailer('index.js'), mapTrailer('other.js')),
    (js) => `// sourceMappingURL in a comment\n${js}`,
  ]) {
    const candidate = await fixture();
    const path = join(candidate.core, 'dist', 'index.js');
    writeFileSync(path, change(readFileSync(path, 'utf8')));
    refusesBeforeWriting(candidate, 'UPSTREAM_MAP_LINK');
  }
});

test('accepts empty upstream mappings only for exactly the JS tsc emits for erased types', async () => {
  // `export {};` followed by executable code is not a module whose types all erase.
  const candidate = await fixture();
  writeFileSync(
    join(candidate.core, 'dist', 'index.js'),
    `export {};\nconsole.log(1);\n${mapTrailer('index.js')}`,
  );
  editJson(join(candidate.core, 'dist', 'index.js.map'), (map) => (map.mappings = ''));
  refusesBeforeWriting(candidate, 'UPSTREAM_MAP_UNMAPPED');
});

test('refuses final maps that embed sources, lose coverage or carry unreviewed fields', async () => {
  refusesBeforeWriting(await fixture({ sourcesContent: true }), 'EMBEDDED_SOURCES');
  for (const [change, code] of [
    [(map) => map.sources.pop(), 'MAP_SOURCE_COVERAGE'],
    [(map) => map.sources.push('../src/lazy.ts'), 'MAP_SOURCE_COVERAGE'],
    [(map) => map.sources.push(map.sources[0]), 'MAP_SOURCE_DUPLICATE'],
    [(map) => (map.x_google_ignoreList = []), 'MAP_SHAPE'],
    [(map) => (map.sections = []), 'MAP_SHAPE'],
    [(map) => (map.sourceRoot = 'src'), 'MAP_SHAPE'],
    [(map) => (map.file = 'other.js'), 'MAP_SHAPE'],
    [(map) => (map.mappings = ''), 'MAP_SHAPE'],
    [(map) => (map.version = 2), 'MAP_SHAPE'],
    [(map) => (map.mappings = 'AAAA!'), 'MAP_SHAPE'],
    [(map) => (map.names = [1]), 'MAP_SHAPE'],
    [
      (map) => (map.sources = Array.from({ length: 4097 }, (_, i) => `../src/s${i}.ts`)),
      'MAP_SHAPE',
    ],
    [(map) => (map.names = Array.from({ length: 1_000_001 }, () => '')), 'MAP_SHAPE'],
    [(map) => (map.sources = ['https://example.invalid/a.ts']), 'MAP_SOURCE_PATH'],
  ]) {
    const candidate = await fixture();
    editJson(join(candidate.dist, 'index.js.map'), change);
    refusesBeforeWriting(candidate, code);
  }
  // A facade's map stays empty in every field: sources, mappings and names each refuse alone.
  for (const change of [
    (map) => (map.sources = ['../src/facade.ts']),
    (map) => (map.mappings = 'AAAA'),
    (map) => (map.names = ['x']),
  ]) {
    const candidate = await fixture();
    editJson(join(candidate.dist, `${facadeNames(candidate)[0]}.map`), change);
    refusesBeforeWriting(candidate, 'MAP_SHAPE');
  }
});

test('removes only the exact terminal trailer that tsup appended after esbuild sized the output', async () => {
  for (const change of [
    (js) => js.slice(0, -mapTrailer('index.js').length),
    (js) => `${js}\n`,
    (js) => js.replace(mapTrailer('index.js'), mapTrailer('chunk.js')),
    (js) => `${js}${mapTrailer('index.js')}`,
  ]) {
    const candidate = await fixture();
    const path = join(candidate.dist, 'index.js');
    writeFileSync(path, change(readFileSync(path, 'utf8')));
    refusesBeforeWriting(candidate, 'FINAL_MAP_LINK');
  }
  const candidate = await fixture();
  const path = join(candidate.dist, 'index.js');
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(mapTrailer('index.js'), `;${mapTrailer('index.js')}`),
  );
  refusesBeforeWriting(candidate, 'TRAILER_BYTES');
});

test('accounts for every emitted file and every consumed input', async () => {
  const extra = await fixture();
  writeFileSync(join(extra.dist, 'notes.txt'), 'x');
  refusesBeforeWriting(extra, 'OUTPUT_INVENTORY');
  const directory = await fixture();
  mkdirSync(join(directory.dist, 'nested'));
  refusesBeforeWriting(directory, 'OUTPUT_INVENTORY');
  const missing = await fixture();
  rmSync(join(missing.dist, 'index.js.map'));
  refusesBeforeWriting(missing, 'OUTPUT_INVENTORY');
  const unpaired = await fixture();
  editJson(join(unpaired.dist, 'metafile-esm.json'), (metafile) => {
    delete metafile.outputs['dist/index.js.map'];
  });
  refusesBeforeWriting(unpaired, 'MAP_PAIRING');
  const crowded = await fixture();
  editJson(join(crowded.dist, 'metafile-esm.json'), (metafile) => {
    for (let i = 0; i < 257; i += 1) {
      metafile.outputs[`dist/extra${i}.js`] = { imports: [], exports: [], inputs: {}, bytes: 1 };
    }
  });
  refusesBeforeWriting(crowded, 'OUTPUT_INVENTORY');
  const unsized = await fixture();
  editJson(join(unsized.dist, 'metafile-esm.json'), (metafile) => {
    const contribution = Object.values(metafile.outputs['dist/index.js'].inputs)[0];
    delete contribution.bytesInOutput;
  });
  refusesBeforeWriting(unsized, 'METAFILE_SHAPE');
  const foreign = await fixture();
  editJson(join(foreign.dist, 'metafile-esm.json'), (metafile) => {
    metafile.inputs['../../node_modules/left-pad/index.js'] = {
      bytes: 1,
      imports: [],
      format: 'esm',
    };
  });
  refusesBeforeWriting(foreign, 'UNSUPPORTED_INPUT');
  // Only the five inlined engine packages and the CLI's own TypeScript are supported inputs.
  for (const input of ['../../packages/ui/dist/x.js', 'src/types.d.ts']) {
    const unsupported = await fixture();
    editJson(join(unsupported.dist, 'metafile-esm.json'), (metafile) => {
      metafile.inputs[input] = { bytes: 1, imports: [], format: 'esm' };
    });
    refusesBeforeWriting(unsupported, 'UNSUPPORTED_INPUT');
  }
  if (posixModes) {
    const linked = await fixture();
    symlinkSync(join(linked.dist, 'index.js'), join(linked.dist, 'alias.js'));
    refusesBeforeWriting(linked, 'OUTPUT_INVENTORY');
    // A link standing in for an expected output has the right name but is not an ordinary file.
    const replaced = await fixture();
    const map = join(replaced.dist, 'index.js.map');
    writeFileSync(join(replaced.root, 'elsewhere.map'), readFileSync(map));
    rmSync(map);
    symlinkSync(join(replaced.root, 'elsewhere.map'), map);
    refusesBeforeWriting(replaced, 'OUTPUT_INVENTORY');
  }
});

test('refuses an orphan map entry and validates the upstream map of a zero-byte input', async () => {
  const orphan = await fixture();
  editJson(join(orphan.dist, 'metafile-esm.json'), (metafile) => {
    metafile.outputs['dist/orphan.js.map'] = { imports: [], exports: [], inputs: {}, bytes: 1 };
  });
  refusesBeforeWriting(orphan, 'MAP_PAIRING');
  // A runtime output whose own map entry was swapped for another keeps the entry count even.
  const swapped = await fixture();
  editJson(join(swapped.dist, 'metafile-esm.json'), (metafile) => {
    metafile.outputs['dist/orphan.js.map'] = metafile.outputs['dist/index.js.map'];
    delete metafile.outputs['dist/index.js.map'];
  });
  refusesBeforeWriting(swapped, 'MAP_PAIRING');
  // A runtime output must be a flat dist/<name>.js, even when its basename matches the inventory.
  const nested = await fixture();
  editJson(join(nested.dist, 'metafile-esm.json'), (metafile) => {
    const path = Object.keys(metafile.outputs).find(
      (key) => key.endsWith('.js') && key !== 'dist/index.js',
    );
    const moved = `dist/x/../${basename(path)}`;
    metafile.outputs[moved] = metafile.outputs[path];
    metafile.outputs[`${moved}.map`] = metafile.outputs[`${path}.map`];
    delete metafile.outputs[path];
    delete metafile.outputs[`${path}.map`];
  });
  refusesBeforeWriting(nested, 'OUTPUT_INVENTORY');
  // types.js contributes no byte to any output, yet its map is a consumed upstream map.
  const zero = await fixture();
  editJson(join(zero.core, 'dist', 'types.js.map'), (map) => (map.sourceRoot = 'src'));
  refusesBeforeWriting(zero, 'UPSTREAM_MAP_SHAPE');
});

test('a source root is a whole directory: a sibling that only shares its prefix is not original', async () => {
  // An upstream map naming packages/core/srcxx and a final map naming apps/cli/srcxx, both existing.
  const upstream = await fixture();
  write(join(upstream.core, 'srcxx', 'index.ts'), 'export const x = 1;\n');
  editJson(
    join(upstream.core, 'dist', 'index.js.map'),
    (map) => (map.sources = ['../srcxx/index.ts']),
  );
  refusesBeforeWriting(upstream, 'MAP_SOURCE_NOT_ORIGINAL');
  const final = await fixture();
  write(join(final.cli, 'srcxx', 'x.ts'), 'export const x = 1;\n');
  editJson(join(final.dist, 'index.js.map'), (map) => (map.sources = ['../srcxx/x.ts']));
  refusesBeforeWriting(final, 'MAP_SOURCE_NOT_ORIGINAL');
});

test('refuses a metafile without outputs or inputs', async () => {
  for (const field of ['outputs', 'inputs']) {
    const candidate = await fixture();
    editJson(join(candidate.dist, 'metafile-esm.json'), (metafile) => delete metafile[field]);
    refusesBeforeWriting(candidate, 'METAFILE_SHAPE');
  }
});

test('refuses a metafile, an upstream map or a final map over its byte bound', async () => {
  // Valid JSON padded past each bound, so only the bound refuses it.
  for (const [path, bound] of [
    [(candidate) => join(candidate.dist, 'metafile-esm.json'), 4 * 1024 * 1024],
    [(candidate) => join(candidate.core, 'dist', 'index.js.map'), 4 * 1024 * 1024],
    [(candidate) => join(candidate.dist, 'index.js.map'), 16 * 1024 * 1024],
  ]) {
    const candidate = await fixture();
    const file = path(candidate);
    writeFileSync(file, readFileSync(file, 'utf8') + ' '.repeat(bound));
    refusesBeforeWriting(candidate, 'UNREADABLE_FILE');
  }
});

test('requires an empty private staging directory outside the candidate', async (t) => {
  const candidate = await fixture();
  for (const [staging, code] of [
    ['relative-staging', 'STAGING_PATH'],
    [join(scratch, 'absent-staging'), 'STAGING_PATH'],
    [join(candidate.root, 'apps'), 'STAGING_PATH'],
    [scratch, 'STAGING_PATH'],
  ]) {
    assert.throws(
      () => finalizeCandidate({ repository: candidate.root, staging }),
      (error) => error instanceof CandidateFinalizationError && error.code === code,
    );
  }
  writeFileSync(join(candidate.staging, 'left-over'), 'x');
  refusesBeforeWritingIgnoringStaging(candidate, 'STAGING_NOT_EMPTY');
  rmSync(join(candidate.staging, 'left-over'));
  if (posixModes) {
    chmodSync(candidate.staging, 0o755);
    refusesBeforeWriting(candidate, 'STAGING_NOT_PRIVATE');
    chmodSync(candidate.staging, 0o700);
    // An owner-only directory another account owns refuses too, before anything is written.
    const realUid = process.getuid();
    const uid = t.mock.method(process, 'getuid', () => realUid + 1);
    try {
      refusesBeforeWriting(candidate, 'STAGING_NOT_PRIVATE');
    } finally {
      uid.mock.restore();
    }
    const link = join(scratch, `staging-link-${count}`);
    symlinkSync(candidate.staging, link);
    assert.throws(
      () => finalizeCandidate({ repository: candidate.root, staging: link }),
      (error) => error instanceof CandidateFinalizationError && error.code === 'STAGING_PATH',
    );
    // A real owner-only directory inside the candidate, named through a linked parent outside it.
    const inside = join(candidate.cli, 'private');
    mkdirSync(inside, { mode: 0o700 });
    chmodSync(inside, 0o700);
    const alias = join(scratch, `alias-parent-${count}`);
    symlinkSync(candidate.cli, alias);
    assert.throws(
      () => finalizeCandidate({ repository: candidate.root, staging: join(alias, 'private') }),
      (error) => error instanceof CandidateFinalizationError && error.code === 'STAGING_PATH',
    );
    // The same real directory refuses when the repository itself is named through a link.
    const aliasRoot = join(scratch, `alias-root-${count}`);
    symlinkSync(candidate.root, aliasRoot);
    assert.throws(
      () => finalizeCandidate({ repository: aliasRoot, staging: inside }),
      (error) => error instanceof CandidateFinalizationError && error.code === 'STAGING_PATH',
    );
    rmSync(inside, { recursive: true });
    // A child whose name merely starts with two dots is inside the candidate.
    const dotted = join(candidate.root, '..private');
    mkdirSync(dotted, { mode: 0o700 });
    chmodSync(dotted, 0o700);
    assert.throws(
      () => finalizeCandidate({ repository: candidate.root, staging: dotted }),
      (error) => error instanceof CandidateFinalizationError && error.code === 'STAGING_PATH',
    );
    rmSync(dotted, { recursive: true });
    // Staging must be named canonically even outside the candidate.
    const outside = join(scratch, `outside-staging-${count}`);
    mkdirSync(outside, { mode: 0o700 });
    chmodSync(outside, 0o700);
    const outsideAlias = join(scratch, `outside-alias-${count}`);
    symlinkSync(scratch, outsideAlias);
    assert.throws(
      () =>
        finalizeCandidate({
          repository: candidate.root,
          staging: join(outsideAlias, `outside-staging-${count}`),
        }),
      (error) => error instanceof CandidateFinalizationError && error.code === 'STAGING_PATH',
    );
  }
});

function refusesBeforeWritingIgnoringStaging(candidate, code) {
  const before = snapshot(candidate.root);
  assert.throws(
    () => finalizeCandidate({ repository: candidate.root, staging: candidate.staging }),
    (error) => error instanceof CandidateFinalizationError && error.code === code,
  );
  assert.deepEqual(snapshot(candidate.root), before);
}

test('re-checks the finite closure and the migration copy on the finalized files', async () => {
  if (posixModes) {
    const mode = await fixture();
    chmodSync(join(mode.dist, 'index.js'), 0o644);
    assert.throws(
      () => finalizeCandidate({ repository: mode.root, staging: mode.staging }),
      (error) => error instanceof BundleClosureError && error.code === 'OUTPUT_MODE',
    );
  }
  const migration = await fixture();
  writeFileSync(join(migration.cli, 'drizzle', '0000_init.sql'), 'drifted\n');
  assert.throws(
    () => finalizeCandidate({ repository: migration.root, staging: migration.staging }),
    (error) => error instanceof CandidateFinalizationError && error.code === 'MIGRATION_COPY',
  );
});

test('ordinary package and CLI builds stay map-free outside a named candidate', () => {
  const root = new URL('../../', import.meta.url);
  for (const name of ['shared', 'llm', 'core', 'db', 'mcp']) {
    const path = fileURLToPath(new URL(`packages/${name}/tsconfig.build.json`, root));
    const read = ts.readConfigFile(path, ts.sys.readFile);
    assert.equal(read.error, undefined);
    const { options } = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path));
    assert.equal(options.sourceMap, false, name);
    assert.equal(options.declarationMap, false, name);
    assert.notEqual(options.inlineSourceMap, true, name);
    assert.notEqual(options.inlineSources, true, name);
  }
  const config = readFileSync(new URL('apps/cli/tsup.config.ts', root), 'utf8');
  assert.match(
    config,
    /^const CANDIDATE = process\.env\.RELAVIUM_CLI_CANDIDATE_STAGING !== undefined;$/mu,
  );
  assert.deepEqual(config.match(/^\s*sourcemap:.*$/gmu), ['  sourcemap: CANDIDATE,']);
  assert.match(config, /if \(CANDIDATE\) options\.sourcesContent = false;/u);
});

test('keeps exact staged and public modes whatever the umask', { skip: !posixModes }, async () => {
  const candidate = await fixture();
  // A umask that removes the owner's write bit would leave every file read-only without exact modes.
  const previous = process.umask(0o277);
  try {
    finalizeCandidate({ repository: candidate.root, staging: candidate.staging });
  } finally {
    process.umask(previous);
  }
  assert.equal(statSync(join(candidate.staging, 'maps')).mode & 0o777, 0o700);
  for (const name of ['metafile-esm.json', 'finalized.json']) {
    assert.equal(statSync(join(candidate.staging, name)).mode & 0o777, 0o600, name);
  }
  for (const name of readdirSync(join(candidate.staging, 'maps'))) {
    assert.equal(statSync(join(candidate.staging, 'maps', name)).mode & 0o777, 0o600, name);
  }
  for (const name of Object.keys(candidate.emitted)) {
    assert.equal(
      statSync(join(candidate.dist, name)).mode & 0o777,
      name === 'index.js' ? 0o755 : 0o644,
      name,
    );
  }
});

test('compares staging and the candidate by the letter case the filesystem stores', async (t) => {
  const candidate = await fixture();
  const parent = dirname(candidate.root);
  const variant = join(parent, basename(candidate.root).toUpperCase());
  if (!existsSync(variant)) {
    t.skip('case-sensitive filesystem');
    return;
  }
  const inside = join(candidate.cli, 'private');
  mkdirSync(inside, { mode: 0o700 });
  chmodSync(inside, 0o700);
  // Another letter case of a path inside the candidate is not its canonical name.
  assert.throws(
    () =>
      finalizeCandidate({
        repository: candidate.root,
        staging: join(variant, 'apps', 'cli', 'private'),
      }),
    (error) => error instanceof CandidateFinalizationError && error.code === 'STAGING_PATH',
  );
  // Nor does another letter case of the repository hide the canonical staging inside it.
  assert.throws(
    () => finalizeCandidate({ repository: variant, staging: inside }),
    (error) => error instanceof CandidateFinalizationError && error.code === 'STAGING_PATH',
  );
});
