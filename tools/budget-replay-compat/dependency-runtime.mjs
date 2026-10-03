/** Both loader threads and the worker's CommonJS calls use this exact copied-file fence. */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import Module, { createRequire, isBuiltin } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
const files = new Map(
  JSON.parse(readFileSync(join(root, 'dependency-runtime.json'), 'utf8')).files.map((file) => [
    file.path,
    file,
  ]),
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function verifyDependencyFile(path) {
  const actual = realpathSync(path);
  const name = relative(root, actual).split(sep).join('/');
  const expected = files.get(name);
  if (!expected) throw new Error(`Unpinned runtime dependency: ${actual}`);
  const bytes = readFileSync(actual);
  if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256)
    throw new Error(`Runtime dependency bytes changed: ${actual}`);
  appendFileSync(
    join(root, 'logs', `${process.env.COMPAT_LABEL}.dependencies.jsonl`),
    `${JSON.stringify({ path: name, sha256: expected.sha256, platformNative: expected.platformNative === true })}\n`,
  );
  return actual;
}

// module.require is the CommonJS entry point; createRequire.resolve asks Node's real resolver without
// executing the target. Guard before invoking the original method, including JSON and native addons.
// The public method is wrapped in BOTH the worker and loader thread. No private Node loader API is used.
const originalRequire = Module.prototype.require;
Module.prototype.require = function requirePinnedDependency(specifier) {
  if (!isBuiltin(specifier)) {
    const resolved = createRequire(this.filename).resolve(specifier);
    verifyDependencyFile(resolved);
  }
  return originalRequire.call(this, specifier);
};
