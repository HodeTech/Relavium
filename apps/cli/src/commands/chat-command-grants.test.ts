import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commandGrantsPath, createCommandGrantStore } from '../permissions/command-grants.js';
import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import { openCommandGrants } from './chat.js';

/**
 * How a chat session finds the remembered command grants (ADR-0118 §2): the project root it keys them by, which surfaces open the
 * store at all, and where an unreadable file is reported. The store itself is covered in permissions/command-grants.test.ts.
 */
class FakeKeychain implements KeychainStore {
  readonly entries = new Map<string, string>();
  get(account: string): string | null {
    return this.entries.get(account) ?? null;
  }
  set(account: string, secret: string): void {
    this.entries.set(account, secret);
  }
  delete(account: string): boolean {
    return this.entries.delete(account);
  }
}

let home: string;
let project: string;
let keychain: FakeKeychain;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-chat-grants-home-')));
  project = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-chat-grants-project-')));
  keychain = new FakeKeychain();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const GLOBAL = (cwd: string) =>
  ({ json: false, color: false, cwd, configPath: undefined, verbosity: 'normal' }) as const;
const notice = () => ({ notice: vi.fn<(text: string) => void>() });

/** What a previous session wrote: a grant for `argv` under `root`, in the operator home. */
async function remember(root: string, argv: readonly string[]): Promise<void> {
  const store = createCommandGrantStore({
    homeDir: home,
    projectRoot: root,
    keychain,
    findProgram: () => Promise.resolve(undefined),
  });
  expect((await store.remember(argv)).ok).toBe(true);
}

describe('the chat’s remembered command grants', () => {
  it('are opened for an interactive session with an operator home, keyed by the project root', async () => {
    await remember(project, ['npm', 'test']);
    const grants = openCommandGrants(
      true,
      { operatorHomeDir: home },
      { global: GLOBAL(project), keychain },
      notice(),
    );
    expect(grants?.matches(['npm', 'test'])).toBe(true);
    expect(grants?.matches(['npm', 'run', 'build'])).toBe(false);
  });

  it('are never opened by a surface that cannot ask: plain, --json and one-shot read and write nothing', async () => {
    await remember(project, ['npm', 'test']);
    const keychainReads = vi.spyOn(keychain, 'get');
    expect(
      openCommandGrants(
        false,
        { operatorHomeDir: home },
        { global: GLOBAL(project), keychain },
        notice(),
      ),
    ).toBeUndefined();
    expect(keychainReads).not.toHaveBeenCalled();
  });

  it('are absent when the session has no operator home to keep them in', () => {
    expect(
      openCommandGrants(true, {}, { global: GLOBAL(project), keychain }, notice()),
    ).toBeUndefined();
  });

  it('key a session started in a subdirectory by the directory that holds .relavium, not by the subdirectory', async () => {
    const subdirectory = join(project, 'packages', 'app');
    mkdirSync(subdirectory, { recursive: true });
    await remember(project, ['npm', 'test']);
    // No .relavium anywhere above: the working directory is the root, and a parent tree's grants are not this tree's.
    const fromCwd = openCommandGrants(
      true,
      { operatorHomeDir: home },
      { global: GLOBAL(subdirectory), keychain },
      notice(),
    );
    expect(fromCwd?.matches(['npm', 'test'])).toBe(false);
    // With one, every directory below it shares the project's grants (what `relavium permissions` lists too).
    mkdirSync(join(project, '.relavium'));
    const fromSubdirectory = openCommandGrants(
      true,
      { operatorHomeDir: home },
      { global: GLOBAL(subdirectory), keychain },
      notice(),
    );
    expect(fromSubdirectory?.matches(['npm', 'test'])).toBe(true);
  });

  it('fall back to the working directory when the home cannot be resolved safely, instead of failing the session', () => {
    const missingHome = join(home, 'no', 'such', 'home');
    const grants = openCommandGrants(
      true,
      { operatorHomeDir: missingHome },
      { global: GLOBAL(project), keychain },
      notice(),
    );
    expect(grants?.matches(['npm', 'test'])).toBe(false); // a usable store that matches nothing, not a throw
  });

  it('report an unreadable file once, on the session’s notice channel, naming the recovery', async () => {
    await remember(project, ['npm', 'test']);
    writeFileSync(commandGrantsPath(home), 'not json\n');
    const sink = notice();
    const grants = openCommandGrants(
      true,
      { operatorHomeDir: home },
      { global: GLOBAL(project), keychain },
      sink,
    );
    expect(grants?.matches(['npm', 'test'])).toBe(false);
    expect(grants?.matches(['git', 'status'])).toBe(false);
    expect(sink.notice).toHaveBeenCalledTimes(1);
    expect(sink.notice.mock.calls[0]?.[0]).toContain('relavium permissions revoke --all');
  });

  it('answer “nothing matches” on a locked keychain instead of throwing into the approval hook', () => {
    const locked: KeychainStore = {
      get: () => {
        throw new KeychainUnavailableError('locked');
      },
      set: () => undefined,
      delete: () => false,
    };
    const grants = openCommandGrants(
      true,
      { operatorHomeDir: home },
      { global: GLOBAL(project), keychain: locked },
      notice(),
    );
    expect(grants?.matches(['npm', 'test'])).toBe(false);
  });
});
