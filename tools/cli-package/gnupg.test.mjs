import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { CustodyError } from './custody-error.mjs';
import {
  GNUPG_FLOOR,
  assertHomeState,
  assertNoGlobalConfig,
  createGnupgHome,
  encryptArgs,
  gnupgEnvironment,
  gnupgVersion,
  listArgs,
  parseColons,
  parseStatus,
  recipientsArgs,
  resolveGpg,
} from './gnupg.mjs';
import { runCommand } from './process.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'relavium-gnupg-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const refuses = (code) => (error) => error instanceof CustodyError && error.code === code;

test('gpg resolves from absolute PATH entries only and is required, never skipped', async () => {
  const gpg = resolveGpg();
  assert.ok(gpg.command.length > 0 && gpg.prefix.length === 0);
  // The installation's own gpgconf sits beside the resolved gpg.
  assert.equal(dirname(gpg.gpgconf.command), dirname(gpg.command));
  assert.match(gpg.gpgconf.command, /gpgconf(?:\.exe)?$/u);
  // The real binary meets the floor; this is the prerequisite local `pnpm run ci` and CI rely on.
  const home = createGnupgHome(scratch, 'version');
  const version = await gnupgVersion(gpg, {
    run: runCommand,
    env: gnupgEnvironment(scratch),
    home,
  });
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  assert.throws(() => resolveGpg(join(scratch, 'none')), refuses('GPG_UNAVAILABLE'));
  // A relative entry is never searched, even when it resolves to a directory holding a gpg.
  mkdirSync(join(scratch, 'relative'));
  writeFileSync(join(scratch, 'relative', process.platform === 'win32' ? 'gpg.exe' : 'gpg'), '');
  const entry = relative(process.cwd(), join(scratch, 'relative'));
  assert.equal(isAbsolute(entry), false);
  assert.throws(
    () => resolveGpg([entry, join(scratch, 'none')].join(delimiter)),
    refuses('GPG_UNAVAILABLE'),
  );
  assert.deepEqual(resolveGpg(join(scratch, 'relative')).prefix, []);
});

test('the version floor is GnuPG 2.2.8, read from the version line only', async () => {
  assert.deepEqual(GNUPG_FLOOR, [2, 2, 8]);
  const gpg = { command: 'gpg', prefix: [] };
  const version = (stdout) =>
    gnupgVersion(gpg, { run: async () => ({ stdout, stderr: '' }), env: {}, home: scratch });
  for (const line of [
    'gpg (GnuPG) 2.2.8\n',
    'gpg (GnuPG/MacGPG2) 2.2.41\n',
    'gpg (GnuPG) 2.4.4\n',
  ]) {
    assert.match(await version(line), /^2\.\d+\.\d+$/u);
  }
  for (const line of ['gpg (GnuPG) 2.2.7\n', 'gpg (GnuPG) 2.1.23\n', 'gpg (GnuPG) 1.4.23\n']) {
    await assert.rejects(version(line), refuses('GPG_VERSION'));
  }
  await assert.rejects(version('gpg 2.4.4\n'), refuses('GPG_VERSION'));
  // The version call is isolated like every other call.
  let argv = [];
  await gnupgVersion(gpg, {
    run: async (_command, args) => {
      argv = args;
      return { stdout: 'gpg (GnuPG) 2.4.4\n', stderr: '' };
    },
    env: {},
    home: 'H',
  });
  for (const flag of [
    '--homedir',
    '--batch',
    '--no-tty',
    '--no-options',
    '--no-autostart',
    '--no-keyring',
  ]) {
    assert.ok(argv.includes(flag), flag);
  }
  assert.equal(argv.at(-1), '--version');
  await assert.rejects(
    gnupgVersion(gpg, {
      run: async () => {
        throw new Error('spawn failed');
      },
      env: {},
      home: scratch,
    }),
    refuses('GPG_UNAVAILABLE'),
  );
});

test('every call is isolated, and encryption never passes a flag that widens it', () => {
  const required = [
    '--homedir',
    '--batch',
    '--no-tty',
    '--no-options',
    '--no-autostart',
    '--no-keyring',
  ];
  const forbidden = [
    '--yes',
    '-R',
    '-F',
    '-r',
    '--recipient',
    '--hidden-recipient',
    '--throw-keyids',
    '--faked-system-time',
    '--ignore-time-conflict',
    '--ignore-valid-from',
    '--keyring',
    '--import',
    '--encrypt-to',
  ];
  const calls = [listArgs('H', 'K'), encryptArgs('H', 'K', 'I', 'O'), recipientsArgs('H', 'C')];
  for (const args of calls) {
    for (const flag of required) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('--homedir') + 1], 'H');
    for (const flag of forbidden) assert.ok(!args.includes(flag), flag);
    assert.ok(!args.some((arg) => arg.startsWith('--allow-') || arg.startsWith('--ignore-')));
  }
  const encrypt = encryptArgs('H', 'K', 'I', 'O');
  for (const [flag, value] of [
    ['--trust-model', 'always'],
    ['--personal-cipher-preferences', 'AES256'],
    ['--compress-algo', 'none'],
    ['--status-fd', '1'],
    ['--set-filename', 'relavium-private-maps.tar'],
    ['--output', 'O'],
    ['--recipient-file', 'K'],
  ]) {
    assert.equal(encrypt[encrypt.indexOf(flag) + 1], value, flag);
  }
  for (const flag of ['--no-encrypt-to', '--no-auto-key-locate', '--no-auto-key-retrieve']) {
    assert.ok(encrypt.includes(flag), flag);
  }
  assert.equal(encrypt.at(-1), 'I');
});

test('the environment is isolated in the C locale and every home is owner-only', () => {
  const env = gnupgEnvironment(scratch);
  assert.equal(env.LANG, 'C');
  assert.equal(env.LC_ALL, 'C');
  for (const name of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME']) assert.equal(env[name], scratch, name);
  for (const name of ['GNUPGHOME', 'GPG_AGENT_INFO', 'GPG_TTY', 'GNUPG_HOME']) {
    assert.equal(env[name], undefined, name);
  }
  const home = createGnupgHome(scratch, 'owner-only');
  if (process.platform !== 'win32') assert.equal(statSync(home).mode & 0o777, 0o700);
});

test('a global configuration in the sysconfdir gpgconf names refuses', async () => {
  const gpg = { command: 'gpg', prefix: [], gpgconf: { command: 'gpgconf', prefix: [] } };
  const check = (stdout) =>
    assertNoGlobalConfig(gpg, { run: async () => ({ stdout, stderr: '' }), env: {} });
  const empty = createGnupgHome(scratch, 'sysconf-empty');
  await check(`${empty}\n`);
  const planted = createGnupgHome(scratch, 'sysconf-planted');
  writeFileSync(join(planted, 'gpg.conf'), 'encrypt-to 0123456789ABCDEF\n');
  await assert.rejects(check(`${planted}\n`), refuses('GPG_CONFIG'));
  // Only the configuration files GnuPG reads count; another daemon's file is not one.
  const other = createGnupgHome(scratch, 'sysconf-other');
  writeFileSync(join(other, 'scdaemon.conf'), 'disable-ccid\n');
  await check(`${other}\n`);
  // The real installation has none, so every encryption may proceed.
  const real = resolveGpg();
  await assertNoGlobalConfig(real, { run: runCommand, env: gnupgEnvironment(scratch) });
});

test('status parsing admits only status lines and keeps unknown keywords for the caller', () => {
  assert.deepEqual(parseStatus('[GNUPG:] BEGIN_ENCRYPTION 2 9\n[GNUPG:] NEWSIG\n'), [
    { keyword: 'BEGIN_ENCRYPTION', args: ['2', '9'] },
    { keyword: 'NEWSIG', args: [] },
  ]);
  assert.deepEqual(parseStatus(''), []);
  for (const text of [
    'gpg: encrypted\n',
    '[GNUPG:] begin\n',
    '[GNUPG:] BEGIN_ENCRYPTION 2 9\n\n',
    '[GNUPG:]BEGIN_ENCRYPTION\n',
  ]) {
    assert.throws(() => parseStatus(text), refuses('STATUS'), text);
  }
  assert.deepEqual(parseColons('pub:-:255\nfpr:::\n'), [
    ['pub', '-', '255'],
    ['fpr', '', '', ''],
  ]);
});

test('a home may hold only the regular files GnuPG creates for these calls', () => {
  const home = createGnupgHome(scratch, 'state');
  assertHomeState(home, ['random_seed']);
  writeFileSync(join(home, 'random_seed'), '');
  assertHomeState(home, ['random_seed']);
  for (const [index, plant] of [
    (path) => writeFileSync(join(path, 'common.conf'), 'use-keyboxd\n'),
    (path) => mkdirSync(join(path, 'private-keys-v1.d')),
    (path) => symlinkSync(join(scratch, 'elsewhere'), join(path, 'S.gpg-agent')),
  ].entries()) {
    const planted = createGnupgHome(scratch, `planted-${index}`);
    plant(planted);
    assert.throws(() => assertHomeState(planted, ['random_seed']), refuses('HOME_STATE'));
  }
  const linkedSeed = createGnupgHome(scratch, 'linked-seed');
  symlinkSync(join(scratch, 'elsewhere'), join(linkedSeed, 'random_seed'));
  assert.throws(() => assertHomeState(linkedSeed, ['random_seed']), refuses('HOME_STATE'));
});
