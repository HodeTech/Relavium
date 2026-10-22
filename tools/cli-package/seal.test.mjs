import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { finalizedPublicFiles, producerNodeMajor } from './seal.mjs';

/** A finalized candidate: public JS only in dist, its metafile and hash record in private staging. */
function withFinalizedFixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-seal-fixture-'));
  const staging = join(root, 'staging');
  const write = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const graph = (outputs) => write('staging/metafile-esm.json', JSON.stringify({ outputs }));
  const record = (paths) => {
    const outputs = paths.map((path) => {
      const bytes = readFileSync(join(root, 'apps/cli', path));
      return {
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
    write(
      'staging/finalized.json',
      JSON.stringify({ version: 1, outputs, maps: [], upstreamMaps: 0 }),
    );
  };
  try {
    graph({
      'dist/index.js': {},
      'dist/index.js.map': {},
      'dist/chunk-ABC.js': {},
      'dist/chunk-ABC.js.map': {},
    });
    write('apps/cli/dist/index.js', '#!/usr/bin/env node\nimport "./chunk-ABC.js";\n');
    write('apps/cli/dist/chunk-ABC.js', 'export {};\n');
    record(['dist/index.js', 'dist/chunk-ABC.js']);
    for (const path of ['0000_first.sql', 'meta/_journal.json', 'meta/0000_snapshot.json']) {
      write(`packages/db/drizzle/${path}`, `canonical ${path}\n`);
      write(`apps/cli/drizzle/${path}`, `canonical ${path}\n`);
    }
    for (const name of ['package.json', 'README.md', 'CHANGELOG.md'])
      write(`apps/cli/${name}`, name);
    write('LICENSE', 'canonical repository license\n');
    return body({
      root,
      staging,
      write,
      graph,
      record,
      remove: (path) => rmSync(join(root, path)),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('producer runtime follows the declared toolchain independently of the fixed public Node floor', () => {
  withFinalizedFixture(({ root, write }) => {
    for (const major of [22, 24, 26]) {
      write('.nvmrc', `${major}\n`);
      assert.equal(producerNodeMajor(root), major);
    }
    for (const invalid of ['', '20', 'v24', '24.0.0', '24\n26', '101']) {
      write('.nvmrc', invalid);
      assert.throws(() => producerNodeMajor(root), /INVALID_PRODUCER_NODE/);
    }
  });
});

test('finalized seal inventory contains exact recorded JS bytes, canonical migrations and public documents', () => {
  withFinalizedFixture(({ root, staging }) => {
    const files = finalizedPublicFiles(root, staging);
    assert.deepEqual(
      [...files.keys()].sort(),
      [
        'package/dist/index.js',
        'package/dist/chunk-ABC.js',
        'package/drizzle/0000_first.sql',
        'package/drizzle/meta/_journal.json',
        'package/drizzle/meta/0000_snapshot.json',
        'package/package.json',
        'package/README.md',
        'package/CHANGELOG.md',
        'package/LICENSE',
      ].sort(),
    );
    assert.equal(
      files.get('package/dist/index.js').toString(),
      '#!/usr/bin/env node\nimport "./chunk-ABC.js";\n',
    );
    assert.equal(
      files.get('package/drizzle/0000_first.sql').toString(),
      'canonical 0000_first.sql\n',
    );
    assert.equal(files.get('package/LICENSE').toString(), 'canonical repository license\n');
    assert.equal(files.has('package/dist/metafile-esm.json'), false);
    assert.equal(files.has('package/dist/index.js.map'), false);
  });
});

for (const [name, mutate, refusal] of [
  [
    'empty compiled graph',
    ({ graph, remove }) => {
      graph({});
      remove('apps/cli/dist/index.js');
      remove('apps/cli/dist/chunk-ABC.js');
    },
    undefined,
  ],
  [
    'oversized compiled graph',
    ({ graph, write, remove }) => {
      const outputs = Array.from({ length: 257 }, (_, index) => `dist/chunk-${index}.js`);
      graph(Object.fromEntries(outputs.map((path) => [path, {}])));
      remove('apps/cli/dist/index.js');
      remove('apps/cli/dist/chunk-ABC.js');
      for (const path of outputs) write(`apps/cli/${path}`, 'export {};');
    },
    undefined,
  ],
  ...[
    'dist/nested/index.js',
    '../outside.js',
    '/dist/index.js',
    'dist/index.json',
    'dist/index space.js',
  ].map((path) => [
    `unreviewed graph output ${path}`,
    ({ graph }) => graph({ [path]: {} }),
    /PACKED_CLI_UNREVIEWED_GRAPH_OUTPUT/,
  ]),
  ['missing emitted chunk', ({ remove }) => remove('apps/cli/dist/chunk-ABC.js'), undefined],
  [
    'unlisted emitted chunk',
    ({ write }) => write('apps/cli/dist/extra.js', 'extra'),
    /PACKED_CLI_EXTRA_FINAL_OUTPUT/,
  ],
  [
    'a map left in the public package',
    ({ write }) => write('apps/cli/dist/index.js.map', '{}'),
    /PACKED_CLI_EXTRA_FINAL_OUTPUT/,
  ],
  [
    'build metadata left in the public package',
    ({ write }) => write('apps/cli/dist/metafile-esm.json', '{}'),
    /PACKED_CLI_EXTRA_FINAL_OUTPUT/,
  ],
  [
    'JS changed after the finalizer recorded it',
    ({ write }) => write('apps/cli/dist/chunk-ABC.js', 'export const late = 1;\n'),
    /PACKED_CLI_FINALIZED_RECORD_DRIFT/,
  ],
  [
    'a hash record missing an output',
    ({ record }) => record(['dist/index.js']),
    /PACKED_CLI_FINALIZED_RECORD_DRIFT/,
  ],
  ['a missing hash record', ({ remove }) => remove('staging/finalized.json'), undefined],
  ['a missing staged metafile', ({ remove }) => remove('staging/metafile-esm.json'), undefined],
  [
    'changed migration',
    ({ write }) => write('apps/cli/drizzle/0000_first.sql', 'changed'),
    /PACKED_CLI_MIGRATION_COPY_CHANGED/,
  ],
  [
    'missing migration',
    ({ remove }) => remove('apps/cli/drizzle/0000_first.sql'),
    /PACKED_CLI_MIGRATION_COPY_CHANGED/,
  ],
  [
    'extra copied migration',
    ({ write }) => write('apps/cli/drizzle/0001_extra.sql', 'extra'),
    /PACKED_CLI_MIGRATION_COPY_CHANGED/,
  ],
  [
    'new uncopied canonical migration',
    ({ write }) => write('packages/db/drizzle/0001_next.sql', 'new'),
    /PACKED_CLI_MIGRATION_COPY_CHANGED/,
  ],
  [
    'changed migration journal',
    ({ write }) => write('apps/cli/drizzle/meta/_journal.json', 'changed'),
    /PACKED_CLI_MIGRATION_COPY_CHANGED/,
  ],
  ['missing public document', ({ remove }) => remove('apps/cli/README.md'), undefined],
  [
    'oversized public document',
    ({ write }) => write('apps/cli/CHANGELOG.md', 'x'.repeat(128 * 1024 + 1)),
    /PACKED_CLI_FILE_KIND_OR_BOUND/,
  ],
  [
    'oversized emitted file',
    ({ write }) => write('apps/cli/dist/chunk-ABC.js', 'x'.repeat(8 * 1024 * 1024 + 1)),
    /PACKED_CLI_FILE_KIND_OR_BOUND/,
  ],
]) {
  test(`finalized seal refuses ${name}`, () => {
    withFinalizedFixture((fixture) => {
      mutate(fixture);
      assert.throws(() => finalizedPublicFiles(fixture.root, fixture.staging), refusal);
    });
  });
}

test(
  'finalized seal refuses a symlink masquerading as an emitted file',
  { skip: process.platform === 'win32' },
  () => {
    withFinalizedFixture(({ root, staging, remove }) => {
      remove('apps/cli/dist/chunk-ABC.js');
      symlinkSync(join(root, 'LICENSE'), join(root, 'apps/cli/dist/chunk-ABC.js'));
      assert.throws(() => finalizedPublicFiles(root, staging), /PACKED_CLI_FILE_KIND_OR_BOUND/);
    });
  },
);
