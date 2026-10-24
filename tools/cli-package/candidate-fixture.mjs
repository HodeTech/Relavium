/**
 * Test-only finalized candidates for the private manifest and symbolication tests. The TypeScript sits
 * at the symbolication anchors' real repository paths with the same function names, the CLI imports
 * its canary into the project's `.relavium/` found by the same upward search as the real CLI, and the
 * exact esbuild behind the installed tsup bundles it with splitting and minify, as the CLI build does.
 * The maps are staged with repository-relative sources and recorded as the finalizer records them.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mapTrailer } from './finalize.mjs';
import { MANIFEST_INPUTS, sealPrivateManifest } from './manifest.mjs';

export const cliRequire = createRequire(new URL('../../apps/cli/package.json', import.meta.url));
const { build } = createRequire(cliRequire.resolve('tsup/package.json'))('esbuild');
export const ts = cliRequire('typescript');
const cliModules = fileURLToPath(new URL('../../apps/cli/node_modules', import.meta.url));
export const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-candidate-fixture-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const posixModes = process.platform !== 'win32';
export const PRELOAD = fileURLToPath(new URL('./frame-capture.mjs', import.meta.url));
let count = 0;
/** A fresh scratch directory name. */
export const fresh = (name) => join(scratch, `${name}-${(count += 1)}`);

export const SOURCES = {
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
    'type Raw = { schema_version?: unknown; workflow?: { id?: unknown } };',
    '',
    'export function parseWorkflow(text: string): { id: string } {',
    '  const raw = decodeHardenedYaml(text) as Raw;',
    "  if (raw.schema_version !== '1.0' || typeof raw.workflow?.id !== 'string') {",
    "    throw new Error('not a workflow');",
    '  }',
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
    "import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';",
    "import { basename, dirname, join, resolve } from 'node:path';",
    "import { detectAndParse } from '../authoring/authoring.js';",
    '',
    '// The real CLI walks up from its working directory to the first `.relavium/` (config/paths.ts).',
    'function projectConfigDir(cwd: string): string {',
    '  let current = resolve(cwd);',
    '  for (;;) {',
    "    const found = join(current, '.relavium');",
    '    if (existsSync(found) && statSync(found).isDirectory()) return found;',
    '    const parent = dirname(current);',
    "    if (parent === current) return join(resolve(cwd), '.relavium');",
    '    current = parent;',
    '  }',
    '}',
    '',
    'export function importCommand(path: string, cwd: string): string {',
    "  const text = readFileSync(path, 'utf8');",
    '  const id = detectAndParse(text, basename(path)).id;',
    "  const target = join(projectConfigDir(cwd), 'workflows', `${id}.relavium.yaml`);",
    '  mkdirSync(dirname(target), { recursive: true });',
    '  writeFileSync(target, text);',
    '  return id;',
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
    'const [command, path, flag, cwd] = process.argv.slice(2);',
    "if (command === 'import' && path !== undefined) {",
    "  const { importCommand } = await import('./commands/import.js');",
    "  importCommand(path, flag === '--cwd' && cwd !== undefined ? cwd : process.cwd());",
    '}',
    '',
  ],
};

/** Write `path` (repository-relative) under `root`. */
export function put(root, path, bytes) {
  mkdirSync(dirname(join(root, ...path.split('/'))), { recursive: true });
  writeFileSync(join(root, ...path.split('/')), bytes);
}

/**
 * A finalized synthetic candidate: its finalized dist, its staged maps with repository-relative
 * sources, the finalizer's record, the manifest inputs and the CLI installation, with an owner-only
 * staging directory and work directory (under `parent` when given).
 */
export async function candidate({ sources = SOURCES, parent = scratch } = {}) {
  const root = fresh('candidate');
  const staging = fresh('staging');
  const work = join(parent, `work-${(count += 1)}`);
  for (const directory of [staging, work]) {
    mkdirSync(directory, { recursive: true });
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

export const TREE = 'b'.repeat(40);
export const COMMIT = 'c'.repeat(40);
/** Git as the manifest asks it: the commit's tree. */
export const git = async (command, args) => {
  assert.equal(command, 'git');
  assert.deepEqual(args, ['--no-replace-objects', 'rev-parse', '--verify', `${COMMIT}^{tree}`]);
  return { stdout: `${TREE}\n`, stderr: '' };
};

/** Seal the manifest of a dirty local candidate, whose source revision is its own copy. */
export function seal(fixture) {
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

/** Re-record the finalized digests of the staged maps only, after a deliberate map change. */
export function rerecordMaps(fixture, mutateRecord = () => {}) {
  const record = JSON.parse(readFileSync(join(fixture.staging, 'finalized.json'), 'utf8'));
  record.maps = readdirSync(join(fixture.staging, 'maps')).map((name) => {
    const bytes = readFileSync(join(fixture.staging, 'maps', name));
    return { path: `dist/${name}`, bytes: bytes.length, sha256: digest(bytes) };
  });
  mutateRecord(record);
  writeFileSync(join(fixture.staging, 'finalized.json'), JSON.stringify(record));
}

/** Re-record every finalized digest after a deliberate change, then seal a fresh manifest. */
export function reseal(fixture) {
  const outputs = readdirSync(join(fixture.cli, 'dist')).map((name) => {
    const bytes = readFileSync(join(fixture.cli, 'dist', name));
    return { path: `dist/${name}`, bytes: bytes.length, sha256: digest(bytes) };
  });
  rerecordMaps(fixture, (record) => (record.outputs = outputs));
  rmSync(join(fixture.staging, 'manifest.json'), { force: true });
  fixture.archive.files = outputs.map((output) => ({
    path: `package/${output.path}`,
    sha256: output.sha256,
  }));
  return seal(fixture);
}

/** The finalized chunk that holds the core call sites. */
export function coreChunk(fixture) {
  return readdirSync(join(fixture.cli, 'dist')).find((name) =>
    JSON.parse(readFileSync(join(fixture.staging, 'maps', `${name}.map`), 'utf8')).sources.includes(
      'packages/core/src/parser.ts',
    ),
  );
}
