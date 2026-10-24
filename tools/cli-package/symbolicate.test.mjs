import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { dirname, join, posix } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MANIFEST_INPUTS, ManifestError, sealPrivateManifest } from './manifest.mjs';
import { mapTrailer } from './finalize.mjs';
import {
  ANCHORS,
  SymbolicationError,
  anchorPosition,
  captureFrames,
  readSourceRevision,
  symbolicateCandidate,
} from './symbolicate.mjs';

// A synthetic candidate whose TypeScript sits at the anchors' real repository paths, with the same
// function names, bundled by the exact esbuild behind the installed tsup with splitting and minify
// as the CLI build does. It runs under the real preload, so capture, maps and anchors are all real.
const cliRequire = createRequire(new URL('../../apps/cli/package.json', import.meta.url));
const { build } = createRequire(cliRequire.resolve('tsup/package.json'))('esbuild');
const ts = cliRequire('typescript');
const cliModules = fileURLToPath(new URL('../../apps/cli/node_modules', import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-symbolicate-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const posixModes = process.platform !== 'win32';
let count = 0;

const SOURCES = {
  'packages/core/src/yaml-decode.ts': [
    "import { parse as parseYaml } from 'yaml';",
    '',
    'export function decodeHardenedYaml(text: string): unknown {',
    "  return parseYaml(text, { version: '1.2' });",
    '}',
    '',
  ],
  'packages/core/src/parser.ts': [
    "import { decodeHardenedYaml } from './yaml-decode.js';",
    '',
    'export function parseWorkflow(text: string): { id: string } {',
    '  const raw = decodeHardenedYaml(text) as { workflow: { id: string } };',
    '  return { id: raw.workflow.id };',
    '}',
    '',
  ],
  'apps/cli/src/authoring/authoring.ts': [
    "import { parseWorkflow } from '../../../../packages/core/src/parser.js';",
    '',
    'export function detectAndParse(text: string, fileName: string): { id: string } {',
    "  if (fileName.endsWith('.relavium.yaml')) {",
    '    return parseAsWorkflow(text);',
    '  }',
    "  throw new Error('unsupported');",
    '}',
    '',
    'function parseAsWorkflow(text: string): { id: string } {',
    '  return parseWorkflow(text);',
    '}',
    '',
  ],
  'apps/cli/src/commands/import.ts': [
    "import { readFileSync } from 'node:fs';",
    "import { basename } from 'node:path';",
    "import { detectAndParse } from '../authoring/authoring.js';",
    '',
    'export function importCommand(path: string): string {',
    "  const text = readFileSync(path, 'utf8');",
    '  return detectAndParse(text, basename(path)).id;',
    '}',
    '',
  ],
  'apps/cli/src/index.ts': [
    '#!/usr/bin/env node',
    "import { Entry } from '@napi-rs/keyring';",
    'try {',
    "  new Entry('relavium', 'probe');",
    '} catch {',
    '  // The preload replaces the keyring binding with one that refuses.',
    '}',
    'const [command, path] = process.argv.slice(2);',
    "if (command === 'import' && path !== undefined) {",
    "  const { importCommand } = await import('./commands/import.js');",
    '  importCommand(path);',
    '}',
    '',
  ],
};

/** Write `path` (repository-relative) under `root`. */
function put(root, path, bytes) {
  mkdirSync(dirname(join(root, ...path.split('/'))), { recursive: true });
  writeFileSync(join(root, ...path.split('/')), bytes);
}

/**
 * A finalized synthetic candidate: its finalized dist without trailers, its staged maps with
 * repository-relative sources, the finalizer's record, the manifest inputs and the CLI installation.
 */
async function candidate({ sources = SOURCES } = {}) {
  count += 1;
  const root = join(scratch, `candidate-${count}`);
  const staging = join(scratch, `staging-${count}`);
  const work = join(scratch, `work-${count}`);
  for (const directory of [staging, work]) {
    mkdirSync(directory);
    chmodSync(directory, 0o700);
  }
  mkdirSync(join(staging, 'maps'));
  for (const [path, lines] of Object.entries(sources)) put(root, path, lines.join('\n'));
  for (const path of MANIFEST_INPUTS) {
    put(
      root,
      path,
      path.endsWith('.json') ? `${JSON.stringify({ synthetic: path })}\n` : `# ${path}\n`,
    );
  }
  put(root, 'apps/cli/tsup.config.ts', "export default {\n  target: 'node22',\n};\n");
  put(root, 'apps/cli/package.json', JSON.stringify({ name: 'relavium', type: 'module' }));
  symlinkSync(cliModules, join(root, 'apps', 'cli', 'node_modules'), 'junction');
  const cli = join(root, 'apps', 'cli');
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
    sourcemap: 'external',
    sourcesContent: false,
    external: ['yaml', '@napi-rs/keyring'],
    write: false,
    logLevel: 'silent',
  });
  const outputs = [];
  const maps = [];
  for (const file of built.outputFiles) {
    const name = posix.basename(file.path.split('\\').join('/'));
    if (name.endsWith('.map')) {
      const map = JSON.parse(file.text);
      map.sources = map.sources.map((source) =>
        posix.normalize(posix.join('apps/cli/dist', source)),
      );
      const bytes = Buffer.from(JSON.stringify(map));
      writeFileSync(join(staging, 'maps', name), bytes);
      maps.push({ path: `dist/${name}`, bytes: bytes.length, sha256: digest(bytes) });
    } else {
      // An external map leaves no link in the code: this is already the finalized JS.
      const code = file.text;
      assert.equal(code.includes(mapTrailer(name)), false);
      put(cli, `dist/${name}`, code);
      const bytes = Buffer.from(code);
      outputs.push({ path: `dist/${name}`, bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  writeFileSync(
    join(staging, 'finalized.json'),
    JSON.stringify({ version: 1, outputs, maps, upstreamMaps: 0 }),
  );
  const archive = {
    sha256: 'a'.repeat(64),
    package: { version: '0.1.1' },
    files: outputs.map((output) => ({ path: `package/${output.path}`, sha256: output.sha256 })),
  };
  return { root, cli, staging, work, archive, outputs };
}

const TREE = 'b'.repeat(40);
const COMMIT = 'c'.repeat(40);
/** Git as the manifest asks it: the commit's tree. */
const git = async (command, args) => {
  assert.equal(command, 'git');
  assert.deepEqual(args, ['--no-replace-objects', 'rev-parse', '--verify', `${COMMIT}^{tree}`]);
  return { stdout: `${TREE}\n`, stderr: '' };
};

/** Seal the manifest of a dirty local candidate, whose source revision is its own copy. */
async function seal(fixture) {
  return sealPrivateManifest({
    candidate: fixture.root,
    staging: fixture.staging,
    checkout: fixture.root,
    source: COMMIT,
    dirty: true,
    archive: fixture.archive,
    run: git,
  });
}

/** Re-record the finalized digests after a deliberate change, then seal a fresh manifest. */
async function reseal(fixture) {
  const outputs = readdirSync(join(fixture.cli, 'dist')).map((name) => {
    const bytes = readFileSync(join(fixture.cli, 'dist', name));
    return { path: `dist/${name}`, bytes: bytes.length, sha256: digest(bytes) };
  });
  const maps = readdirSync(join(fixture.staging, 'maps')).map((name) => {
    const bytes = readFileSync(join(fixture.staging, 'maps', name));
    return { path: `dist/${name}`, bytes: bytes.length, sha256: digest(bytes) };
  });
  rmSync(join(fixture.staging, 'finalized.json'));
  rmSync(join(fixture.staging, 'manifest.json'), { force: true });
  writeFileSync(
    join(fixture.staging, 'finalized.json'),
    JSON.stringify({ version: 1, outputs, maps, upstreamMaps: 0 }),
  );
  fixture.archive.files = outputs.map((output) => ({
    path: `package/${output.path}`,
    sha256: output.sha256,
  }));
  return seal(fixture);
}

function symbolicate(fixture, options = {}) {
  return symbolicateCandidate({
    candidate: fixture.root,
    staging: fixture.staging,
    checkout: fixture.root,
    work: fixture.work,
    archive: fixture.archive,
    ...options,
  });
}

const refuses = (code) => (error) => error instanceof SymbolicationError && error.code === code;

/** The finalized chunk that holds the core call sites. */
function coreChunk(fixture) {
  return readdirSync(join(fixture.cli, 'dist')).find((name) =>
    JSON.parse(readFileSync(join(fixture.staging, 'maps', `${name}.map`), 'utf8')).sources.includes(
      'packages/core/src/parser.ts',
    ),
  );
}

test('the manifest binds the commit, toolchain, inputs, finalized pairs, sources and tarball', async () => {
  const fixture = await candidate();
  const manifest = await seal(fixture);
  assert.deepEqual(manifest.source, { commit: COMMIT, tree: TREE, dirty: true });
  assert.equal(manifest.packageVersion, '0.1.1');
  assert.equal(manifest.target, 'node22');
  assert.equal(manifest.tarballSha256, 'a'.repeat(64));
  assert.equal(manifest.toolchain.node, process.version);
  assert.equal(manifest.toolchain.typescript, ts.version);
  assert.deepEqual(Object.keys(manifest.inputs), [...MANIFEST_INPUTS]);
  assert.equal(
    manifest.inputs['apps/cli/tsup.config.ts'],
    digest(readFileSync(join(fixture.cli, 'tsup.config.ts'))),
  );
  assert.deepEqual(
    manifest.outputs.map((output) => output.path),
    fixture.outputs.map((output) => output.path).sort(),
  );
  for (const output of manifest.outputs) {
    assert.equal(output.sha256, digest(readFileSync(join(fixture.cli, output.path))));
    assert.deepEqual(output.map, {
      path: `${output.path}.map`,
      sha256: digest(
        readFileSync(join(fixture.staging, 'maps', `${posix.basename(output.path)}.map`)),
      ),
    });
  }
  assert.deepEqual(Object.keys(manifest.sources), Object.keys(SOURCES).sort());
  for (const [path, value] of Object.entries(manifest.sources)) {
    assert.equal(value, digest(readFileSync(join(fixture.root, ...path.split('/')))));
  }
  // Written once, owner-only, and holding no absolute path.
  const text = readFileSync(join(fixture.staging, 'manifest.json'), 'utf8');
  assert.deepEqual(JSON.parse(text), manifest);
  assert.equal(text.includes(scratch), false);
  if (posixModes) {
    assert.equal(statSync(join(fixture.staging, 'manifest.json')).mode & 0o777, 0o600);
  }
  await assert.rejects(seal(fixture), (error) => error.code === 'EEXIST');
});

test('the manifest refuses drifted maps and tarball entries and a missing tree', async () => {
  for (const [label, change, code] of [
    [
      'a staged map changed after the finalizer recorded it',
      (fixture) =>
        writeFileSync(join(fixture.staging, 'maps', `${coreChunk(fixture)}.map`), '{"sources":[]}'),
      'MAP_DRIFT',
    ],
    [
      'a tarball entry that is not the finalized JS',
      (fixture) => (fixture.archive.files[0].sha256 = 'd'.repeat(64)),
      'TARBALL_DRIFT',
    ],
    [
      'an output without its map in the record',
      (fixture) => {
        const record = JSON.parse(readFileSync(join(fixture.staging, 'finalized.json'), 'utf8'));
        record.maps.pop();
        writeFileSync(join(fixture.staging, 'finalized.json'), JSON.stringify(record));
      },
      'RECORD',
    ],
    [
      'a build configuration without its target',
      (fixture) => writeFileSync(join(fixture.cli, 'tsup.config.ts'), 'export default {};\n'),
      'TARGET',
    ],
    [
      'a missing manifest input',
      (fixture) => rmSync(join(fixture.root, 'pnpm-lock.yaml')),
      'UNREADABLE_INPUT',
    ],
  ]) {
    const fixture = await candidate();
    change(fixture);
    await assert.rejects(
      seal(fixture),
      (error) => error instanceof ManifestError && error.code === code,
      label,
    );
    assert.equal(existsSync(join(fixture.staging, 'manifest.json')), false, label);
  }
  const fixture = await candidate();
  await assert.rejects(
    sealPrivateManifest({
      candidate: fixture.root,
      staging: fixture.staging,
      checkout: fixture.root,
      source: COMMIT,
      dirty: false,
      archive: fixture.archive,
      run: async () => ({ stdout: 'not a tree\n', stderr: '' }),
    }),
    (error) => error instanceof ManifestError && error.code === 'SOURCE_TREE',
  );
});

test('actual packed frames reach every anchor through the real preload and exact segments', async () => {
  const fixture = await candidate();
  await seal(fixture);
  let frames;
  const result = await symbolicate(fixture, {
    capture: async (options) => (frames = await captureFrames(options)),
  });
  assert.deepEqual(result, { anchors: ANCHORS.length });
  // One stack crossed the entry, a lazy chunk and the inlined core.
  const files = new Set(
    frames
      .filter((frame) => frame.file?.includes('/dist/') || frame.file?.includes('\\dist\\'))
      .map((frame) => frame.file),
  );
  assert.ok(files.size >= 2, 'the stack crosses more than one finalized chunk');
  // The run kept its files in the private work directory.
  assert.equal(existsSync(join(fixture.work, 'frames.json')), true);
  assert.equal(existsSync(join(fixture.root, '.relavium')), false);
});

test('the expected positions come from the source revision, independently of any map', () => {
  for (const anchor of ANCHORS) {
    const text = SOURCES[anchor.source].join('\n');
    const position = anchorPosition(ts, text, anchor);
    const line = text.split('\n')[position.line - 1];
    assert.equal(line.slice(position.column - 1).startsWith(anchor.call), true, anchor.call);
  }
  // A member call is positioned at its property name; a second call or owner is ambiguous.
  assert.deepEqual(
    anchorPosition(ts, 'function f() {\n  yaml.parse(x);\n}\n', {
      source: 'a.ts',
      within: 'f',
      call: 'parse',
    }),
    { line: 2, column: 8 },
  );
  for (const text of [
    'function f() { g(); g(); }',
    'function f() { h(); }',
    'function f() { g(); }\nfunction f() { g(); }',
  ]) {
    assert.throws(
      () => anchorPosition(ts, text, { source: 'a.ts', within: 'f', call: 'g' }),
      refuses('ANCHOR_SOURCE'),
      text,
    );
  }
});

test('wrong JS, a wrong map, permuted sources and a wrong source revision cannot reach the anchors', async () => {
  // Every digest is re-recorded after each change, so only the mapping layer can refuse it.
  for (const [label, change] of [
    [
      'JS shifted by one column',
      (fixture) => {
        const path = join(fixture.cli, 'dist', coreChunk(fixture));
        writeFileSync(path, readFileSync(path, 'utf8').replace(/^/gmu, ' '));
      },
    ],
    [
      'JS shifted by one line',
      (fixture) => {
        const path = join(fixture.cli, 'dist', coreChunk(fixture));
        writeFileSync(path, `\n${readFileSync(path, 'utf8')}`);
      },
    ],
    [
      'a map from a build one line apart',
      (fixture) => {
        const path = join(fixture.staging, 'maps', `${coreChunk(fixture)}.map`);
        const map = JSON.parse(readFileSync(path, 'utf8'));
        map.mappings = `;${map.mappings}`;
        writeFileSync(path, JSON.stringify(map));
      },
    ],
    [
      'a map whose sources are permuted',
      (fixture) => {
        const path = join(fixture.staging, 'maps', `${coreChunk(fixture)}.map`);
        const map = JSON.parse(readFileSync(path, 'utf8'));
        map.sources.reverse();
        writeFileSync(path, JSON.stringify(map));
      },
    ],
    [
      'a source revision with one more line',
      (fixture) => {
        const path = join(fixture.root, 'packages', 'core', 'src', 'parser.ts');
        writeFileSync(path, `// shifted\n${readFileSync(path, 'utf8')}`);
      },
    ],
  ]) {
    const fixture = await candidate();
    change(fixture);
    await reseal(fixture);
    await assert.rejects(symbolicate(fixture), refuses('ANCHOR_UNMAPPED'), label);
  }
  // Another chunk's map names other sources, so the resealed manifest no longer covers the anchors.
  const fixture = await candidate();
  const core = `${coreChunk(fixture)}.map`;
  writeFileSync(
    join(fixture.staging, 'maps', core),
    readFileSync(join(fixture.staging, 'maps', 'index.js.map')),
  );
  await reseal(fixture);
  await assert.rejects(symbolicate(fixture), refuses('SOURCE_REVISION'));
});

test('files that are not the manifest’s refuse by their digest', async () => {
  for (const [label, change, code] of [
    [
      'finalized JS changed after the manifest',
      (fixture) => {
        const path = join(fixture.cli, 'dist', coreChunk(fixture));
        writeFileSync(path, `${readFileSync(path, 'utf8')} `);
      },
      'FRAME_FILE',
    ],
    [
      'a staged map changed after the manifest',
      (fixture) => {
        const path = join(fixture.staging, 'maps', `${coreChunk(fixture)}.map`);
        writeFileSync(path, `${readFileSync(path, 'utf8')} `);
      },
      'MAP_DIGEST',
    ],
    [
      'a source changed after the manifest',
      (fixture) => {
        const path = join(fixture.root, 'apps', 'cli', 'src', 'commands', 'import.ts');
        writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
      },
      'SOURCE_REVISION',
    ],
    [
      'a tarball entry that is not the run file',
      (fixture) => {
        const key = `package/dist/${coreChunk(fixture)}`;
        fixture.archive.files.find((file) => file.path === key).sha256 = 'e'.repeat(64);
      },
      'FRAME_FILE',
    ],
  ]) {
    const fixture = await candidate();
    await seal(fixture);
    change(fixture);
    await assert.rejects(symbolicate(fixture), refuses(code), label);
  }
  const fixture = await candidate();
  await assert.rejects(symbolicate(fixture), (error) => error instanceof ManifestError);
  await seal(fixture);
  await assert.rejects(symbolicate(fixture, { anchors: [] }), refuses('ANCHORS'));
});

test('a clean candidate reads its source revision from the checkout’s Git objects', async () => {
  const checkout = join(scratch, 'checkout');
  mkdirSync(checkout);
  const gitRun = (args) => {
    const run = spawnSync('git', args, {
      cwd: checkout,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: checkout, GIT_CONFIG_NOSYSTEM: '1' },
    });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  gitRun(['init', '--quiet']);
  const path = 'apps/cli/src/commands/import.ts';
  put(checkout, path, SOURCES[path].join('\n'));
  gitRun(['add', '.']);
  gitRun([
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'x',
  ]);
  const commit = gitRun(['rev-parse', 'HEAD']);
  const text = SOURCES[path].join('\n');
  const manifest = { source: { commit, dirty: false }, sources: { [path]: digest(text) } };
  const texts = await readSourceRevision({
    candidate: join(scratch, 'no-candidate'),
    checkout,
    manifest,
    paths: [path],
  });
  assert.equal(texts.get(path), text);
  // A commit whose blob is not the built source refuses; so does a path outside the manifest.
  await assert.rejects(
    readSourceRevision({
      candidate: checkout,
      checkout,
      manifest: { ...manifest, sources: { [path]: digest(`${text}\n`) } },
      paths: [path],
    }),
    refuses('SOURCE_REVISION'),
  );
  await assert.rejects(
    readSourceRevision({ candidate: checkout, checkout, manifest, paths: ['apps/cli/src/x.ts'] }),
    refuses('SOURCE_REVISION'),
  );
});

test('the capture refuses a run that fails, never parses the canary or parses it twice', async () => {
  for (const [label, entry, code] of [
    ['a failed run', 'process.exit(3);', 'CAPTURE_FAILED'],
    ['no canary parse', "import('yaml').then((y) => y.parse('a: 1'));", 'CAPTURE_COUNT'],
    [
      'two canary parses',
      "import { readFileSync } from 'node:fs'; import { parse } from 'yaml';" +
        "const t = readFileSync(process.argv[3], 'utf8'); parse(t); parse(t);",
      'CAPTURE_COUNT',
    ],
  ]) {
    const fixture = await candidate();
    writeFileSync(join(fixture.cli, 'dist', 'index.js'), entry);
    await assert.rejects(
      captureFrames({ candidate: fixture.root, work: fixture.work }),
      refuses(code),
      label,
    );
  }
});

test('the preload refuses the keyring and leaves V8’s stack formatting as it found it', async () => {
  const fixture = await candidate();
  const canary = 'frames-canary-preload';
  const document = join(fixture.work, `${canary}.relavium.yaml`);
  writeFileSync(document, `workflow:\n  id: ${canary}\n`);
  writeFileSync(
    join(fixture.cli, 'dist', 'index.js'),
    "import { readFileSync } from 'node:fs';\n" +
      "import { Entry } from '@napi-rs/keyring';\n" +
      "import { parse } from 'yaml';\n" +
      'let keyring;\n' +
      "try { new Entry('relavium', 'probe'); keyring = 'native'; } catch (error) { keyring = error.message; }\n" +
      "parse(readFileSync(process.argv[2], 'utf8'));\n" +
      // A formatter left installed would make `stack` an array of call sites, not a string.
      'process.stdout.write(JSON.stringify({ keyring, limit: Error.stackTraceLimit,' +
      " stack: typeof new Error('x').stack }));\n",
  );
  const run = spawnSync(
    process.execPath,
    [
      '--import',
      new URL('frame-capture.mjs', import.meta.url).href,
      join(fixture.cli, 'dist', 'index.js'),
      document,
    ],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        RELAVIUM_FRAME_CAPTURE_LOG: join(fixture.work, 'frames.json'),
        RELAVIUM_FRAME_CAPTURE_PACKAGE: join(fixture.cli, 'package.json'),
        RELAVIUM_FRAME_CAPTURE_CANARY: canary,
      },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    keyring: 'The symbolication run refuses the keyring',
    limit: 10,
    stack: 'string',
  });
  const record = JSON.parse(readFileSync(join(fixture.work, 'frames.json'), 'utf8'));
  assert.equal(record.captures.length, 1);
  // Owner-only, and never overwritten.
  if (posixModes) assert.equal(statSync(join(fixture.work, 'frames.json')).mode & 0o777, 0o600);
  // Without its configuration the preload refuses to run at all.
  const bare = spawnSync(
    process.execPath,
    ['--import', new URL('frame-capture.mjs', import.meta.url).href, '--eval', ''],
    { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH } },
  );
  assert.notEqual(bare.status, 0);
});
