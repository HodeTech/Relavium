import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ARCHIVE_LIMITS } from './archive.mjs';
import { isPackageVersion } from './binding.mjs';
import { CustodyError } from './custody-error.mjs';
import { parsePins } from './custody.mjs';
import { sha256 } from './files.mjs';
import {
  CIPHERTEXT_BYTES,
  RELEASE_BINDING_FILE,
  RELEASE_BINDING_KIND,
  ciphertextFileName,
  parseReleaseBinding,
  serializeReleaseBinding,
  tarballName,
  validateReleaseBinding,
  verifyRetainedCandidate,
} from './release-binding.mjs';
import { SYNTHETIC_SOURCE, loadRecipientForTests } from './release-recipient.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'relavium-release-binding-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;
const fresh = (name) => join(scratch, `${name}-${(count += 1)}`);
const refuses = (code) => (error) =>
  error instanceof CustodyError &&
  error.code === code &&
  /^PACKED_CLI_CUSTODY_[A-Z_]+$/u.test(error.message) &&
  !error.message.includes(scratch);
const posix = process.platform !== 'win32';

const VERSION = '0.1.1';
const TARBALL = Buffer.from('a synthetic tarball, never a package\n');
const CIPHERTEXT = Buffer.from('synthetic ciphertext bytes');
const PINS = Object.freeze({ primary: '4'.repeat(40), subkey: '5'.repeat(40) });
const A = { primary: '1'.repeat(40), subkey: '2'.repeat(40) };
const B = { primary: '1'.repeat(40), subkey: '3'.repeat(40) };
const C = { primary: '6'.repeat(40), subkey: '7'.repeat(40) };
const CLEAN = { commit: 'd'.repeat(40), tree: 'e'.repeat(40), dirty: false };
const SYNTHETIC = { ...SYNTHETIC_SOURCE, dirty: true };

/** A loaded production recipient with the given history, from a temporary root. */
function production(...recipients) {
  const root = fresh('recipient');
  mkdirSync(root);
  writeFileSync(join(root, 'recipient.asc'), 'key');
  writeFileSync(
    join(root, 'pins.json'),
    `${JSON.stringify({ version: 1, recipients }, null, 2)}\n`,
  );
  return loadRecipientForTests({ root });
}
const ROTATED = production({ ...A, status: 'retired' }, { ...B, status: 'current' });
const synthetic = Object.freeze({ scope: 'synthetic', pins: PINS, packageVersion: VERSION });
const productionExpected = (recipient = ROTATED) =>
  Object.freeze({
    scope: 'production',
    recipient,
    packageVersion: VERSION,
    source: CLEAN.commit,
  });

/** A receipt in canonical key order; synthetic unless told otherwise. */
function receipt({
  source = SYNTHETIC,
  recipient = PINS,
  tarball = TARBALL,
  ciphertext = CIPHERTEXT,
} = {}) {
  return {
    version: 1,
    kind: RELEASE_BINDING_KIND,
    packageVersion: VERSION,
    source: { ...source },
    tarball: { name: tarballName(VERSION), bytes: tarball.length, sha256: sha256(tarball) },
    ciphertext: {
      name: ciphertextFileName(VERSION),
      bytes: ciphertext.length,
      sha256: sha256(ciphertext),
    },
    recipient: { ...recipient },
    toolchain: {
      node: 'v22.23.1',
      pnpm: '9.12.3',
      typescript: '5.6.3',
      tsup: '8.3.5',
      esbuild: '0.24.0',
      gnupg: '2.5.21',
    },
    target: 'node22',
    inputs: { 'apps/cli/package.json': 'a'.repeat(64), 'package.json': 'b'.repeat(64) },
    mapCheck: { status: 'complete' },
    origin: {
      kind: 'github',
      repository: 'example/relavium',
      workflow: 'release',
      runId: '1',
      runAttempt: '1',
      event: 'push',
      source: source.commit,
    },
  };
}
const productionReceipt = (recipient = B) => receipt({ source: CLEAN, recipient });
/** A deep copy changed by `change`. */
const changed = (value, change) => {
  const copy = globalThis.structuredClone(value);
  change(copy);
  return copy;
};

test('a valid receipt validates to its frozen canonical copy, and its canonical bytes parse', () => {
  for (const [value, expected] of [
    [receipt(), synthetic],
    [productionReceipt(), productionExpected()],
  ]) {
    const normalized = validateReleaseBinding(value, expected);
    assert.deepEqual(normalized, value);
    assert.notEqual(normalized, value);
    assert.deepEqual(Object.keys(normalized), Object.keys(value));
    const frozen = (object) =>
      Object.isFrozen(object) &&
      Object.values(object).every((child) => typeof child !== 'object' || frozen(child));
    assert.ok(frozen(normalized));
    const bytes = serializeReleaseBinding(normalized);
    assert.equal(bytes.toString('utf8'), `${JSON.stringify(value, null, 2)}\n`);
    assert.deepEqual(parseReleaseBinding(bytes, expected), normalized);
  }
  // Inputs come back sorted by path.
  const unsorted = changed(receipt(), (copy) => {
    copy.inputs = { 'package.json': 'b'.repeat(64), 'apps/cli/package.json': 'a'.repeat(64) };
  });
  assert.deepEqual(Object.keys(validateReleaseBinding(unsorted, synthetic).inputs), [
    'apps/cli/package.json',
    'package.json',
  ]);
});

test('every key at every level is exact', () => {
  const value = receipt();
  for (const key of Object.keys(value)) {
    const code = key === 'version' || key === 'kind' ? 'BINDING_VERSION' : 'BINDING_SHAPE';
    assert.throws(
      () =>
        validateReleaseBinding(
          changed(value, (copy) => delete copy[key]),
          synthetic,
        ),
      refuses(code),
      key,
    );
  }
  assert.throws(
    () => validateReleaseBinding({ ...value, extra: true }, synthetic),
    refuses('BINDING_SHAPE'),
  );
  for (const parent of [
    'source',
    'tarball',
    'ciphertext',
    'recipient',
    'toolchain',
    'mapCheck',
    'origin',
  ]) {
    for (const key of Object.keys(value[parent])) {
      // An origin without its kind is not a GitHub origin.
      const code = parent === 'origin' && key === 'kind' ? 'BINDING_ORIGIN' : 'BINDING_SHAPE';
      assert.throws(
        () =>
          validateReleaseBinding(
            changed(value, (copy) => delete copy[parent][key]),
            synthetic,
          ),
        refuses(code),
        `${parent}.${key}`,
      );
    }
    assert.throws(
      () =>
        validateReleaseBinding(
          changed(value, (copy) => (copy[parent].extra = 'x')),
          synthetic,
        ),
      refuses('BINDING_SHAPE'),
      `${parent}.extra`,
    );
    for (const replacement of [null, [], 'x']) {
      const code = parent === 'origin' ? 'BINDING_ORIGIN' : 'BINDING_SHAPE';
      assert.throws(
        () =>
          validateReleaseBinding(
            changed(value, (copy) => (copy[parent] = replacement)),
            synthetic,
          ),
        refuses(code),
        `${parent} = ${JSON.stringify(replacement)}`,
      );
    }
  }
  for (const inputs of [null, [], 'x']) {
    assert.throws(
      () =>
        validateReleaseBinding(
          changed(value, (copy) => (copy.inputs = inputs)),
          synthetic,
        ),
      refuses('BINDING_SHAPE'),
    );
  }
});

test('every value has its exact format', () => {
  const value = receipt();
  const cases = [
    (copy) => (copy.packageVersion = 'v0.1.1'),
    (copy) => (copy.packageVersion = `0.1.1-${'a'.repeat(100)}`),
    (copy) => (copy.source.commit = copy.source.commit.toUpperCase()),
    (copy) => (copy.source.tree = 'b'.repeat(39)),
    (copy) => (copy.source.dirty = 'true'),
    (copy) => (copy.tarball.sha256 = copy.tarball.sha256.toUpperCase()),
    (copy) => (copy.ciphertext.sha256 = 'z'.repeat(64)),
    (copy) => (copy.tarball.bytes = 18.5),
    (copy) => (copy.ciphertext.bytes = '26'),
    (copy) => (copy.recipient.primary = copy.recipient.primary.toLowerCase().replace(/4/gu, 'a')),
    (copy) => (copy.recipient.subkey = `${copy.recipient.subkey.slice(0, 39)}!`),
    (copy) => (copy.toolchain.node = '22.23.1'),
    (copy) => (copy.toolchain.pnpm = 'latest'),
    (copy) => (copy.toolchain.typescript = '5.6'),
    (copy) => (copy.toolchain.tsup = 8),
    (copy) => (copy.toolchain.esbuild = '0.24.0-'),
    (copy) => (copy.toolchain.gnupg = '2.5.21-beta'),
    (copy) => (copy.target = 'node2'),
    (copy) => (copy.target = 'deno22'),
    (copy) => (copy.inputs = {}),
    (copy) =>
      (copy.inputs = Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`file-${index}.json`, 'a'.repeat(64)]),
      )),
    ...['../package.json', './package.json', 'apps//cli', '/package.json', 'apps\\cli', 'a b'].map(
      (path) => (copy) => (copy.inputs = { [path]: 'a'.repeat(64) }),
    ),
    (copy) => (copy.inputs = { [`${'a'.repeat(257)}`]: 'a'.repeat(64) }),
    (copy) => (copy.inputs = { 'package.json': 'A'.repeat(64) }),
    (copy) => (copy.origin.repository = 'relavium'),
    (copy) => (copy.origin.workflow = 'release\u0007'),
    (copy) => (copy.origin.runId = '0'),
    (copy) => (copy.origin.runAttempt = '01'),
    (copy) => (copy.origin.runAttempt = '1234567'),
    (copy) => (copy.origin.repository = `${'a'.repeat(100)}/${'b'.repeat(100)}`),
    // Every pattern is anchored at both ends: a prefix before a valid value refuses.
    (copy) => (copy.source.commit = `x${copy.source.commit}`),
    (copy) => (copy.source.tree = `x${copy.source.tree}`),
    (copy) => (copy.tarball.sha256 = `x${copy.tarball.sha256}`),
    (copy) => (copy.recipient.primary = `X${copy.recipient.primary}`),
    (copy) => (copy.toolchain.node = `x${copy.toolchain.node}`),
    (copy) => (copy.toolchain.typescript = `x${copy.toolchain.typescript}`),
    (copy) => (copy.toolchain.gnupg = `x${copy.toolchain.gnupg}`),
    (copy) => (copy.target = `x${copy.target}`),
    (copy) => (copy.origin.repository = ` ${copy.origin.repository}`),
    (copy) => (copy.origin.workflow = `\u0007${copy.origin.workflow}`),
    (copy) => (copy.origin.runId = `x${copy.origin.runId}`),
    (copy) => (copy.origin.runAttempt = `x${copy.origin.runAttempt}`),
    (copy) => (copy.inputs = { 'package.json': `x${'a'.repeat(64)}` }),
    // ...and at the end: a suffix after a valid value refuses.
    (copy) => (copy.source.commit = `${copy.source.commit}x`),
    (copy) => (copy.source.tree = `${copy.source.tree}x`),
    (copy) => (copy.tarball.sha256 = `${copy.tarball.sha256}a`),
    (copy) => (copy.recipient.subkey = `${copy.recipient.subkey}A`),
    (copy) => (copy.toolchain.node = `${copy.toolchain.node}x`),
    (copy) => (copy.toolchain.typescript = `${copy.toolchain.typescript} `),
    (copy) => (copy.toolchain.gnupg = `${copy.toolchain.gnupg}x`),
    (copy) => (copy.target = `${copy.target}x`),
    (copy) => (copy.origin.repository = `${copy.origin.repository} x`),
    (copy) => (copy.origin.workflow = `${copy.origin.workflow}\u0007`),
    (copy) => (copy.origin.runId = `${copy.origin.runId}x`),
    (copy) => (copy.origin.runAttempt = `${copy.origin.runAttempt}x`),
    (copy) => (copy.inputs = { 'package.json': `${'a'.repeat(64)}a` }),
    // The toolchain's length bounds: one past each refuses.
    (copy) => (copy.toolchain.node = `v1.1.${'1'.repeat(36)}`),
    ...['pnpm', 'typescript', 'tsup', 'esbuild'].map(
      (tool) => (copy) => (copy.toolchain[tool] = `1.1.${'1'.repeat(97)}`),
    ),
    (copy) => (copy.toolchain.gnupg = `1.1.${'1'.repeat(37)}`),
    // A value whose string form matches is still not a string.
    (copy) => (copy.toolchain.node = [copy.toolchain.node]),
    (copy) => (copy.source.commit = [copy.source.commit]),
    (copy) => (copy.origin.workflow = 'w'.repeat(201)),
    (copy) => (copy.origin.runId = '1'.repeat(21)),
    // Integer-like names would sort ahead of every path in the canonical bytes.
    ...['0', '9', '10', '4294967295'].map(
      (path) => (copy) =>
        (copy.inputs = { [path]: 'a'.repeat(64), 'package.json': 'b'.repeat(64) }),
    ),
  ];
  for (const [index, change] of cases.entries()) {
    assert.throws(
      () => validateReleaseBinding(changed(value, change), synthetic),
      refuses('BINDING_SHAPE'),
      `case ${index}`,
    );
  }
  // At the bounds: 64 inputs and a 256-character path are admitted.
  const bounded = changed(value, (copy) => {
    copy.inputs = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        index === 0 ? 'a'.repeat(256) : `file-${String(index).padStart(2, '0')}.json`,
        'a'.repeat(64),
      ]),
    );
  });
  assert.equal(Object.keys(validateReleaseBinding(bounded, synthetic).inputs).length, 64);
  const single = changed(value, (copy) => (copy.inputs = { 'package.json': 'a'.repeat(64) }));
  // The origin's bounds are inclusive, and a numeric-looking path with a leading zero is a name.
  const origins = changed(value, (copy) => {
    copy.origin.repository = `${'a'.repeat(99)}/${'b'.repeat(100)}`;
    copy.origin.workflow = 'w'.repeat(200);
    copy.origin.runId = '1'.repeat(20);
    copy.origin.runAttempt = '123456';
    copy.inputs = { '01': 'a'.repeat(64), 'package.json': 'b'.repeat(64) };
  });
  assert.deepEqual(validateReleaseBinding(origins, synthetic).origin, origins.origin);
  // The toolchain's length bounds are inclusive.
  const tools = changed(value, (copy) => {
    copy.toolchain.node = `v1.1.${'1'.repeat(35)}`;
    for (const tool of ['pnpm', 'typescript', 'tsup', 'esbuild']) {
      copy.toolchain[tool] = `1.1.${'1'.repeat(96)}`;
    }
    copy.toolchain.gnupg = `1.1.${'1'.repeat(36)}`;
  });
  assert.deepEqual(validateReleaseBinding(tools, synthetic).toolchain, tools.toolchain);
  assert.deepEqual(validateReleaseBinding(single, synthetic).inputs, {
    'package.json': 'a'.repeat(64),
  });
});

test('the version, candidate, names, sizes, map check and origin refuse with their own codes', () => {
  const value = receipt();
  for (const [code, change] of [
    ['BINDING_VERSION', (copy) => (copy.version = 2)],
    ['BINDING_VERSION', (copy) => (copy.kind = 'package_test')],
    ['BINDING_CANDIDATE', (copy) => (copy.packageVersion = '0.1.2')],
    ['BINDING_NAME', (copy) => (copy.tarball.name = 'relavium-0.1.2.tgz')],
    ['BINDING_NAME', (copy) => (copy.ciphertext.name = 'relavium-0.1.1.tgz.gpg')],
    ['BINDING_SIZE', (copy) => (copy.tarball.bytes = 17)],
    ['BINDING_SIZE', (copy) => (copy.tarball.bytes = ARCHIVE_LIMITS.compressedBytes + 1)],
    ['BINDING_SIZE', (copy) => (copy.ciphertext.bytes = 0)],
    ['BINDING_SIZE', (copy) => (copy.ciphertext.bytes = CIPHERTEXT_BYTES + 1)],
    ['BINDING_MAP_CHECK', (copy) => (copy.mapCheck.status = 'pending')],
    ['BINDING_ORIGIN', (copy) => (copy.origin = { kind: 'local' })],
    ['BINDING_ORIGIN', (copy) => (copy.origin.event = 'pull_request')],
    ['BINDING_ORIGIN', (copy) => (copy.origin.event = 'workflow_dispatch')],
    ['BINDING_ORIGIN', (copy) => (copy.origin.source = 'f'.repeat(40))],
    ['BINDING_RECIPIENT', (copy) => (copy.recipient = { ...C })],
    ['BINDING_RECIPIENT', (copy) => (copy.recipient.subkey = C.subkey)],
    // Both halves of the pair must match: the expected subkey under another primary refuses.
    ['BINDING_RECIPIENT', (copy) => (copy.recipient.primary = C.primary)],
    ['BINDING_SCOPE', (copy) => (copy.source = { ...CLEAN })],
    ['BINDING_SCOPE', (copy) => (copy.source.tree = 'e'.repeat(40))],
  ]) {
    assert.throws(
      () => validateReleaseBinding(changed(value, change), synthetic),
      refuses(code),
      code,
    );
  }
  for (const bad of [null, [], 'receipt', 1]) {
    assert.throws(() => validateReleaseBinding(bad, synthetic), refuses('BINDING_VERSION'));
  }
  // The sizes are inclusive bounds.
  for (const change of [
    (copy) => (copy.tarball.bytes = 18),
    (copy) => (copy.tarball.bytes = ARCHIVE_LIMITS.compressedBytes),
    (copy) => (copy.ciphertext.bytes = 1),
    (copy) => (copy.ciphertext.bytes = CIPHERTEXT_BYTES),
  ]) {
    validateReleaseBinding(changed(value, change), synthetic);
  }
  assert.equal(CIPHERTEXT_BYTES, 128 * 1024 * 1024 + 64 * 1024);
});

test('production scope admits only a clean, non-synthetic source of the expected commit and a recipient from the history', () => {
  const value = productionReceipt();
  for (const [code, change] of [
    ['BINDING_CANDIDATE', (copy) => (copy.source.commit = 'f'.repeat(40))],
    ['BINDING_DIRTY', (copy) => (copy.source.dirty = true)],
    ['BINDING_RECIPIENT', (copy) => (copy.recipient = { ...C })],
    ['BINDING_RECIPIENT', (copy) => (copy.recipient = { primary: A.primary, subkey: C.subkey })],
    ['BINDING_RECIPIENT', (copy) => (copy.recipient = { primary: C.primary, subkey: B.subkey })],
  ]) {
    assert.throws(
      () =>
        validateReleaseBinding(
          changed(value, (copy) => {
            change(copy);
            copy.origin.source = copy.source.commit;
          }),
          productionExpected(),
        ),
      refuses(code),
      code,
    );
  }
  // The synthetic sentinel never validates as a release, even with the expected commit.
  const sentinel = receipt({ source: { ...SYNTHETIC_SOURCE, dirty: false }, recipient: B });
  assert.throws(
    () =>
      validateReleaseBinding(sentinel, {
        ...productionExpected(),
        source: SYNTHETIC_SOURCE.commit,
      }),
    refuses('BINDING_SCOPE'),
  );
  // A rotation keeps every earlier candidate valid: a retired recipient still verifies, a recipient
  // outside the history never does, and a history that dropped one refuses that one's candidates.
  validateReleaseBinding(productionReceipt(A), productionExpected());
  validateReleaseBinding(productionReceipt(B), productionExpected());
  assert.throws(
    () => validateReleaseBinding(productionReceipt(C), productionExpected()),
    refuses('BINDING_RECIPIENT'),
  );
  const dropped = production({ ...B, status: 'current' });
  assert.throws(
    () => validateReleaseBinding(productionReceipt(A), productionExpected(dropped)),
    refuses('BINDING_RECIPIENT'),
  );
});

test('the expectation is required, and production needs the loaded recipient itself', () => {
  const value = productionReceipt();
  for (const expected of [
    undefined,
    null,
    {},
    { scope: 'release' },
    { ...synthetic, scope: 'Synthetic' },
  ]) {
    assert.throws(() => validateReleaseBinding(value, expected), refuses('BINDING_SCOPE'));
  }
  for (const recipient of [
    { ...ROTATED },
    globalThis.structuredClone(ROTATED),
    { file: ROTATED.file, current: ROTATED.current, history: ROTATED.history },
    undefined,
  ]) {
    assert.throws(
      () => validateReleaseBinding(value, { ...productionExpected(), recipient }),
      refuses('RECIPIENT_SOURCE'),
    );
  }
  // A synthetic expectation without pins admits no recipient.
  assert.throws(
    () => validateReleaseBinding(receipt(), { scope: 'synthetic', packageVersion: VERSION }),
    refuses('BINDING_RECIPIENT'),
  );
});

test('only the exact canonical bytes parse', () => {
  const bytes = serializeReleaseBinding(validateReleaseBinding(receipt(), synthetic));
  const text = bytes.toString('utf8');
  for (const [name, bad] of [
    ['duplicate key', Buffer.from(text.replace('{\n', '{\n  "version": 1,\n'))],
    [
      'reordered keys',
      Buffer.from(`${JSON.stringify({ kind: RELEASE_BINDING_KIND, ...receipt() }, null, 2)}\n`),
    ],
    ['compact', Buffer.from(`${JSON.stringify(receipt())}\n`)],
    ['no final newline', Buffer.from(text.slice(0, -1))],
    ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])],
    ['trailing byte', Buffer.concat([bytes, Buffer.from(' ')])],
    ['CRLF', Buffer.from(text.replaceAll('\n', '\r\n'))],
    [
      'invalid UTF-8 inside a string',
      (() => {
        const bad = Buffer.from(bytes);
        bad[bytes.indexOf('"workflow": "release"') + '"workflow": "r'.length] = 0xff;
        return bad;
      })(),
    ],
    ['not JSON', Buffer.from('receipt')],
    // Also refused as non-canonical: no canonical receipt reaches the 64 KiB bound, which only spares the
    // parser an oversized input.
    ['too large', Buffer.concat([bytes, Buffer.alloc(64 * 1024 + 1 - bytes.length, 0x20)])],
    [
      'unsorted inputs',
      Buffer.from(
        `${JSON.stringify(
          changed(receipt(), (copy) => {
            copy.inputs = {
              'package.json': 'b'.repeat(64),
              'apps/cli/package.json': 'a'.repeat(64),
            };
          }),
          null,
          2,
        )}\n`,
      ),
    ],
  ]) {
    assert.throws(() => parseReleaseBinding(bad, synthetic), refuses('BINDING_BYTES'), name);
  }
  // Only a Buffer read from the file is parsed: a string or another view refuses.
  assert.throws(() => parseReleaseBinding(text, synthetic), refuses('BINDING_BYTES'));
  assert.throws(
    () => parseReleaseBinding(new Uint8Array(bytes), synthetic),
    refuses('BINDING_BYTES'),
  );
  // A canonical receipt invalid for the expectation still refuses with its own code.
  assert.throws(
    () => parseReleaseBinding(bytes, { ...synthetic, packageVersion: '0.1.2' }),
    refuses('BINDING_CANDIDATE'),
  );
});

test("the package version and fingerprint rules are binding.mjs's and parsePins'", () => {
  /** @param {() => unknown} call */
  const admits = (call) => {
    try {
      call();
      return true;
    } catch (error) {
      if (error instanceof CustodyError) return false;
      throw error;
    }
  };
  for (const version of [
    '0.1.1',
    '1.2.3-rc.1',
    '1.2.3+build.5',
    '01.2.3',
    '1.2',
    'v1.2.3',
    '1.2.3-',
    '1.2.3+',
    `1.2.3-${'a'.repeat(94)}`,
    `1.2.3-${'a'.repeat(95)}`,
  ]) {
    const value = changed(receipt(), (copy) => {
      copy.packageVersion = version;
      copy.tarball.name = tarballName(version);
      copy.ciphertext.name = ciphertextFileName(version);
    });
    assert.equal(
      admits(() => validateReleaseBinding(value, { ...synthetic, packageVersion: version })),
      isPackageVersion(version),
      version,
    );
  }
  for (const fingerprint of [
    'A'.repeat(40),
    '0'.repeat(40),
    'a'.repeat(40),
    'A'.repeat(39),
    'A'.repeat(41),
    'G'.repeat(40),
    `${'A'.repeat(39)}!`,
  ]) {
    const pins = { primary: fingerprint, subkey: PINS.subkey };
    assert.equal(
      admits(() => validateReleaseBinding(receipt({ recipient: pins }), { ...synthetic, pins })),
      admits(() => parsePins(pins)),
      fingerprint,
    );
  }
});

/** A retained candidate directory: its receipt, tarball and ciphertext. */
function candidate({
  value = receipt(),
  tarball = TARBALL,
  ciphertext = CIPHERTEXT,
  expected = synthetic,
} = {}) {
  const directory = fresh('candidate');
  mkdirSync(directory);
  writeFileSync(
    join(directory, RELEASE_BINDING_FILE),
    serializeReleaseBinding(validateReleaseBinding(value, expected)),
  );
  writeFileSync(join(directory, tarballName(VERSION)), tarball);
  writeFileSync(join(directory, ciphertextFileName(VERSION)), ciphertext);
  return directory;
}
/** Every entry's kind and bytes, to show a refusal changed nothing; only regular files are read. */
const snapshot = (directory) =>
  readdirSync(directory)
    .sort()
    .map((name) => {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isFile()) return [name, sha256(readFileSync(path))];
      return [name, info.isSymbolicLink() ? `link ${readlinkSync(path)}` : String(info.mode)];
    });

test('a retained candidate is reused from its verified bytes, with no rebuild and no GnuPG call', () => {
  for (const [value, expected] of [
    [receipt(), synthetic],
    [productionReceipt(), productionExpected()],
  ]) {
    const directory = candidate({ value, expected });
    const before = snapshot(directory);
    const verified = verifyRetainedCandidate({ directory, expected });
    assert.ok(Object.isFrozen(verified));
    assert.deepEqual(verified.receipt, value);
    assert.deepEqual(verified.receiptBytes, readFileSync(join(directory, RELEASE_BINDING_FILE)));
    assert.deepEqual(verified.tarball, TARBALL);
    assert.deepEqual(verified.ciphertext, CIPHERTEXT);
    // The bytes returned are the bytes verified: replacing a file afterwards changes nothing returned.
    writeFileSync(join(directory, tarballName(VERSION)), Buffer.alloc(TARBALL.length, 0x78));
    assert.deepEqual(verified.tarball, TARBALL);
    writeFileSync(join(directory, tarballName(VERSION)), TARBALL);
    assert.deepEqual(snapshot(directory), before);
  }
  // A candidate sealed under a retired recipient is still reused after a rotation.
  const retired = productionReceipt(A);
  verifyRetainedCandidate({
    directory: candidate({ value: retired, expected: productionExpected() }),
    expected: productionExpected(),
  });
});

test('a retained candidate whose assets or entries differ from its receipt refuses and is left as it was', () => {
  const flip = (bytes) => {
    const copy = Buffer.from(bytes);
    copy[0] ^= 1;
    return copy;
  };
  const cases = [
    [
      'CANDIDATE_DIGEST',
      (directory) => writeFileSync(join(directory, tarballName(VERSION)), flip(TARBALL)),
    ],
    [
      'CANDIDATE_DIGEST',
      (directory) => writeFileSync(join(directory, ciphertextFileName(VERSION)), flip(CIPHERTEXT)),
    ],
    [
      'CANDIDATE_SIZE',
      (directory) =>
        writeFileSync(
          join(directory, ciphertextFileName(VERSION)),
          Buffer.concat([CIPHERTEXT, Buffer.from('x')]),
        ),
    ],
    [
      'CANDIDATE_SIZE',
      (directory) => writeFileSync(join(directory, tarballName(VERSION)), TARBALL.subarray(1)),
    ],
    ['CANDIDATE_ENTRIES', (directory) => writeFileSync(join(directory, 'notes.txt'), 'extra')],
    ['CANDIDATE_ENTRIES', (directory) => rmSync(join(directory, ciphertextFileName(VERSION)))],
    ['CANDIDATE_ENTRIES', (directory) => rmSync(join(directory, RELEASE_BINDING_FILE))],
    // Same count, another name: the listing is compared by name, not by size.
    [
      'CANDIDATE_ENTRIES',
      (directory) =>
        renameSync(
          join(directory, tarballName(VERSION)),
          join(directory, tarballName(VERSION).toUpperCase()),
        ),
    ],
    [
      'CANDIDATE_ASSET',
      (directory) => {
        rmSync(join(directory, tarballName(VERSION)));
        mkdirSync(join(directory, tarballName(VERSION)));
      },
    ],
    [
      'BINDING_BYTES',
      (directory) =>
        writeFileSync(
          join(directory, RELEASE_BINDING_FILE),
          Buffer.concat([readFileSync(join(directory, RELEASE_BINDING_FILE)), Buffer.from(' ')]),
        ),
    ],
  ];
  if (posix) {
    cases.push(
      [
        'CANDIDATE_ASSET',
        (directory) => {
          const target = fresh('linked-ciphertext');
          writeFileSync(target, CIPHERTEXT);
          rmSync(join(directory, ciphertextFileName(VERSION)));
          symlinkSync(target, join(directory, ciphertextFileName(VERSION)));
        },
      ],
      [
        'CANDIDATE_ASSET',
        (directory) => {
          const target = fresh('linked-receipt');
          writeFileSync(target, readFileSync(join(directory, RELEASE_BINDING_FILE)));
          rmSync(join(directory, RELEASE_BINDING_FILE));
          symlinkSync(target, join(directory, RELEASE_BINDING_FILE));
        },
      ],
      [
        'CANDIDATE_ASSET',
        (directory) => {
          rmSync(join(directory, tarballName(VERSION)));
          assert.equal(spawnSync('mkfifo', [join(directory, tarballName(VERSION))]).status, 0);
        },
      ],
    );
  }
  for (const [code, change] of cases) {
    const directory = candidate();
    change(directory);
    const before = snapshot(directory);
    assert.throws(
      () => verifyRetainedCandidate({ directory, expected: synthetic }),
      refuses(code),
      code,
    );
    assert.deepEqual(snapshot(directory), before);
  }
  // A receipt over its bound is not read.
  const large = candidate();
  writeFileSync(join(large, RELEASE_BINDING_FILE), Buffer.alloc(64 * 1024 + 1, 0x20));
  assert.throws(
    () => verifyRetainedCandidate({ directory: large, expected: synthetic }),
    refuses('CANDIDATE_ASSET'),
  );
  // A stale receipt, for another candidate of the same version, refuses.
  const stale = candidate({ value: productionReceipt(), expected: productionExpected() });
  assert.throws(
    () =>
      verifyRetainedCandidate({
        directory: stale,
        expected: { ...productionExpected(), source: 'f'.repeat(40) },
      }),
    refuses('BINDING_CANDIDATE'),
  );
  // So does a receipt verified in the wrong scope.
  assert.throws(
    () => verifyRetainedCandidate({ directory: stale, expected: synthetic }),
    refuses('BINDING_SCOPE'),
  );
});

test('each expectation field is read once, so a changing expectation cannot change scope midway', () => {
  let reads = 0;
  const flipping = {
    get scope() {
      reads += 1;
      return reads === 1 ? 'synthetic' : 'production';
    },
    recipient: ROTATED,
    pins: PINS,
    packageVersion: VERSION,
    source: CLEAN.commit,
  };
  // Read as synthetic once: a clean source is never a synthetic candidate.
  assert.throws(
    () => validateReleaseBinding(receipt({ source: CLEAN, recipient: PINS }), flipping),
    refuses('BINDING_SCOPE'),
  );
  assert.equal(reads, 1);
});

test(
  'a retained asset swapped for a link after its size check refuses as not an ordinary file',
  { skip: !posix },
  () => {
    const directory = candidate();
    const path = join(directory, ciphertextFileName(VERSION));
    const other = fresh('other-ciphertext');
    writeFileSync(other, Buffer.alloc(CIPHERTEXT.length, 0x78));
    const fs = createRequire(import.meta.url)('node:fs');
    const lstat = fs.lstatSync;
    let swapped = false;
    fs.lstatSync = (target, ...rest) => {
      const info = lstat(target, ...rest);
      if (target === path && !swapped) {
        swapped = true;
        rmSync(path);
        symlinkSync(other, path);
      }
      return info;
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => verifyRetainedCandidate({ directory, expected: synthetic }),
        refuses('CANDIDATE_ASSET'),
      );
    } finally {
      fs.lstatSync = lstat;
      syncBuiltinESMExports();
    }
    assert.equal(swapped, true);
  },
);

test('each receipt field is read once, and a throwing accessor refuses with a fixed code', () => {
  // A name checked on its first read is the name returned, never a later value.
  let reads = 0;
  const value = receipt();
  Object.defineProperty(value.tarball, 'name', {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? tarballName(VERSION) : '/private/host/path';
    },
  });
  assert.equal(validateReleaseBinding(value, synthetic).tarball.name, tarballName(VERSION));
  assert.equal(reads, 1);
  // A clean source checked once stays clean in the receipt returned.
  let dirtyReads = 0;
  const clean = productionReceipt();
  Object.defineProperty(clean.source, 'dirty', {
    enumerable: true,
    get() {
      dirtyReads += 1;
      return dirtyReads !== 1;
    },
  });
  assert.equal(validateReleaseBinding(clean, productionExpected()).source.dirty, false);
  assert.equal(dirtyReads, 1);
  // The origin and the inputs are read once each.
  const counts = { origin: 0, inputs: 0 };
  const counted = receipt();
  for (const key of ['origin', 'inputs']) {
    const original = counted[key];
    Object.defineProperty(counted, key, {
      enumerable: true,
      get() {
        counts[key] += 1;
        return original;
      },
    });
  }
  validateReleaseBinding(counted, synthetic);
  assert.deepEqual(counts, { origin: 1, inputs: 1 });
  const throwing = receipt();
  Object.defineProperty(throwing, 'target', {
    enumerable: true,
    get() {
      throw new Error(`at ${scratch}`);
    },
  });
  assert.throws(() => validateReleaseBinding(throwing, synthetic), refuses('UNEXPECTED'));
  const expectation = {
    ...synthetic,
    get pins() {
      throw new Error(`at ${scratch}`);
    },
  };
  assert.throws(
    () =>
      parseReleaseBinding(
        serializeReleaseBinding(validateReleaseBinding(receipt(), synthetic)),
        expectation,
      ),
    refuses('UNEXPECTED'),
  );
});

test('reuse reads its expectation once, and a vanished asset refuses as that asset', () => {
  const directory = candidate();
  let reads = 0;
  const flipping = {
    scope: 'synthetic',
    pins: PINS,
    get packageVersion() {
      reads += 1;
      return reads === 1 ? VERSION : '0.1.2';
    },
  };
  verifyRetainedCandidate({ directory, expected: flipping });
  assert.equal(reads, 1);
  // An asset that disappears after the listing refuses as that asset, never a host error.
  const fs = createRequire(import.meta.url)('node:fs');
  const lstat = fs.lstatSync;
  const path = join(directory, tarballName(VERSION));
  fs.lstatSync = (target, ...rest) => {
    if (target === path) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return lstat(target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => verifyRetainedCandidate({ directory, expected: synthetic }),
      refuses('CANDIDATE_ASSET'),
    );
  } finally {
    fs.lstatSync = lstat;
    syncBuiltinESMExports();
  }
  // A malformed call refuses with a fixed code, and a throwing option with no host text.
  for (const options of [undefined, null, 'options']) {
    assert.throws(() => verifyRetainedCandidate(options), refuses('BINDING_SCOPE'));
  }
  assert.throws(
    () =>
      verifyRetainedCandidate({
        get directory() {
          throw new Error(`at ${scratch}`);
        },
      }),
    refuses('UNEXPECTED'),
  );
  // The receipt bytes returned are the ones verified, even when the file changes during verification.
  const changing = candidate();
  const receiptPath = join(changing, RELEASE_BINDING_FILE);
  const original = readFileSync(receiptPath);
  const tarballPath = join(changing, tarballName(VERSION));
  fs.lstatSync = (target, ...rest) => {
    if (target === tarballPath) writeFileSync(receiptPath, Buffer.from('{"replaced": true}\n'));
    return lstat(target, ...rest);
  };
  syncBuiltinESMExports();
  let verified;
  try {
    verified = verifyRetainedCandidate({ directory: changing, expected: synthetic });
  } finally {
    fs.lstatSync = lstat;
    syncBuiltinESMExports();
  }
  assert.deepEqual(verified.receiptBytes, original);
});

test('reuse needs a valid expectation, and a host failure refuses with a fixed code and no path', () => {
  const directory = candidate();
  for (const [code, expected] of [
    ['BINDING_SCOPE', undefined],
    ['BINDING_CANDIDATE', { ...synthetic, packageVersion: '../0.1.1' }],
    ['BINDING_CANDIDATE', { ...synthetic, packageVersion: 1 }],
  ]) {
    assert.throws(() => verifyRetainedCandidate({ directory, expected }), refuses(code), code);
  }
  assert.throws(
    () =>
      verifyRetainedCandidate({ directory: join(fresh('none'), 'candidate'), expected: synthetic }),
    refuses('UNEXPECTED'),
  );
  // The reuse API takes no GnuPG binary or run port.
  assert.equal(verifyRetainedCandidate.length, 1);
});
