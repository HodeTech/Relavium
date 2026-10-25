/**
 * The isolated GnuPG boundary of the custody tools (Step 9b.1; packaging.md, "Recipient custody").
 * GnuPG is release tooling, never a runtime dependency. Every call runs a resolved absolute binary
 * through the shell-free, bounded `runCommand` in the isolated environment. Every `gpg` call runs in a
 * fresh owner-only home the tools create themselves, with no per-home options file, keyring, agent or
 * key discovery; the one `gpgconf` query takes no home. GnuPG still reads its installation's
 * system-wide `gpg.conf` under `--no-options`, so a global configuration refuses before any call that
 * handles a key. Only status lines, colon records, the version line and the configuration directory
 * are read; other human-readable output and stderr are never read or surfaced.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { refuseCustody } from './custody-error.mjs';
import { isolatedEnvironment } from './process.mjs';

/** GnuPG 2.2.8 has `--show-keys`, the CVE-2018-12020 fix and refuses missing-MDC decryption. */
export const GNUPG_FLOOR = Object.freeze([2, 2, 8]);
/** Bounds for one GnuPG call: its status and colon output are small. */
export const GNUPG_CALL = Object.freeze({ timeoutMs: 60_000, maxBytes: 256 * 1024 });
/** The literal-packet name inside the ciphertext, so no host file name enters it. */
export const LITERAL_NAME = 'relavium-private-maps.tar';

/**
 * @typedef {{command: string, prefix: string[]}} Command
 * @typedef {Command & {gpgconf: Command}} GnupgInstallation
 */

/**
 * Resolve `gpg` from absolute PATH entries only, without a shell, and the `gpgconf` of the same
 * installation beside it.
 * @returns {GnupgInstallation}
 */
export function resolveGpg(path = process.env.PATH ?? '', platform = process.platform) {
  const executable = (name) => (platform === 'win32' ? `${name}.exe` : name);
  for (const directory of path.split(delimiter).filter(Boolean)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, executable('gpg'));
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const command = realpathSync(candidate);
      return {
        command,
        prefix: [],
        gpgconf: { command: join(dirname(command), executable('gpgconf')), prefix: [] },
      };
    }
  }
  return refuseCustody('GPG_UNAVAILABLE');
}

/**
 * A fresh owner-only GnuPG home. Created here, so no `gpg.conf`, `common.conf` or keyring can already
 * be in it.
 * @param {string} parent @param {string} name
 */
export function createGnupgHome(parent, name) {
  const home = join(parent, name);
  mkdirSync(home, { mode: 0o700 });
  return home;
}

/** The isolated environment for GnuPG, in the C locale, with every home and temporary path in `work`. */
export function gnupgEnvironment(work) {
  return { ...isolatedEnvironment(work), LANG: 'C', LC_ALL: 'C' };
}

/** @param {string} home */
const isolated = (home) => [
  '--homedir',
  home,
  '--batch',
  '--no-tty',
  '--no-options',
  '--no-autostart',
  '--no-keyring',
];

/**
 * List the keys in one recipient file as colon records, importing nothing. The default trust model
 * runs here: GnuPG 2.4 cannot list an expired or revoked key under `--trust-model always` without a
 * trust database, so this home may gain an empty one; encryption runs in a separate home.
 * @param {string} home @param {string} recipient
 */
export function listArgs(home, recipient) {
  return [
    ...isolated(home),
    '--with-colons',
    '--fixed-list-mode',
    '--with-subkey-fingerprint',
    '--show-keys',
    recipient,
  ];
}

/**
 * Encrypt `input` to the one key in `recipient`, its status on stdout. `--trust-model always`: the
 * assurance is the pinned fingerprints and the colon pre-check, and GnuPG treats a `--recipient-file`
 * key as fully valid. No compression keeps the ciphertext's size bound.
 * @param {string} home @param {string} recipient @param {string} input @param {string} output
 */
export function encryptArgs(home, recipient, input, output) {
  return [
    ...isolated(home),
    '--no-encrypt-to',
    '--no-auto-key-locate',
    '--no-auto-key-retrieve',
    '--trust-model',
    'always',
    '--personal-cipher-preferences',
    'AES256',
    '--compress-algo',
    'none',
    '--status-fd',
    '1',
    '--set-filename',
    LITERAL_NAME,
    '--output',
    output,
    '--encrypt',
    '--recipient-file',
    recipient,
    input,
  ];
}

/**
 * The recipients of a ciphertext, from its public-key packets: needs no secret key.
 * @param {string} home @param {string} ciphertext
 */
export function recipientsArgs(home, ciphertext) {
  return [
    ...isolated(home),
    '--trust-model',
    'always',
    '--status-fd',
    '1',
    '--list-only',
    '--decrypt',
    ciphertext,
  ];
}

/**
 * Status lines only: any other line refuses. Unknown keywords and extra arguments are kept for the
 * caller to ignore, as GnuPG's DETAILS requires.
 * @param {string} text
 * @returns {{keyword: string, args: string[]}[]}
 */
export function parseStatus(text) {
  return text
    .split('\n')
    .filter((line, index, lines) => !(index === lines.length - 1 && line === ''))
    .map((line) => {
      const match = /^\[GNUPG:\] ([A-Z_]+)(?: (.*))?$/u.exec(line);
      if (!match) return refuseCustody('STATUS');
      return { keyword: match[1], args: match[2] === undefined ? [] : match[2].split(' ') };
    });
}

/**
 * Colon records, one array of fields per line.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseColons(text) {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split(':'));
}

/**
 * The GnuPG version, refused below the floor.
 * @param {{command: string, prefix: string[]}} gpg
 * @param {{run: Function, env: Record<string, string>, home: string}} options
 */
export async function gnupgVersion(gpg, { run, env, home }) {
  let stdout;
  try {
    ({ stdout } = await run(gpg.command, [...gpg.prefix, ...isolated(home), '--version'], {
      ...GNUPG_CALL,
      env,
    }));
  } catch {
    return refuseCustody('GPG_UNAVAILABLE');
  }
  const match = /^gpg \(GnuPG(?:\/[^)]+)?\) (\d+)\.(\d+)\.(\d+)\s/u.exec(String(stdout));
  if (!match) return refuseCustody('GPG_VERSION');
  const version = match.slice(1, 4).map(Number);
  for (const [index, floor] of GNUPG_FLOOR.entries()) {
    if (version[index] > floor) break;
    if (version[index] < floor) refuseCustody('GPG_VERSION');
  }
  return version.join('.');
}

/**
 * GnuPG reads `<sysconfdir>/gpg.conf` even under `--no-options`, and `[force]` options there override
 * the command line: a global configuration could add or hide a recipient, redirect the output or log
 * the session key. The installation's `gpgconf` names that directory; a `gpg.conf` or `common.conf`
 * in it refuses.
 * @param {GnupgInstallation} gpg
 * @param {{run: Function, env: Record<string, string>}} options
 */
export async function assertNoGlobalConfig(gpg, { run, env }) {
  let stdout;
  try {
    ({ stdout } = await run(
      gpg.gpgconf.command,
      [...gpg.gpgconf.prefix, '--list-dirs', 'sysconfdir'],
      { ...GNUPG_CALL, env },
    ));
  } catch {
    return refuseCustody('GPG_UNAVAILABLE');
  }
  // A named directory is printed raw and ended by one newline; only the unnamed listing is
  // percent-escaped. Anything that is not exactly one absolute path refuses.
  const text = String(stdout);
  const directory = text.endsWith('\n') ? text.slice(0, -1) : '';
  if (!isAbsolute(directory) || /[\r\n\0]/u.test(directory)) refuseCustody('GPG_CONFIG');
  for (const name of ['gpg.conf', 'common.conf']) {
    if (existsSync(join(directory, name))) refuseCustody('GPG_CONFIG');
  }
}

/**
 * The home may hold only regular files GnuPG itself creates for these calls: never a socket, a
 * configuration, a keyring or private-key material.
 * @param {string} home @param {readonly string[]} allowed
 */
export function assertHomeState(home, allowed) {
  for (const name of readdirSync(home)) {
    if (!allowed.includes(name) || !lstatSync(join(home, name)).isFile()) {
      refuseCustody('HOME_STATE');
    }
  }
}
