import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportMetadata, finish } from './retention.mjs';
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'causal-retention-'));
  try {
    const repository = join(root, 'repo'),
      scratch = join(root, 'scratch'),
      directory = join(root, 'evidence');
    mkdirSync(repository);
    mkdirSync(scratch);
    writeFileSync(join(scratch, 'summary.json'), '{"complete":false}');
    return fn({
      root,
      repository,
      scratch,
      directory,
      evidenceKind: 'secrets',
      summary: { complete: false },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('exports only bounded own-family metadata, excluding graph/cache/home/native database bytes', () => {
  fixture((options) => {
    for (const dir of ['graph', 'cache', 'home']) {
      mkdirSync(join(options.scratch, dir));
      writeFileSync(join(options.scratch, dir, 'secret.json'), 'excluded');
    }
    writeFileSync(join(options.scratch, 'native.db'), 'excluded');
    writeFileSync(join(options.scratch, 'library.node'), 'excluded');
    exportMetadata(options);
    assert.deepEqual(readdirSync(join(options.directory, 'secrets')).sort(), [
      'export.json',
      'summary.json',
    ]);
    assert.equal(existsSync(join(options.directory, 'filesystem')), false);
    const exported = JSON.parse(
      readFileSync(join(options.directory, 'secrets', 'export.json'), 'utf8'),
    );
    assert.equal(exported.files, 1);
    assert.equal(exported.bytes, readFileSync(join(options.scratch, 'summary.json')).length);
    assert.throws(() => exportMetadata(options), /already exists/);
  });
});
test('same repository, same scratch and symlink-redirected export refuse without overwrite', () => {
  fixture((options) => {
    for (const directory of [options.repository, options.scratch])
      assert.throws(() => exportMetadata({ ...options, directory }), /outside/);
    const redirect = join(options.root, 'redirect');
    symlinkSync(options.repository, redirect, 'dir');
    assert.throws(
      () => exportMetadata({ ...options, directory: join(redirect, 'nested') }),
      /outside/,
    );
    assert.throws(() => exportMetadata({ ...options, evidenceKind: '../escape' }), /family/);
  });
});
test('metadata links cannot borrow graph or developer files', () => {
  fixture((options) => {
    symlinkSync(join(options.scratch, 'summary.json'), join(options.scratch, 'linked.json'));
    assert.throws(() => exportMetadata(options), /symlinked/);
    assert.equal(existsSync(join(options.directory, 'secrets')), false);
  });
});
test('final export metadata counts against byte ceiling before any destination is written', () => {
  fixture((options) => {
    writeFileSync(join(options.scratch, 'large.log'), 'x'.repeat(64 * 1024 * 1024 - 512));
    assert.throws(
      () => exportMetadata({ ...options, summary: { failure: 'x'.repeat(1024) } }),
      /bound/,
    );
    assert.equal(existsSync(join(options.directory, 'secrets')), false);
  });
});
for (const failure of ['assertion', 'import', 'export'])
  test(`failure cleanup removes scratch and preserves primary ${failure} error when export also fails`, () => {
    fixture((options) => {
      const primaryFailure = new Error(failure);
      const result = finish({ ...options, directory: options.repository, primaryFailure });
      assert.equal(result, primaryFailure);
      assert.equal(existsSync(options.scratch), false);
    });
  });
test('export failure becomes primary and scratch still closes when no earlier failure exists', () => {
  fixture((options) => {
    const error = finish({ ...options, directory: options.repository });
    assert.match(error.message, /outside/);
    assert.equal(existsSync(options.scratch), false);
  });
});
