/**
 * Maintainer-only generator of the committed synthetic custody fixtures (Step 9b.1). It is never run in
 * CI: generation is not deterministic, so the armored public keys and `pins.json` it writes are
 * committed and reviewed instead. Every key is a synthetic OpenPGP v4 key under `fixture.invalid`; no
 * secret key leaves the throwaway home, which is removed with its agent stopped. Only this generator
 * may fake the system time, to create keys that expired in 2020.
 *
 *   node tools/cli-package/custody-fixtures/generate.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
// A short home: the agent's socket path must fit the platform's limit (104 bytes on macOS).
const home = mkdtempSync(join(tmpdir(), 'rg-'));
const PAST = '20200101T000000!';
const NO_AEAD = 'AES256 AES192 AES SHA512 SHA384 SHA256 ZLIB ZIP Uncompressed';

/** @param {string[]} args @param {{input?: string, past?: boolean}} [options] */
function gpg(args, { input, past = false } = {}) {
  const run = spawnSync(
    'gpg',
    [
      '--homedir',
      home,
      '--batch',
      '--no-tty',
      '--pinentry-mode',
      'loopback',
      '--passphrase',
      '',
      ...(past ? ['--faked-system-time', PAST] : []),
      ...args,
    ],
    { encoding: 'utf8', input, env: { PATH: process.env.PATH, GNUPGHOME: home, LANG: 'C' } },
  );
  assert.equal(run.status, 0, `gpg ${args.join(' ')} failed:\n${run.stderr}`);
  return run.stdout;
}

/** The primary and subkey fingerprints, in listing order, of the key with this UID. */
function fingerprints(uid) {
  const fprs = [];
  let current;
  for (const line of gpg(['--with-colons', '--fixed-list-mode', '--list-keys', uid]).split('\n')) {
    const fields = line.split(':');
    if (fields[0] === 'pub' || fields[0] === 'sub') current = fields[0];
    if (fields[0] === 'fpr') fprs.push({ kind: current, fpr: fields[9] });
  }
  return {
    primary: fprs.find((item) => item.kind === 'pub').fpr,
    subkeys: fprs.filter((item) => item.kind === 'sub').map((item) => item.fpr),
  };
}

/** @param {string} name @param {{past?: boolean, primary?: string, usage?: string}} [options] */
function key(name, { past = false, primary = 'ed25519', usage = 'cert' } = {}) {
  const uid = `${name} <${name}@fixture.invalid>`;
  gpg(['--quick-gen-key', uid, primary, usage, past ? '1d' : 'never'], { past });
  return uid;
}

/** @param {string} uid @param {string} algo @param {{past?: boolean, expire?: string}} [options] */
function subkey(uid, algo, { past = false, expire = 'never' } = {}) {
  gpg(['--quick-add-key', fingerprints(uid).primary, algo, 'encr', expire], { past });
}

/** Drop the AEAD feature, so encryption to this key uses SEIPDv1 with MDC (the approved profile). */
function withoutAead(uid) {
  gpg(['--command-fd', '0', '--edit-key', fingerprints(uid).primary], {
    input: `setpref ${NO_AEAD}\ny\nsave\n`,
  });
}

const fixtures = {};
function record(name, uid, pin = (keys) => keys.subkeys[0]) {
  const keys = fingerprints(uid);
  writeFileSync(join(here, `${name}.asc`), gpg(['--armor', '--export', keys.primary]));
  fixtures[name] = { primary: keys.primary, subkey: pin(keys) };
}

try {
  let uid = key('good');
  subkey(uid, 'cv25519');
  withoutAead(uid);
  record('good', uid);

  uid = key('other');
  subkey(uid, 'cv25519');
  withoutAead(uid);
  record('other', uid);

  uid = key('good-aead');
  subkey(uid, 'cv25519');
  record('good-aead', uid);

  uid = key('rsa3072', { primary: 'rsa3072' });
  subkey(uid, 'rsa3072');
  withoutAead(uid);
  record('rsa3072', uid);

  uid = key('rsa2048', { primary: 'rsa3072' });
  subkey(uid, 'rsa2048');
  withoutAead(uid);
  record('rsa2048', uid);

  uid = key('expired-primary', { past: true });
  subkey(uid, 'cv25519', { past: true });
  record('expired-primary', uid);

  // A subkey cannot be added in the past to a key created now, so both are created in 2020.
  uid = `expired-subkey <expired-subkey@fixture.invalid>`;
  gpg(['--quick-gen-key', uid, 'ed25519', 'cert', 'never'], { past: true });
  subkey(uid, 'cv25519', { past: true, expire: '1d' });
  record('expired-subkey', uid);

  uid = key('revoked-primary');
  subkey(uid, 'cv25519');
  withoutAead(uid);
  const revoked = fingerprints(uid).primary;
  const certificate = readFileSync(join(home, 'openpgp-revocs.d', `${revoked}.rev`), 'utf8');
  gpg(['--import'], { input: certificate.replace(/^:-----BEGIN/mu, '-----BEGIN') });
  record('revoked-primary', uid);

  uid = key('revoked-subkey');
  subkey(uid, 'cv25519');
  withoutAead(uid);
  gpg(['--command-fd', '0', '--edit-key', fingerprints(uid).primary], {
    input: 'key 1\nrevkey\ny\n0\n\ny\nsave\n',
  });
  record('revoked-subkey', uid);

  uid = key('sign-only', { usage: 'sign' });
  withoutAead(uid);
  record('sign-only', uid, (keys) => keys.primary);

  uid = key('two-encryption-subkeys');
  subkey(uid, 'cv25519');
  subkey(uid, 'cv25519');
  withoutAead(uid);
  record('two-encryption-subkeys', uid);

  writeFileSync(join(here, 'pins.json'), `${JSON.stringify(fixtures, null, 2)}\n`);
  for (const name of readdirSync(here).filter((file) => file.endsWith('.asc'))) {
    assert.ok(!readFileSync(join(here, name), 'utf8').includes('PRIVATE KEY'), name);
  }
} finally {
  spawnSync('gpgconf', ['--homedir', home, '--kill', 'all'], { stdio: 'ignore' });
  spawnSync('gpgconf', ['--homedir', home, '--remove-socketdir'], { stdio: 'ignore' });
  rmSync(home, { recursive: true, force: true });
}
