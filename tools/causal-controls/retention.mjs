/** Bounded metadata-only evidence with primary-failure-preserving cleanup. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { json } from '../usage-coverage-controls/source-graph.mjs';
const maxFiles = 2000,
  maxBytes = 64 * 1024 * 1024;

export function exportMetadata({ directory, scratch, repository, evidenceKind, summary }) {
  assert.ok(['filesystem', 'secrets'].includes(evidenceKind), 'Unknown evidence family');
  if (directory === undefined) return;
  let ancestor = resolve(directory);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const base = resolve(realpathSync(ancestor), relative(ancestor, resolve(directory)));
  const destination = join(base, evidenceKind);
  for (const root of [repository, scratch]) {
    const delta = relative(realpathSync(root), destination);
    assert.ok(
      delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta),
      'Evidence must be outside repository and scratch',
    );
  }
  assert.ok(!existsSync(destination), 'Evidence destination already exists');
  const entries = [];
  let bytes = 0;
  function collect(dir, rel = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['graph', 'cache', 'home'].includes(entry.name)) continue;
      const source = join(dir, entry.name),
        path = join(rel, entry.name);
      assert.ok(!lstatSync(source).isSymbolicLink(), 'Metadata must not be symlinked');
      if (entry.isDirectory()) collect(source, path);
      else if (entry.isFile() && /\.(json|jsonl|log)$/.test(entry.name)) {
        const content = readFileSync(source);
        entries.push({ path, content });
        bytes += content.length;
        assert.ok(entries.length + 1 <= maxFiles && bytes <= maxBytes, 'Metadata export bound');
      }
    }
  }
  collect(scratch);
  const metadata = Buffer.from(
    JSON.stringify({ version: 1, files: entries.length, bytes, report: summary }, null, 2) + '\n',
  );
  assert.ok(bytes + metadata.length <= maxBytes, 'Metadata export bound');
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(destination);
  for (const entry of entries) {
    mkdirSync(dirname(join(destination, entry.path)), { recursive: true });
    writeFileSync(join(destination, entry.path), entry.content, { flag: 'wx' });
  }
  writeFileSync(join(destination, 'export.json'), metadata, { flag: 'wx' });
}
export function finish({ scratch, summary, primaryFailure, directory, repository, evidenceKind }) {
  try {
    json(join(scratch, 'summary.json'), summary);
  } catch (error) {
    primaryFailure ??= error;
  }
  try {
    exportMetadata({ scratch, summary, directory, repository, evidenceKind });
  } catch (error) {
    primaryFailure ??= error;
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    primaryFailure ??= error;
  }
  return primaryFailure;
}
