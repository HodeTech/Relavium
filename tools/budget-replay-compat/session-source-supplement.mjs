/** Additive source only: original archive/manifest/dependency bytes remain immutable. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { baselineCommit } from './baseline-provenance.mjs';
import { systemTool } from './system-tools.mjs';

const allowed = [
  {
    path: 'packages/db/src/session-store.ts',
    gitBlob: '9b4c5a1b5235dc44b110e41d7cc71cad5d071162',
    bytes: 36496,
    sha256: '8a42221ccf48f1361ba964796bf4638d745eeb286b53d66ef83a68bf4682d25b',
  },
];
export function installSessionSourceSupplement(repository, tooling, owned) {
  const manifest = JSON.parse(
    readFileSync(join(tooling, 'frozen/session-source-supplement.json'), 'utf8'),
  );
  assert.deepEqual(manifest, { baselineCommit, files: allowed });
  for (const file of allowed) {
    const object = execFileSync(
      systemTool('git'),
      ['--no-replace-objects', 'rev-parse', `${baselineCommit}:${file.path}`],
      { cwd: repository, encoding: 'utf8' },
    ).trim();
    assert.equal(object, file.gitBlob);
    const bytes = execFileSync(
      systemTool('git'),
      ['--no-replace-objects', 'cat-file', 'blob', object],
      { cwd: repository },
    );
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    const target = join(owned, 'frozen', file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o400 });
  }
  writeFileSync(
    join(owned, 'session-source-supplement.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx' },
  );
  return manifest;
}
