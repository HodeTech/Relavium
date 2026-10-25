import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, posix } from 'node:path';
import { before, test } from 'node:test';
import { candidate, fresh, posixModes, seal } from './candidate-fixture.mjs';
import { CONTAINER_LIMITS, buildPrivateContainer, readPrivateContainer } from './container.mjs';
import { CustodyError } from './custody-error.mjs';
import { RECORD_BYTES, readPrivateManifest } from './manifest.mjs';
import { writeUstar } from './ustar.mjs';

const refuses = (code) => (error) => error instanceof CustodyError && error.code === code;

/** @type {string} */
let sealed;
before(async () => {
  // One synthetic candidate sealed as the producer seals it, plus the metafile the finalizer stages.
  const fixture = await candidate();
  await seal(fixture);
  writeFileSync(join(fixture.staging, 'metafile-esm.json'), '{"inputs":{},"outputs":{}}');
  sealed = fixture.staging;
});

/** A fresh copy of the sealed staging, changed by `change`. */
function staging(change = () => {}) {
  const copy = fresh('container-staging');
  cpSync(sealed, copy, { recursive: true });
  change(copy);
  return copy;
}

const mapName = (copy) => readdirSync(join(copy, 'maps'))[0];

test('the sealed staging becomes one container that reads back and extracts to the same staging', () => {
  const copy = staging();
  const { bytes, manifest } = buildPrivateContainer(copy);
  assert.deepEqual(manifest, readPrivateManifest(copy));
  const read = readPrivateContainer(bytes);
  assert.deepEqual(read.manifest, manifest);
  const expected = [
    'finalized.json',
    'manifest.json',
    ...readdirSync(join(copy, 'maps'))
      .sort()
      .map((name) => `maps/${name}`),
    'metafile-esm.json',
  ];
  assert.deepEqual([...read.files.keys()], expected);
  // Recovery is `gpg -d | tar -x`: the platform tar's extraction is a staging the manifest reader reads.
  const archive = join(fresh('container-archive'), 'container.tar');
  mkdirSync(join(archive, '..'));
  writeFileSync(archive, bytes);
  const out = fresh('container-extracted');
  mkdirSync(out);
  assert.equal(spawnSync('tar', ['-xf', archive, '-C', out]).status, 0);
  for (const path of expected) {
    assert.deepEqual(
      readFileSync(join(out, ...path.split('/'))),
      readFileSync(join(copy, ...path.split('/'))),
    );
  }
  assert.deepEqual(readPrivateManifest(out), manifest);
});

test('a staging that is not exactly the sealed records and maps refuses', () => {
  for (const [code, change] of [
    ['CONTAINER_SET', (copy) => writeFileSync(join(copy, 'notes.txt'), 'extra')],
    ['CONTAINER_SET', (copy) => rmSync(join(copy, 'metafile-esm.json'))],
    ['CONTAINER_SET', (copy) => rmSync(join(copy, 'manifest.json'))],
    ['CONTAINER_SET', (copy) => writeFileSync(join(copy, 'maps', 'extra.js.map'), '{}')],
    ['CONTAINER_SET', (copy) => rmSync(join(copy, 'maps', mapName(copy)))],
    ['CONTAINER_SET', (copy) => writeFileSync(join(copy, 'maps', 'notes.txt'), '{}')],
    [
      'CONTAINER_DRIFT',
      (copy) => {
        const path = join(copy, 'maps', mapName(copy));
        writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(' ')]));
      },
    ],
    [
      'CONTAINER_RECORD',
      (copy) => {
        const path = join(copy, 'finalized.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        record.outputs[0].sha256 = '0'.repeat(64);
        writeFileSync(path, JSON.stringify(record));
      },
    ],
    ['CONTAINER_RECORD', (copy) => writeFileSync(join(copy, 'manifest.json'), '{"version":1}')],
    [
      'CONTAINER_RECORD',
      (copy) => {
        const path = join(copy, 'finalized.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        record.maps[0].bytes += 1;
        writeFileSync(path, JSON.stringify(record));
      },
    ],
    [
      'CONTAINER_RECORD',
      (copy) => {
        const path = join(copy, 'finalized.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        record.maps[0].sha256 = '0'.repeat(64);
        writeFileSync(path, JSON.stringify(record));
      },
    ],
    [
      'CONTAINER_RECORD',
      (copy) => {
        const path = join(copy, 'finalized.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        record.maps[0].path = 'dist/other.js.map';
        writeFileSync(path, JSON.stringify(record));
      },
    ],
    [
      'CONTAINER_RECORD',
      (copy) => {
        const path = join(copy, 'finalized.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        record.version = 2;
        writeFileSync(path, JSON.stringify(record));
      },
    ],
    [
      'CONTAINER_RECORD',
      (copy) => {
        const path = join(copy, 'finalized.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        record.extra = true;
        writeFileSync(path, JSON.stringify(record));
      },
    ],
    [
      'CONTAINER_RECORD',
      (copy) => {
        const path = join(copy, 'finalized.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        record.upstreamMaps = 1.5;
        writeFileSync(path, JSON.stringify(record));
      },
    ],
    [
      'CONTAINER_RECORD',
      (copy) => {
        const path = join(copy, 'finalized.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        delete record.outputs[0].bytes;
        writeFileSync(path, JSON.stringify(record));
      },
    ],
    [
      'CONTAINER_RECORD',
      (copy) => {
        const path = join(copy, 'finalized.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        record.outputs[0].bytes = '1';
        writeFileSync(path, JSON.stringify(record));
      },
    ],
    [
      'CONTAINER_RECORD',
      (copy) => {
        const path = join(copy, 'finalized.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        record.maps = {};
        writeFileSync(path, JSON.stringify(record));
      },
    ],
    [
      'CONTAINER_RECORD',
      (copy) => {
        const path = join(copy, 'finalized.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        record.maps[0].extra = true;
        writeFileSync(path, JSON.stringify(record));
      },
    ],
    ['CONTAINER_RECORD', (copy) => writeFileSync(join(copy, 'metafile-esm.json'), 'not json')],
    ['CONTAINER_RECORD', (copy) => writeFileSync(join(copy, 'metafile-esm.json'), '[]')],
  ]) {
    assert.throws(() => buildPrivateContainer(staging(change)), refuses(code), code);
  }
});

test('a staging that cannot be read refuses with a fixed code and no path', () => {
  const missing = join(fresh('no-staging'), 'staging');
  const file = `${fresh('file-staging')}.json`;
  writeFileSync(file, '{}');
  for (const path of [missing, file]) {
    assert.throws(
      () => buildPrivateContainer(path),
      (error) =>
        error instanceof CustodyError &&
        error.code === 'CONTAINER_UNREADABLE' &&
        !error.message.includes(path),
    );
  }
});

test('a linked record or maps directory refuses', { skip: !posixModes }, () => {
  assert.throws(
    () =>
      buildPrivateContainer(
        staging((copy) => {
          const target = `${fresh('linked-metafile')}.json`;
          writeFileSync(target, '{}');
          rmSync(join(copy, 'metafile-esm.json'));
          symlinkSync(target, join(copy, 'metafile-esm.json'));
        }),
      ),
    refuses('CONTAINER_ENTRY'),
  );
  assert.throws(
    () =>
      buildPrivateContainer(
        staging((copy) => {
          const maps = fresh('linked-maps');
          cpSync(join(copy, 'maps'), maps, { recursive: true });
          rmSync(join(copy, 'maps'), { recursive: true });
          symlinkSync(maps, join(copy, 'maps'));
        }),
      ),
    refuses('CONTAINER_SET'),
  );
});

test('the entry, count and total bounds refuse before a container is written', () => {
  const copy = staging();
  const largest = Math.max(
    ...['finalized.json', 'manifest.json', 'metafile-esm.json'].map(
      (name) => readFileSync(join(copy, name)).length,
    ),
    ...readdirSync(join(copy, 'maps')).map((name) => readFileSync(join(copy, 'maps', name)).length),
  );
  assert.throws(
    () => buildPrivateContainer(copy, { ...CONTAINER_LIMITS, entryBytes: largest - 1 }),
    refuses('CONTAINER_ENTRY'),
  );
  assert.throws(
    () => buildPrivateContainer(copy, { ...CONTAINER_LIMITS, entries: 3 }),
    refuses('CONTAINER_SIZE'),
  );
  const { bytes } = buildPrivateContainer(copy);
  // Exactly at every bound is admitted, on building and on reading.
  const exact = {
    entryBytes: largest,
    entries: 3 + readdirSync(join(copy, 'maps')).length,
    totalBytes: bytes.length,
  };
  assert.deepEqual(buildPrivateContainer(copy, exact).bytes, bytes);
  assert.equal(readPrivateContainer(bytes, exact).files.size, exact.entries);
  // Reading bounds each entry as building does.
  assert.throws(
    () => readPrivateContainer(bytes, { ...CONTAINER_LIMITS, entryBytes: largest - 1 }),
    refuses('CONTAINER_FILE_SIZE'),
  );
  // The total is refused before the archive is assembled, not by the read-back check.
  assert.throws(
    () => buildPrivateContainer(copy, { ...CONTAINER_LIMITS, totalBytes: bytes.length - 1 }),
    refuses('CONTAINER_TOTAL'),
  );
  assert.throws(
    () => readPrivateContainer(bytes, { ...CONTAINER_LIMITS, entries: 3 }),
    refuses('CONTAINER_FILE_COUNT'),
  );
  assert.throws(
    () => readPrivateContainer(bytes, { ...CONTAINER_LIMITS, totalBytes: bytes.length - 1 }),
    refuses('CONTAINER_SIZE'),
  );
});

test("each record stays within its reader's bound, on building and on reading", () => {
  /** @param {string} name @param {number} extra */
  const padded = (name, extra) =>
    staging((copy) => {
      const path = join(copy, name);
      const bytes = readFileSync(path);
      // Trailing whitespace keeps the JSON valid, so only the size is judged.
      const padding = Buffer.alloc(RECORD_BYTES[name] - bytes.length + extra, 0x20);
      writeFileSync(path, Buffer.concat([bytes, padding]));
    });
  for (const name of ['finalized.json', 'manifest.json', 'metafile-esm.json']) {
    buildPrivateContainer(padded(name, 0));
    assert.throws(() => buildPrivateContainer(padded(name, 1)), refuses('CONTAINER_RECORD'), name);
  }
  // The manifest reader recovery uses refuses that manifest too.
  assert.throws(
    () => readPrivateManifest(padded('manifest.json', 1)),
    (error) => error instanceof Error && 'code' in error && error.code === 'UNREADABLE',
  );
  const files = readPrivateContainer(buildPrivateContainer(staging()).bytes).files;
  const over = new Map(files);
  over.set(
    'manifest.json',
    Buffer.concat([files.get('manifest.json'), Buffer.alloc(RECORD_BYTES['manifest.json'], 0x20)]),
  );
  assert.throws(
    () => readPrivateContainer(writeUstar([...over], () => 0o600)),
    refuses('CONTAINER_RECORD'),
  );
});

test('a written container that does not read back refuses: the self-check', () => {
  // A chunk name too long for the dialect's 100-byte name field is truncated by the writer, and
  // only the read-back of the written container notices.
  const copy = staging((dir) => {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const record = JSON.parse(readFileSync(join(dir, 'finalized.json'), 'utf8'));
    const [output] = manifest.outputs;
    const long = `dist/${'x'.repeat(100)}.js`;
    renameSync(
      join(dir, 'maps', posix.basename(output.map.path)),
      join(dir, 'maps', `${posix.basename(long)}.map`),
    );
    for (const item of record.outputs) if (item.path === output.path) item.path = long;
    for (const item of record.maps) if (item.path === output.map.path) item.path = `${long}.map`;
    output.path = long;
    output.map.path = `${long}.map`;
    manifest.outputs.sort((left, right) => (left.path < right.path ? -1 : 1));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'finalized.json'), JSON.stringify(record));
  });
  assert.throws(() => buildPrivateContainer(copy), refuses('CONTAINER_TAR_NAME'));
});

test('a container outside the owner-only dialect, or whose contents disagree, refuses on reading', () => {
  const files = readPrivateContainer(buildPrivateContainer(staging()).bytes).files;
  const write = (entries, mode = 0o600) => writeUstar(entries, () => mode);
  assert.throws(
    () => readPrivateContainer(write([...files, ['notes.txt', Buffer.from('x')]])),
    refuses('CONTAINER_PATH'),
  );
  assert.throws(
    () => readPrivateContainer(write([...files], 0o644)),
    refuses('CONTAINER_TAR_MODE'),
  );
  const [map] = [...files.keys()].filter((path) => path.startsWith('maps/'));
  const drifted = new Map(files);
  drifted.set(map, Buffer.concat([files.get(map), Buffer.from(' ')]));
  assert.throws(() => readPrivateContainer(write([...drifted])), refuses('CONTAINER_DRIFT'));
  const missing = new Map(files);
  missing.delete('metafile-esm.json');
  assert.throws(() => readPrivateContainer(write([...missing])), refuses('CONTAINER_SET'));
  assert.throws(() => readPrivateContainer(Uint8Array.from([1])), refuses('CONTAINER_SIZE'));
});
