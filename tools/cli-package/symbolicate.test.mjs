import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  COMMIT,
  PRELOAD,
  SOURCES,
  candidate,
  cliRequire,
  coreChunk,
  digest,
  fresh,
  posixModes,
  put,
  reseal,
  scratch,
  seal,
  ts,
} from './candidate-fixture.mjs';
import * as keyringStub from './frame-capture-keyring.mjs';
import { ManifestError, sealPrivateManifest } from './manifest.mjs';
import { isolatedEnvironment, isolatedGitEnvironment, runCommand } from './process.mjs';
import {
  ANCHORS,
  SymbolicationError,
  anchorPosition,
  captureFrames,
  readSourceRevision,
  symbolicateCandidate,
} from './symbolicate.mjs';

const refuses = (code) => (error) => error instanceof SymbolicationError && error.code === code;
const repository = fileURLToPath(new URL('../../', import.meta.url));

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

/** A sealed fixture and the frames one real capture of it produced. */
async function sealedWithFrames() {
  const fixture = await candidate();
  await seal(fixture);
  const frames = await captureFrames({ candidate: fixture.root, work: fixture.work });
  return { fixture, frames };
}

/** Re-record the manifest's map digest for `chunk` after a deliberate change to its staged map. */
function rerecordManifestMap(fixture, chunk) {
  const path = join(fixture.staging, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const bytes = readFileSync(join(fixture.staging, 'maps', `${chunk}.map`));
  for (const output of manifest.outputs) {
    if (output.path === `dist/${chunk}`) output.map.sha256 = digest(bytes);
  }
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}

/** Entry code that imports the canary into the run's project, as the real CLI does. */
const IMPORTS =
  "import { mkdirSync as m, writeFileSync as w } from 'node:fs'; import { join as j } from 'node:path';\n" +
  'const [, , , project] = process.argv.slice(2);\n' +
  "m(j(project, '.relavium', 'workflows'), { recursive: true });\n" +
  "w(j(project, '.relavium', 'workflows', `${process.env.RELAVIUM_FRAME_CAPTURE_CANARY}.relavium.yaml`), '');\n";

test('actual packed frames reach every anchor through the real preload and exact segments', async () => {
  const fixture = await candidate();
  await seal(fixture);
  let frames;
  const result = await symbolicate(fixture, {
    capture: async (options) => (frames = await captureFrames(options)),
  });
  assert.deepEqual(result, { anchors: ANCHORS.length });
  // One stack crossed the entry and the lazy chunk that inlines the core.
  const files = new Set(
    frames.filter((frame) => frame.file?.includes('/dist/')).map((frame) => frame.file),
  );
  assert.ok(files.size >= 2, 'the stack crosses more than one finalized chunk');
  // The canary was imported into the run's own project, never the candidate.
  const imported = readdirSync(join(fixture.work, 'project', '.relavium', 'workflows'));
  assert.equal(imported.length, 1);
  assert.match(imported[0], /^frames-canary-[0-9a-f]{12}\.relavium\.yaml$/u);
  assert.equal(existsSync(join(fixture.root, '.relavium')), false);
  // The count is the table's, not a constant.
  assert.deepEqual(
    await symbolicate(fixture, { anchors: [...ANCHORS, ANCHORS[0]], capture: async () => frames }),
    { anchors: ANCHORS.length + 1 },
  );
});

test('an ancestor project of the work directory is never adopted by the canary import', async () => {
  // A developer's real `.relavium/` above the temporary directory, as on Windows.
  const ancestor = fresh('ancestor');
  mkdirSync(join(ancestor, '.relavium'), { recursive: true });
  const fixture = await candidate({ parent: ancestor });
  await seal(fixture);
  assert.deepEqual(await symbolicate(fixture), { anchors: ANCHORS.length });
  assert.deepEqual(readdirSync(join(ancestor, '.relavium')), []);
  assert.equal(readdirSync(join(fixture.work, 'project', '.relavium', 'workflows')).length, 1);
  // A run that imports nothing into its project refuses.
  const elsewhere = await candidate();
  writeFileSync(
    join(elsewhere.cli, 'dist', 'index.js'),
    "import { readFileSync } from 'node:fs'; import { parse } from 'yaml';\n" +
      "parse(readFileSync(process.argv[3], 'utf8'));\n",
  );
  await assert.rejects(
    captureFrames({ candidate: elsewhere.root, work: elsewhere.work }),
    refuses('CAPTURE_PROJECT'),
  );
  // So does one that writes its project's catalog but not the canary.
  const other = fresh('other-import');
  mkdirSync(other, { mode: 0o700 });
  await assert.rejects(
    captureFrames({
      candidate: scratch,
      work: other,
      run: async (_command, args, options) => {
        const workflows = join(args.at(-1), '.relavium', 'workflows');
        mkdirSync(workflows);
        writeFileSync(join(workflows, 'another.relavium.yaml'), '');
        writeFileSync(
          options.env.RELAVIUM_FRAME_CAPTURE_LOG,
          JSON.stringify({
            version: 1,
            captures: [[{ file: null, line: null, column: null, async: false }]],
          }),
        );
        return { stdout: '', stderr: '' };
      },
    }),
    refuses('CAPTURE_PROJECT'),
  );
});

test('the anchors keep the coverage ruling and resolve in the real repository', async () => {
  const core = ANCHORS.filter((anchor) => anchor.source.startsWith('packages/core/src/'));
  const cli = ANCHORS.filter((anchor) => anchor.source.startsWith('apps/cli/src/'));
  assert.ok(core.length >= 2, 'at least two core anchors');
  assert.ok(cli.length >= 3, 'at least three CLI anchors');
  assert.equal(Object.isFrozen(ANCHORS), true);
  for (const anchor of ANCHORS) {
    const text = readFileSync(join(repository, ...anchor.source.split('/')), 'utf8');
    const position = anchorPosition(ts, text, anchor);
    const line = text.split(/\r\n|[\n\r\u2028\u2029]/u)[position.line - 1];
    assert.equal(line.slice(position.column - 1).startsWith(anchor.call), true, anchor.within);
  }
  // A table below the ruling refuses before anything runs.
  const fixture = await candidate();
  await seal(fixture);
  for (const anchors of [
    [],
    ANCHORS.slice(1),
    ANCHORS.slice(0, 4),
    ANCHORS.filter((anchor) => !anchor.source.startsWith('packages/core/')),
    // A repeated entry is one call site.
    [ANCHORS[0], ANCHORS[0], ANCHORS[2], ANCHORS[2], ANCHORS[2]],
    [...ANCHORS.slice(1), ANCHORS[1]],
    // Call sites in other engine packages, or outside a package's sources, are not core anchors.
    [
      ...cli,
      { source: 'packages/shared/src/a.ts', within: 'f', call: 'g' },
      { source: 'packages/core/test/b.ts', within: 'f', call: 'g' },
    ],
  ]) {
    let ran = false;
    await assert.rejects(
      symbolicate(fixture, {
        anchors,
        capture: async () => {
          ran = true;
          return [];
        },
      }),
      refuses('ANCHORS'),
    );
    assert.equal(ran, false);
  }
});

test('the expected positions come from the source revision, independently of any map', () => {
  for (const anchor of ANCHORS) {
    const text = SOURCES[anchor.source].join('\n');
    const position = anchorPosition(ts, text, anchor);
    const line = text.split('\n')[position.line - 1];
    assert.equal(line.slice(position.column - 1).startsWith(anchor.call), true, anchor.call);
  }
  const at = (text, within = 'f', call = 'g') =>
    anchorPosition(ts, text, { source: 'a.ts', within, call });
  // A member call is positioned at its property name.
  assert.deepEqual(at('function f() {\n  yaml.parse(x);\n}\n', 'f', 'parse'), {
    line: 2,
    column: 8,
  });
  // Declaration, arrow, function expression and method owners; a call outside the owner is ignored.
  assert.deepEqual(at('function f() { g(); }\nfunction h() { g(); }'), { line: 1, column: 16 });
  assert.deepEqual(at('const f = () => {\n  g();\n};'), { line: 2, column: 3 });
  assert.deepEqual(at('const f = function () {\n  g();\n};'), { line: 2, column: 3 });
  assert.deepEqual(at('class A {\n  f() {\n    g();\n  }\n}'), { line: 3, column: 5 });
  assert.deepEqual(at('const f = () => g();\nconst h = () => g();'), { line: 1, column: 17 });
  assert.deepEqual(at('let f;\nfunction f() { g(); }'), { line: 2, column: 16 });
  assert.deepEqual(at('export default function () { g(); }\nfunction f() { g(); }'), {
    line: 2,
    column: 16,
  });
  // Bodiless signatures (overloads, declarations) are not owners; the implementation is.
  assert.deepEqual(
    at(
      'function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: unknown) { g(); }',
    ),
    { line: 3, column: 26 },
  );
  assert.deepEqual(at('declare function f(): void;\nfunction f() { g(); }'), {
    line: 2,
    column: 16,
  });
  // A missing owner, a second owner, no call or a second call is ambiguous.
  for (const text of [
    'function h() { g(); }',
    'function f() { g(); g(); }',
    'function f() { h(); }',
    'function f() { g(); }\nfunction f() { g(); }',
  ]) {
    assert.throws(() => at(text), refuses('ANCHOR_SOURCE'), text);
  }
  // A refusal names only its fixed code.
  assert.throws(() => at('function h() {}'), {
    name: 'SymbolicationError',
    code: 'ANCHOR_SOURCE',
    message: 'PACKED_CLI_SYMBOLICATION_ANCHOR_SOURCE',
  });
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
    [
      'a source revision one column apart',
      (fixture) => {
        const path = join(fixture.root, 'packages', 'core', 'src', 'parser.ts');
        const text = readFileSync(path, 'utf8');
        assert.ok(text.includes('const raw = decodeHardenedYaml'));
        writeFileSync(
          path,
          text.replace('const raw = decodeHardenedYaml', 'const raw =  decodeHardenedYaml'),
        );
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
  writeFileSync(
    join(fixture.staging, 'maps', `${coreChunk(fixture)}.map`),
    readFileSync(join(fixture.staging, 'maps', 'index.js.map')),
  );
  await reseal(fixture);
  await assert.rejects(symbolicate(fixture), refuses('SOURCE_REVISION'));
});

test('a call after non-ASCII text on its line still reaches its anchor', async () => {
  const sources = {
    ...SOURCES,
    'packages/core/src/yaml-decode.ts': [
      "import { parse as parseYaml } from 'yaml';",
      '',
      'export function decodeHardenedYaml(text: string): unknown {',
      "  const mark = 'é—😀'; return mark.length > 0 ? parseYaml(text, { version: '1.2' }) : null;",
      '}',
      '',
    ],
  };
  const fixture = await candidate({ sources });
  await seal(fixture);
  assert.deepEqual(await symbolicate(fixture), { anchors: ANCHORS.length });
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
      'finalized JS the tarball agrees with but the manifest does not',
      (fixture) => {
        const chunk = coreChunk(fixture);
        const path = join(fixture.cli, 'dist', chunk);
        writeFileSync(path, `${readFileSync(path, 'utf8')} `);
        fixture.archive.files.find((file) => file.path === `package/dist/${chunk}`).sha256 = digest(
          readFileSync(path),
        );
      },
      'FRAME_FILE',
    ],
    [
      'a tarball entry that is not the run file',
      (fixture) => {
        const key = `package/dist/${coreChunk(fixture)}`;
        fixture.archive.files.find((file) => file.path === key).sha256 = 'e'.repeat(64);
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
  ]) {
    const fixture = await candidate();
    await seal(fixture);
    change(fixture);
    await assert.rejects(symbolicate(fixture), refuses(code), label);
  }
  // Without a manifest the candidate is never run.
  const bare = await candidate();
  let ran = false;
  await assert.rejects(
    symbolicate(bare, {
      capture: async () => {
        ran = true;
        return [];
      },
    }),
    (error) => error instanceof ManifestError && error.code === 'UNREADABLE',
  );
  assert.equal(ran, false);
});

test('a recorded map that does not decode refuses with its own code', async () => {
  for (const [label, change] of [
    ['not JSON', () => '{'],
    ['malformed mappings', (map) => JSON.stringify({ ...map, mappings: 'A!' })],
    [
      'a source index out of range',
      (map) => JSON.stringify({ ...map, sources: map.sources.slice(0, -1) }),
    ],
    [
      'a name index out of range',
      (map) => JSON.stringify({ ...map, names: map.names.slice(0, -1) }),
    ],
  ]) {
    const fixture = await candidate();
    await seal(fixture);
    const chunk = coreChunk(fixture);
    const path = join(fixture.staging, 'maps', `${chunk}.map`);
    const map = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(map.names.length > 0, 'the minified chunk records names');
    writeFileSync(path, change(map));
    rerecordManifestMap(fixture, chunk);
    await assert.rejects(symbolicate(fixture), refuses('MAP_DECODE'), label);
  }
});

test('only synchronous frames inside the finalized dist count, and an unrecorded one refuses', async () => {
  const { fixture, frames } = await sealedWithFrames();
  assert.deepEqual(await symbolicate(fixture, { capture: async () => frames }), {
    anchors: ANCHORS.length,
  });
  // Anchors reached only by asynchronous frames do not count.
  await assert.rejects(
    symbolicate(fixture, {
      capture: async () => frames.map((frame) => ({ ...frame, async: true })),
    }),
    refuses('ANCHOR_UNMAPPED'),
  );
  // Native, node-internal, preload and sibling-directory frames are skipped.
  const sibling = join(fixture.cli, 'distx');
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'a.js'), '');
  const skipped = [
    { file: null, line: null, column: null, async: false },
    { file: 'node:internal/modules/run_main', line: 1, column: 1, async: false },
    { file: pathToFileURL(PRELOAD).href, line: 1, column: 1, async: false },
    { file: pathToFileURL(join(sibling, 'a.js')).href, line: 1, column: 1, async: false },
  ];
  assert.deepEqual(await symbolicate(fixture, { capture: async () => [...skipped, ...frames] }), {
    anchors: ANCHORS.length,
  });
  // A dist frame the manifest does not record, or that cannot be resolved, refuses.
  writeFileSync(join(fixture.cli, 'dist', 'extra.js'), '');
  for (const name of ['extra.js', 'missing.js']) {
    const frame = {
      file: pathToFileURL(join(fixture.cli, 'dist', name)).href,
      line: 1,
      column: 1,
      async: false,
    };
    await assert.rejects(
      symbolicate(fixture, { capture: async () => [frame, ...frames] }),
      refuses('FRAME_FILE'),
      name,
    );
  }
  // A symlinked candidate path reaches the same dist.
  const link = fresh('linked-candidate');
  symlinkSync(fixture.root, link, 'junction');
  assert.deepEqual(await symbolicate(fixture, { candidate: link, capture: async () => frames }), {
    anchors: ANCHORS.length,
  });
  // Without the candidate's TypeScript the run refuses with its code. A fresh candidate: Node's
  // resolution cache would still answer for one that already resolved it.
  const untooled = await candidate();
  await seal(untooled);
  rmSync(join(untooled.cli, 'node_modules'), { recursive: true, force: true });
  await assert.rejects(
    symbolicate(untooled, { capture: async () => frames }),
    refuses('TOOLCHAIN'),
  );
});

/** Git without the host's configuration, for building test repositories. */
function gitIn(directory, args) {
  const run = spawnSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function commitAll(directory) {
  gitIn(directory, ['add', '.']);
  gitIn(directory, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'x',
  ]);
  return gitIn(directory, ['rev-parse', 'HEAD']);
}

test('a clean candidate reads the recorded commit from the checkout, never HEAD or its own copy', async () => {
  const fixture = await candidate();
  const checkout = fresh('checkout');
  mkdirSync(checkout);
  gitIn(checkout, ['init', '--quiet']);
  for (const [path, lines] of Object.entries(SOURCES)) put(checkout, path, lines.join('\n'));
  const recorded = commitAll(checkout);
  put(
    checkout,
    'packages/core/src/parser.ts',
    `// later\n${SOURCES['packages/core/src/parser.ts'].join('\n')}`,
  );
  commitAll(checkout);
  await sealPrivateManifest({
    candidate: fixture.root,
    staging: fixture.staging,
    checkout,
    source: recorded,
    dirty: false,
    archive: fixture.archive,
  });
  // The candidate copy changes after the seal too: a clean build must not read it.
  const copy = join(fixture.root, 'packages', 'core', 'src', 'yaml-decode.ts');
  writeFileSync(copy, `// later\n${readFileSync(copy, 'utf8')}`);
  // The run port reaches the capture and each Git read, one per anchor source.
  const commands = [];
  const run = (command, args, options) => {
    commands.push(command === 'git' ? args.slice(0, 3).join(' ') : command);
    return runCommand(command, args, options);
  };
  assert.deepEqual(await symbolicate(fixture, { checkout, run }), { anchors: ANCHORS.length });
  assert.deepEqual(commands, [
    process.execPath,
    ...Array(new Set(ANCHORS.map((anchor) => anchor.source)).size).fill(
      '--no-replace-objects cat-file blob',
    ),
  ]);
});

test('a dirty candidate reads its own copy, never the checkout', async () => {
  const fixture = await candidate();
  await seal(fixture);
  const empty = fresh('empty-checkout');
  mkdirSync(empty);
  assert.deepEqual(await symbolicate(fixture, { checkout: empty }), { anchors: ANCHORS.length });
});

test('the source revision is read without configuration and refuses with its fixed code', async () => {
  const path = 'apps/cli/src/commands/import.ts';
  const text = 'é — 😀\nexport function f() {}\n';
  const clean = {
    source: { commit: COMMIT, dirty: false },
    sources: { [path]: digest(Buffer.from(text, 'utf8')) },
  };
  const calls = [];
  const texts = await readSourceRevision({
    candidate: fresh('nowhere'),
    checkout: scratch,
    manifest: clean,
    paths: [path],
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: text, stderr: '' };
    },
  });
  // Non-ASCII text round-trips.
  assert.equal(texts.get(path), text);
  assert.deepEqual(
    calls.map(({ command, args, options }) => [command, args, options.cwd, options.env]),
    [
      [
        'git',
        ['--no-replace-objects', 'cat-file', 'blob', `${COMMIT}:${path}`],
        scratch,
        isolatedGitEnvironment(),
      ],
    ],
  );
  let unlistedRead = false;
  for (const [label, options] of [
    [
      'a missing dirty copy',
      {
        candidate: fresh('nowhere'),
        manifest: { source: { commit: COMMIT, dirty: true }, sources: { [path]: 'f'.repeat(64) } },
      },
    ],
    [
      'a failed Git read',
      {
        candidate: scratch,
        manifest: clean,
        run: async () => {
          throw new Error('git failed');
        },
      },
    ],
    [
      'a blob that is not the built source',
      {
        candidate: scratch,
        manifest: { ...clean, sources: { [path]: digest(`${text}\n`) } },
        run: async () => ({ stdout: text, stderr: '' }),
      },
    ],
    [
      'a path outside the manifest, refused before Git runs',
      {
        candidate: scratch,
        manifest: clean,
        paths: ['apps/cli/src/x.ts'],
        run: async () => {
          unlistedRead = true;
          return { stdout: text, stderr: '' };
        },
      },
    ],
  ]) {
    await assert.rejects(
      readSourceRevision({ checkout: scratch, paths: [path], ...options }),
      refuses('SOURCE_REVISION'),
      label,
    );
  }
  assert.equal(unlistedRead, false);
});

test('the CLI runs in the private work directory with an isolated environment', async () => {
  const fixture = await candidate();
  process.env.RELAVIUM_SYMBOLICATION_SENTINEL = 'ambient-secret';
  const calls = [];
  try {
    await captureFrames({
      candidate: fixture.root,
      work: fixture.work,
      run: (command, args, options) => {
        calls.push({ command, args, options });
        return runCommand(command, args, options);
      },
    });
  } finally {
    delete process.env.RELAVIUM_SYMBOLICATION_SENTINEL;
  }
  const [{ command, args, options }] = calls;
  assert.equal(calls.length, 1);
  assert.equal(command, process.execPath);
  const canary = options.env.RELAVIUM_FRAME_CAPTURE_CANARY;
  assert.match(canary, /^frames-canary-[0-9a-f]{12}$/u);
  const home = join(fixture.work, 'home');
  const project = join(fixture.work, 'project');
  const document = join(fixture.work, `${canary}.relavium.yaml`);
  assert.deepEqual(args, [
    '--import',
    pathToFileURL(PRELOAD).href,
    join(fixture.root, 'apps', 'cli', 'dist', 'index.js'),
    'import',
    document,
    '--cwd',
    project,
  ]);
  assert.equal(options.cwd, fixture.work);
  assert.deepEqual(options.env, {
    ...isolatedEnvironment(home),
    RELAVIUM_FRAME_CAPTURE_LOG: join(fixture.work, 'frames.json'),
    RELAVIUM_FRAME_CAPTURE_PACKAGE: join(fixture.root, 'apps', 'cli', 'package.json'),
    RELAVIUM_FRAME_CAPTURE_CANARY: canary,
  });
  if (posixModes) {
    for (const directory of [home, project, join(project, '.relavium')]) {
      assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
    }
    assert.equal(statSync(document).mode & 0o777, 0o600);
  }
});

test('the capture validates the record it reads', async () => {
  const valid = { file: 'file:///x.js', line: 1, column: 1, async: false };
  const cases = [
    ['no record', undefined, 'CAPTURE_FAILED'],
    [
      'an oversized record',
      `${JSON.stringify({ version: 1, captures: [[valid]] })}${' '.repeat(1024 * 1024)}`,
      'CAPTURE_FAILED',
    ],
    ['null', 'null', 'CAPTURE_SHAPE'],
    ['another version', { version: 2, captures: [[valid]] }, 'CAPTURE_SHAPE'],
    ['captures not an array', { version: 1, captures: 'xy' }, 'CAPTURE_SHAPE'],
    ['captures array-like', { version: 1, captures: { 0: [valid], length: 1 } }, 'CAPTURE_SHAPE'],
    ['no capture', { version: 1, captures: [] }, 'CAPTURE_COUNT'],
    ['two captures', { version: 1, captures: [[valid], [valid]] }, 'CAPTURE_COUNT'],
    ['a stack that is not an array', { version: 1, captures: [{}] }, 'CAPTURE_SHAPE'],
    ['an empty stack', { version: 1, captures: [[]] }, 'CAPTURE_SHAPE'],
    ['65 frames', { version: 1, captures: [Array(65).fill(valid)] }, 'CAPTURE_SHAPE'],
    ['a null frame', { version: 1, captures: [[null]] }, 'CAPTURE_SHAPE'],
    ['a numeric file', { version: 1, captures: [[{ ...valid, file: 5 }]] }, 'CAPTURE_SHAPE'],
    [
      'a non-boolean async',
      { version: 1, captures: [[{ ...valid, async: 'no' }]] },
      'CAPTURE_SHAPE',
    ],
    ['a fractional line', { version: 1, captures: [[{ ...valid, line: 1.5 }]] }, 'CAPTURE_SHAPE'],
    ['line zero', { version: 1, captures: [[{ ...valid, line: 0 }]] }, 'CAPTURE_SHAPE'],
    [
      'a fractional column',
      { version: 1, captures: [[{ ...valid, column: 1.5 }]] },
      'CAPTURE_SHAPE',
    ],
    ['column zero', { version: 1, captures: [[{ ...valid, column: 0 }]] }, 'CAPTURE_SHAPE'],
    [
      'one bad frame among good ones',
      { version: 1, captures: [[valid, { ...valid, line: 0 }]] },
      'CAPTURE_SHAPE',
    ],
  ];
  const admitted = [
    ['64 frames', { version: 1, captures: [Array(64).fill(valid)] }],
    [
      'a native frame without a position',
      { version: 1, captures: [[{ file: null, line: null, column: null, async: false }, valid]] },
    ],
  ];
  // A stand-in run that imports the canary into its project and writes the given record.
  const writing = (record) => async (_command, args, options) => {
    const workflows = join(args.at(-1), '.relavium', 'workflows');
    mkdirSync(workflows, { recursive: true });
    writeFileSync(
      join(workflows, `${options.env.RELAVIUM_FRAME_CAPTURE_CANARY}.relavium.yaml`),
      '',
    );
    if (record !== undefined) {
      writeFileSync(
        options.env.RELAVIUM_FRAME_CAPTURE_LOG,
        typeof record === 'string' ? record : JSON.stringify(record),
      );
    }
    return { stdout: '', stderr: '' };
  };
  for (const [label, record, code] of cases) {
    const work = fresh('record');
    mkdirSync(work, { mode: 0o700 });
    await assert.rejects(
      captureFrames({ candidate: scratch, work, run: writing(record) }),
      refuses(code),
      label,
    );
  }
  for (const [label, record] of admitted) {
    const work = fresh('record');
    mkdirSync(work, { mode: 0o700 });
    assert.deepEqual(
      await captureFrames({ candidate: scratch, work, run: writing(record) }),
      record.captures[0],
      label,
    );
  }
});

test('the capture refuses a run that fails, never parses the canary or parses it twice', async () => {
  for (const [label, entry, code] of [
    ['a failed run', `${IMPORTS}process.exit(3);\n`, 'CAPTURE_FAILED'],
    [
      'no canary parse',
      `${IMPORTS}import('yaml').then((y) => y.parse('a: 1'));\n`,
      'CAPTURE_COUNT',
    ],
    [
      'two canary parses',
      `${IMPORTS}import { readFileSync } from 'node:fs'; import { parse } from 'yaml';\n` +
        "const t = readFileSync(process.argv[3], 'utf8'); parse(t); parse(t);\n",
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

/** Run `entry` as the finalized CLI under the preload, with only PATH and `env` set. */
function preload(fixture, entry, env, args = []) {
  writeFileSync(join(fixture.cli, 'dist', 'index.js'), entry);
  return spawnSync(
    process.execPath,
    ['--import', pathToFileURL(PRELOAD).href, join(fixture.cli, 'dist', 'index.js'), ...args],
    { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH, ...env } },
  );
}

test('the preload refuses the keyring and native modules and leaves V8’s stack formatting alone', async () => {
  const fixture = await candidate();
  const canary = 'frames-canary-preload';
  const document = join(fixture.work, `${canary}.relavium.yaml`);
  writeFileSync(document, `id: ${canary}\nv: yes\n`);
  const log = join(fixture.work, 'frames.json');
  const configured = {
    RELAVIUM_FRAME_CAPTURE_LOG: log,
    RELAVIUM_FRAME_CAPTURE_PACKAGE: join(fixture.cli, 'package.json'),
    RELAVIUM_FRAME_CAPTURE_CANARY: canary,
  };
  const read = () => JSON.parse(readFileSync(log, 'utf8'));
  const clear = () => rmSync(log, { force: true });
  let run = preload(
    fixture,
    "import { readFileSync } from 'node:fs';\n" +
      "import { Entry, findCredentials } from '@napi-rs/keyring';\n" +
      "import { parse } from 'yaml';\n" +
      'const message = (action) => { try { action(); return "ran"; } catch (error) { return error.message; } };\n' +
      "const keyring = [message(() => new Entry('relavium', 'probe')), message(() => findCredentials('relavium'))];\n" +
      "const native = message(() => process.dlopen({ exports: {} }, '/nonexistent/addon.node'));\n" +
      "parse(readFileSync(process.argv[2], 'utf8'));\n" +
      // A formatter left installed would make `stack` an array of call sites, not a string.
      "process.stdout.write(JSON.stringify({ keyring, native, limit: Error.stackTraceLimit, stack: typeof new Error('x').stack }));\n",
    configured,
    [document],
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    keyring: [
      'The symbolication run refuses the keyring',
      'The symbolication run refuses the keyring',
    ],
    native: 'The symbolication run refuses native modules',
    limit: 10,
    stack: 'string',
  });
  assert.equal(read().captures.length, 1);
  if (posixModes) assert.equal(statSync(log).mode & 0o777, 0o600);
  // An explicit process.exit still writes the record.
  clear();
  run = preload(
    fixture,
    "import { readFileSync } from 'node:fs'; import { parse } from 'yaml';\n" +
      "parse(readFileSync(process.argv[2], 'utf8'));\nprocess.exit(0);\n",
    configured,
    [document],
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(read().captures.length, 1);
  // The first frame is the caller of parse, never the preload; parse options pass through.
  clear();
  run = preload(
    fixture,
    "import { readFileSync } from 'node:fs'; import { parse } from 'yaml';\n" +
      "const value = parse(readFileSync(process.argv[2], 'utf8'), { version: '1.1' });\n" +
      'process.stdout.write(JSON.stringify(value.v));\n',
    configured,
    [document],
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'true');
  assert.equal(
    read().captures[0][0].file,
    pathToFileURL(join(fixture.cli, 'dist', 'index.js')).href,
  );
  // An existing record is never overwritten.
  writeFileSync(log, 'keep');
  preload(fixture, "import 'yaml';\n", configured);
  assert.equal(readFileSync(log, 'utf8'), 'keep');
  // Asynchronous callers are marked async and a native frame has no file.
  clear();
  run = preload(
    fixture,
    "import { readFileSync } from 'node:fs'; import { parse } from 'yaml';\n" +
      'async function inner(text) { await null; [text].map((t) => parse(t)); }\n' +
      'async function outer(text) { await inner(text); }\n' +
      "await outer(readFileSync(process.argv[2], 'utf8'));\n",
    configured,
    [document],
  );
  assert.equal(run.status, 0, run.stderr);
  const frames = read().captures[0];
  assert.ok(
    frames.some((frame) => frame.async === true),
    'an async frame',
  );
  assert.ok(
    frames.some((frame) => Object.hasOwn(frame, 'file') && frame.file === null),
    'a native frame',
  );
  // An eval frame has no file name: it is recorded as null, never dropped.
  clear();
  run = preload(
    fixture,
    "import { readFileSync } from 'node:fs'; import { parse } from 'yaml';\n" +
      "const text = readFileSync(process.argv[2], 'utf8');\neval('parse(text)');\n",
    configured,
    [document],
  );
  assert.equal(run.status, 0, run.stderr);
  assert.ok(read().captures[0].every((frame) => Object.hasOwn(frame, 'file')));
  assert.ok(read().captures[0].some((frame) => frame.file === null));
  // A deep stack stops at the 64 frames the producer admits.
  clear();
  run = preload(
    fixture,
    "import { readFileSync } from 'node:fs'; import { parse } from 'yaml';\n" +
      "const text = readFileSync(process.argv[2], 'utf8');\n" +
      'function deep(n) { if (n === 0) return parse(text); return deep(n - 1); }\ndeep(100);\n',
    configured,
    [document],
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(read().captures[0].length, 64);
  // A platform keyring binding is refused by name.
  clear();
  run = preload(
    fixture,
    "let result;\ntry { await import('@napi-rs/keyring-darwin-arm64'); result = 'loaded'; } catch (error) { result = error.message; }\nprocess.stdout.write(result);\n",
    configured,
  );
  assert.equal(run.stdout, 'Native keyring import refused');
  // Without a canary, a log or a package the preload refuses before the entry runs.
  const marker = join(fixture.work, 'ran');
  for (const missing of Object.keys(configured)) {
    const env = { ...configured };
    delete env[missing];
    clear();
    run = preload(
      fixture,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\n`,
      env,
    );
    assert.notEqual(run.status, 0, missing);
    assert.equal(existsSync(marker), false, missing);
    assert.equal(existsSync(log), false, missing);
  }
});

test('the preload refuses any module that resolves outside the candidate', async () => {
  const fixture = await candidate();
  // A module another local user could plant in a `node_modules` above the candidate, as ws's optional
  // `bufferutil` would find one in a shared temporary directory.
  const name = `relavium-planted-${process.pid}`;
  const planted = join(dirname(fixture.root), 'node_modules', name);
  mkdirSync(planted, { recursive: true });
  const marker = join(fixture.work, 'planted-ran');
  writeFileSync(join(planted, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
  writeFileSync(
    join(planted, 'index.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`,
  );
  const entry =
    "import { createRequire } from 'node:module';\n" +
    `let required; try { createRequire(import.meta.url)(${JSON.stringify(name)}); required = 'loaded'; } catch (error) { required = error.message; }\n` +
    `let imported; try { await import(${JSON.stringify(name)}); imported = 'loaded'; } catch (error) { imported = error.message; }\n` +
    'process.stdout.write(JSON.stringify({ required, imported }));\n';
  // Without the preload, Node's resolution walks up and runs it.
  writeFileSync(join(fixture.cli, 'dist', 'index.js'), entry);
  let run = spawnSync(process.execPath, [join(fixture.cli, 'dist', 'index.js')], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { required: 'loaded', imported: 'loaded' });
  assert.equal(existsSync(marker), true);
  rmSync(marker);
  // Under the preload both a require and an import refuse, and it never runs.
  const canary = 'frames-canary-confined';
  run = preload(fixture, entry, {
    RELAVIUM_FRAME_CAPTURE_LOG: join(fixture.work, 'frames.json'),
    RELAVIUM_FRAME_CAPTURE_PACKAGE: join(fixture.cli, 'package.json'),
    RELAVIUM_FRAME_CAPTURE_CANARY: canary,
  });
  assert.equal(run.status, 0, run.stderr);
  const refusal = 'The symbolication run refuses a module outside the candidate';
  assert.deepEqual(JSON.parse(run.stdout), { required: refusal, imported: refusal });
  assert.equal(existsSync(marker), false);
});

test('the keyring stand-in has every export the real package declares, and each refuses', () => {
  // Read from the package's own declarations and entry, so the test loads no native binding.
  const root = dirname(cliRequire.resolve('@napi-rs/keyring/package.json'));
  const names = new Set([
    ...[
      ...readFileSync(join(root, 'index.d.ts'), 'utf8').matchAll(
        /^export declare (?:class|function) (\w+)/gmu,
      ),
    ].map((match) => match[1]),
    ...[
      ...readFileSync(join(root, 'index.js'), 'utf8').matchAll(/^module\.exports\.(\w+) =/gmu),
    ].map((match) => match[1]),
  ]);
  assert.ok(names.size >= 4, 'the package declares its exports');
  for (const name of names) assert.equal(Object.hasOwn(keyringStub, name), true, name);
  for (const [name, value] of Object.entries(keyringStub)) {
    assert.throws(
      () => (/^[A-Z]/u.test(name) ? new value() : value()),
      /^Error: The symbolication run refuses the keyring$/u,
      name,
    );
  }
});
