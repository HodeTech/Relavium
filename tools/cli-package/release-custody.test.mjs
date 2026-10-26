import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, join, relative } from 'node:path';
import { before, test } from 'node:test';
import { fresh, posixModes } from './candidate-fixture.mjs';
import { readPrivateContainer } from './container.mjs';
import { CustodyError } from './custody-error.mjs';
import { encryptOnce } from './custody.mjs';
import { sha256 } from './files.mjs';
import { PINS, ephemeralKey, fixture } from './gpg-fixture.mjs';
import { runCommand } from './process.mjs';
import {
  RELEASE_BINDING_FILE,
  ciphertextFileName,
  parseReleaseBinding,
  serializeReleaseBinding,
  tarballName,
  verifyRetainedCandidate,
} from './release-binding.mjs';
import { encryptCandidate, sealReleaseBinding } from './release-custody.mjs';
import {
  CLEAN,
  TARBALL,
  VERSION,
  containerWith,
  containers,
  origin,
  places,
  recipientRoot,
} from './release-fixture.mjs';
import { SYNTHETIC_SOURCE, loadRecipientForTests } from './release-recipient.mjs';

const refuses = (code) => (error) =>
  error instanceof CustodyError &&
  error.code === code &&
  /^PACKED_CLI_CUSTODY_[A-Z_]+$/u.test(error.message);

/** @type {{staging: string, synthetic: Buffer, clean: Buffer}} */
let built;
before(async () => {
  built = await containers();
});

/** A run port that records every GnuPG call; everything else is the real GnuPG. */
function recording(before = () => {}) {
  const calls = [];
  /** @type {typeof runCommand} */
  const run = async (command, args, options) => {
    before(args);
    calls.push(
      args.find(
        (arg) =>
          arg.startsWith('--') &&
          ![
            '--homedir',
            '--batch',
            '--no-tty',
            '--no-options',
            '--no-autostart',
            '--no-keyring',
          ].includes(arg),
      ),
    );
    return runCommand(command, args, options);
  };
  return { run, calls };
}
const synthetic = Object.freeze({
  kind: 'synthetic',
  recipient: { file: fixture('good'), pins: PINS.good },
});

/** No receipt of either kind exists: custody never downgrades to a package-test artifact. */
function noReceipt(destination) {
  const names = readdirSync(destination);
  assert.equal(names.includes(RELEASE_BINDING_FILE), false, 'a release receipt was written');
  assert.equal(
    names.includes('package-test-receipt.json'),
    false,
    'a package-test receipt was written',
  );
}

test('the gate refuses a wrong scope, recipient or candidate before any GnuPG call', async () => {
  const unbranded = {
    kind: 'production',
    recipient: { file: fixture('good'), current: PINS.good, history: [] },
  };
  const ephemeral = ephemeralKey();
  const production = {
    kind: 'production',
    recipient: loadRecipientForTests({
      root: recipientRoot(ephemeral.file, [{ ...ephemeral.pins, status: 'current' }]),
    }),
  };
  const dirtyClean = containerWith(built.staging, { ...CLEAN, dirty: true });
  const cleanSentinel = containerWith(built.staging, { ...SYNTHETIC_SOURCE, dirty: false });
  for (const [code, scope, container] of [
    ['SCOPE', undefined, built.synthetic],
    ['SCOPE', { kind: 'release', recipient: synthetic.recipient }, built.synthetic],
    ['SCOPE', { kind: 'synthetic' }, built.synthetic],
    ['RECIPIENT_SOURCE', unbranded, built.clean],
    ['RECIPIENT_SOURCE', { ...production, recipient: { ...production.recipient } }, built.clean],
    ['DIRTY_SOURCE', production, dirtyClean],
    ['DIRTY_SOURCE', production, built.synthetic],
    ['SYNTHETIC_SOURCE', production, cleanSentinel],
    ['FIXTURE_SCOPE', synthetic, built.clean],
    ['FIXTURE_SCOPE', synthetic, dirtyClean],
  ]) {
    const { root, destination } = places();
    const { run, calls } = recording();
    await assert.rejects(
      encryptCandidate({ scope, container, destination, privateRoot: root, run }),
      refuses(code),
      code,
    );
    assert.deepEqual(calls, [], code);
    assert.deepEqual(readdirSync(destination), [tarballName(VERSION)], code);
  }
  // A destination that cannot be resolved, or whose tarball is missing or another, refuses before any
  // call: a ciphertext encrypted into it could never be sealed.
  // A link refuses before anything is read through it: its target's stray entry is never reached.
  const linked = (destination) => {
    const target = fresh('linked-destination-target');
    mkdirSync(target);
    writeFileSync(join(target, tarballName(VERSION)), TARBALL);
    writeFileSync(join(target, 'stray'), 'x');
    rmSync(destination, { recursive: true });
    symlinkSync(target, destination);
  };
  for (const [code, change] of [
    ['PLACEMENT', (destination) => rmSync(destination, { recursive: true })],
    [
      'PLACEMENT',
      (destination) =>
        posixModes ? linked(destination) : rmSync(destination, { recursive: true }),
    ],
    ['CANDIDATE_ENTRIES', (destination) => rmSync(join(destination, tarballName(VERSION)))],
    [
      'CANDIDATE_ENTRIES',
      (destination) => writeFileSync(join(destination, 'package-test-receipt.json'), '{}'),
    ],
    [
      'ALREADY_ENCRYPTED',
      (destination) =>
        writeFileSync(join(destination, ciphertextFileName(VERSION)), 'earlier ciphertext'),
    ],
    [
      'TARBALL_DRIFT',
      (destination) =>
        writeFileSync(join(destination, tarballName(VERSION)), Buffer.from('another tarball')),
    ],
    [
      'TARBALL_DRIFT',
      (destination) => {
        rmSync(join(destination, tarballName(VERSION)));
        mkdirSync(join(destination, tarballName(VERSION)));
      },
    ],
    // A link to a file with the right bytes is not an ordinary tarball either.
    [
      'TARBALL_DRIFT',
      (destination) => {
        if (!posixModes) return rmSync(join(destination, tarballName(VERSION)));
        const target = fresh('linked-tarball-target');
        writeFileSync(target, TARBALL);
        rmSync(join(destination, tarballName(VERSION)));
        symlinkSync(target, join(destination, tarballName(VERSION)));
      },
    ],
  ]) {
    const { root, destination } = places();
    change(destination);
    const { run, calls } = recording();
    await assert.rejects(
      encryptCandidate({
        scope: synthetic,
        container: built.synthetic,
        destination,
        privateRoot: root,
        run,
      }),
      refuses(code),
      code,
    );
    assert.deepEqual(calls, [], code);
  }
  // Only a normalized absolute path names the destination and the private root, so a trailing separator
  // or `.` cannot make lstat follow a link; a link whose target holds a receipt refuses as a link.
  if (posixModes) {
    const target = fresh('linked-target');
    mkdirSync(target);
    writeFileSync(join(target, tarballName(VERSION)), TARBALL);
    const link = fresh('linked-destination');
    symlinkSync(target, link);
    const sealedTarget = fresh('linked-sealed-target');
    mkdirSync(sealedTarget);
    writeFileSync(join(sealedTarget, tarballName(VERSION)), TARBALL);
    writeFileSync(join(sealedTarget, RELEASE_BINDING_FILE), '{}');
    const sealedLink = fresh('linked-sealed-destination');
    symlinkSync(sealedTarget, sealedLink);
    for (const destination of [`${link}/`, `${link}/.`, sealedLink]) {
      const { root } = places();
      const { run, calls } = recording();
      await assert.rejects(
        encryptCandidate({
          scope: synthetic,
          container: built.synthetic,
          destination,
          privateRoot: root,
          run,
        }),
        refuses('PLACEMENT'),
        destination,
      );
      assert.deepEqual(calls, [], destination);
      assert.deepEqual(readdirSync(target), [tarballName(VERSION)]);
    }
  }
  {
    const { root, destination } = places();
    for (const [code, options] of [
      ['PLACEMENT', { destination: relative(process.cwd(), destination), privateRoot: root }],
      [
        'PLACEMENT',
        { destination: `${destination}/../${basename(destination)}`, privateRoot: root },
      ],
      ['PRIVATE_ROOT', { destination, privateRoot: `${root}/` }],
    ]) {
      const { run, calls } = recording();
      await assert.rejects(
        encryptCandidate({ scope: synthetic, container: built.synthetic, ...options, run }),
        refuses(code),
        JSON.stringify(options),
      );
      assert.deepEqual(calls, []);
    }
  }
  // A tarball whose name differs only in case is not the tarball, even where the volume would open it.
  {
    const { root, destination } = places();
    rmSync(join(destination, tarballName(VERSION)));
    writeFileSync(join(destination, tarballName(VERSION).toUpperCase()), TARBALL);
    const { run, calls } = recording();
    await assert.rejects(
      encryptCandidate({
        scope: synthetic,
        container: built.synthetic,
        destination,
        privateRoot: root,
        run,
      }),
      refuses('CANDIDATE_ENTRIES'),
    );
    assert.deepEqual(calls, []);
  }
  // A malformed call refuses with a fixed code, never a host error.
  for (const options of [undefined, null, 'options']) {
    await assert.rejects(encryptCandidate(options), refuses('SCOPE'));
  }
  await assert.rejects(
    encryptCandidate({
      get scope() {
        throw new Error('/private/host/path');
      },
    }),
    (error) => refuses('UNEXPECTED')(error) && !error.message.includes('/private/host/path'),
  );
  // The recipient is read once too: the brand check sees the value encrypted to.
  {
    let reads = 0;
    const counted = {
      kind: 'production',
      get recipient() {
        reads += 1;
        return { file: ephemeral.file, current: ephemeral.pins, history: [] };
      },
    };
    const { root, destination } = places();
    const { run, calls } = recording();
    await assert.rejects(
      encryptCandidate({
        scope: counted,
        container: built.clean,
        destination,
        privateRoot: root,
        run,
      }),
      refuses('RECIPIENT_SOURCE'),
    );
    assert.deepEqual(calls, []);
    assert.equal(reads, 1);
  }
  // The scope is read once: a kind that changes after its first read cannot skip the brand check.
  {
    let reads = 0;
    const flipping = {
      get kind() {
        reads += 1;
        return reads === 1 ? 'production' : 'synthetic';
      },
      recipient: { file: ephemeral.file, current: ephemeral.pins, history: [] },
    };
    const { root, destination } = places();
    const { run, calls } = recording();
    await assert.rejects(
      encryptCandidate({
        scope: flipping,
        container: built.clean,
        destination,
        privateRoot: root,
        run,
      }),
      refuses('RECIPIENT_SOURCE'),
    );
    assert.deepEqual(calls, []);
    assert.equal(reads, 1);
  }
  // A destination that already holds a receipt is sealed: nothing is encrypted into it.
  for (const kind of ['file', 'dangling link']) {
    const { root, destination } = places();
    if (kind === 'file') writeFileSync(join(destination, RELEASE_BINDING_FILE), '{}');
    else if (posixModes)
      symlinkSync(join(destination, 'missing'), join(destination, RELEASE_BINDING_FILE));
    else continue;
    const { run, calls } = recording();
    await assert.rejects(
      encryptCandidate({
        scope: synthetic,
        container: built.synthetic,
        destination,
        privateRoot: root,
        run,
      }),
      refuses('ALREADY_SEALED'),
    );
    assert.deepEqual(calls, []);
  }
  // A host failure in the gate refuses with a fixed code, never the host's error.
  {
    const { root } = places();
    const { run, calls } = recording();
    await assert.rejects(
      encryptCandidate({
        scope: synthetic,
        container: built.synthetic,
        destination: undefined,
        privateRoot: root,
        run,
      }),
      refuses('UNEXPECTED'),
    );
    assert.deepEqual(calls, []);
  }
  // A container that is not one refuses as encryptOnce would, before any call.
  const { root, destination } = places();
  const { run, calls } = recording();
  await assert.rejects(
    encryptCandidate({
      scope: synthetic,
      container: Buffer.from('x'),
      destination,
      privateRoot: root,
      run,
    }),
    (error) => error instanceof CustodyError && error.code.startsWith('CONTAINER_'),
  );
  assert.deepEqual(calls, []);
});

/** Encrypt the synthetic container in fresh places and return everything the sealer tests need. */
async function encrypted(scope = synthetic, container = built.synthetic) {
  const { root, destination } = places();
  const record = await encryptCandidate({ scope, container, destination, privateRoot: root });
  return { root, destination, record };
}

test('a synthetic candidate is encrypted, then sealed once beside its ciphertext and tarball', async () => {
  const { root, destination, record } = await encrypted();
  assert.deepEqual(record.recipient, PINS.good);
  assert.deepEqual(readdirSync(root), []);
  const sealed = sealReleaseBinding(record, { origin: origin(SYNTHETIC_SOURCE.commit) });
  assert.deepEqual(
    readdirSync(destination).sort(),
    [ciphertextFileName(VERSION), RELEASE_BINDING_FILE, tarballName(VERSION)].sort(),
  );
  const bytes = readFileSync(join(destination, RELEASE_BINDING_FILE));
  assert.deepEqual(bytes, sealed.bytes);
  assert.deepEqual(serializeReleaseBinding(sealed.receipt), bytes);
  const manifest = readPrivateContainer(built.synthetic).manifest;
  const expected = { scope: 'synthetic', pins: PINS.good, packageVersion: VERSION };
  assert.deepEqual(parseReleaseBinding(bytes, expected), sealed.receipt);
  assert.deepEqual(sealed.receipt.source, manifest.source);
  assert.deepEqual(sealed.receipt.tarball, {
    name: tarballName(VERSION),
    bytes: TARBALL.length,
    sha256: sha256(TARBALL),
  });
  assert.deepEqual(sealed.receipt.ciphertext, {
    name: record.name,
    bytes: record.bytes,
    sha256: record.sha256,
  });
  assert.deepEqual(sealed.receipt.recipient, PINS.good);
  assert.equal(sealed.receipt.toolchain.gnupg, record.gnupg);
  assert.equal(sealed.receipt.toolchain.node, manifest.toolchain.node);
  assert.deepEqual(sealed.receipt.inputs, manifest.inputs);
  assert.equal(sealed.receipt.target, manifest.target);
  // The sealed candidate is reusable as it stands, and a record seals only once.
  verifyRetainedCandidate({ directory: destination, expected });
  assert.throws(
    () => sealReleaseBinding(record, { origin: origin(SYNTHETIC_SOURCE.commit) }),
    refuses('RECORD_SOURCE'),
  );
});

test('only a record the gate returned seals, and an existing receipt refuses before anything is read', async () => {
  const { destination, record } = await encrypted();
  const direct = places();
  const unscoped = await encryptOnce({
    container: built.synthetic,
    recipient: synthetic.recipient,
    destination: direct.destination,
    privateRoot: direct.root,
  });
  for (const value of [
    { ...record },
    globalThis.structuredClone(record),
    unscoped,
    undefined,
    null,
    'record',
  ]) {
    assert.throws(
      () => sealReleaseBinding(value, { origin: origin(SYNTHETIC_SOURCE.commit) }),
      refuses('RECORD_SOURCE'),
    );
  }
  // A planted receipt wins over the unreadable ciphertext: nothing was read.
  writeFileSync(join(destination, RELEASE_BINDING_FILE), 'planted');
  rmSync(join(destination, record.name));
  assert.throws(
    () => sealReleaseBinding(record, { origin: origin(SYNTHETIC_SOURCE.commit) }),
    refuses('ALREADY_SEALED'),
  );
  assert.equal(readFileSync(join(destination, RELEASE_BINDING_FILE), 'utf8'), 'planted');
  // Calling without options, or with a throwing origin, refuses with a fixed code, never a host error.
  const again = await encrypted();
  assert.throws(() => sealReleaseBinding(again.record), refuses('BINDING_ORIGIN'));
  assert.throws(() => sealReleaseBinding(again.record, null), refuses('BINDING_ORIGIN'));
  assert.throws(
    () =>
      sealReleaseBinding(again.record, {
        get origin() {
          throw new Error(`at ${again.destination}`);
        },
      }),
    (error) => refuses('UNEXPECTED')(error) && !error.message.includes(again.destination),
  );
  noReceipt(again.destination);
});

test('the sealer refuses a candidate directory that is not exactly its tarball and the ciphertext encrypted', async () => {
  const flip = (path) => {
    const bytes = readFileSync(path);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(path, bytes);
  };
  const cases = [
    ['CANDIDATE_ENTRIES', (destination) => writeFileSync(join(destination, 'notes.txt'), 'x')],
    ['CANDIDATE_ENTRIES', (destination) => rmSync(join(destination, tarballName(VERSION)))],
    ['CANDIDATE_ENTRIES', (destination, record) => rmSync(join(destination, record.name))],
    // Same count, another name: the listing is compared by name, not by size.
    [
      'CANDIDATE_ENTRIES',
      (destination) =>
        renameSync(
          join(destination, tarballName(VERSION)),
          join(destination, tarballName(VERSION).toUpperCase()),
        ),
    ],
    [
      'CIPHERTEXT_DRIFT',
      (destination, record) => appendFileSync(join(destination, record.name), 'x'),
    ],
    ['CIPHERTEXT_DRIFT', (destination, record) => flip(join(destination, record.name))],
    [
      'CIPHERTEXT_DRIFT',
      (destination, record) => {
        const bytes = readFileSync(join(destination, record.name));
        writeFileSync(join(destination, record.name), bytes.subarray(1));
      },
    ],
    ['TARBALL_DRIFT', (destination) => flip(join(destination, tarballName(VERSION)))],
    [
      'TARBALL_DRIFT',
      (destination) =>
        writeFileSync(join(destination, tarballName(VERSION)), Buffer.alloc(16 * 1024 * 1024 + 1)),
    ],
  ];
  if (posixModes) {
    cases.push(
      [
        'CIPHERTEXT_DRIFT',
        (destination, record) => {
          const target = fresh('linked-ciphertext');
          writeFileSync(target, readFileSync(join(destination, record.name)));
          rmSync(join(destination, record.name));
          symlinkSync(target, join(destination, record.name));
        },
      ],
      [
        'TARBALL_DRIFT',
        (destination) => {
          const target = fresh('linked-tarball');
          writeFileSync(target, TARBALL);
          rmSync(join(destination, tarballName(VERSION)));
          symlinkSync(target, join(destination, tarballName(VERSION)));
        },
      ],
    );
  }
  for (const [code, change] of cases) {
    const { destination, record } = await encrypted();
    change(destination, record);
    assert.throws(
      () => sealReleaseBinding(record, { origin: origin(SYNTHETIC_SOURCE.commit) }),
      refuses(code),
      code,
    );
    noReceipt(destination);
  }
  // A malformed origin refuses in the self-check, before anything is written.
  for (const value of [
    { kind: 'local' },
    origin('f'.repeat(40)),
    { ...origin(SYNTHETIC_SOURCE.commit), event: 'pull_request' },
  ]) {
    const { destination, record } = await encrypted();
    assert.throws(() => sealReleaseBinding(record, { origin: value }), refuses('BINDING_ORIGIN'));
    noReceipt(destination);
  }
});

test('the receipt is published once and atomically, whatever happens to the write', async () => {
  // A receipt that appears while sealing is never overwritten.
  const raced = await encrypted();
  assert.throws(
    () =>
      sealReleaseBinding(raced.record, {
        origin: origin(SYNTHETIC_SOURCE.commit),
        write: (path, bytes) => {
          writeFileSync(join(raced.destination, RELEASE_BINDING_FILE), 'raced');
          writeFileSync(path, bytes);
        },
      }),
    refuses('ALREADY_SEALED'),
  );
  assert.equal(readFileSync(join(raced.destination, RELEASE_BINDING_FILE), 'utf8'), 'raced');
  assert.deepEqual(
    readdirSync(raced.destination).sort(),
    [ciphertextFileName(VERSION), RELEASE_BINDING_FILE, tarballName(VERSION)].sort(),
  );
  // A write that fails midway leaves nothing under the final name and no partial sibling.
  const failed = await encrypted();
  assert.throws(
    () =>
      sealReleaseBinding(failed.record, {
        origin: origin(SYNTHETIC_SOURCE.commit),
        write: (path, bytes) => {
          writeFileSync(path, bytes.subarray(0, 10));
          throw new Error(`disk full at ${path}`);
        },
      }),
    (error) => refuses('UNEXPECTED')(error) && !error.message.includes(failed.destination),
  );
  assert.deepEqual(
    readdirSync(failed.destination).sort(),
    [ciphertextFileName(VERSION), tarballName(VERSION)].sort(),
  );
  // The record survives a failed seal, so the candidate can still be sealed.
  sealReleaseBinding(failed.record, { origin: origin(SYNTHETIC_SOURCE.commit) });
  assert.ok(readdirSync(failed.destination).includes(RELEASE_BINDING_FILE));
  // A link that fails for another reason publishes nothing, reports no host text and keeps the record.
  const unlinked = await encrypted();
  const fs = createRequire(import.meta.url)('node:fs');
  const link = fs.linkSync;
  fs.linkSync = (existing) => {
    throw Object.assign(new Error(`EPERM: ${existing}`), { code: 'EPERM' });
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => sealReleaseBinding(unlinked.record, { origin: origin(SYNTHETIC_SOURCE.commit) }),
      (error) => refuses('UNEXPECTED')(error) && !error.message.includes(unlinked.destination),
    );
  } finally {
    fs.linkSync = link;
    syncBuiltinESMExports();
  }
  assert.deepEqual(
    readdirSync(unlinked.destination).sort(),
    [ciphertextFileName(VERSION), tarballName(VERSION)].sort(),
  );
  sealReleaseBinding(unlinked.record, { origin: origin(SYNTHETIC_SOURCE.commit) });
  assert.ok(readdirSync(unlinked.destination).includes(RELEASE_BINDING_FILE));
});

test(
  'a sibling that cannot be removed after the link leaves the receipt published, never a false refusal',
  { skip: !posixModes || process.getuid?.() === 0 },
  async () => {
    const { destination, record } = await encrypted();
    const fs = createRequire(import.meta.url)('node:fs');
    const link = fs.linkSync;
    fs.linkSync = (existing, created) => {
      link(existing, created);
      chmodSync(destination, 0o500);
    };
    syncBuiltinESMExports();
    try {
      const sealed = sealReleaseBinding(record, { origin: origin(SYNTHETIC_SOURCE.commit) });
      assert.deepEqual(readFileSync(join(destination, RELEASE_BINDING_FILE)), sealed.bytes);
      assert.equal(readdirSync(destination).filter((name) => name.endsWith('.partial')).length, 1);
    } finally {
      fs.linkSync = link;
      syncBuiltinESMExports();
      chmodSync(destination, 0o700);
    }
    // Published, but not reusable until the sibling is removed: reuse admits exactly three entries.
    assert.throws(
      () =>
        verifyRetainedCandidate({
          directory: destination,
          expected: { scope: 'synthetic', pins: PINS.good, packageVersion: VERSION },
        }),
      refuses('CANDIDATE_ENTRIES'),
    );
  },
);

test('a destination that stops resolving refuses before any GnuPG call, with a fixed code and no path', async () => {
  const { root, destination } = places();
  const fs = createRequire(import.meta.url)('node:fs');
  const realpath = fs.realpathSync;
  let calls = 0;
  // The gate resolves the destination once, before encryption: nothing after publication can fail on it.
  fs.realpathSync = Object.assign(
    (path, ...rest) => {
      if (path === destination && (calls += 1) === 1) throw new Error(`vanished: ${destination}`);
      return realpath(path, ...rest);
    },
    { native: realpath.native },
  );
  syncBuiltinESMExports();
  const recorded = recording();
  try {
    await assert.rejects(
      encryptCandidate({
        scope: synthetic,
        container: built.synthetic,
        destination,
        privateRoot: root,
        run: recorded.run,
      }),
      (error) => refuses('PLACEMENT')(error) && !error.message.includes(destination),
    );
  } finally {
    fs.realpathSync = realpath;
    syncBuiltinESMExports();
  }
  assert.equal(calls, 1);
  assert.deepEqual(recorded.calls, []);
});

test("the caller's container changing during encryption changes nothing encrypted or sealed", async () => {
  const ephemeral = ephemeralKey();
  const scope = { kind: 'synthetic', recipient: { file: ephemeral.file, pins: ephemeral.pins } };
  const mine = Buffer.from(built.synthetic);
  // Overwritten in place while GnuPG runs, before the gate's copy is written for encryption.
  const { run } = recording((args) => {
    if (args.includes('--show-keys')) mine.fill(0x20);
  });
  const { root, destination } = places();
  const record = await encryptCandidate({
    scope,
    container: mine,
    destination,
    privateRoot: root,
    run,
  });
  assert.equal(mine[0], 0x20);
  const out = fresh('release-copy');
  mkdirSync(out);
  ephemeral.decrypt(join(destination, record.name), join(out, 'container.tar'));
  assert.deepEqual(readFileSync(join(out, 'container.tar')), built.synthetic);
  sealReleaseBinding(record, { origin: origin(SYNTHETIC_SOURCE.commit) });
});

test('the gate forwards the clock and the GnuPG installation to encryptOnce', async () => {
  // A clock before the fixture key's creation makes its subkey one created in the future.
  const early = places();
  await assert.rejects(
    encryptCandidate({
      scope: synthetic,
      container: built.synthetic,
      destination: early.destination,
      privateRoot: early.root,
      now: 1,
    }),
    refuses('RECIPIENT_UNUSABLE'),
  );
  const missing = places();
  const absent = { command: join(fresh('no-gpg'), 'gpg'), prefix: [] };
  await assert.rejects(
    encryptCandidate({
      scope: synthetic,
      container: built.synthetic,
      destination: missing.destination,
      privateRoot: missing.root,
      gpg: { ...absent, gpgconf: absent },
    }),
    refuses('GPG_UNAVAILABLE'),
  );
});

test('a production candidate round-trips: the receipt binds what the ciphertext decrypts to', async () => {
  const ephemeral = ephemeralKey();
  // A rotated history: an earlier recipient retired, the ephemeral key current.
  const earlier = { primary: '1'.repeat(40), subkey: '2'.repeat(40) };
  const recipient = loadRecipientForTests({
    root: recipientRoot(ephemeral.file, [
      { ...earlier, status: 'retired' },
      { ...ephemeral.pins, status: 'current' },
    ]),
  });
  const { destination, record } = await encrypted({ kind: 'production', recipient }, built.clean);
  assert.deepEqual(record.recipient, ephemeral.pins);
  const sealed = sealReleaseBinding(record, { origin: origin(CLEAN.commit) });
  const out = fresh('release-round-trip');
  mkdirSync(out);
  ephemeral.decrypt(join(destination, record.name), join(out, 'container.tar'));
  const decrypted = readFileSync(join(out, 'container.tar'));
  assert.deepEqual(decrypted, built.clean);
  const { manifest } = readPrivateContainer(decrypted);
  const { receipt } = sealed;
  assert.equal(receipt.packageVersion, manifest.packageVersion);
  assert.deepEqual(receipt.source, manifest.source);
  assert.equal(receipt.tarball.sha256, manifest.tarballSha256);
  const { gnupg, ...tools } = receipt.toolchain;
  assert.deepEqual(tools, manifest.toolchain);
  assert.equal(gnupg, record.gnupg);
  assert.equal(receipt.target, manifest.target);
  assert.deepEqual(receipt.inputs, manifest.inputs);
  const expected = {
    scope: 'production',
    recipient,
    packageVersion: VERSION,
    source: CLEAN.commit,
  };
  const reused = verifyRetainedCandidate({ directory: destination, expected });
  assert.deepEqual(reused.receipt, receipt);
  // The production receipt never verifies as synthetic, nor under a history without its recipient.
  assert.throws(
    () =>
      verifyRetainedCandidate({
        directory: destination,
        expected: { scope: 'synthetic', pins: ephemeral.pins, packageVersion: VERSION },
      }),
    refuses('BINDING_SCOPE'),
  );
  const rotatedAway = loadRecipientForTests({
    root: recipientRoot(ephemeral.file, [{ ...earlier, status: 'current' }]),
  });
  assert.throws(
    () =>
      verifyRetainedCandidate({
        directory: destination,
        expected: { ...expected, recipient: rotatedAway },
      }),
    refuses('BINDING_RECIPIENT'),
  );
});
