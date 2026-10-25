import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CustodyError } from './custody-error.mjs';
import { PINS } from './gpg-fixture.mjs';
import {
  FIXTURE_PINS_FILE,
  PRODUCTION_RECIPIENT_ROOT,
  SYNTHETIC_SOURCE,
  isProductionRecipient,
  isSyntheticSource,
  loadProductionRecipient,
  loadRecipientForTests,
} from './release-recipient.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'relavium-release-recipient-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;
const fresh = (name) => join(scratch, `${name}-${(count += 1)}`);
const refuses = (code) => (error) =>
  error instanceof CustodyError &&
  error.code === code &&
  /^PACKED_CLI_CUSTODY_[A-Z_]+$/u.test(error.message) &&
  !error.message.includes(scratch);
const posix = process.platform !== 'win32';

const A = { primary: '1'.repeat(40), subkey: '2'.repeat(40) };
const B = { primary: '1'.repeat(40), subkey: '3'.repeat(40) };

/** A recipient root with the given files; `pins` may be any value or raw text. */
function root({
  pins = { version: 1, recipients: [{ ...A, status: 'current' }] },
  key = 'key',
} = {}) {
  const path = fresh('root');
  mkdirSync(path);
  writeFileSync(join(path, 'recipient.asc'), key);
  writeFileSync(
    join(path, 'pins.json'),
    typeof pins === 'string' ? pins : `${JSON.stringify(pins, null, 2)}\n`,
  );
  return path;
}
const history = (...recipients) => ({ version: 1, recipients });

test('the committed recipient directory is absent in Wave 3, so every production use refuses', () => {
  // Interim: Wave 4b commits the directory and turns this into a load of the real recipient.
  assert.equal(basename(PRODUCTION_RECIPIENT_ROOT), 'release-recipient');
  // No trailing separator: lstat of `dir/` would follow a link to another directory.
  assert.equal(/[\\/]$/u.test(PRODUCTION_RECIPIENT_ROOT), false);
  assert.equal(
    dirname(PRODUCTION_RECIPIENT_ROOT),
    fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/u, ''),
  );
  assert.throws(() => loadProductionRecipient(), refuses('PRODUCTION_RECIPIENT_ABSENT'));
  // It takes no argument: a root passed to it is ignored, never an override.
  assert.throws(
    () => loadProductionRecipient({ root: root() }),
    refuses('PRODUCTION_RECIPIENT_ABSENT'),
  );
  assert.throws(
    () => loadRecipientForTests({ root: join(fresh('missing'), 'release-recipient') }),
    refuses('PRODUCTION_RECIPIENT_ABSENT'),
  );
});

test('a loaded recipient is frozen, branded, and its current pins come from an append-only history', () => {
  const path = root({ pins: history({ ...A, status: 'retired' }, { ...B, status: 'current' }) });
  const recipient = loadRecipientForTests({ root: path });
  assert.equal(recipient.file, join(path, 'recipient.asc'));
  assert.deepEqual(recipient.current, B);
  assert.deepEqual(recipient.history, [
    { ...A, status: 'retired' },
    { ...B, status: 'current' },
  ]);
  assert.ok(Object.isFrozen(recipient) && Object.isFrozen(recipient.current));
  assert.ok(Object.isFrozen(recipient.history) && recipient.history.every(Object.isFrozen));
  assert.equal(isProductionRecipient(recipient), true);
  // Only the loaded value is a production recipient: never a copy or a hand-built object.
  for (const value of [
    { ...recipient },
    globalThis.structuredClone(recipient),
    { file: recipient.file, current: recipient.current, history: recipient.history },
    null,
    undefined,
    'recipient',
  ]) {
    assert.equal(isProductionRecipient(value), false);
  }
  // Each load brands its own value.
  const again = loadRecipientForTests({ root: path });
  assert.notEqual(again, recipient);
  assert.equal(isProductionRecipient(again), true);
});

test('a recipient directory that is not exactly the two committed files refuses', () => {
  const valid = root();
  const cases = [
    () => {
      const file = fresh('file-root');
      writeFileSync(file, '');
      return file;
    },
    () => {
      const path = root();
      writeFileSync(join(path, 'extra'), '');
      return path;
    },
    () => {
      const path = root();
      rmSync(join(path, 'pins.json'));
      return path;
    },
    () => {
      const path = root();
      rmSync(join(path, 'recipient.asc'));
      return path;
    },
    () => root({ key: Buffer.alloc(64 * 1024 + 1) }),
    () =>
      root({
        pins: JSON.stringify(history({ ...A, status: 'current' })).padEnd(64 * 1024 + 1, ' '),
      }),
  ];
  if (posix) {
    cases.push(
      () => {
        const link = fresh('linked-root');
        symlinkSync(valid, link);
        return link;
      },
      () => {
        const path = root();
        rmSync(join(path, 'recipient.asc'));
        symlinkSync(join(valid, 'recipient.asc'), join(path, 'recipient.asc'));
        return path;
      },
      () => {
        const path = root();
        rmSync(join(path, 'pins.json'));
        assert.equal(spawnSync('mkfifo', [join(path, 'pins.json')]).status, 0);
        return path;
      },
    );
  }
  for (const [index, make] of cases.entries()) {
    assert.throws(
      () => loadRecipientForTests({ root: make() }),
      refuses('PRODUCTION_RECIPIENT_INVALID'),
      String(index),
    );
  }
});

test('the pins history is exactly one current recipient among at most 32 distinct ones', () => {
  const current = { ...A, status: 'current' };
  for (const pins of [
    'not json',
    '[]',
    history(),
    { version: 2, recipients: [current] },
    { version: 1, recipients: [current], extra: true },
    { recipients: [current] },
    { version: 1, recipients: {} },
    history({ ...A, status: 'retired' }),
    history(current, { ...B, status: 'current' }),
    history(current, { primary: B.primary, subkey: A.subkey, status: 'retired' }),
    history({ ...A, status: 'pending' }),
    history(current, { ...B, status: 'pending' }),
    history({ ...A, status: 'current', extra: true }),
    history({ primary: A.primary, status: 'current' }),
    history({ primary: 'a'.repeat(40), subkey: A.subkey, status: 'current' }),
    history({ primary: [A.primary], subkey: A.subkey, status: 'current' }),
    history({ primary: A.primary, subkey: `${A.subkey}!`, status: 'current' }),
    history({ primary: `X${A.primary}`, subkey: A.subkey, status: 'current' }),
    // Only the canonical serialization: a compact layout, a missing final newline, another key order or a
    // duplicated key, which JSON.parse would resolve silently to its last value.
    JSON.stringify(history({ ...A, status: 'current' })),
    JSON.stringify(history({ ...A, status: 'current' }), null, 2),
    `${JSON.stringify({ recipients: [{ ...A, status: 'current' }], version: 1 }, null, 2)}\n`,
    `${JSON.stringify(history({ status: 'current', ...A }), null, 2)}\n`,
    `${JSON.stringify(history({ ...A, status: 'retired' }), null, 2)}\n`.replace(
      '"status": "retired"',
      '"status": "retired",\n      "status": "current"',
    ),
    history(
      current,
      ...Array.from({ length: 32 }, (_, index) => ({
        primary: A.primary,
        subkey: index.toString(16).toUpperCase().padStart(40, 'F'),
        status: 'retired',
      })),
    ),
  ]) {
    assert.throws(
      () => loadRecipientForTests({ root: root({ pins }) }),
      refuses('PRODUCTION_RECIPIENT_INVALID'),
      typeof pins === 'string' ? pins : JSON.stringify(pins).slice(0, 120),
    );
  }
  // Exactly 32 entries is within the bound.
  const full = history(
    current,
    ...Array.from({ length: 31 }, (_, index) => ({
      primary: A.primary,
      subkey: index.toString(16).toUpperCase().padStart(40, 'F'),
      status: 'retired',
    })),
  );
  assert.equal(loadRecipientForTests({ root: root({ pins: full }) }).history.length, 32);
});

test('a history naming a committed fixture key refuses, whichever fingerprint it is', () => {
  const fixture = PINS.good;
  for (const entry of [
    { primary: fixture.primary, subkey: A.subkey },
    { primary: A.primary, subkey: fixture.subkey },
  ]) {
    assert.throws(
      () =>
        loadRecipientForTests({
          root: root({ pins: history({ ...entry, status: 'current' }) }),
        }),
      refuses('FIXTURE_RECIPIENT'),
    );
  }
  // A retired fixture entry refuses as well.
  assert.throws(
    () =>
      loadRecipientForTests({
        root: root({
          pins: history({ ...A, status: 'current' }, { ...PINS.other, status: 'retired' }),
        }),
      }),
    refuses('FIXTURE_RECIPIENT'),
  );
  // The denylist is the committed fixtures file; an unreadable or malformed one fails closed.
  assert.equal(
    FIXTURE_PINS_FILE,
    fileURLToPath(new URL('./custody-fixtures/pins.json', import.meta.url)),
  );
  const fixtureFiles = [join(fresh('none'), 'pins.json')];
  for (const content of [
    '[]',
    '{}',
    'not json',
    JSON.stringify({ good: { primary: A.primary } }),
    JSON.stringify({ good: { ...A, extra: 'x' } }),
    JSON.stringify({ good: { primary: 'a'.repeat(40), subkey: A.subkey } }),
    JSON.stringify({ good: { primary: A.primary, subkey: 'a'.repeat(40) } }),
    JSON.stringify({ good: A, bad: null }),
  ]) {
    const file = fresh('fixtures.json');
    writeFileSync(file, content);
    fixtureFiles.push(file);
  }
  for (const fixtures of fixtureFiles) {
    assert.throws(
      () => loadRecipientForTests({ root: root(), fixtures }),
      refuses('PRODUCTION_RECIPIENT_INVALID'),
    );
  }
});

test(
  'a recipient directory that cannot be read refuses with a fixed code and no path',
  { skip: !posix || process.getuid?.() === 0 },
  () => {
    const path = root();
    chmodSync(path, 0o000);
    try {
      assert.throws(
        () => loadRecipientForTests({ root: path }),
        refuses('PRODUCTION_RECIPIENT_INVALID'),
      );
    } finally {
      chmodSync(path, 0o700);
    }
  },
);

test('the synthetic source is the fixtures sentinel, never a clean source', () => {
  assert.deepEqual(SYNTHETIC_SOURCE, { commit: 'c'.repeat(40), tree: 'b'.repeat(40) });
  assert.ok(Object.isFrozen(SYNTHETIC_SOURCE));
  assert.equal(isSyntheticSource({ commit: 'c'.repeat(40), tree: 'b'.repeat(40) }), true);
  assert.equal(isSyntheticSource({ commit: 'c'.repeat(40), tree: 'e'.repeat(40) }), false);
  assert.equal(isSyntheticSource({ commit: 'd'.repeat(40), tree: 'b'.repeat(40) }), false);
});
