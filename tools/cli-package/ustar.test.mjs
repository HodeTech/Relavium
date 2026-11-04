import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readUstar, ustarEntry, writeChecksum, writeUstar } from './ustar.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'relavium-ustar-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

class Refused extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const refuses = (code) => (error) => error instanceof Refused && error.code === code;

/** A private, owner-only dialect like the custody container's. */
function read(tar, overrides = {}) {
  const files = [];
  const order = [];
  readUstar(tar, {
    admitPath: (path) => {
      if (!/^(?:[A-Za-z-]+\.json|maps\/[a-z]+\.js\.map)$/u.test(path)) throw new Refused('PATH');
    },
    modeFor: () => 0o600,
    maxFiles: 4,
    maxFileBytes: 4096,
    refuse: (code) => {
      throw new Refused(code);
    },
    admitEntry: (path) => order.push(`admit ${path}`),
    onFile: ({ path, mode, contents }) => {
      order.push(`file ${path}`);
      files.push([path, mode, Buffer.from(contents)]);
    },
    ...overrides,
  });
  return { files, order };
}

/** Unaligned, empty, exactly one block, and one byte over a block: every padding case. */
const ENTRIES = [
  ['manifest.json', Buffer.from('{"synthetic":true}\n')],
  ['empty.json', Buffer.alloc(0)],
  ['maps/index.js.map', Buffer.alloc(512, 0x62)],
  ['metafile-esm.json', Buffer.alloc(513, 0x61)],
];

test('a written archive reads back entry by entry, in order, with its mode', () => {
  const { files, order } = read(writeUstar(ENTRIES, () => 0o600));
  assert.deepEqual(
    files,
    ENTRIES.map(([path, bytes]) => [path, 0o600, bytes]),
  );
  assert.deepEqual(
    order,
    ENTRIES.flatMap(([path]) => [`admit ${path}`, `file ${path}`]),
  );
});

test('the platform tar extracts the same bytes, nested directories included', () => {
  const archive = join(scratch, 'container.tar');
  const out = join(scratch, 'extracted');
  mkdirSync(out);
  writeFileSync(
    archive,
    writeUstar(ENTRIES, () => 0o600),
  );
  const run = spawnSync('tar', ['-xf', archive, '-C', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, 'the platform tar must extract the archive');
  for (const [path, bytes] of ENTRIES) {
    assert.deepEqual(readFileSync(join(out, ...path.split('/'))), bytes);
  }
});

/** One entry archive whose header the mutation edits, with a repaired checksum unless told not to. */
function mutated(mutate, { repair = true } = {}) {
  const block = ustarEntry('manifest.json', Buffer.from('{}'), 0o600);
  mutate(block);
  if (repair) writeChecksum(block.subarray(0, 512));
  return Buffer.concat([block, Buffer.alloc(1024)]);
}

test('each header field outside the dialect refuses with its own code', () => {
  for (const [code, archive] of [
    ['TAR_CHECKSUM', mutated((block) => (block[0] = 0x4d), { repair: false })],
    ['TAR_FORMAT', mutated((block) => block.write('gnutar', 257))],
    ['TAR_TYPE', mutated((block) => (block[156] = 0x35))],
    ['TAR_METADATA', mutated((block) => (block[157] = 0x61))],
    ['TAR_METADATA', mutated((block) => block.write('000001 \0', 108))],
    ['TAR_METADATA', mutated((block) => block.write('000001 \0', 116))],
    ['TAR_METADATA', mutated((block) => block.write('000001 \0', 329))],
    ['TAR_METADATA', mutated((block) => block.write('000001 \0', 337))],
    ['TAR_NUMBER', mutated((block) => block.write('0000000000x ', 136))],
    ['TAR_FORMAT', mutated((block) => block.write('xx', 263))],
    ['TAR_NUMBER', mutated((block) => block.write('00000000009 ', 124))],
    ['TAR_NAME', mutated((block) => (block[20] = 0x61))],
    ['TAR_NAME', mutated((block) => block.fill(0, 0, 100))],
    ['UTF8', mutated((block) => block.fill(0xff, 0, 4))],
    ['TAR_MODE', mutated((block) => block.write('000644', 100))],
    ['FILE_SIZE', mutated((block) => block.write('00000010001 ', 124))],
  ]) {
    assert.throws(() => read(archive), refuses(code), code);
  }
});

test('the archive structure refuses duplicates, aliases, truncation, padding, count and end', () => {
  const one = ustarEntry('manifest.json', Buffer.from('{}'), 0o600);
  const end = Buffer.alloc(1024);
  const padded = Buffer.from(one);
  padded[512 + 2] = 1;
  for (const [code, archive] of [
    ['DUPLICATE_FILE', Buffer.concat([one, one, end])],
    [
      'PATH_ALIAS',
      Buffer.concat([one, ustarEntry('MANIFEST.json', Buffer.from('{}'), 0o600), end]),
    ],
    ['TAR_TRUNCATED', one.subarray(0, 600)],
    ['TAR_TRUNCATED', Buffer.concat([one.subarray(0, 512), Buffer.alloc(100)])],
    ['TAR_PADDING', Buffer.concat([padded, end])],
    ['TAR_END', one],
    ['TAR_END', Buffer.concat([one, end, Buffer.alloc(512)])],
    ['TAR_END', Buffer.concat([one, Buffer.alloc(1023), Buffer.from([1])])],
    [
      'FILE_COUNT',
      writeUstar(
        ['a', 'b', 'c', 'd', 'e'].map((name) => [`${name}.json`, Buffer.from('{}')]),
        () => 0o600,
      ),
    ],
  ]) {
    assert.throws(() => read(archive), refuses(code), code);
  }
  // A one-character name is a name: the caller's path rule judges it.
  assert.throws(
    () => read(Buffer.concat([ustarEntry('a', Buffer.from('{}'), 0o600), end])),
    refuses('PATH'),
  );
  // The caller's path rule runs inside the header check, before its mode and size are judged.
  assert.throws(
    () => read(Buffer.concat([ustarEntry('outside.txt', Buffer.alloc(8192), 0o644), end])),
    refuses('PATH'),
  );
});

test("the caller's entry hook runs before the entry's bytes are bounded", () => {
  const order = [];
  assert.throws(
    () =>
      read(writeUstar(ENTRIES, () => 0o600).subarray(0, 600), {
        admitEntry: (path) => {
          order.push(path);
          throw new Refused('EXTRA');
        },
      }),
    refuses('EXTRA'),
  );
  assert.deepEqual(order, ['manifest.json']);
});
