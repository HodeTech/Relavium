import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BundleClosureError, checkBundleClosure } from './closure.mjs';

// Use the exact esbuild installed behind the existing CLI tsup tool, not a new
// dependency, a copied metadata generator, or the product build. Everything is
// emitted in memory from tiny temporary source fixtures; no native/service load.
const cliRequire = createRequire(new URL('../../apps/cli/package.json', import.meta.url));
const { build } = createRequire(cliRequire.resolve('tsup/package.json'))('esbuild');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-emitted-closure-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
mkdirSync(join(scratch, 'src'));
writeFileSync(
  join(scratch, 'src/index.ts'),
  '#!/usr/bin/env node\nimport {program} from "commander";\n' +
    'import {authority} from "./authority.js";\n' +
    'console.log(program, authority, "é", "import(\\"fake\\")");\n' +
    'export const run = () => import("./runtime.js");\n',
);
writeFileSync(join(scratch, 'src/authority.ts'), 'export const authority = new WeakMap();\n');
writeFileSync(
  join(scratch, 'src/runtime.ts'),
  'import {authority} from "./authority.js";\n' +
    'import {readFile} from "node:fs/promises";\n' +
    'export {Client} from "@modelcontextprotocol/sdk/client/index.js";\n' +
    'export const execute = () => [authority, readFile, import("./tail.js")];\n',
);
writeFileSync(
  join(scratch, 'src/tail.ts'),
  'export const sdk = () => import("@modelcontextprotocol/sdk/client/stdio.js");\n',
);

async function fixture(splitting = true) {
  const built = await build({
    absWorkingDir: scratch,
    entryPoints: { index: 'src/index.ts' },
    outdir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    bundle: true,
    splitting,
    minify: true,
    metafile: true,
    write: false,
    external: ['commander', '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  });
  const files = {};
  for (const output of built.outputFiles) {
    const path = relative(scratch, output.path).split(sep).join('/');
    files[path] = {
      contents: output.text,
      mode: path === 'dist/index.js' ? 0o755 : 0o644,
      kind: 'file',
    };
  }
  return {
    metafile: built.metafile,
    manifest: { dependencies: { commander: '1', '@modelcontextprotocol/sdk': '1' } },
    files,
  };
}
const original = await fixture();
function candidate() {
  return JSON.parse(JSON.stringify(original));
}
function lazyFile(value) {
  return Object.keys(value.metafile.outputs).find((path) =>
    value.metafile.outputs[path].entryPoint?.endsWith('/runtime.ts'),
  );
}
function setContents(value, path, contents) {
  value.files[path].contents = contents;
  value.metafile.outputs[path].bytes = Buffer.byteLength(contents);
}
function append(value, contents, path = lazyFile(value)) {
  setContents(value, path, `${value.files[path].contents}\n${contents}\n`);
}
function refuses(value, code) {
  assert.throws(
    () => checkBundleClosure(value),
    (error) => error instanceof BundleClosureError && error.code === code,
    `expected ${code}`,
  );
}

test('actual minified split esbuild graph retains shared authority and SDK subpaths', () => {
  const report = checkBundleClosure(candidate());
  assert.ok(report.outputs.length >= 4, 'must exercise entry, lazy runtime/tail, shared chunk');
  assert.equal(report.inputs.length, 4);
  assert.deepEqual(report.dependencies, ['@modelcontextprotocol/sdk', 'commander']);
  const owners = Object.values(original.metafile.outputs).filter(
    (output) => output.inputs['src/authority.ts']?.bytesInOutput > 0,
  );
  assert.equal(owners.length, 1, 'shared private state is hoisted exactly once by actual esbuild');
});

test('also accepts one-output ESM build during the migration', async () => {
  const value = await fixture(false);
  assert.equal(checkBundleClosure(value).outputs.length, 1);
});

test('literal/comment/regex/template import-looking text and hashbang text are data', () => {
  const value = candidate();
  append(
    value,
    'const data = ["require(\\"nope\\")", "#!", /import("nope")/, `import("nope")`];\n' +
      '/* import("nope"); require("nope"); */ console.log(data);',
  );
  checkBundleClosure(value);
});

test('removing an emitted lazy chunk refuses even with complete build metadata', () => {
  const value = candidate();
  delete value.files[lazyFile(value)];
  refuses(value, 'MISSING_OUTPUT');
});

test('removing a chunk from both inventories still refuses its loading edge', () => {
  const value = candidate();
  const path = lazyFile(value);
  delete value.files[path];
  delete value.metafile.outputs[path];
  refuses(value, 'MISSING_CHUNK');
});

for (const path of ['dist/stale.js', 'dist/nested/hidden.js', 'dist/extra.mjs', 'dist/extra.cjs']) {
  test(`extra on-disk JavaScript is refused: ${path}`, () => {
    const value = candidate();
    value.files[path] = { contents: 'export {};', mode: 0o644 };
    refuses(value, 'EXTRA_OUTPUT');
  });
}

test('an unreferenced output present in both inventories is refused', () => {
  const value = candidate();
  value.files['dist/orphan.js'] = { contents: 'export {};', mode: 0o644 };
  value.metafile.outputs['dist/orphan.js'] = {
    imports: [],
    exports: [],
    inputs: {},
    bytes: Buffer.byteLength('export {};'),
  };
  refuses(value, 'UNREFERENCED_OUTPUT');
});

for (const path of [
  'dist/nested/a.js',
  '../evil.js',
  '/tmp/evil.js',
  'dist/../evil.js',
  'dist/a.mjs',
]) {
  test(`metadata output must be flat, relative JS: ${path}`, () => {
    const value = candidate();
    value.metafile.outputs[path] = { imports: [], exports: [], inputs: {}, bytes: 0 };
    refuses(value, 'OUTPUT_PATH');
  });
}

for (const specifier of [
  '../outside.js',
  '/tmp/outside.js',
  'file:///tmp/a.js',
  './nested/a.js',
  './a.js?x',
  './%2e%2e/a.js',
]) {
  test(`actual lazy loading rejects escaping/unsupported path ${specifier}`, () => {
    const value = candidate();
    append(value, `void import(${JSON.stringify(specifier)});`);
    assert.throws(() => checkBundleClosure(value), BundleClosureError);
  });
}

test('a relative external cannot disguise an unbundled chunk', () => {
  const value = candidate();
  value.metafile.outputs['dist/index.js'].imports.push({
    path: './outside.js',
    kind: 'dynamic-import',
    external: true,
  });
  refuses(value, 'EXTERNAL_CHUNK');
});

for (const specifier of [
  'unlisted',
  '@other/sdk/client.js',
  '@relavium/core',
  '@relavium/db/subpath',
]) {
  test(`actual lazy imports independently enforce declarations/private engine: ${specifier}`, () => {
    const value = candidate();
    append(value, `void import(${JSON.stringify(specifier)});`);
    refuses(value, specifier.startsWith('@relavium/') ? 'PRIVATE_EXTERNAL' : 'UNDECLARED_EXTERNAL');
  });
}

test('metadata-only undeclared lazy external cannot hide behind changed JS', () => {
  const value = candidate();
  value.metafile.outputs[lazyFile(value)].imports.push({
    path: 'unlisted',
    kind: 'dynamic-import',
    external: true,
  });
  refuses(value, 'UNDECLARED_EXTERNAL');
});

test('a dead manifest declaration is refused even if a tree-shaken input mentions it', () => {
  const value = candidate();
  value.manifest.dependencies.stale = '1';
  value.metafile.inputs['src/tail.ts'].imports.push({
    path: 'stale',
    kind: 'dynamic-import',
    external: true,
  });
  refuses(value, 'DEAD_DEPENDENCY');
});

for (const specifier of ['node:not-a-builtin', 'fs/not-a-builtin', 'node:fs/not-a-builtin']) {
  test(`builtin authority uses the full specifier: ${specifier}`, () => {
    const value = candidate();
    append(value, `void import(${JSON.stringify(specifier)});`);
    refuses(value, 'EXTERNAL_PATH');
  });
}

test('actual reexports are loading edges, independently of metadata', () => {
  const value = candidate();
  append(value, 'export * from "node:crypto";');
  refuses(value, 'IMPORT_DRIFT');
});

test('a metadata import absent from JavaScript is refused', () => {
  const value = candidate();
  value.metafile.outputs[lazyFile(value)].imports.push({
    path: 'node:os',
    kind: 'import-statement',
    external: true,
  });
  refuses(value, 'IMPORT_DRIFT');
});

test('removing the metadata edge alone also refuses', () => {
  const value = candidate();
  value.metafile.outputs['dist/index.js'].imports.pop();
  refuses(value, 'IMPORT_DRIFT');
});

for (const expression of [
  'process.argv[2]',
  '"./" + name',
  'new URL("./tail.js", import.meta.url)',
  '`./tail.js`',
]) {
  test(`nonliteral dynamic import refuses: ${expression}`, () => {
    const value = candidate();
    append(value, `void import(${expression});`);
    refuses(value, 'NONLITERAL_IMPORT');
  });
}

test('import options require an explicit future review', () => {
  const value = candidate();
  append(value, 'void import("commander", {with: {type: "json"}});');
  refuses(value, 'UNKNOWN_LOADER');
});

for (const loader of [
  'require("commander")',
  '__require("commander")',
  'module.require("commander")',
  'globalThis["require"]("commander")',
  '(0, eval)("import(\\"hidden\\")")',
  'new Function("return import(\\"hidden\\")")',
  'process.getBuiltinModule("module")',
  'process.dlopen({}, "/tmp/addon.node")',
  'import {Worker as W} from "node:worker_threads"; new W("./hidden.js")',
  'new Worker("./hidden.js")',
  'import {createRequire as r} from "node:module"; r(import.meta.url)("hidden")',
  'import Module from "module"; Module._load("hidden")',
  'import * as loader from "node:module"',
  'import {register as r} from "node:module"',
  'void import("node:module")',
  'import {runInNewContext as r} from "node:vm"',
]) {
  test(`unreviewed loading capability refuses: ${loader}`, () => {
    const value = candidate();
    append(value, `${loader};`);
    refuses(value, 'UNKNOWN_LOADER');
  });
}

for (const kind of ['require-call', 'require-resolve', 'file-loader', 'new-kind']) {
  test(`unknown metadata loader kind refuses in every input and output: ${kind}`, () => {
    for (const metadata of [true, false]) {
      const value = candidate();
      const imports = metadata
        ? value.metafile.inputs['src/tail.ts'].imports
        : value.metafile.outputs[lazyFile(value)].imports;
      imports.push({ path: 'commander', kind, external: true });
      refuses(value, 'LOADER_KIND');
    }
  });
}

test('malformed JavaScript cannot be certified by valid metadata', () => {
  const value = candidate();
  append(value, 'export const broken = ;');
  refuses(value, 'JS_SYNTAX');
});

test('missing input references and absent contributed input refuse', () => {
  const value = candidate();
  value.metafile.inputs['src/tail.ts'].imports.push({
    path: 'src/absent.ts',
    kind: 'import-statement',
  });
  refuses(value, 'MISSING_INPUT');
  const other = candidate();
  other.metafile.outputs[lazyFile(other)].inputs['src/absent.ts'] = { bytesInOutput: 1 };
  refuses(other, 'MISSING_INPUT');
});

test('one authority input cannot be independently copied into another output', () => {
  const value = candidate();
  value.metafile.outputs['dist/index.js'].inputs['src/authority.ts'] = { bytesInOutput: 1 };
  refuses(value, 'DUPLICATE_INPUT');
});

test('source path aliases cannot claim an independently bundled authority', () => {
  const value = candidate();
  value.metafile.inputs['src/other/../authority.ts'] = JSON.parse(
    JSON.stringify(value.metafile.inputs['src/authority.ts']),
  );
  refuses(value, 'INPUT_PATH');
});

test('third-party implementations and CommonJS inputs are refused', () => {
  const value = candidate();
  value.metafile.inputs['node_modules/commander/index.js'] = {
    format: 'esm',
    bytes: 1,
    imports: [],
  };
  refuses(value, 'BUNDLED_DEPENDENCY');
  const other = candidate();
  other.metafile.inputs['src/authority.ts'].format = 'cjs';
  refuses(other, 'INPUT_FORMAT');
});

test('entry inventory requires exactly the configured entry', () => {
  const value = candidate();
  value.metafile.outputs['dist/index.js'].entryPoint = 'src/runtime.ts';
  refuses(value, 'ENTRY_POINT');
  const other = candidate();
  other.metafile.outputs[lazyFile(other)].entryPoint = 'src/index.ts';
  refuses(other, 'ENTRY_POINT');
});

test('JS byte drift, unexpected permissions and hashbang drift each refuse', () => {
  const byteDrift = candidate();
  byteDrift.files[lazyFile(byteDrift)].contents += ' ';
  refuses(byteDrift, 'OUTPUT_BYTES');
  for (const entry of [true, false]) {
    const value = candidate();
    const path = entry ? 'dist/index.js' : lazyFile(value);
    value.files[path].mode = entry ? 0o644 : 0o755;
    refuses(value, 'OUTPUT_MODE');
    const other = candidate();
    setContents(
      other,
      path,
      entry
        ? other.files[path].contents.replace('#!', '//')
        : '#!/usr/bin/env node\n' + other.files[path].contents,
    );
    refuses(other, 'HASHBANG');
  }
});

test('a symbolic link cannot satisfy an emitted runtime file', () => {
  const value = candidate();
  value.files[lazyFile(value)].kind = 'symlink';
  refuses(value, 'OUTPUT_KIND');
});

for (const mutate of [
  (value) => {
    value.metafile.inputs = [];
  },
  (value) => {
    value.metafile.outputs = null;
  },
  (value) => {
    value.manifest.dependencies = null;
  },
  (value) => {
    value.metafile.inputs['src/index.ts'].bytes = -1;
  },
  (value) => {
    value.metafile.inputs['src/index.ts'].imports = null;
  },
  (value) => {
    value.metafile.outputs['dist/index.js'].exports = [7];
  },
  (value) => {
    value.metafile.outputs['dist/index.js'].inputs = null;
  },
]) {
  test('malformed independent inventory shape refuses', () => {
    const value = candidate();
    mutate(value);
    refuses(value, 'METADATA_SHAPE');
  });
}

test('thin CLI inventories actual files from its package root and refuses missing/extra/symlink chunks', () => {
  const root = mkdtempSync(join(scratch, 'adapter-'));
  const tooling = join(root, 'tools/bundle-closure');
  const pkg = join(root, 'apps/cli');
  mkdirSync(tooling, { recursive: true });
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  symlinkSync(
    fileURLToPath(new URL('../../node_modules', import.meta.url)),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  for (const name of ['check.mjs', 'closure.mjs']) {
    copyFileSync(fileURLToPath(new URL(name, import.meta.url)), join(tooling, name));
  }
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(original.manifest));
  writeFileSync(join(pkg, 'dist/metafile-esm.json'), JSON.stringify(original.metafile));
  for (const [path, file] of Object.entries(original.files)) {
    writeFileSync(join(pkg, path), file.contents);
    chmodSync(join(pkg, path), file.mode);
  }
  function run() {
    const result = spawnSync(process.execPath, [join(tooling, 'check.mjs')], {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    return result;
  }
  assert.equal(run().status, 0);
  writeFileSync(join(pkg, 'dist/extra.js'), 'export {};');
  assert.match(run().stderr, /EXTRA_OUTPUT/u);
  rmSync(join(pkg, 'dist/extra.js'));
  const lazy = join(pkg, lazyFile(original));
  rmSync(lazy);
  assert.match(run().stderr, /MISSING_OUTPUT/u);
  symlinkSync(join(pkg, 'dist/index.js'), lazy);
  assert.match(run().stderr, /OUTPUT_KIND/u);
  rmSync(lazy);
  writeFileSync(lazy, original.files[lazyFile(original)].contents);
  chmodSync(lazy, 0o644);
  const linkedDirectory = join(pkg, 'dist/linked');
  symlinkSync(dirname(lazy), linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(run().stderr, /OUTPUT_KIND/u);
});

test('POSIX modes require actual evidence; Windows graph evidence is explicitly narrower', () => {
  const value = candidate();
  delete value.files['dist/index.js'].mode;
  refuses(value, 'OUTPUT_MODE');
  const windows = candidate();
  windows.modeEvidence = 'not-observable-windows';
  refuses(windows, 'MODE_EVIDENCE');
  for (const file of Object.values(windows.files)) delete file.mode;
  assert.equal(checkBundleClosure(windows).modeEvidence, 'not-observable-windows');
  const missing = candidate();
  missing.modeEvidence = 'unverified';
  refuses(missing, 'MODE_EVIDENCE');
});
