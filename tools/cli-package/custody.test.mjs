import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { candidate, fresh, posixModes, seal } from './candidate-fixture.mjs';
import { buildPrivateContainer } from './container.mjs';
import { CustodyError } from './custody-error.mjs';
import { ciphertextName, encryptOnce, inspectRecipient, parsePins } from './custody.mjs';
import {
  createGnupgHome,
  gnupgEnvironment,
  gnupgVersion,
  listArgs,
  parseColons,
  resolveGpg,
} from './gnupg.mjs';
import { PINS, ephemeralKey, fixture, processesNaming } from './gpg-fixture.mjs';
import { readPrivateManifest } from './manifest.mjs';
import { runCommand } from './process.mjs';

const refuses = (code) => (error) => error instanceof CustodyError && error.code === code;
const NOW = Math.floor(Date.now() / 1000);

/** The installed GnuPG's version, read independently of `encryptOnce`. */
async function installedVersion() {
  const work = fresh('version');
  mkdirSync(work);
  const home = createGnupgHome(work, 'home');
  return gnupgVersion(resolveGpg(), { run: runCommand, env: gnupgEnvironment(work), home });
}

/** @type {Buffer} */
let container;
/** @type {string} */
let staging;
before(async () => {
  // A synthetic candidate sealed as the producer seals it: synthetic maps only, never a product's.
  const fixtureCandidate = await candidate();
  await seal(fixtureCandidate);
  writeFileSync(join(fixtureCandidate.staging, 'metafile-esm.json'), '{"inputs":{},"outputs":{}}');
  staging = fixtureCandidate.staging;
  container = buildPrivateContainer(staging).bytes;
});
const NAME = () => ciphertextName(readPrivateManifest(staging).packageVersion);

/** A fresh owner-only private root and an empty destination. */
function places() {
  const root = fresh('custody-root');
  mkdirSync(root);
  chmodSync(root, 0o700);
  const destination = fresh('custody-destination');
  mkdirSync(destination);
  return { root, destination };
}

/** @param {string[]} args */
const kindOf = (args) =>
  args.includes('--list-dirs')
    ? 'config'
    : args.includes('--version')
      ? 'version'
      : args.includes('--show-keys')
        ? 'list'
        : args.includes('--encrypt')
          ? 'encrypt'
          : args.includes('--list-only')
            ? 'recipients'
            : 'other';
/** @param {string[]} args @param {string} flag */
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

/**
 * A run port that records every GnuPG call and lets a test act before one, replace it, or rewrite
 * its result; everything else is the real GnuPG.
 * @param {Record<string, {before?: Function, replace?: Function, after?: Function}>} [hooks]
 */
function recording(hooks = {}) {
  const calls = [];
  /** @type {typeof runCommand} */
  const run = async (command, args, options) => {
    const kind = kindOf(args);
    calls.push(kind);
    const hook = hooks[kind] ?? {};
    if (hook.before) await hook.before(args);
    if (hook.replace) return hook.replace(args);
    const result = await runCommand(command, args, options);
    return hook.after ? hook.after(result, args) : result;
  };
  return { run, calls };
}

/** One encryption attempt with fresh places; good recipient unless overridden. */
async function attempt(overrides = {}) {
  const { root, destination } = places();
  try {
    const record = await encryptOnce({
      container,
      recipient: { file: fixture('good'), pins: PINS.good },
      destination,
      privateRoot: root,
      ...overrides,
    });
    return { root, destination, record };
  } catch (error) {
    return { root, destination, error };
  }
}

/** A refusal with its code that removed its plaintext work directory and published nothing. */
function refused(outcome, code) {
  assert.ok(outcome.error instanceof CustodyError, `expected ${code}, got ${outcome.error}`);
  assert.equal(outcome.error.code, code);
  assert.deepEqual(readdirSync(outcome.root), [], 'plaintext work directory left');
  assert.deepEqual(readdirSync(outcome.destination), [], 'something was published');
}

/** A colon key record with the shape of a good v4 key unless overridden. */
function key(type, overrides = {}) {
  const fields = Array(20).fill('');
  fields[0] = type;
  fields[1] = '-';
  fields[2] = type === 'pub' ? '255' : '255';
  fields[3] = type === 'pub' ? '22' : '18';
  fields[4] = 'KEYID';
  fields[5] = String(NOW - 86_400);
  fields[8] = '-';
  fields[11] = type === 'pub' ? 'cEC' : 'e';
  fields[16] = type === 'pub' ? 'ed25519' : 'cv25519';
  for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value;
  return fields;
}
/** @param {string} value */
const fpr = (value) => Object.assign(Array(11).fill(''), { 0: 'fpr', 9: value });
const PRIMARY = 'A'.repeat(40);
const SUBKEY = 'B'.repeat(40);
/** A good key's records with the given field overrides on its primary and subkey. */
const records = (pub = {}, sub = {}) => [
  key('pub', pub),
  fpr(PRIMARY),
  key('sub', sub),
  fpr(SUBKEY),
];

test('pins are exactly two 40-digit uppercase fingerprints', () => {
  assert.deepEqual(parsePins({ primary: PRIMARY, subkey: SUBKEY }), {
    primary: PRIMARY,
    subkey: SUBKEY,
  });
  for (const pins of [
    undefined,
    { primary: PRIMARY },
    { primary: PRIMARY, subkey: SUBKEY, extra: SUBKEY },
    { primary: PRIMARY.toLowerCase(), subkey: SUBKEY },
    { primary: PRIMARY, subkey: `${SUBKEY}!` },
    { primary: PRIMARY, subkey: SUBKEY.slice(-16) },
    { primary: 'good <good@fixture.invalid>', subkey: SUBKEY },
    { primary: 'C'.repeat(64), subkey: SUBKEY },
  ]) {
    assert.throws(() => parsePins(pins), refuses('PIN_FORMAT'), JSON.stringify(pins));
  }
});

test('the recipient classification refuses in its fixed order', () => {
  const pins = { primary: PRIMARY, subkey: SUBKEY };
  assert.equal(inspectRecipient(records(), pins, NOW), pins);
  for (const [code, listing, override] of [
    ['RECIPIENT_SECRET', [key('sec'), fpr(PRIMARY), key('ssb'), fpr(SUBKEY)]],
    ['RECIPIENT_MISSING', []],
    ['RECIPIENT_MISSING', records(), { primary: 'C'.repeat(40), subkey: SUBKEY }],
    ['RECIPIENT_MISSING', records(), { primary: PRIMARY, subkey: 'C'.repeat(40) }],
    ['RECIPIENT_UNEXPECTED', [...records(), key('pub'), fpr('D'.repeat(40))]],
    ['RECIPIENT_REVOKED', records({ 1: 'r' })],
    ['RECIPIENT_REVOKED', records({}, { 1: 'r' })],
    ['RECIPIENT_EXPIRED', records({ 1: 'e' })],
    ['RECIPIENT_EXPIRED', records({}, { 6: String(NOW) })],
    ['RECIPIENT_UNUSABLE', records({ 1: 'i' })],
    ['RECIPIENT_UNUSABLE', records({ 11: 'cECD' })],
    ['RECIPIENT_UNUSABLE', records({ 11: 'cC' })],
    ['RECIPIENT_UNUSABLE', records({}, { 11: 's' })],
    ['RECIPIENT_UNUSABLE', records({}, { 1: 'n' })],
    ['RECIPIENT_UNUSABLE', records({}, { 1: 'i' })],
    ['RECIPIENT_UNUSABLE', records({}, { 11: 'eD' })],
    ['RECIPIENT_UNUSABLE', records({ 1: 'n' })],
    ['RECIPIENT_UNUSABLE', records({ 1: 'd' })],
    ['RECIPIENT_UNUSABLE', records({ 5: String(NOW + 60) })],
    ['RECIPIENT_UNUSABLE', records({}, { 5: String(NOW + 60) })],
    ['RECIPIENT_UNUSABLE', records({}, { 16: 'nistp256' })],
    ['RECIPIENT_UNUSABLE', records({}, { 3: '1', 2: '2048', 16: '' })],
    // An ElGamal subkey of any size is not an approved algorithm.
    ['RECIPIENT_UNUSABLE', records({}, { 3: '16', 2: '4096', 16: '' })],
    ['RECIPIENT_UNUSABLE', records({}, { 3: '16', 2: '255', 16: 'cv25519' })],
    // Revocation is reported before expiry.
    ['RECIPIENT_REVOKED', records({ 1: 'r', 6: String(NOW) })],
    ['RECIPIENT_SECRET', [...records(), key('ssb'), fpr('E'.repeat(40))]],
    [
      'RECIPIENT_UNUSABLE',
      records({ 3: '18', 11: 'ecEC', 16: 'cv25519' }),
      { primary: PRIMARY, subkey: PRIMARY },
    ],
    ['RECIPIENT_UNEXPECTED', [...records(), key('sub'), fpr('E'.repeat(40))]],
  ]) {
    assert.throws(
      () => inspectRecipient(listing, override ?? pins, NOW),
      refuses(code),
      `${code} ${JSON.stringify(listing.map((fields) => fields.slice(0, 12)))}`,
    );
  }
  // RSA of at least 3072 bits is approved; an expired or revoked second subkey is not unexpected.
  assert.equal(inspectRecipient(records({}, { 3: '1', 2: '3072', 16: '' }), pins, NOW), pins);
  assert.equal(
    inspectRecipient([...records(), key('sub', { 1: 'r' }), fpr('E'.repeat(40))], pins, NOW),
    pins,
  );
  assert.equal(
    inspectRecipient([...records(), key('sub', { 1: 'e' }), fpr('E'.repeat(40))], pins, NOW),
    pins,
  );
  assert.equal(
    inspectRecipient(
      [...records(), key('sub', { 6: String(NOW) }), fpr('E'.repeat(40))],
      pins,
      NOW,
    ),
    pins,
  );
  assert.equal(inspectRecipient(records({}, { 3: '1', 2: '4096', 16: '' }), pins, NOW), pins);
});

test('the committed synthetic fixtures list as their names say under the real GnuPG', async () => {
  const gpg = resolveGpg();
  const work = fresh('fixture-listing');
  mkdirSync(work);
  let count = 0;
  const classify = async (file, pins) => {
    const home = createGnupgHome(work, `home-${(count += 1)}`);
    const listed = await runCommand(gpg.command, [...gpg.prefix, ...listArgs(home, file)], {
      timeoutMs: 60_000,
      maxBytes: 256 * 1024,
      env: gnupgEnvironment(work),
    });
    try {
      inspectRecipient(parseColons(listed.stdout), pins, NOW);
      return 'ok';
    } catch (error) {
      if (error instanceof CustodyError) return error.code;
      throw error;
    }
  };
  for (const [name, expected] of Object.entries({
    good: 'ok',
    other: 'ok',
    'good-aead': 'ok',
    rsa3072: 'ok',
    rsa2048: 'RECIPIENT_UNUSABLE',
    'expired-primary': 'RECIPIENT_EXPIRED',
    'expired-subkey': 'RECIPIENT_EXPIRED',
    'revoked-primary': 'RECIPIENT_REVOKED',
    'revoked-subkey': 'RECIPIENT_REVOKED',
    'sign-only': 'RECIPIENT_UNUSABLE',
    'two-encryption-subkeys': 'RECIPIENT_UNEXPECTED',
  })) {
    assert.match(PINS[name].primary, /^[0-9A-F]{40}$/u, name);
    assert.match(PINS[name].subkey, /^[0-9A-F]{40}$/u, name);
    assert.equal(await classify(fixture(name), PINS[name]), expected, name);
  }
  const both = join(work, 'two-keys.asc');
  writeFileSync(
    both,
    Buffer.concat([readFileSync(fixture('good')), readFileSync(fixture('other'))]),
  );
  assert.equal(await classify(both, PINS.good), 'RECIPIENT_UNEXPECTED');
  assert.equal(await classify(fixture('good'), PINS.other), 'RECIPIENT_MISSING');
  // A rotation that changed the key without updating the subkey pin.
  assert.equal(
    await classify(fixture('good'), { primary: PINS.good.primary, subkey: PINS.other.subkey }),
    'RECIPIENT_MISSING',
  );
});

test('no tracked file holds a PGP private-key block', () => {
  const marker = ['BEGIN PGP', 'PRIVATE KEY BLOCK'].join(' ');
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const found = spawnSync('git', ['grep', '-l', '-F', marker], {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.equal(found.status, 1, `tracked private-key blocks:\n${found.stdout}`);
});

test('encryption publishes exactly one ciphertext for the pinned subkey and leaves no plaintext', async () => {
  const { run, calls } = recording();
  const outcome = await attempt({ run });
  assert.equal(outcome.error, undefined);
  const name = NAME();
  assert.deepEqual(readdirSync(outcome.destination), [name]);
  const bytes = readFileSync(join(outcome.destination, name));
  assert.deepEqual(outcome.record, {
    name,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    recipient: PINS.good,
    gnupg: await installedVersion(),
  });
  assert.ok(Object.isFrozen(outcome.record) && Object.isFrozen(outcome.record.recipient));
  assert.deepEqual(calls, ['version', 'config', 'list', 'encrypt', 'recipients']);
  assert.deepEqual(readdirSync(outcome.root), []);
});

test('an ephemeral key decrypts the ciphertext to the container, and tar extracts the staging', async () => {
  const ephemeral = ephemeralKey();
  const outcome = await attempt({ recipient: { file: ephemeral.file, pins: ephemeral.pins } });
  assert.equal(outcome.error, undefined);
  const out = fresh('round-trip');
  mkdirSync(out);
  const plain = join(out, 'container.tar');
  ephemeral.decrypt(join(outcome.destination, NAME()), plain);
  assert.deepEqual(readFileSync(plain), container);
  const extracted = join(out, 'staging');
  mkdirSync(extracted);
  assert.equal(spawnSync('tar', ['-xf', plain, '-C', extracted]).status, 0);
  assert.deepEqual(readPrivateManifest(extracted), readPrivateManifest(staging));
  for (const name of readdirSync(join(staging, 'maps'))) {
    assert.deepEqual(
      readFileSync(join(extracted, 'maps', name)),
      readFileSync(join(staging, 'maps', name)),
    );
  }
  // Secret key material is never a recipient.
  refused(
    await attempt({ recipient: { file: ephemeral.secret, pins: ephemeral.pins } }),
    'RECIPIENT_SECRET',
  );
  ephemeral.dispose();
  assert.deepEqual(processesNaming(ephemeral.home), [], 'the ephemeral agent is still running');
  assert.equal(existsSync(ephemeral.home), false);
});

test('every committed refusal fixture is refused before encryption, and AEAD after it', async () => {
  for (const [name, code] of [
    ['expired-primary', 'RECIPIENT_EXPIRED'],
    ['expired-subkey', 'RECIPIENT_EXPIRED'],
    ['revoked-primary', 'RECIPIENT_REVOKED'],
    ['revoked-subkey', 'RECIPIENT_REVOKED'],
    ['sign-only', 'RECIPIENT_UNUSABLE'],
    ['rsa2048', 'RECIPIENT_UNUSABLE'],
    ['two-encryption-subkeys', 'RECIPIENT_UNEXPECTED'],
  ]) {
    const { run, calls } = recording();
    refused(await attempt({ run, recipient: { file: fixture(name), pins: PINS[name] } }), code);
    assert.deepEqual(calls, ['version', 'config', 'list'], name);
  }
  // GnuPG 2.3 and later pick OCB for a key that advertises AEAD, a profile that is refused; GnuPG 2.2
  // has no AEAD and encrypts SEIPDv1, which the profile check admits.
  const [major, minor] = (await installedVersion()).split('.').map(Number);
  const aead = await attempt({
    recipient: { file: fixture('good-aead'), pins: PINS['good-aead'] },
  });
  if (major > 2 || (major === 2 && minor >= 3)) refused(aead, 'PROFILE');
  else assert.equal(aead.error, undefined, String(aead.error));
});

test("GnuPG's own refusal is a second layer behind the pre-check", async () => {
  // A forged listing passes the pre-check for an expired key; the real GnuPG still refuses it.
  const pins = PINS['expired-subkey'];
  const forged = [key('pub'), fpr(pins.primary), key('sub'), fpr(pins.subkey)]
    .map((fields) => fields.join(':'))
    .join('\n');
  const { run, calls } = recording({ list: { replace: () => ({ stdout: forged, stderr: '' }) } });
  refused(
    await attempt({ run, recipient: { file: fixture('expired-subkey'), pins } }),
    'ENCRYPTION_FAILED',
  );
  assert.deepEqual(calls, ['version', 'config', 'list', 'encrypt']);
});

test('the status must be exactly one pinned, completed SEIPDv1 AES-256 encryption', async () => {
  const rewrite = (change) => ({
    encrypt: { after: (result) => ({ ...result, stdout: change(result.stdout) }) },
  });
  for (const [code, change] of [
    ['STATUS', (text) => `${text}gpg: encrypted\n`],
    ['STATUS', (text) => text.replace(/\[GNUPG:\] END_ENCRYPTION\n/u, '')],
    ['STATUS', (text) => text.replace(/(\[GNUPG:\] BEGIN_ENCRYPTION[^\n]*\n)/u, '$1$1')],
    [
      'STATUS',
      (text) =>
        text.replace(/(\[GNUPG:\] BEGIN_ENCRYPTION[^\n]*\n)(\[GNUPG:\] END_ENCRYPTION\n)/u, '$2$1'),
    ],
    ['STATUS', (text) => `${text}[GNUPG:] INV_RECP 0 recipient\n`],
    ['STATUS', (text) => `${text}[GNUPG:] FAILURE encrypt 53\n`],
    ...['NO_RECP 0', 'ERROR encrypt 1', 'KEYEXPIRED 1', 'KEYREVOKED', 'INV_SGNR 0 x'].map(
      (line) => ['STATUS', (text) => `${text}[GNUPG:] ${line}\n`],
    ),
    ['STATUS', (text) => `${text}[GNUPG:] END_ENCRYPTION\n`],
    ['STATUS', (text) => text.replace(/\[GNUPG:\] KEY_CONSIDERED[^\n]*\n/u, '')],
    [
      'STATUS',
      (text) =>
        text.replace(/KEY_CONSIDERED [0-9A-F]{40} 0/u, `KEY_CONSIDERED ${'A'.repeat(40)} 0`),
    ],
    ['STATUS', (text) => text.replace(/KEY_CONSIDERED ([0-9A-F]{40}) 0/u, 'KEY_CONSIDERED $1 1')],
    ['PROFILE', (text) => text.replace(/BEGIN_ENCRYPTION 2 9/u, 'BEGIN_ENCRYPTION 0 9 2')],
    ['PROFILE', (text) => text.replace(/BEGIN_ENCRYPTION 2 9/u, 'BEGIN_ENCRYPTION 2 7')],
    ['PROFILE', (text) => text.replace(/BEGIN_ENCRYPTION 2 9/u, 'BEGIN_ENCRYPTION 2 9 2')],
    ['PROFILE', (text) => text.replace(/BEGIN_ENCRYPTION 2 9/u, 'BEGIN_ENCRYPTION 0 9')],
    ['PROFILE', (text) => text.replace(/BEGIN_ENCRYPTION 2 9/u, 'BEGIN_ENCRYPTION 1 9')],
  ]) {
    refused(await attempt(recording(rewrite(change))), code);
  }
});

test('the ciphertext must name exactly the pinned subkey and nothing else', async () => {
  const rewrite = (change) => ({
    recipients: { after: (result) => ({ ...result, stdout: change(result.stdout) }) },
  });
  for (const change of [
    (text) => text.replace(/(\[GNUPG:\] ENC_TO[^\n]*\n)/u, '$1$1'),
    (text) => text.replace(/ENC_TO [0-9A-F]{16}/u, `ENC_TO ${'1'.repeat(16)}`),
    (text) => text.replace(/ENC_TO [0-9A-F]{16}/u, `ENC_TO ${'0'.repeat(16)}`),
    (text) => text.replace(/\[GNUPG:\] ENC_TO[^\n]*\n/u, ''),
  ]) {
    refused(await attempt(recording(rewrite(change))), 'RECIPIENTS');
  }
  refused(
    await attempt(
      recording({
        recipients: {
          replace: () => {
            throw new Error('listing failed');
          },
        },
      }),
    ),
    'RECIPIENTS',
  );
});

test('the work directory must hold exactly the expected assets, the ciphertext within its bound', async () => {
  const output = (args) => valueOf(args, '--output');
  for (const change of [
    (args) => writeFileSync(join(dirname(output(args)), 'extra'), 'planted'),
    (args) => rmSync(output(args)),
    (args) => appendFileSync(output(args), Buffer.alloc(container.length + 64 * 1024)),
  ]) {
    refused(
      await attempt(
        recording({
          encrypt: {
            after: (result, args) => {
              change(args);
              return result;
            },
          },
        }),
      ),
      'ASSET',
    );
  }
});

test('a GnuPG home that gains configuration, keyrings or secrets refuses', async () => {
  for (const [kind, name] of [
    ['encrypt', 'common.conf'],
    ['encrypt', 'pubring.kbx'],
    ['list', 'gpg.conf'],
    ['recipients', 'trustdb.gpg'],
  ]) {
    refused(
      await attempt(
        recording({
          [kind]: {
            after: (result, args) => {
              writeFileSync(join(valueOf(args, '--homedir'), name), 'planted');
              return result;
            },
          },
        }),
      ),
      'HOME_STATE',
    );
  }
});

test('a failing GnuPG call or an unreadable recipient refuses with a fixed code', async () => {
  const fail = () => {
    throw new Error('child failed');
  };
  refused(await attempt(recording({ encrypt: { replace: fail } })), 'ENCRYPTION_FAILED');
  refused(await attempt(recording({ list: { replace: fail } })), 'RECIPIENT_UNREADABLE');
  refused(await attempt(recording({ version: { replace: fail } })), 'GPG_UNAVAILABLE');
  refused(
    await attempt({ recipient: { file: join(fresh('none'), 'key.asc'), pins: PINS.good } }),
    'RECIPIENT_UNREADABLE',
  );
  const empty = join(fresh('empty-recipient'), 'key.asc');
  mkdirSync(dirname(empty));
  writeFileSync(empty, '');
  const outcome = await attempt({ recipient: { file: empty, pins: PINS.good } });
  assert.ok(
    ['RECIPIENT_UNREADABLE', 'RECIPIENT_MISSING'].includes(outcome.error?.code),
    String(outcome.error),
  );
  refused(outcome, outcome.error.code);
});

test('the checked recipient copy is the one encrypted to, read within its bound', async () => {
  // The caller's file changes after it was read: the checked copy is still the only key used.
  const work = fresh('recipient-copy');
  mkdirSync(work);
  const original = join(work, 'recipient.asc');
  writeFileSync(original, readFileSync(fixture('good')));
  const seen = [];
  const swap = recording({
    list: {
      before: (args) => {
        seen.push(args.at(-1));
        writeFileSync(original, readFileSync(fixture('other')));
      },
    },
    encrypt: {
      before: (args) => seen.push(args[args.indexOf('--recipient-file') + 1]),
    },
  });
  const outcome = await attempt({ run: swap.run, recipient: { file: original, pins: PINS.good } });
  assert.equal(outcome.error, undefined, String(outcome.error));
  assert.deepEqual(outcome.record.recipient, PINS.good);
  assert.equal(seen.length, 2);
  for (const path of seen) {
    assert.notEqual(path, original);
    assert.equal(path.split(/[\\/]/u).at(-1), 'recipient.asc');
  }
  const large = join(work, 'large.asc');
  writeFileSync(large, Buffer.concat([readFileSync(fixture('good')), Buffer.alloc(256 * 1024)]));
  refused(await attempt({ recipient: { file: large, pins: PINS.good } }), 'RECIPIENT_UNREADABLE');
});

test("a global GnuPG configuration in the installation's sysconfdir refuses before any key is handled", async () => {
  const sysconf = fresh('sysconfdir');
  mkdirSync(sysconf);
  const config = (stdout) => ({ config: { replace: () => ({ stdout, stderr: '' }) } });
  // An empty configuration directory, as Homebrew and Ubuntu ship it, admits.
  const admitted = recording(config(`${sysconf}\n`));
  const outcome = await attempt(admitted);
  assert.equal(outcome.error, undefined, String(outcome.error));
  for (const name of ['gpg.conf', 'common.conf']) {
    const directory = fresh(`sysconf-${name}`);
    mkdirSync(directory);
    writeFileSync(join(directory, name), 'log-file /tmp/leak.log\ndebug-all\n');
    const { run, calls } = recording(config(`${directory}\n`));
    refused(await attempt({ run }), 'GPG_CONFIG');
    assert.deepEqual(calls, ['version', 'config'], name);
  }
  // gpgconf percent-escapes a directory name; a relative or malformed answer refuses.
  const escaped = fresh('sys conf');
  mkdirSync(escaped);
  writeFileSync(join(escaped, 'gpg.conf'), 'throw-keyids\n');
  refused(await attempt(recording(config(`${escaped.replaceAll(' ', '%20')}\n`))), 'GPG_CONFIG');
  refused(await attempt(recording(config('relative/dir\n'))), 'GPG_CONFIG');
  refused(await attempt(recording(config('%zz\n'))), 'GPG_CONFIG');
  refused(
    await attempt(
      recording({
        config: {
          replace: () => {
            throw new Error('gpgconf failed');
          },
        },
      }),
    ),
    'GPG_UNAVAILABLE',
  );
});

test('the published bytes are the listed bytes, and the default clock counts seconds', async () => {
  // A ciphertext file replaced after it was read — here by another valid ciphertext for the same
  // recipient, so its listing still passes — is refused, never published.
  const earlier = await attempt();
  assert.equal(earlier.error, undefined, String(earlier.error));
  const other = readFileSync(join(earlier.destination, NAME()));
  const swapped = recording({
    recipients: { before: (args) => writeFileSync(args.at(-1), other) },
  });
  refused(await attempt(swapped), 'ASSET');
  // A recipient whose subkey expires tomorrow is valid under the default clock (seconds since the
  // epoch); a clock in milliseconds would call it expired.
  const pins = PINS.good;
  const tomorrow = String(Math.floor(Date.now() / 1000) + 86_400);
  const listing = [key('pub'), fpr(pins.primary), key('sub', { 6: tomorrow }), fpr(pins.subkey)]
    .map((fields) => fields.join(':'))
    .join('\n');
  const { root, destination } = places();
  const forged = recording({ list: { replace: () => ({ stdout: listing, stderr: '' }) } });
  const record = await encryptOnce({
    container,
    recipient: { file: fixture('good'), pins },
    destination,
    privateRoot: root,
    run: forged.run,
  });
  assert.equal(record.name, NAME());
});

test('a ciphertext is published once: an existing one refuses before any GnuPG call', async () => {
  const { root, destination } = places();
  writeFileSync(join(destination, NAME()), 'earlier ciphertext');
  const { run, calls } = recording();
  await assert.rejects(
    encryptOnce({
      container,
      recipient: { file: fixture('good'), pins: PINS.good },
      destination,
      privateRoot: root,
      run,
    }),
    refuses('ALREADY_ENCRYPTED'),
  );
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(join(destination, NAME()), 'utf8'), 'earlier ciphertext');
  // One that appears while encrypting is never overwritten.
  const raced = places();
  const late = recording({
    recipients: {
      before: () => writeFileSync(join(raced.destination, NAME()), 'raced ciphertext'),
    },
  });
  await assert.rejects(
    encryptOnce({
      container,
      recipient: { file: fixture('good'), pins: PINS.good },
      destination: raced.destination,
      privateRoot: raced.root,
      run: late.run,
    }),
    refuses('ALREADY_ENCRYPTED'),
  );
  assert.equal(readFileSync(join(raced.destination, NAME()), 'utf8'), 'raced ciphertext');
  assert.deepEqual(readdirSync(raced.destination), [NAME()]);
  assert.deepEqual(readdirSync(raced.root), []);
});

test('the destination and the private root are separate directories, the root owner-only', async () => {
  const { run, calls } = recording();
  const { root, destination } = places();
  const nested = join(root, 'destination');
  mkdirSync(nested);
  const options = (overrides) => ({
    container,
    recipient: { file: fixture('good'), pins: PINS.good },
    run,
    ...overrides,
  });
  await assert.rejects(
    encryptOnce(options({ destination: nested, privateRoot: root })),
    refuses('PLACEMENT'),
  );
  const inner = join(destination, 'root');
  mkdirSync(inner);
  chmodSync(inner, 0o700);
  await assert.rejects(
    encryptOnce(options({ destination, privateRoot: inner })),
    refuses('PLACEMENT'),
  );
  if (posixModes) {
    const linked = fresh('linked-destination');
    symlinkSync(destination, linked);
    await assert.rejects(
      encryptOnce(options({ destination: linked, privateRoot: root })),
      refuses('PLACEMENT'),
    );
    const open = fresh('open-root');
    mkdirSync(open);
    chmodSync(open, 0o755);
    await assert.rejects(
      encryptOnce(options({ destination, privateRoot: open })),
      refuses('PRIVATE_ROOT'),
    );
  }
  await assert.rejects(
    encryptOnce(
      options({ container: Buffer.from('not a container'), destination, privateRoot: root }),
    ),
    (error) => error instanceof CustodyError && error.code.startsWith('CONTAINER_'),
  );
  assert.deepEqual(calls, []);
});

test('an overlap spelled differently on a case-insensitive volume still refuses', async (context) => {
  const base = fresh('case');
  mkdirSync(join(base, 'Public'), { recursive: true });
  if (!existsSync(join(base, 'PUBLIC'))) {
    context.skip('this volume is case-sensitive');
    return;
  }
  const root = join(base, 'PUBLIC', 'root');
  mkdirSync(root);
  chmodSync(root, 0o700);
  const { run, calls } = recording();
  await assert.rejects(
    encryptOnce({
      container,
      recipient: { file: fixture('good'), pins: PINS.good },
      destination: join(base, 'Public'),
      privateRoot: root,
      run,
    }),
    refuses('PLACEMENT'),
  );
  assert.deepEqual(calls, []);
});

test('a missing destination or private root refuses with a fixed code and no path', async () => {
  const { root, destination } = places();
  const missing = join(fresh('missing'), 'nowhere');
  for (const [code, overrides] of [
    ['PLACEMENT', { destination: missing, privateRoot: root }],
    ['PRIVATE_ROOT', { destination, privateRoot: missing }],
  ]) {
    await assert.rejects(
      encryptOnce({
        container,
        recipient: { file: fixture('good'), pins: PINS.good },
        ...overrides,
      }),
      (error) =>
        error instanceof CustodyError &&
        error.code === code &&
        !JSON.stringify({ message: error.message, ...error }).includes('nowhere'),
    );
  }
});

test(
  'a work directory that cannot be removed refuses with a fixed code',
  { skip: !posixModes || process.getuid?.() === 0 },
  async () => {
    const { root, destination } = places();
    const locked = recording({ recipients: { before: () => chmodSync(root, 0o500) } });
    try {
      await assert.rejects(
        encryptOnce({
          container,
          recipient: { file: fixture('good'), pins: PINS.good },
          destination,
          privateRoot: root,
          run: locked.run,
        }),
        (error) =>
          error instanceof CustodyError &&
          error.code === 'CLEANUP' &&
          !JSON.stringify({ message: error.message, ...error }).includes(root),
      );
      // The plaintext is removed before anything is published.
      assert.deepEqual(readdirSync(destination), []);
    } finally {
      chmodSync(root, 0o700);
    }
  },
);

test('no GnuPG output, path or host error text reaches a refusal', async () => {
  const marker = join(fresh('marker'), 'private', 'path');
  const leaked = (error) => {
    const text = JSON.stringify({ message: error.message, ...error, cause: error.cause });
    assert.equal(text.includes(marker), false, text);
    assert.equal(text.includes('fixture.invalid'), false, text);
    assert.match(error.message, /^PACKED_CLI_CUSTODY_[A-Z_]+$/u);
  };
  const failing = recording({
    encrypt: {
      replace: () => {
        const error = new Error(`gpg failed at ${marker}`);
        Object.assign(error, {
          result: { stdout: marker, stderr: `good <good@fixture.invalid> ${marker}` },
        });
        throw error;
      },
    },
  });
  const first = await attempt(failing);
  refused(first, 'ENCRYPTION_FAILED');
  leaked(first.error);
  // A host failure after encryption is UNEXPECTED, never its message.
  const lost = places();
  const vanished = recording({
    recipients: { before: () => rmSync(lost.destination, { recursive: true }) },
  });
  await assert.rejects(
    encryptOnce({
      container,
      recipient: { file: fixture('good'), pins: PINS.good },
      destination: lost.destination,
      privateRoot: lost.root,
      run: vanished.run,
    }),
    (error) => {
      leaked(error);
      return error instanceof CustodyError && error.code === 'UNEXPECTED';
    },
  );
  assert.deepEqual(vanished.calls, ['version', 'config', 'list', 'encrypt', 'recipients']);
  assert.deepEqual(readdirSync(lost.root), []);
});

test(
  'an interrupt during encryption stops GnuPG, removes the plaintext and publishes nothing',
  { skip: !posixModes },
  async () => {
    const { root, destination } = places();
    const work = fresh('interrupt');
    mkdirSync(work);
    const listing = join(work, 'listing.txt');
    const pins = PINS.good;
    writeFileSync(
      listing,
      [key('pub'), fpr(pins.primary), key('sub'), fpr(pins.subkey)]
        .map((fields) => fields.join(':'))
        .join('\n'),
    );
    const started = join(work, 'started');
    const pidFile = join(work, 'gpg.pid');
    const fakeGpg = join(work, 'gpg.mjs');
    writeFileSync(
      fakeGpg,
      [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        'const args = process.argv.slice(2);',
        `if (args.includes('--list-dirs')) process.stdout.write(${JSON.stringify(work)} + '\\n');`,
        "else if (args.includes('--version')) process.stdout.write('gpg (GnuPG) 2.4.4\\n');",
        `else if (args.includes('--show-keys')) process.stdout.write(readFileSync(${JSON.stringify(listing)}, 'utf8'));`,
        `else { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); writeFileSync(${JSON.stringify(started)}, ''); setInterval(() => {}, 1000); }`,
      ].join('\n'),
    );
    const driver = join(work, 'driver.mjs');
    const here = (name) => JSON.stringify(new URL(`./${name}`, import.meta.url).href);
    writeFileSync(
      driver,
      [
        "import { readFileSync, rmSync } from 'node:fs';",
        `import { encryptOnce } from ${here('custody.mjs')};`,
        `import { exitOnInterrupt } from ${here('process.mjs')};`,
        `const root = ${JSON.stringify(root)};`,
        `await exitOnInterrupt(() => rmSync(root, { recursive: true, force: true }), () =>`,
        `  encryptOnce({ container: readFileSync(${JSON.stringify(join(work, 'container.tar'))}),`,
        `    recipient: { file: ${JSON.stringify(fixture('good'))}, pins: ${JSON.stringify(pins)} },`,
        `    destination: ${JSON.stringify(destination)}, privateRoot: root,`,
        `    gpg: { command: process.execPath, prefix: [${JSON.stringify(fakeGpg)}],`,
        `      gpgconf: { command: process.execPath, prefix: [${JSON.stringify(fakeGpg)}] } } }));`,
      ].join('\n'),
    );
    writeFileSync(join(work, 'container.tar'), container);
    const child = spawn(process.execPath, [driver], { stdio: 'ignore' });
    const closed = new Promise((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal })),
    );
    for (let index = 0; index < 400 && !existsSync(started); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(existsSync(started), 'the stand-in never started encrypting');
    const gpgPid = Number(readFileSync(pidFile, 'utf8'));
    child.kill('SIGINT');
    assert.deepEqual(await closed, { code: 130, signal: null });
    assert.equal(existsSync(root), false, 'the private root and its plaintext survived');
    assert.deepEqual(readdirSync(destination), []);
    // The group got SIGKILL before the driver exited; its member is reaped shortly after.
    const alive = () => {
      try {
        process.kill(gpgPid, 0);
        return true;
      } catch (error) {
        assert.equal(error.code, 'ESRCH');
        return false;
      }
    };
    for (let index = 0; index < 500 && alive(); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(alive(), false, 'the stopped GnuPG stand-in outlived its group kill');
  },
);
