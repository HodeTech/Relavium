/** Physical byte capture and the shared Node/Vite source boundary for ADR-0104 controls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import Module, { createRequire, isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { systemTool } from '../budget-replay-compat/system-tools.mjs';

export const aliases = Object.freeze({
  '@relavium/shared': 'packages/shared/src/index.ts',
  '@relavium/llm': 'packages/llm/src/index.ts',
  '@relavium/llm/adapters': 'packages/llm/src/adapters/index.ts',
  '@relavium/core': 'packages/core/src/index.ts',
  '@relavium/db': 'packages/db/src/index.ts',
  '@relavium/mcp': 'packages/mcp/src/index.ts',
});
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const portable = (path) => path.split(sep).join('/');
const within = (root, path) => path === root || path.startsWith(`${root}${sep}`);
const packages = [
  'packages/shared',
  'packages/llm',
  'packages/core',
  'packages/db',
  'packages/mcp',
  'apps/cli',
];
const sourceRoots = [
  ...packages.map((p) => `${p}/src`),
  'packages/db/drizzle',
  'tools/usage-coverage-controls',
  'tools/budget-replay-compat',
];
const rootFiles = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'vitest.config.ts',
];
function git(repository, args) {
  const run = spawnSync(systemTool('git'), ['-C', repository, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}
function names(repository) {
  return git(repository, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    ...sourceRoots,
    ...rootFiles,
    ...packages.map((p) => `${p}/*.json`),
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
}
export function sourceState(repository) {
  const files = names(repository).map((path) => {
    const physical = join(repository, path);
    assert.ok(lstatSync(physical).isFile(), `Owned source must be a physical file: ${path}`);
    const bytes = readFileSync(physical);
    return { path, bytes: bytes.length, sha256: digest(bytes) };
  });
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    index: digest(git(repository, ['ls-files', '--stage', '-z'])),
    files,
  };
}
export function captureSource(repository, destination) {
  const before = sourceState(repository);
  for (const file of before.files) {
    const target = join(destination, file.path);
    mkdirSync(dirname(target), { recursive: true });
    const bytes = readFileSync(join(repository, file.path));
    assert.equal(digest(bytes), file.sha256, `Source changed during capture: ${file.path}`);
    writeFileSync(target, bytes, { flag: 'wx' });
    assert.notEqual(
      statSync(target).ino,
      statSync(join(repository, file.path)).ino,
      'Source copy shares an inode',
    );
  }
  assert.deepEqual(sourceState(repository), before, 'Developer source changed during capture');
  return before;
}
export function verifyFiles(root, files) {
  for (const file of files) {
    const target = join(root, file.path);
    assert.ok(lstatSync(target).isFile(), `Source no longer physical: ${target}`);
    const bytes = readFileSync(target);
    assert.equal(bytes.length, file.bytes, `Source size changed: ${target}`);
    assert.equal(digest(bytes), file.sha256, `Source bytes changed: ${target}`);
  }
}

/** Resolve physical external packages without admitting workspace src/dist through node_modules. */
export function captureDependencies(repository) {
  const roots = new Map();
  const pins = [];
  function visit(root) {
    root = realpathSync(root);
    if (!within(join(repository, 'node_modules', '.pnpm'), root))
      throw new Error(`External dependency is not installed physical package: ${root}`);
    if (roots.has(root)) return;
    const packageBytes = readFileSync(join(root, 'package.json'));
    const info = JSON.parse(packageBytes);
    const pin = {
      root,
      name: info.name,
      version: info.version,
      packageSha256: digest(packageBytes),
    };
    roots.set(root, pin);
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.cache' || entry.name === '.vite')
          continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) {
          const bytes = readFileSync(path);
          pins.push({ path, bytes: bytes.length, sha256: digest(bytes), packageRoot: root });
        } else if (entry.isSymbolicLink()) {
          // Package-internal links are permitted only when their physical file remains inside that package.
          const physical = realpathSync(path);
          assert.ok(within(root, physical), `External package link escapes: ${path}`);
        }
      }
    };
    walk(root);
    const require = createRequire(join(root, 'package.json'));
    for (const name of Object.keys({
      ...info.dependencies,
      ...info.optionalDependencies,
      ...info.peerDependencies,
    })) {
      if (isBuiltin(name)) continue;
      for (const base of require.resolve.paths(name) ?? []) {
        const candidate = join(base, name);
        if (existsSync(join(candidate, 'package.json'))) {
          visit(candidate);
          break;
        }
      }
    }
  }
  for (const home of ['', ...packages]) {
    const directory = join(repository, home, 'node_modules');
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith('.') || entry === '@relavium') continue;
      const root = join(directory, entry);
      if (entry.startsWith('@')) {
        for (const name of readdirSync(root)) visit(join(root, name));
      } else if (existsSync(join(root, 'package.json'))) visit(root);
    }
  }
  return {
    packages: [...roots.values()].sort((a, b) => a.root.localeCompare(b.root)),
    files: pins.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
export function linkDependencies(repository, graph) {
  for (const home of ['', ...packages]) {
    const source = join(repository, home, 'node_modules');
    if (existsSync(source))
      symlinkSync(
        source,
        join(graph, home, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
  }
}

export function runtimeState() {
  const controlPath = process.env.RELAVIUM_USAGE_RUNTIME;
  assert.ok(controlPath, 'RELAVIUM_USAGE_RUNTIME is required');
  const control = JSON.parse(readFileSync(controlPath, 'utf8'));
  const manifestBytes = readFileSync(control.manifestPath);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(digest(manifestBytes), control.manifestSha256, 'Source manifest changed');
  const dependencyBytes = readFileSync(control.dependencyManifestPath);
  assert.equal(
    digest(dependencyBytes),
    control.dependencyManifestSha256,
    'Dependency manifest changed',
  );
  const dependencies = JSON.parse(dependencyBytes);
  const files = new Map(manifest.files.map((f) => [join(manifest.sourceRoot, f.path), f]));
  const external = new Map(dependencies.files.map((f) => [f.path, f]));
  const infrastructure = new Map(control.infrastructure.map((f) => [f.path, f]));
  return {
    ...control,
    sourceRoot: manifest.sourceRoot,
    files,
    external,
    infrastructure,
    admitted: new Set(),
  };
}
export function verifyResolved(state, path) {
  const physical = realpathSync(path);
  const entry =
    state.files.get(physical) ?? state.external.get(physical) ?? state.infrastructure.get(physical);
  assert.ok(entry, `USAGE_SOURCE_ESCAPE: ${physical}`);
  const bytes = readFileSync(physical);
  assert.equal(bytes.length, entry.bytes, `USAGE_SOURCE_SIZE_CHANGED: ${physical}`);
  assert.equal(digest(bytes), entry.sha256, `USAGE_SOURCE_BYTES_CHANGED: ${physical}`);
  if (state.external.has(physical) && !state.admitted.has(physical)) {
    state.admitted.add(physical);
    appendFileSync(
      join(state.evaluationDirectory, `${process.pid}.dependencies.jsonl`),
      `${JSON.stringify({
        ...entry,
        pid: process.pid,
        stage: 'dependency-load-verification',
      })}\n`,
    );
  }
  return { physical, entry, bytes, owned: state.files.has(physical) };
}
export function rejectUnknownAlias(specifier) {
  if (specifier.startsWith('@relavium/') && !Object.hasOwn(aliases, specifier))
    throw new Error(`USAGE_UNKNOWN_WORKSPACE_ALIAS: ${specifier}`);
}
export function installRequireFence(state) {
  const original = Module.prototype.require;
  Module.prototype.require = function requireOwned(specifier) {
    rejectUnknownAlias(specifier);
    if (!isBuiltin(specifier))
      verifyResolved(state, createRequire(this.filename).resolve(specifier));
    return original.call(this, specifier);
  };
}
export function relativeSource(state, specifier, importer) {
  if (Object.hasOwn(aliases, specifier)) return join(state.sourceRoot, aliases[specifier]);
  if (!specifier.startsWith('.') || !importer || !within(state.sourceRoot, importer))
    return undefined;
  const original = resolve(dirname(importer), specifier);
  if (existsSync(original)) return original;
  if (original.endsWith('.js'))
    for (const extension of ['.ts', '.tsx']) {
      const candidate = `${original.slice(0, -3)}${extension}`;
      if (existsSync(candidate)) return candidate;
    }
  return undefined;
}

/** Synthetic AST nodes preserve original source positions/maps; runtime records raw physical bytes. */
export function instrument(state, path) {
  const checked = verifyResolved(state, path);
  const require = createRequire(join(state.sourceRoot, 'package.json'));
  const ts = require('typescript');
  const source = checked.bytes.toString('utf8');
  let name = `__relaviumUsageEvaluation_${checked.entry.sha256.slice(0, 12)}`;
  while (source.includes(name)) name += '_';
  const metadata = {
    sourceMode: 'current',
    physicalPath: checked.physical,
    relativePath: portable(relative(state.sourceRoot, checked.physical)),
    rawSha256: checked.entry.sha256,
    bytes: checked.entry.bytes,
    manifestSha256: state.manifestSha256,
    phase: state.phase,
    mutationId: state.mutationId,
  };
  const header = `import { recordEvaluation as ${name} } from ${JSON.stringify(state.evaluationHelper)};\n${name}(${JSON.stringify(metadata)});\n`;
  const nodes = ts.createSourceFile(
    'usage-evaluation-header.mjs',
    header,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  ).statements;
  const result = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      isolatedModules: true,
      sourceMap: true,
      inlineSources: true,
    },
    transformers: {
      before: [
        () => (file) => {
          const synthetic = (node) => {
            ts.setTextRange(node, { pos: -1, end: -1 });
            ts.forEachChild(node, synthetic);
          };
          for (const node of nodes) synthetic(node);
          return ts.factory.updateSourceFile(file, [...nodes, ...file.statements]);
        },
      ],
    },
    reportDiagnostics: true,
  });
  assert.equal(
    (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error).length,
    0,
    `USAGE_SOURCE_TRANSPILE_FAILED: ${path}`,
  );
  const map = JSON.parse(result.sourceMapText);
  map.sources = [path];
  const code = result.outputText.replace(/\/\/# sourceMappingURL=.*$/m, '');
  return { code, map };
}
function physicalId(id) {
  if (id.startsWith('\0') || id.startsWith('/@vite/') || id.startsWith('/@id/')) return undefined;
  const [path, query] = id.split('?');
  if (query !== undefined && !/^(?:v=[\w-]+|import|direct|raw|url)$/.test(query))
    throw new Error(`USAGE_UNKNOWN_SOURCE_QUERY: ${id}`);
  return path.startsWith('file:')
    ? fileURLToPath(path)
    : path.startsWith('/@fs/')
      ? path.slice(4)
      : isAbsolute(path)
        ? path
        : undefined;
}
export function sourcePlugin() {
  const state = runtimeState();
  return {
    name: 'relavium-usage-owned-source',
    enforce: 'pre',
    async resolveId(specifier, importer) {
      rejectUnknownAlias(specifier);
      const mapped = relativeSource(state, specifier, importer && physicalId(importer));
      if (mapped !== undefined) {
        verifyResolved(state, mapped);
        return mapped;
      }
      const result = await this.resolve(specifier, importer, { skipSelf: true });
      if (result !== null) {
        const path = physicalId(result.id);
        if (path && existsSync(path)) verifyResolved(state, path);
      }
      return result;
    },
    transform(_code, id) {
      const path = physicalId(id);
      if (!path || !existsSync(path)) return undefined;
      const checked = verifyResolved(state, path);
      if (
        !checked.owned ||
        !/\.(?:[cm]?[jt]s|tsx)$/.test(path) ||
        path.includes('/tools/usage-coverage-controls/')
      )
        return undefined;
      return instrument(state, path);
    },
  };
}
export const toUrl = (path) => pathToFileURL(path).href;
