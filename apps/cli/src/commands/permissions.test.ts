import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  commandGrantsPath,
  createCommandGrantStore,
  type CommandGrantStore,
} from '../permissions/command-grants.js';
import { CliError } from '../process/cli-error.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import { captureIo, parseNdjson } from '../test-support.js';
import {
  permissionsListCommand,
  permissionsRevokeCommand,
  type PermissionsDeps,
} from './permissions.js';
import { buildPermissionsRevokeArgs } from './permissions-input.js';

/** `relavium permissions list|revoke` (ADR-0118 §2): the keychain is an in-memory fake, the file system a real temp tree. */
class FakeKeychain implements KeychainStore {
  readonly entries = new Map<string, string>();
  locked = false;
  get(account: string): string | null {
    if (this.locked) throw new KeychainUnavailableError('locked');
    return this.entries.get(account) ?? null;
  }
  set(account: string, secret: string): void {
    if (this.locked) throw new KeychainUnavailableError('locked');
    this.entries.set(account, secret);
  }
  delete(account: string): boolean {
    return this.entries.delete(account);
  }
}

let home: string;
let project: string;
let other: string;
let keychain: FakeKeychain;
let counter = 0;

beforeEach(() => {
  // realpath: on macOS the temp directory is a symlink, and the store keys grants by the resolved real path.
  home = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-permissions-home-')));
  project = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-permissions-project-')));
  other = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-permissions-other-')));
  keychain = new FakeKeychain();
  counter = 0;
});
afterEach(() => {
  for (const directory of [home, project, other])
    rmSync(directory, { recursive: true, force: true });
});

const file = (): string => commandGrantsPath(home);

function globalOptions(cwd: string, json = false): GlobalOptions {
  return { json, color: false, cwd, configPath: undefined, verbosity: 'normal' };
}

function deps(
  cwd = project,
  json = false,
  io?: CliIo,
): { deps: PermissionsDeps; out: () => string; err: () => string } {
  const captured = captureIo();
  return {
    deps: { io: io ?? captured.io, global: globalOptions(cwd, json), homeDir: home, keychain },
    out: captured.out,
    err: captured.err,
  };
}

/** A grant store for `root`, sharing the fake keychain and the home: what a chat session would have written. */
function storeFor(root: string): CommandGrantStore {
  return createCommandGrantStore({
    homeDir: home,
    projectRoot: root,
    keychain,
    now: () => new Date('2026-11-19T12:00:00.000Z'),
    newId: () => `grant-${String(++counter)}`,
    findProgram: (name) =>
      Promise.resolve(['npm', 'git', 'curl'].includes(name) ? name : undefined),
  });
}

function refusal(action: () => unknown): CliError {
  try {
    action();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('expected the command to refuse');
}

describe('relavium permissions list', () => {
  it('says so when nothing is remembered, exits 0, and never creates the digest key just to look', () => {
    const run = deps();
    expect(permissionsListCommand(run.deps)).toBe(EXIT_CODES.success);
    expect(run.out()).toBe('No remembered commands for this project.\n');
    expect(keychain.entries.size).toBe(0);
    expect(existsSync(file())).toBe(false);
  });

  it('lists this project’s grants by number, program name, argument count and date, and nothing else', async () => {
    const grants = storeFor(project);
    await grants.remember(['npm', 'test']);
    await grants.remember(['git', 'status', '--short']);
    await grants.remember(['git']);
    const run = deps();
    expect(permissionsListCommand(run.deps)).toBe(EXIT_CODES.success);
    expect(run.out()).toBe(
      'Remembered commands for this project (3):\n' +
        '  1. npm  (1 argument)  remembered 2026-11-19T12:00:00.000Z\n' +
        '  2. git  (2 arguments)  remembered 2026-11-19T12:00:00.000Z\n' +
        '  3. git  (0 arguments)  remembered 2026-11-19T12:00:00.000Z\n' +
        'Revoke one with `relavium permissions revoke <number>`, or all of them with `relavium permissions revoke --all`.\n',
    );
  });

  it('never prints a command, an argument or a digest: a credential in an argument stays out of the listing', async () => {
    const secret = 'sk-live-CANARY-0123456789';
    await storeFor(project).remember([
      'curl',
      '-H',
      `Authorization: Bearer ${secret}`,
      'https://x',
    ]);
    await storeFor(project).remember([`./deploy-${secret}`, '--token', secret]);
    for (const json of [false, true]) {
      const run = deps(project, json);
      permissionsListCommand(run.deps);
      expect(run.out()).not.toContain(secret);
      expect(run.out()).not.toContain('Bearer');
      expect(run.out()).not.toContain('https://x');
      expect(run.out()).not.toMatch(/[0-9a-f]{64}/u);
      expect(run.out()).toContain('(unnamed program)');
    }
  });

  it('shows another project’s grants nowhere: the listing is for the project it is run in', async () => {
    await storeFor(project).remember(['npm', 'test']);
    await storeFor(other).remember(['git', 'push']);
    const run = deps(other);
    permissionsListCommand(run.deps);
    expect(run.out()).toContain('git');
    expect(run.out()).not.toContain('npm');
    expect(deps(project).deps.global.cwd).toBe(project);
  });

  it('keys a subdirectory of the project to the project, as the chat does', async () => {
    mkdirSync(join(project, '.relavium'));
    const subdirectory = join(project, 'packages', 'app');
    mkdirSync(subdirectory, { recursive: true });
    await storeFor(project).remember(['npm', 'test']);
    const run = deps(subdirectory);
    permissionsListCommand(run.deps);
    expect(run.out()).toContain('1. npm');
  });

  it('--json writes one record per grant with exactly the listed fields, and nothing for an empty list', async () => {
    const empty = deps(project, true);
    expect(permissionsListCommand(empty.deps)).toBe(EXIT_CODES.success);
    expect(empty.out()).toBe('');
    await storeFor(project).remember(['npm', 'test']);
    await storeFor(project).remember(['git', 'status']);
    const run = deps(project, true);
    permissionsListCommand(run.deps);
    expect(parseNdjson(run.out())).toEqual([
      { index: 1, id: 'grant-1', program: 'npm', args: 1, grantedAt: '2026-11-19T12:00:00.000Z' },
      { index: 2, id: 'grant-2', program: 'git', args: 1, grantedAt: '2026-11-19T12:00:00.000Z' },
    ]);
  });

  it('a hand-edited time carrying a newline or an escape makes the file unreadable: nothing of it is ever printed', async () => {
    await storeFor(project).remember(['npm', 'test']);
    writeFileSync(
      file(),
      readFileSync(file(), 'utf8').replace(
        /"at":"[^"]*"/u,
        String.raw`"at":"\u001b]0;pwned\u0007\n  2. sudo  (0 arguments)"`,
      ),
    );
    for (const json of [false, true]) {
      const run = deps(project, json);
      const failure = refusal(() => permissionsListCommand(run.deps));
      expect(failure.code).toBe('config_error');
      expect(run.out(), 'a refused listing prints no rows').toBe('');
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a directory that cannot be inspected is an unreadable store (exit 2), never an empty list',
    async () => {
      await storeFor(project).remember(['npm', 'test']);
      chmodSync(dirname(file()), 0o000);
      try {
        const failure = refusal(() => permissionsListCommand(deps().deps));
        expect(failure.code).toBe('config_error');
        expect(failure.exitCode).toBe(EXIT_CODES.invalidInvocation);
      } finally {
        chmodSync(dirname(file()), 0o700);
      }
    },
  );

  it('a locked keychain is a clean exit-2 refusal that names the way out and leaks nothing', () => {
    keychain.locked = true;
    const failure = refusal(() => permissionsListCommand(deps().deps));
    expect(failure.exitCode).toBe(EXIT_CODES.invalidInvocation);
    expect(failure.message).toContain('keychain');
    expect(failure.message).toContain('relavium permissions revoke --all');
  });

  it('an unreadable file is a config error that names the file and the recovery', async () => {
    await storeFor(project).remember(['npm', 'test']);
    writeFileSync(file(), `${readFileSync(file(), 'utf8')}not json\n`);
    const failure = refusal(() => permissionsListCommand(deps().deps));
    expect(failure.code).toBe('config_error');
    expect(failure.exitCode).toBe(EXIT_CODES.invalidInvocation);
    expect(failure.message).toContain(file());
    expect(failure.message).toContain('relavium permissions revoke --all');
  });

  it('output that cannot be delivered is output_unavailable, never a silent success', async () => {
    await storeFor(project).remember(['npm', 'test']); // an empty --json listing writes nothing, so there must be a record to lose
    const broken: CliIo = {
      ...captureIo().io,
      writeOut: () => {
        throw new Error('EPIPE');
      },
    };
    expect(refusal(() => permissionsListCommand(deps(project, false, broken).deps)).code).toBe(
      'output_unavailable',
    );
    expect(refusal(() => permissionsListCommand(deps(project, true, broken).deps)).code).toBe(
      'output_unavailable',
    );
  });
});

describe('relavium permissions revoke', () => {
  it('revokes the numbered grant: it stops matching, the others stay, and the numbers close up', async () => {
    const grants = storeFor(project);
    await grants.remember(['npm', 'test']);
    await grants.remember(['git', 'status']);
    const run = deps();
    expect(permissionsRevokeCommand({ all: false, index: 1 }, run.deps)).toBe(EXIT_CODES.success);
    expect(run.out()).toBe(
      'Revoked remembered command 1: npm, 1 argument. It asks again the next time it is needed. The numbers have changed: `relavium permissions list` shows them.\n',
    );
    const fresh = storeFor(project);
    expect(fresh.matches(['npm', 'test'])).toBe(false);
    expect(fresh.matches(['git', 'status'])).toBe(true);
    const listing = deps();
    permissionsListCommand(listing.deps);
    expect(listing.out()).toContain('1. git');
  });

  it('a number that names nothing is exit 2 and changes nothing; the refusal does not echo it', async () => {
    await storeFor(project).remember(['npm', 'test']);
    const before = readFileSync(file(), 'utf8');
    const failure = refusal(() => permissionsRevokeCommand({ all: false, index: 2 }, deps().deps));
    expect(failure.exitCode).toBe(EXIT_CODES.invalidInvocation);
    expect(failure.message).toContain('relavium permissions list');
    expect(failure.message, 'the number typed is not echoed').not.toMatch(/\d/u);
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('cannot reach another project’s grant by number', async () => {
    await storeFor(other).remember(['git', 'push']);
    const failure = refusal(() => permissionsRevokeCommand({ all: false, index: 1 }, deps().deps));
    expect(failure.exitCode).toBe(EXIT_CODES.invalidInvocation);
    expect(storeFor(other).matches(['git', 'push'])).toBe(true);
  });

  it('--all removes the file for every project, says so, and says so honestly the second time', async () => {
    await storeFor(project).remember(['npm', 'test']);
    await storeFor(other).remember(['git', 'push']);
    const first = deps();
    expect(permissionsRevokeCommand({ all: true }, first.deps)).toBe(EXIT_CODES.success);
    expect(first.out()).toBe('Removed every remembered command, for every project.\n');
    expect(existsSync(file())).toBe(false);
    expect(storeFor(other).matches(['git', 'push'])).toBe(false);
    const second = deps();
    permissionsRevokeCommand({ all: true }, second.deps);
    expect(second.out()).toBe('There were no remembered commands to remove.\n');
  });

  it('--all works with a locked keychain and with an unreadable file: it is the recovery', async () => {
    await storeFor(project).remember(['npm', 'test']);
    writeFileSync(file(), `${readFileSync(file(), 'utf8')}not json\n`);
    keychain.locked = true;
    expect(permissionsRevokeCommand({ all: true }, deps().deps)).toBe(EXIT_CODES.success);
    expect(existsSync(file())).toBe(false);
  });

  it('a numbered revoke with a locked keychain is a clean refusal, not a crash', async () => {
    await storeFor(project).remember(['npm', 'test']);
    keychain.locked = true;
    const failure = refusal(() => permissionsRevokeCommand({ all: false, index: 1 }, deps().deps));
    expect(failure.exitCode).toBe(EXIT_CODES.invalidInvocation);
    expect(failure.message).toContain('keychain');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '--all that cannot remove the file is a storage failure, never "no remembered commands"',
    async () => {
      await storeFor(project).remember(['npm', 'test']);
      chmodSync(dirname(file()), 0o500);
      try {
        const failure = refusal(() => permissionsRevokeCommand({ all: true }, deps().deps));
        expect(failure.code).toBe('storage_unavailable');
        expect(failure.exitCode).toBe(EXIT_CODES.workflowFailed);
        expect(existsSync(file())).toBe(true);
      } finally {
        chmodSync(dirname(file()), 0o700);
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a numbered revoke whose tombstone cannot be written is a storage failure (exit 1), never success and never “no such command”',
    async () => {
      await storeFor(project).remember(['npm', 'test']);
      chmodSync(file(), 0o400);
      try {
        const failure = refusal(() =>
          permissionsRevokeCommand({ all: false, index: 1 }, deps().deps),
        );
        expect(failure.code).toBe('storage_unavailable');
        expect(failure.exitCode).toBe(EXIT_CODES.workflowFailed);
        expect(
          storeFor(project).matches(['npm', 'test']),
          'the grant is still live, and the exit said so',
        ).toBe(true);
      } finally {
        chmodSync(file(), 0o600);
      }
    },
  );

  it('a revoke the file has no room to record names the way out (exit 2) and changes nothing', async () => {
    await storeFor(project).remember(['npm', 'test']);
    const filler = Array.from({ length: 8191 }, (_, i) =>
      JSON.stringify({ v: 1, revoked: `filler-${String(i)}`, at: '2026-11-19T00:00:00.000Z' }),
    ).join('\n');
    writeFileSync(file(), `${readFileSync(file(), 'utf8')}\n${filler}\n`); // 8,192 lines: the bound
    const before = readFileSync(file(), 'utf8');
    const failure = refusal(() => permissionsRevokeCommand({ all: false, index: 1 }, deps().deps));
    expect(failure.code).toBe('config_error');
    expect(failure.exitCode).toBe(EXIT_CODES.invalidInvocation);
    expect(failure.message).toContain('relavium permissions revoke --all');
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('--all opens no keychain and needs no project root: it works where neither can be had', async () => {
    await storeFor(project).remember(['npm', 'test']);
    const touched = vi.spyOn(keychain, 'get');
    const run = deps(project);
    // A working directory that does not exist has no project root to find; the recovery must not care.
    const there = { ...run.deps, global: globalOptions(join(project, 'does', 'not', 'exist')) };
    expect(permissionsRevokeCommand({ all: true }, there)).toBe(EXIT_CODES.success);
    expect(touched).not.toHaveBeenCalled();
    expect(existsSync(file())).toBe(false);
  });

  it('--all removes a symlink at the path, not what it points at', () => {
    const target = join(home, 'precious.txt');
    writeFileSync(target, 'keep me');
    mkdirSync(dirname(file()), { recursive: true });
    symlinkSync(target, file());
    expect(permissionsRevokeCommand({ all: true }, deps().deps)).toBe(EXIT_CODES.success);
    expect(readFileSync(target, 'utf8')).toBe('keep me');
    expect(existsSync(file())).toBe(false);
  });

  it('--all forgets the digest key as well, and still works when the keychain is locked', async () => {
    await storeFor(project).remember(['npm', 'test']);
    expect(keychain.entries.size).toBe(1);
    expect(permissionsRevokeCommand({ all: true }, deps().deps)).toBe(EXIT_CODES.success);
    expect(
      keychain.entries.size,
      'the key went with the file, so a restored copy would not verify',
    ).toBe(0);
    await storeFor(project).remember(['npm', 'test']);
    keychain.locked = true;
    expect(permissionsRevokeCommand({ all: true }, deps().deps)).toBe(EXIT_CODES.success);
    expect(existsSync(file())).toBe(false);
  });

  it('--all says what it did, in both forms, including that there was nothing to remove', () => {
    const human = deps();
    permissionsRevokeCommand({ all: true }, human.deps);
    expect(human.out()).toBe('There were no remembered commands to remove.\n');
    const json = deps(project, true);
    permissionsRevokeCommand({ all: true }, json.deps);
    expect(parseNdjson(json.out())).toEqual([{ action: 'revoke-all', removed: false }]);
  });

  it('--all with a directory at the path is a storage failure (exit 1): it cannot be removed as a file', () => {
    mkdirSync(file(), { recursive: true });
    const failure = refusal(() => permissionsRevokeCommand({ all: true }, deps().deps));
    expect(failure.code).toBe('storage_unavailable');
    expect(failure.exitCode).toBe(EXIT_CODES.workflowFailed);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '--all removes a read-only file from a writable directory, and with no file in an unwritable directory there is nothing to remove',
    async () => {
      await storeFor(project).remember(['npm', 'test']);
      chmodSync(file(), 0o400);
      expect(permissionsRevokeCommand({ all: true }, deps().deps)).toBe(EXIT_CODES.success);
      expect(existsSync(file())).toBe(false);
      chmodSync(dirname(file()), 0o500);
      try {
        const run = deps();
        expect(permissionsRevokeCommand({ all: true }, run.deps)).toBe(EXIT_CODES.success);
        expect(run.out()).toBe('There were no remembered commands to remove.\n');
      } finally {
        chmodSync(dirname(file()), 0o700);
      }
    },
  );

  it('the revoke confirmation names what was withdrawn, with the right plural and for a program it could not name', async () => {
    const grants = storeFor(project);
    await grants.remember(['npm']);
    await grants.remember(['./deploy.sh', '--prod', '--force']);
    const second = deps();
    permissionsRevokeCommand({ all: false, index: 2 }, second.deps);
    expect(second.out()).toContain(': (unnamed program), 2 arguments.');
    const first = deps();
    permissionsRevokeCommand({ all: false, index: 1 }, first.deps);
    expect(first.out()).toContain(': npm, 0 arguments.');
  });

  it('--json answers with one record naming what was done', async () => {
    await storeFor(project).remember(['npm', 'test']);
    const numbered = deps(project, true);
    permissionsRevokeCommand({ all: false, index: 1 }, numbered.deps);
    expect(parseNdjson(numbered.out())).toEqual([
      { action: 'revoke', index: 1, id: 'grant-1', program: 'npm', args: 1 },
    ]);
    const everything = deps(project, true);
    permissionsRevokeCommand({ all: true }, everything.deps);
    expect(parseNdjson(everything.out())).toEqual([{ action: 'revoke-all', removed: true }]);
  });

  it('output that cannot be delivered after a revoke is output_unavailable (the revoke itself already happened)', async () => {
    await storeFor(project).remember(['npm', 'test']);
    const broken: CliIo = {
      ...captureIo().io,
      writeOut: () => {
        throw new Error('EPIPE');
      },
    };
    expect(
      refusal(() =>
        permissionsRevokeCommand({ all: false, index: 1 }, deps(project, false, broken).deps),
      ).code,
    ).toBe('output_unavailable');
    expect(storeFor(project).matches(['npm', 'test'])).toBe(false);
  });
});

describe('the revoke argument builder', () => {
  const input = (positionals: readonly string[], all?: boolean) => ({
    positionals,
    options: all === undefined ? {} : { all },
  });

  it('takes a plain number from 1, or --all, and nothing else', () => {
    expect(buildPermissionsRevokeArgs(input(['1']))).toEqual({ all: false, index: 1 });
    expect(buildPermissionsRevokeArgs(input(['64']))).toEqual({ all: false, index: 64 });
    expect(buildPermissionsRevokeArgs(input([], true))).toEqual({ all: true });
  });

  it.each([
    { why: 'neither a number nor --all', positionals: [], all: undefined },
    { why: 'both a number and --all', positionals: ['1'], all: true },
    { why: 'two numbers', positionals: ['1', '2'], all: undefined },
    { why: 'zero', positionals: ['0'], all: undefined },
    { why: 'a leading zero', positionals: ['01'], all: undefined },
    { why: 'a negative number', positionals: ['-1'], all: undefined },
    { why: 'a fraction', positionals: ['1.5'], all: undefined },
    { why: 'an exponent', positionals: ['1e3'], all: undefined },
    { why: 'hexadecimal', positionals: ['0x10'], all: undefined },
    { why: 'a padded number', positionals: [' 1'], all: undefined },
    { why: 'a number longer than any grant list', positionals: ['9999999'], all: undefined },
    { why: 'a program name', positionals: ['npm'], all: undefined },
  ])('refuses $why as an invalid invocation', ({ positionals, all }) => {
    const failure = refusal(() => buildPermissionsRevokeArgs(input(positionals, all)));
    expect(failure.code).toBe('invalid_invocation');
    expect(failure.exitCode).toBe(EXIT_CODES.invalidInvocation);
  });

  it('never echoes what was typed', () => {
    const canary = 'sk-CANARY-do-not-echo';
    for (const positionals of [[canary], [canary, canary]])
      expect(refusal(() => buildPermissionsRevokeArgs(input(positionals))).message).not.toContain(
        canary,
      );
  });
});
