/** Freeze actual Node lookup edges before running either source version. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const portable = (path) => path.split(sep).join('/');
const kinds = ['dependencies', 'optionalDependencies', 'peerDependencies'];

function lookup(root, name) {
  const paths = createRequire(join(root, 'package.json')).resolve.paths(name) ?? [];
  for (const base of paths) {
    const candidate = join(base, name);
    if (existsSync(candidate)) return realpathSync(candidate);
    // An anonymous CommonJS file must not be mistaken for an absent optional package.
    for (const extension of ['.js', '.json', '.node'])
      assert.ok(!existsSync(`${candidate}${extension}`), `unpackaged dependency: ${name}`);
  }
  return undefined;
}

function portableFiles(root, native) {
  const files = [];
  function walk(path) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.name === 'node_modules' || (native && child === 'build')) continue;
      if (entry.isDirectory()) walk(child);
      else {
        assert.ok(entry.isFile(), `unexpected dependency symlink: ${child}`);
        files.push(portable(child));
      }
    }
  }
  walk('');
  return files.sort((a, b) => a.localeCompare(b));
}

function declaredEdges(metadata) {
  return kinds.flatMap((kind) =>
    Object.entries(metadata[kind] ?? {}).map(([name, specifier]) => ({
      kind,
      name,
      specifier,
      optional:
        kind === 'optionalDependencies' ||
        (kind === 'peerDependencies' && metadata.peerDependenciesMeta?.[name]?.optional === true),
    })),
  );
}

function verifyEdges(root, pin, roots) {
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const expected = new Map(pin.edges.map((edge) => [`${edge.kind}/${edge.name}`, edge]));
  const declared = declaredEdges(metadata);
  assert.equal(expected.size, pin.edges.length, `duplicate edge: ${pin.name}`);
  assert.equal(declared.length, expected.size, `edge inventory: ${pin.name}`);
  for (const edge of declared) {
    const frozen = expected.get(`${edge.kind}/${edge.name}`);
    assert.ok(frozen, `unrecorded edge: ${pin.name}/${edge.name}`);
    assert.equal(edge.specifier, frozen.specifier);
    assert.equal(edge.optional, frozen.optional);
    if (isBuiltin(edge.name)) {
      assert.equal(frozen.builtin, true, `${pin.name}/${edge.name}`);
      assert.equal(frozen.target, undefined);
      assert.equal(frozen.absent, undefined);
      continue;
    }
    assert.equal(frozen.builtin, undefined);
    const actual = lookup(root, edge.name);
    if (frozen.absent) {
      assert.equal(edge.optional, true);
      assert.equal(frozen.target, undefined);
      assert.equal(actual, undefined, `previously absent optional edge: ${pin.name}/${edge.name}`);
    } else {
      assert.ok(roots.has(frozen.target), `unpinned target: ${pin.name}/${edge.name}`);
      assert.equal(
        actual,
        roots.get(frozen.target),
        `dependency edge changed: ${pin.name}/${edge.name}`,
      );
    }
  }
}

export function snapshotDependencyClosure(repository, owned, pins) {
  assert.equal(pins.schemaVersion, 2);
  const installed = new Map();
  const copied = new Map();
  const files = [];
  for (const pin of pins.packages) {
    assert.ok(pin.relativePackageRoot.startsWith('node_modules/'));
    const root = resolve(repository, pin.relativePackageRoot);
    assert.equal(portable(relative(repository, root)), pin.relativePackageRoot);
    assert.equal(realpathSync(root), root, `package root redirected: ${pin.name}`);
    assert.ok(!installed.has(pin.relativePackageRoot));
    installed.set(pin.relativePackageRoot, root);
    const target = join(owned, 'dependencies', pin.relativePackageRoot);
    copied.set(pin.relativePackageRoot, target);
    const metadata = readFileSync(join(root, 'package.json'));
    assert.equal(digest(metadata), pin.packageJsonSha256, pin.name);
    const parsed = JSON.parse(metadata.toString('utf8'));
    assert.equal(parsed.name, pin.name);
    assert.equal(parsed.version, pin.version);
    assert.equal(pin.baselineLockPackageKey, `${pin.name}@${pin.version}`);
    assert.deepEqual(
      portableFiles(root, pin.name === 'better-sqlite3'),
      pin.files.map((file) => file.path),
      `portable file inventory: ${pin.name}`,
    );
    for (const file of pin.files) {
      const source = resolve(root, file.path);
      assert.equal(portable(relative(root, source)), file.path);
      const bytes = readFileSync(source);
      assert.equal(bytes.length, file.bytes, `${pin.name}/${file.path}`);
      assert.equal(digest(bytes), file.sha256, `${pin.name}/${file.path}`);
      const destination = join(target, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
      files.push({
        ...file,
        path: portable(relative(owned, destination)),
        package: pin.relativePackageRoot,
      });
    }
    if (pin.name === 'better-sqlite3') {
      // The native build remains the documented platform exception, captured and hashed for THIS run.
      const path = 'build/Release/better_sqlite3.node';
      const bytes = readFileSync(join(root, path));
      const destination = join(target, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
      files.push({
        path: portable(relative(owned, destination)),
        bytes: bytes.length,
        sha256: digest(bytes),
        package: pin.relativePackageRoot,
        platformNative: true,
      });
    }
  }
  // No package code has executed. Bind installed CJS, ESM, peer, optional and missing edges first.
  for (const pin of pins.packages)
    verifyEdges(installed.get(pin.relativePackageRoot), pin, installed);
  for (const pin of pins.packages) {
    const root = copied.get(pin.relativePackageRoot);
    for (const edge of pin.edges) {
      if (edge.builtin || edge.absent) continue;
      const link = join(root, 'node_modules', edge.name);
      if (existsSync(link)) {
        assert.equal(realpathSync(link), copied.get(edge.target));
        continue;
      }
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(copied.get(edge.target), link, 'dir');
    }
  }
  for (const entry of pins.rootImports) {
    assert.ok(copied.has(entry.target), entry.name);
    const link = join(owned, 'node_modules', entry.name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(copied.get(entry.target), link, 'dir');
  }
  // Check the reconstructed lookup, including absent edges, so root imports cannot change a peer's presence.
  for (const pin of pins.packages) verifyEdges(copied.get(pin.relativePackageRoot), pin, copied);
  const runtime = {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    packages: pins.packages.map(({ name, relativePackageRoot, edges }) => ({
      name,
      relativePackageRoot,
      edges,
    })),
    rootImports: pins.rootImports,
  };
  writeFileSync(join(owned, 'dependency-runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`);
  return runtime;
}
