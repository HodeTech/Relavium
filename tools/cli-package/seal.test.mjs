import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { finalizedPublicFiles } from './seal.mjs';

function withFinalizedFixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-seal-fixture-'));
  const write = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const graph = (outputs) => write('apps/cli/dist/metafile-esm.json', JSON.stringify({ outputs }));
  try {
    graph({ 'dist/index.js': {}, 'dist/chunk-ABC.js': {} });
    write('apps/cli/dist/index.js', '#!/usr/bin/env node\nimport "./chunk-ABC.js";\n');
    write('apps/cli/dist/chunk-ABC.js', 'export {};\n');
    for (const path of ['0000_first.sql', 'meta/_journal.json', 'meta/0000_snapshot.json']) {
      write(`packages/db/drizzle/${path}`, `canonical ${path}\n`);
      write(`apps/cli/drizzle/${path}`, `canonical ${path}\n`);
    }
    for (const name of ['package.json', 'README.md', 'CHANGELOG.md'])
      write(`apps/cli/${name}`, name);
    write('LICENSE', 'canonical repository license\n');
    return body({ root, write, graph, remove: (path) => rmSync(join(root, path)) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('finalized seal inventory contains exact graph bytes, canonical migrations and public documents', () => {
  withFinalizedFixture(({ root }) => {
    const files = finalizedPublicFiles(root);
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
    'dist/index.js.map',
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
    'unlisted emitted map',
    ({ write }) => write('apps/cli/dist/index.js.map', '{}'),
    /PACKED_CLI_EXTRA_FINAL_OUTPUT/,
  ],
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
      assert.throws(() => finalizedPublicFiles(fixture.root), refusal);
    });
  });
}

test(
  'finalized seal refuses a symlink masquerading as an emitted file',
  { skip: process.platform === 'win32' },
  () => {
    withFinalizedFixture(({ root, remove }) => {
      remove('apps/cli/dist/chunk-ABC.js');
      symlinkSync(join(root, 'LICENSE'), join(root, 'apps/cli/dist/chunk-ABC.js'));
      assert.throws(() => finalizedPublicFiles(root), /PACKED_CLI_FILE_KIND_OR_BOUND/);
    });
  },
);
