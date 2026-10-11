import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function physicalDestination(path) {
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, path));
}

/** Optional bounded CI metadata export. Never archives the copied graph, native DBs, caches or dependency bytes. */
export function exportAcceptanceEvidence({
  repository,
  scratch,
  kind,
  report,
  directory = process.env.RELAVIUM_ACCEPTANCE_EVIDENCE,
}) {
  if (directory === undefined) return;
  assert.ok(kind === 'wire' || kind === 'usage', 'Unknown acceptance evidence kind');
  const destination = physicalDestination(resolve(directory, kind));
  const delta = relative(realpathSync(repository), destination);
  assert.ok(
    delta !== '' && (delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta)),
    'Acceptance evidence must be outside authored source',
  );
  mkdirSync(dirname(destination), { recursive: true });
  // A fresh owned destination also excludes existing nested symlinks and retained-report overwrite.
  mkdirSync(destination);
  let files = 0;
  let bytes = 0;
  function copy(path) {
    const source = join(scratch, path);
    if (!existsSync(source)) return;
    assert.ok(lstatSync(source).isFile(), 'Acceptance metadata must be a physical file');
    files += 1;
    bytes += statSync(source).size;
    assert.ok(
      files <= 20000 && bytes <= 256 * 1024 * 1024,
      'Acceptance metadata export exceeds its bound',
    );
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  }
  if (kind === 'wire') {
    for (const entry of readdirSync(scratch, { withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith('.json')) copy(entry.name);
  } else {
    for (const name of ['summary.json', 'developer-source.json', 'installed-dependencies.json'])
      copy(name);
    for (const entry of readdirSync(scratch, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'seed') continue;
      for (const phase of ['fixed', 'mutated', 'restored']) {
        const root = join(entry.name, phase);
        for (const name of [
          'cases.json',
          'result.json',
          'vitest.json',
          'native-events.jsonl',
          'command.process.json',
          'command.stdout.log',
          'command.stderr.log',
          'source-manifest.json',
          'runtime.json',
          'replay/result.json',
        ])
          copy(join(root, name));
        const evaluations = join(scratch, root, 'evaluation');
        if (existsSync(evaluations))
          for (const file of readdirSync(evaluations, { withFileTypes: true })) {
            if (file.isFile() && /\.(?:ndjson|jsonl)$/.test(file.name))
              copy(join(root, 'evaluation', file.name));
          }
      }
    }
  }
  const metadata = JSON.stringify({ version: 1, kind, files, bytes, report }, null, 2) + '\n';
  assert.ok(
    files + 1 <= 20000 && bytes + Buffer.byteLength(metadata) <= 256 * 1024 * 1024,
    'Acceptance metadata export including its manifest exceeds its bound',
  );
  writeFileSync(join(destination, 'export.json'), metadata, { flag: 'wx' });
}
