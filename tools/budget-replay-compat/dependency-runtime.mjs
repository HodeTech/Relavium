/** Both loader threads and the worker's CommonJS calls use this exact copied-file fence. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import Module, { createRequire, isBuiltin } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
const runtime = JSON.parse(readFileSync(join(root, 'dependency-runtime.json'), 'utf8'));
const files = new Map(runtime.files.map((file) => [file.path, file]));
const packages = new Map(runtime.packages.map((pin) => [pin.relativePackageRoot, pin]));
const rootImports = new Map(runtime.rootImports.map((entry) => [entry.name, entry.target]));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileName = (path) => relative(root, realpathSync(path)).split(sep).join('/');
const packageRoot = (pin) => join(root, 'dependencies', pin.relativePackageRoot);

function lookup(pin, name) {
  const paths = createRequire(join(packageRoot(pin), 'package.json')).resolve.paths(name) ?? [];
  for (const base of paths) {
    const candidate = join(base, name);
    if (existsSync(candidate)) return realpathSync(candidate);
    for (const extension of ['.js', '.json', '.node'])
      if (existsSync(`${candidate}${extension}`))
        throw new Error(`Unpackaged runtime dependency: ${pin.name}/${name}`);
  }
  return undefined;
}

// Recheck before package code can run, including optional presence checks made with require.resolve.
// A cached preflight result cannot prove that the copied lookup graph stayed unchanged afterwards.
function verifyPackageEdges(pin) {
  for (const edge of pin.edges) {
    if (edge.builtin) continue;
    const actual = lookup(pin, edge.name);
    const target = packages.get(edge.target);
    if (edge.absent ? actual !== undefined : !target || actual !== packageRoot(target))
      throw new Error(`Runtime dependency edge changed: ${pin.name}/${edge.name}`);
  }
}

export function verifyDependencyFile(path) {
  const actual = realpathSync(path);
  const name = fileName(actual);
  const expected = files.get(name);
  if (!expected) throw new Error(`Unpinned runtime dependency: ${actual}`);
  const bytes = readFileSync(actual);
  if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256)
    throw new Error(`Runtime dependency bytes changed: ${actual}`);
  const pin = packages.get(expected.package);
  if (pin) verifyPackageEdges(pin);
  appendFileSync(
    join(root, 'logs', `${process.env.COMPAT_LABEL}.dependencies.jsonl`),
    `${JSON.stringify({ path: name, sha256: expected.sha256, platformNative: expected.platformNative === true })}\n`,
  );
  return actual;
}

/** Bind Node's actual target to THIS issuer's edge, rather than membership in the global file set. */
export function verifyDependencyResolution(parentPath, specifier, resolved) {
  const actual = verifyDependencyFile(resolved);
  const target = files.get(fileName(actual));
  const parent = parentPath === undefined ? undefined : files.get(fileName(parentPath));
  const issuer = packages.get(parent?.package);
  if (issuer) verifyPackageEdges(issuer);
  const bare =
    !specifier.startsWith('.') &&
    !specifier.startsWith('#') &&
    !specifier.startsWith('file:') &&
    !isAbsolute(specifier);
  if (bare) {
    const parts = specifier.split('/');
    const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const edge = issuer?.edges.find((entry) => entry.name === name);
    const expected = issuer
      ? name === issuer.name
        ? issuer.relativePackageRoot
        : edge?.absent || edge?.builtin
          ? undefined
          : edge?.target
      : rootImports.get(name);
    if (expected === undefined || target.package !== expected)
      throw new Error(`Runtime dependency resolution changed: ${issuer?.name ?? 'worker'}/${name}`);
  } else if (parent?.package !== target.package && target.platformNative !== true) {
    // bindings resolves the captured SQLite addon by absolute filename. That invocation-hashed native
    // exception cannot admit another portable package or an arbitrary file through a relative import.
    throw new Error(`Runtime dependency import crossed package ownership: ${specifier}`);
  }
  return actual;
}

// module.require is the CommonJS entry point; createRequire.resolve asks Node's real resolver without
// executing the target. Guard before invoking the original method, including JSON and native addons.
// The public method is wrapped in BOTH the worker and loader thread. No private Node loader API is used.
const originalRequire = Module.prototype.require;
Module.prototype.require = function requirePinnedDependency(specifier) {
  if (!isBuiltin(specifier)) {
    const resolved = createRequire(this.filename).resolve(specifier);
    verifyDependencyResolution(this.filename, specifier, resolved);
  }
  return originalRequire.call(this, specifier);
};
