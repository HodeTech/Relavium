/**
 * Test-only GnuPG fixtures (Step 9b.1): the committed synthetic public keys and their pins, and an
 * ephemeral decryption key generated per run in a short owner-only home. Its public export and, for
 * the secret-material refusal, its armored secret export go to a second owner-only temporary
 * directory. Both directories are removed and the home's agent stopped when the test file ends; no
 * secret key is ever committed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveGpg } from './gnupg.mjs';

export const FIXTURES = fileURLToPath(new URL('./custody-fixtures/', import.meta.url));
/** @type {Record<string, {primary: string, subkey: string}>} */
export const PINS = JSON.parse(readFileSync(join(FIXTURES, 'pins.json'), 'utf8'));
/** @param {string} name */
export const fixture = (name) => join(FIXTURES, `${name}.asc`);

const NO_AEAD = 'AES256 AES192 AES SHA512 SHA384 SHA256 ZLIB ZIP Uncompressed';
/** The longest agent socket name GnuPG creates in a home, against macOS's 104-byte socket path limit. */
const SOCKET = '/S.gpg-agent.browser';

/** Every process whose command line names `home`. */
export function processesNaming(home) {
  const listing = spawnSync(
    'ps',
    process.platform === 'darwin' ? ['-axo', 'command'] : ['-eo', 'args'],
    { encoding: 'utf8' },
  );
  return listing.stdout.split('\n').filter((line) => line.includes(home));
}

/**
 * A fresh synthetic key pair whose secret key stays in its own short home: the public key (only the
 * pinned encryption subkey) in a file, its pins, the secret key's export for refusal tests, and
 * decryption. The home's agent is stopped and the home removed after the test file.
 */
export function ephemeralKey() {
  const gpg = resolveGpg();
  // Checked before anything is created: `mkdtemp` appends six characters to the prefix.
  const prefix = join(tmpdir(), 'rg-');
  assert.ok(prefix.length + 6 + SOCKET.length < 100, 'the ephemeral key home path is too long');
  const home = mkdtempSync(prefix);
  const exportDirectory = mkdtempSync(join(tmpdir(), 'rge-'));
  const env = { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' };
  /** @param {string[]} args @param {string} [input] */
  const call = (args, input) => {
    const run = spawnSync(
      gpg.command,
      [
        ...gpg.prefix,
        '--homedir',
        home,
        '--batch',
        '--no-tty',
        '--no-options',
        '--pinentry-mode',
        'loopback',
        '--passphrase',
        '',
        ...args,
      ],
      { encoding: 'utf8', input, env, timeout: 60_000 },
    );
    assert.equal(run.status, 0, `ephemeral gpg ${args[0]} failed`);
    return run.stdout;
  };
  const dispose = () => {
    spawnSync('gpgconf', ['--homedir', home, '--kill', 'all'], { stdio: 'ignore', env });
    spawnSync('gpgconf', ['--homedir', home, '--remove-socketdir'], { stdio: 'ignore', env });
    rmSync(home, { recursive: true, force: true });
    rmSync(exportDirectory, { recursive: true, force: true });
  };
  after(dispose);
  const uid = 'ephemeral <ephemeral@fixture.invalid>';
  call(['--quick-gen-key', uid, 'ed25519', 'cert', 'never']);
  const listing = () =>
    call(['--with-colons', '--fixed-list-mode', '--with-subkey-fingerprint', '--list-keys', uid])
      .split('\n')
      .filter((line) => line.startsWith('fpr:'))
      .map((line) => line.split(':')[9]);
  const [primary] = listing();
  call(['--quick-add-key', primary, 'cv25519', 'encr', 'never']);
  call(['--command-fd', '0', '--edit-key', primary], `setpref ${NO_AEAD}\ny\nsave\n`);
  const [, subkey] = listing();
  const file = join(exportDirectory, 'public.asc');
  writeFileSync(file, call(['--armor', '--export', `${subkey}!`]));
  const secret = join(exportDirectory, 'secret.asc');
  writeFileSync(secret, call(['--armor', '--export-secret-keys', primary]));
  return {
    home,
    file,
    secret,
    pins: { primary, subkey },
    /** @param {string} ciphertext @param {string} output */
    decrypt: (ciphertext, output) => call(['--output', output, '--decrypt', ciphertext]),
    dispose,
  };
}
