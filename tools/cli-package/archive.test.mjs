import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { ARCHIVE_LIMITS, inspectPackageArchive, PackageArchiveError } from './archive.mjs';
import { checksum, entry, ustar } from './ustar-fixture.mjs';

const expectedPackage = {
  name: 'relavium',
  version: '0.1.1',
  type: 'module',
  bin: { relavium: 'dist/index.js' },
  engines: { node: '>=22' },
  dependencies: { commander: '^14.0.0' },
  devDependencies: { '@relavium/core': '0.0.0' },
};

/** @returns {Map<string, Uint8Array>} */
function inventory() {
  return new Map([
    ['package/dist/index.js', Buffer.from('#!/usr/bin/env node\nimport "./chunk-ABC.js";\n')],
    ['package/dist/chunk-ABC.js', Buffer.from('export const value = "é";\n')],
    ['package/drizzle/0000_first.sql', Buffer.from('CREATE TABLE fixture(id TEXT);\n')],
    ['package/drizzle/meta/0000_snapshot.json', Buffer.from('{}\n')],
    ['package/drizzle/meta/_journal.json', Buffer.from('{"entries":[]}\n')],
    ['package/package.json', Buffer.from(JSON.stringify(expectedPackage))],
    ['package/README.md', Buffer.from('fixture package\n')],
    ['package/CHANGELOG.md', Buffer.from('fixture changes\n')],
    ['package/LICENSE', Buffer.from('fixture license\n')],
  ]);
}

/** @param {Map<string, Uint8Array>} [files] */
function tar(files = inventory()) {
  return ustar(files);
}

/** @param {Buffer} input @param {string} code @param {Map<string, Uint8Array>} [files] */
function rejects(input, code, files = inventory()) {
  assert.throws(
    () => inspectPackageArchive(input, { expectedFiles: files, expectedPackage }),
    (error) => error instanceof PackageArchiveError && error.code === code,
  );
}

/** @param {(header: Buffer) => void} mutate */
function mutateHeader(mutate) {
  const input = tar();
  mutate(input.subarray(0, 512));
  checksum(input.subarray(0, 512));
  return gzipSync(input);
}

test('inspects every finalized byte, USTAR mode and artifact digest', () => {
  const bytes = gzipSync(tar());
  const result = inspectPackageArchive(bytes, { expectedFiles: inventory(), expectedPackage });
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.bytes, bytes.length);
  assert.equal(result.files.length, inventory().size);
  assert.deepEqual(result.package, expectedPackage);
  for (const [path, contents] of inventory()) {
    assert.deepEqual(
      result.files.find((file) => file.path === path),
      {
        path,
        bytes: contents.length,
        sha256: createHash('sha256').update(contents).digest('hex'),
        mode: path === 'package/dist/index.js' ? 0o755 : 0o644,
      },
    );
  }
});

test('publication manifest comparison is semantic and permits pnpm private devDependency transforms', () => {
  const files = inventory();
  files.set('package/package.json', Buffer.from(JSON.stringify(expectedPackage, null, 2)));
  const result = inspectPackageArchive(gzipSync(tar(files)), {
    expectedFiles: inventory(),
    expectedPackage,
  });
  assert.deepEqual(result.package, expectedPackage);
});

test('receipt digest inventory binds every byte including manifest formatting', () => {
  const expectedFiles = new Map(
    [...inventory()].map(([path, contents]) => [
      path,
      {
        sha256: createHash('sha256').update(contents).digest('hex'),
        bytes: contents.length,
      },
    ]),
  );
  assert.equal(
    inspectPackageArchive(gzipSync(tar()), { expectedFiles, expectedPackage }).files.length,
    9,
  );
  const files = inventory();
  files.set('package/package.json', Buffer.from(JSON.stringify(expectedPackage, null, 2)));
  assert.throws(
    () => inspectPackageArchive(gzipSync(tar(files)), { expectedFiles, expectedPackage }),
    (error) => error instanceof PackageArchiveError && error.code === 'FILE_DRIFT',
  );
  expectedFiles.set('package/dist/index.js', { sha256: 'invalid', bytes: 1 });
  assert.throws(
    () => inspectPackageArchive(gzipSync(tar()), { expectedFiles, expectedPackage }),
    (error) => error instanceof PackageArchiveError && error.code === 'EXPECTED_INVENTORY',
  );
});

test('compressed stream refuses truncation, CRC errors, extra members and trailing zeros', () => {
  const bytes = gzipSync(tar());
  rejects(bytes.subarray(0, bytes.length - 3), 'GZIP_INVALID');
  const badCrc = Buffer.from(bytes);
  badCrc[badCrc.length - 8] = (badCrc[badCrc.length - 8] ?? 0) ^ 1;
  rejects(badCrc, 'GZIP_INVALID');
  rejects(Buffer.concat([bytes, gzipSync(Buffer.alloc(0))]), 'GZIP_TRAILING');
  rejects(Buffer.concat([bytes, Buffer.alloc(1)]), 'GZIP_TRAILING');
  const badFlags = Buffer.from(bytes);
  badFlags[3] = 8;
  rejects(badFlags, 'GZIP_HEADER');
  rejects(Buffer.alloc(ARCHIVE_LIMITS.compressedBytes + 1), 'GZIP_SIZE');
  rejects(gzipSync(Buffer.alloc(ARCHIVE_LIMITS.expandedBytes + 1)), 'GZIP_INVALID');
});

test('tar refuses bad checksum, unsupported type/format/metadata and numeric fields', () => {
  const wrongChecksum = tar();
  wrongChecksum[0] = 120;
  rejects(gzipSync(wrongChecksum), 'TAR_CHECKSUM');
  for (const type of ['1', '2', '3', '4', '5', '6', '7', 'x', 'g', 'L', 'K', '\0']) {
    rejects(
      mutateHeader((header) => {
        header.write(type, 156);
      }),
      'TAR_TYPE',
    );
  }
  rejects(
    mutateHeader((header) => {
      header.write('ustar ', 257);
    }),
    'TAR_FORMAT',
  );
  for (const offset of [157, 265, 297, 345, 500]) {
    rejects(
      mutateHeader((header) => {
        header[offset] = 65;
      }),
      'TAR_METADATA',
    );
  }
  rejects(
    mutateHeader((header) => {
      header.write('000001', 108);
    }),
    'TAR_METADATA',
  );
  for (const value of ['-0000000001 ', '00000000009 ', '0000000001x ', '           ']) {
    rejects(
      mutateHeader((header) => {
        header.write(value, 124);
      }),
      'TAR_NUMBER',
    );
  }
  rejects(
    mutateHeader((header) => {
      header[124] = 128;
    }),
    'TAR_NUMBER',
  );
});

test('tar refuses unsafe/noncanonical names, source/maps/private inventories even when expected', () => {
  for (const path of [
    '/package/dist/index.js',
    'package/../dist/index.js',
    'package/dist/../index.js',
    'package//dist/index.js',
    './package/dist/index.js',
    'package\\dist\\index.js',
    'package/dist/chunk.js.map',
    'package/dist/source.ts',
    'package/src/index.js',
    'package/dist/metafile.json',
    'package/private-manifest.json',
    'package/dist/chunk.JS',
    'package/dist/index.js:stream',
    'package/dist/index.js\n',
  ]) {
    rejects(
      mutateHeader((header) => {
        header.fill(0, 0, 100);
        header.write(path, 0, 100);
      }),
      'PUBLIC_PATH',
    );
  }
  rejects(
    mutateHeader((header) => {
      header[40] = 65;
    }),
    'TAR_NAME',
  );
  rejects(
    mutateHeader((header) => {
      header.fill(65, 0, 100);
    }),
    'TAR_NAME',
  );
  rejects(
    mutateHeader((header) => {
      header[0] = 255;
    }),
    'UTF8',
  );
  const files = inventory();
  files.set('package/dist/index.js.map', Buffer.from('{}'));
  rejects(gzipSync(tar(files)), 'PUBLIC_PATH', files);
});

test('tar refuses duplicate, absent, extra and changed public files', () => {
  const index = inventory().get('package/dist/index.js');
  assert.ok(index);
  rejects(
    gzipSync(Buffer.concat([entry('package/dist/index.js', index), tar()])),
    'DUPLICATE_FILE',
  );
  const missing = inventory();
  missing.delete('package/LICENSE');
  rejects(gzipSync(tar(missing)), 'MISSING_FILE');
  const extra = inventory();
  extra.set('package/dist/extra.js', Buffer.from('export {};'));
  rejects(gzipSync(tar(extra)), 'EXTRA_FILE');
  const changed = inventory();
  changed.set('package/drizzle/0000_first.sql', Buffer.from('DROP TABLE fixture;'));
  rejects(gzipSync(tar(changed)), 'FILE_DRIFT');
});

test('tar requires complete bodies, zero padding and exactly two final zero records', () => {
  rejects(gzipSync(tar().subarray(0, 520)), 'TAR_TRUNCATED');
  rejects(gzipSync(tar().subarray(0, 100)), 'TAR_TRUNCATED');
  rejects(gzipSync(tar().subarray(0, -512)), 'TAR_END');
  rejects(gzipSync(tar().subarray(0, -1024)), 'TAR_END');
  rejects(gzipSync(Buffer.concat([tar(), Buffer.alloc(512)])), 'TAR_END');
  const padded = tar();
  padded[1023] = 1;
  rejects(gzipSync(padded), 'TAR_PADDING');
  const trailing = tar();
  trailing[trailing.length - 1] = 1;
  rejects(gzipSync(trailing), 'TAR_END');
  rejects(
    mutateHeader((header) => {
      header.write((ARCHIVE_LIMITS.fileBytes + 1).toString(8).padStart(11, '0') + ' ', 124);
    }),
    'FILE_SIZE',
  );
});

test('only executable entry owns its exact hashbang, no output has a map link', () => {
  for (const mode of ['000644', '004755', '000777']) {
    rejects(
      mutateHeader((header) => {
        header.write(mode, 100);
      }),
      'TAR_MODE',
    );
  }
  for (const [path, source, code] of [
    ['package/dist/index.js', '#!/usr/bin/node\n', 'HASHBANG'],
    ['package/dist/index.js', 'export {};\n', 'HASHBANG'],
    ['package/dist/chunk-ABC.js', '#!/usr/bin/env node\n', 'HASHBANG'],
    ['package/dist/chunk-ABC.js', 'export {};\n//# sourceMappingURL=chunk.js.map\n', 'MAP_LINK'],
    [
      'package/dist/chunk-ABC.js',
      'export {};\n/*# sourceMappingURL=data:application/json;base64,e30= */',
      'MAP_LINK',
    ],
  ]) {
    assert.ok(path && source && code);
    const files = inventory();
    files.set(path, Buffer.from(source));
    rejects(gzipSync(tar(files)), code, files);
  }
});

test('manifest rejects runtime drift and unresolved/private runtime dependencies', () => {
  const drift = inventory();
  drift.set(
    'package/package.json',
    Buffer.from(JSON.stringify({ ...expectedPackage, scripts: { install: 'bad' } })),
  );
  rejects(gzipSync(tar(drift)), 'MANIFEST_DRIFT');
  for (const dependencies of [
    { commander: 'catalog:' },
    { commander: 'workspace:*' },
    { '@relavium/core': '0.0.0' },
  ]) {
    const badPackage = { ...expectedPackage, dependencies };
    const files = inventory();
    files.set('package/package.json', Buffer.from(JSON.stringify(badPackage)));
    assert.throws(
      () =>
        inspectPackageArchive(gzipSync(tar(files)), {
          expectedFiles: files,
          expectedPackage: badPackage,
        }),
      (error) => error instanceof PackageArchiveError && error.code === 'MANIFEST_RUNTIME',
    );
  }
});

for (const [changed, code] of [
  ...[
    undefined,
    {},
    'dist/index.js',
    { relavium: './dist/missing.js' },
    { relavium: '../dist/index.js' },
    { relavium: './dist/../dist/index.js' },
    { relavium: './dist/index.js', other: './dist/index.js' },
  ].map((bin) => [{ bin }, 'MANIFEST_BIN']),
  ...[undefined, {}, { node: '>=20' }, { node: '>=24' }, { node: '>=22.1' }].map((engines) => [
    { engines },
    'MANIFEST_NODE_FLOOR',
  ]),
])
  test(`archive independently refuses public command/floor drift: ${JSON.stringify(changed)}`, () => {
    const badPackage = JSON.parse(JSON.stringify({ ...expectedPackage, ...changed }));
    const files = inventory();
    files.set('package/package.json', Buffer.from(JSON.stringify(badPackage)));
    assert.throws(
      () =>
        inspectPackageArchive(gzipSync(tar(files)), {
          expectedFiles: files,
          expectedPackage: badPackage,
        }),
      (error) => error instanceof PackageArchiveError && error.code === code,
    );
  });

test('portable install paths refuse Windows device names and case aliases', () => {
  const aliases = inventory();
  aliases.set('package/dist/Chunk-ABC.js', Buffer.from('export {};'));
  rejects(gzipSync(tar(aliases)), 'PATH_ALIAS', aliases);
  for (const name of ['CON', 'prn', 'AUX', 'nul', 'com1', 'LPT9']) {
    const devices = inventory();
    devices.set(`package/dist/${name}.js`, Buffer.from('export {};'));
    rejects(gzipSync(tar(devices)), 'PUBLIC_PATH', devices);
  }
});

test('inventory and manifest resource ceilings are enforced before comparison', () => {
  const files = inventory();
  while (files.size < ARCHIVE_LIMITS.files) {
    files.set(`package/dist/bound-${files.size}.js`, Buffer.from('export {};'));
  }
  const atLimit = inspectPackageArchive(gzipSync(tar(files)), {
    expectedFiles: files,
    expectedPackage,
  });
  assert.equal(atLimit.files.length, ARCHIVE_LIMITS.files);
  const overLimit = Buffer.concat([
    tar(files).subarray(0, -1024),
    entry('package/dist/overflow.js', Buffer.alloc(0)),
    Buffer.alloc(1024),
  ]);
  rejects(gzipSync(overLimit), 'FILE_COUNT', files);
  files.set('package/dist/overflow.js', Buffer.alloc(0));
  rejects(gzipSync(tar(files)), 'EXPECTED_INVENTORY', files);
  const oversizedManifest = inventory();
  oversizedManifest.set(
    'package/package.json',
    Buffer.from(' '.repeat(ARCHIVE_LIMITS.manifestBytes + 1)),
  );
  rejects(gzipSync(tar(oversizedManifest)), 'MANIFEST_SIZE', oversizedManifest);
  const invalidManifest = inventory();
  invalidManifest.set('package/package.json', Buffer.from('{malformed'));
  rejects(gzipSync(tar(invalidManifest)), 'MANIFEST_JSON', invalidManifest);
  const missingEntry = inventory();
  missingEntry.delete('package/dist/index.js');
  rejects(gzipSync(tar(missingEntry)), 'EXPECTED_INVENTORY', missingEntry);
});
