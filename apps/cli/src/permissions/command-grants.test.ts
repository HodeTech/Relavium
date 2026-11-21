import { execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import {
  COMMAND_GRANT_LIMITS,
  COMMAND_GRANTS_KEY_ACCOUNT,
  UNNAMED_PROGRAM,
  canonicalRoot,
  commandGrantsPath,
  createCommandGrantStore,
  grantDigest,
  grantRecordMac,
  removeCommandGrantsFile,
  rootDigest,
  type CommandGrantStore,
} from './command-grants.js';

/** ADR-0118 §2, point by point. The keychain is an in-memory fake; the file system is a real temp directory. */
class FakeKeychain implements KeychainStore {
  readonly entries = new Map<string, string>();
  failure: 'none' | 'throws' | 'drops-writes' | 'truncates' = 'none';
  get(account: string): string | null {
    if (this.failure === 'throws') throw new KeychainUnavailableError('locked');
    return this.entries.get(account) ?? null;
  }
  set(account: string, secret: string): void {
    if (this.failure === 'throws') throw new KeychainUnavailableError('locked');
    if (this.failure === 'drops-writes') return;
    this.entries.set(account, this.failure === 'truncates' ? secret.slice(0, 4) : secret);
  }
  delete(account: string): boolean {
    // A locked keychain refuses a delete as it refuses a read (the seam's contract: a backend failure throws), and the entry stays.
    if (this.failure === 'throws') throw new KeychainUnavailableError('locked');
    return this.entries.delete(account);
  }
}

let home: string;
let project: string;
let keychain: FakeKeychain;
let messages: string[];
// One counter for every store of a test, as real ids are unique across processes.
let counter = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'relavium-grants-home-'));
  project = mkdtempSync(join(tmpdir(), 'relavium-grants-project-'));
  keychain = new FakeKeychain();
  messages = [];
  counter = 0;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const PATH_PROGRAMS = new Set(['npm', 'git', 'cat']);
const findProgram = (name: string): Promise<string | undefined> =>
  Promise.resolve(PATH_PROGRAMS.has(name) ? `/usr/bin/${name}` : undefined);

function store(
  root = project,
  overrides: Partial<Parameters<typeof createCommandGrantStore>[0]> = {},
): CommandGrantStore {
  return createCommandGrantStore({
    homeDir: home,
    projectRoot: root,
    keychain,
    notify: (message) => messages.push(message),
    now: () => new Date('2026-11-19T12:00:00.000Z'),
    newId: () => `grant-${String(++counter)}`,
    findProgram,
    ...overrides,
  });
}

const file = (): string => commandGrantsPath(home);
const text = (): string => readFileSync(file(), 'utf8');
const AT = '2026-11-19T00:00:00.000Z';
/** chmod-based refusals do not hold for root (a container run) or on Windows. */
const CAN_REFUSE = process.platform !== 'win32' && process.getuid?.() !== 0;
const nonEmptyLines = (): string[] =>
  text()
    .split('\n')
    .filter((line) => line !== '');
/** A valid tombstone line for an id that names nothing: it costs a line and bytes, grants nothing and revokes nothing. */
const filler = (index: number): string =>
  JSON.stringify({ v: 1, revoked: `filler-${String(index)}`, at: AT });
function writeFile(content: string): void {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), content);
}
/** Make the keychain hold a usable key, as a previous session would have left it. */
function useKey(): Buffer {
  const key = Buffer.alloc(32, 5);
  keychain.entries.set(COMMAND_GRANTS_KEY_ACCOUNT, key.toString('base64'));
  return key;
}
/** A valid grant line for `root` (a canonical path string), as another session under this key would have written it. */
function grantLine(key: Buffer, root: string, argv: readonly string[], id: string): string {
  const digest = rootDigest(key, root);
  const fields = {
    v: 1 as const,
    id,
    root: digest,
    grant: grantDigest(key, digest, argv),
    args: Math.max(0, argv.length - 1),
    at: AT,
  };
  return JSON.stringify({ ...fields, mac: grantRecordMac(key, fields) });
}

describe('the digests', () => {
  const key = Buffer.alloc(32, 7);
  const root = rootDigest(key, '/work/repo');

  it('are keyed, versioned and deterministic', () => {
    expect(root).toMatch(/^[0-9a-f]{64}$/u);
    expect(rootDigest(key, '/work/repo')).toBe(root);
    expect(rootDigest(Buffer.alloc(32, 8), '/work/repo'), 'another key, another digest').not.toBe(
      root,
    );
    expect(rootDigest(key, '/work/other'), 'another root, another digest').not.toBe(root);
  });

  it('tell argv boundaries apart: one argument with a space is not two arguments', () => {
    const digests = [
      grantDigest(key, root, ['cat a b']),
      grantDigest(key, root, ['cat', 'a b']),
      grantDigest(key, root, ['cat', 'a', 'b']),
      grantDigest(key, root, ['cat', 'a', 'b', '']),
      grantDigest(key, root, ['cat', 'ab']),
      // The same count and the same concatenated bytes: only the per-element length tells them apart.
      grantDigest(key, root, ['ab', 'c']),
      grantDigest(key, root, ['a', 'bc']),
    ];
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('bind the root digest: the same argv under another root is another digest', () => {
    const elsewhere = rootDigest(key, '/work/other');
    expect(grantDigest(key, root, ['npm', 'test'])).not.toBe(
      grantDigest(key, elsewhere, ['npm', 'test']),
    );
  });
});

describe('remembering and matching', () => {
  it('remembers one exact argv: a match needs every element, a prefix, a longer argv, a glob or a reorder is another command', async () => {
    const grants = store();
    expect(grants.matches(['npm', 'test'])).toBe(false);
    const result = await grants.remember(['npm', 'test']);
    expect(result).toEqual({ ok: true, id: 'grant-1', alreadyRemembered: false });
    expect(grants.matches(['npm', 'test'])).toBe(true);
    for (const other of [
      ['npm'],
      ['npm', 'test', '--', '--exec=x'],
      ['npm', 'test '],
      ['test', 'npm'],
      ['npm', '*'],
      ['NPM', 'test'],
    ])
      expect(grants.matches(other), JSON.stringify(other)).toBe(false);
  });

  it('is idempotent: remembering the same argv again reports it and writes no second record', async () => {
    const grants = store();
    await grants.remember(['git', 'status']);
    const before = text();
    expect(await grants.remember(['git', 'status'])).toEqual({
      ok: true,
      id: 'grant-1',
      alreadyRemembered: true,
    });
    expect(text()).toBe(before);
  });

  it('is shared by two paths to one tree and by nothing else', async () => {
    const real = canonicalRoot(project);
    const link = join(
      tmpdir(),
      `relavium-grants-link-${String(process.pid)}-${String(Date.now())}`,
    );
    symlinkSync(real, link, 'dir');
    try {
      await store(link).remember(['npm', 'test']);
      expect(
        store(project).matches(['npm', 'test']),
        'the real path sees the symlinked path’s grant',
      ).toBe(true);
      const other = mkdtempSync(join(tmpdir(), 'relavium-grants-other-'));
      try {
        expect(store(other).matches(['npm', 'test']), 'a fresh clone elsewhere shares none').toBe(
          false,
        );
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('is not matched by a record copied into another root’s lines', async () => {
    await store().remember(['npm', 'test']);
    const copied = text().trim();
    const other = mkdtempSync(join(tmpdir(), 'relavium-grants-other-'));
    try {
      // The same record, line for line: the other root's digest differs, so it is not THAT root's grant.
      writeFileSync(file(), `\n${copied}\n`);
      expect(store(other).matches(['npm', 'test'])).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('never accepts an empty argv', async () => {
    const grants = store();
    expect(grants.matches([])).toBe(false);
    await expect(grants.remember([])).rejects.toBeInstanceOf(RangeError);
  });
});

describe('what the file holds (ADR-0118 §2)', () => {
  it('never the command, an argument or the key: a canary credential in the argv appears nowhere on disk', async () => {
    const grants = store();
    const canary = 'sk-CANARY-0123456789abcdef-PASSWORD';
    await grants.remember(['psql', `--password=${canary}`, 'postgres://user:hunter2@db/x']);
    const onDisk = text();
    expect(onDisk).not.toContain(canary);
    expect(onDisk).not.toContain('hunter2');
    expect(onDisk).not.toContain('psql');
    expect(onDisk).not.toContain('postgres');
    const key = keychain.entries.get(COMMAND_GRANTS_KEY_ACCOUNT) ?? '';
    expect(key.length).toBeGreaterThan(20);
    expect(onDisk, 'the digest key never enters the file').not.toContain(key);
  });

  it('one bounded JSON record per append, framed by a leading newline, owner-only', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    await grants.remember(['git', 'status']);
    const lines = text().split('\n');
    expect(lines[0], 'the leading newline').toBe('');
    const records = lines.filter((line) => line !== '');
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(() => JSON.parse(record) as unknown).not.toThrow();
      expect(record.length).toBeLessThan(700);
    }
    if (process.platform !== 'win32') {
      expect(statSync(file()).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, '.relavium')).mode & 0o777).toBe(0o700);
    }
  });

  it('names a program by its SHAPE first: free text is never named even when a lookup would resolve it', async () => {
    const grants = store(project, { findProgram: () => Promise.resolve('/anywhere/resolves') });
    for (const first of [
      'PGPASSWORD=hunter2',
      './build.sh',
      '/usr/bin/git',
      'a b',
      'user@host',
      'x'.repeat(65),
      'a:b',
    ])
      await grants.remember([first, 'arg']);
    await grants.remember(['npm', 'arg']);
    const listed = grants.list();
    expect(listed.ok && listed.grants.map((g) => g.program)).toEqual([
      ...Array<string>(7).fill(UNNAMED_PROGRAM),
      'npm',
    ]);
    expect(text()).not.toContain('hunter2');
    expect(text()).not.toContain('user@host');
  });

  it('labels a program only when argv[0] is a bare name that resolves on the PATH', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']); // a bare name on the PATH: named
    await grants.remember(['PGPASSWORD=hunter2', 'psql']); // an assignment: free text, never kept
    await grants.remember(['./scripts/build.sh', '--release']); // a path
    await grants.remember(['/usr/bin/git', 'status']); // an absolute path
    await grants.remember(['nonexistent-tool', 'x']); // a bare name that resolves to nothing
    await grants.remember(['my secret command', 'x']); // whitespace
    const listed = grants.list();
    expect(listed.ok && listed.grants.map((g) => [g.program, g.args])).toEqual([
      ['npm', 1],
      [UNNAMED_PROGRAM, 1],
      [UNNAMED_PROGRAM, 1],
      [UNNAMED_PROGRAM, 1],
      [UNNAMED_PROGRAM, 1],
      [UNNAMED_PROGRAM, 1],
    ]);
    expect(text()).not.toContain('hunter2');
    expect(text()).not.toContain('my secret command');
  });
});

describe('the fold fails closed (ADR-0084 §5)', () => {
  it('a garbage line makes the WHOLE store “no grants” and says so exactly once', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    appendFileSync(file(), '\n{"v":1,"revoked":\n');
    expect(grants.matches(['npm', 'test'])).toBe(false);
    expect(grants.matches(['npm', 'test'])).toBe(false);
    expect(grants.list()).toEqual({ ok: false, reason: 'unreadable' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('relavium permissions revoke --all');
    expect(messages[0]).not.toContain('npm');
  });

  it('a truncated TOMBSTONE does not resurrect the grant it was revoking', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    // The revocation line, cut in half: a skipping reader would drop it and the grant would be live again.
    appendFileSync(file(), '\n{"v":1,"revoked":"grant-1","at":"2026-1');
    expect(grants.matches(['npm', 'test'])).toBe(false);
  });

  it('a record that is not a grant or a revocation reads as unreadable too', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    appendFileSync(file(), '\n{"v":1,"unexpected":true}\n');
    expect(grants.matches(['npm', 'test'])).toBe(false);
  });

  it('a torn tail (a process killed mid-append) makes the store unreadable, and nothing is appended behind it', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    appendFileSync(file(), '{"v":1,"revoked":"gr'); // no terminator
    const before = text();
    expect(grants.matches(['npm', 'test'])).toBe(false);
    expect(await store().remember(['git', 'status'])).toEqual({ ok: false, reason: 'unreadable' });
    expect(grants.revoke(1)).toEqual({ ok: false, reason: 'unreadable' });
    expect(text(), 'a store that cannot be read is not appended to').toBe(before);
  });

  it('a grant time that is not an ISO instant is not a grant: a hand-edited line cannot carry a newline or an escape into a listing', async () => {
    await store().remember(['npm', 'test']);
    writeFile(text().replace(/"at":"[^"]*"/u, String.raw`"at":"x\n  2. sudo  (0 arguments)"`));
    expect(store().list()).toEqual({ ok: false, reason: 'unreadable' });
  });
});

describe('revocation does not depend on file order, and one argv is one grant', () => {
  it('a replayed grant line stays revoked, and so does a tombstone placed above its grant', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    const grantRecord = nonEmptyLines()[0] ?? '';
    grants.revoke(1);
    expect(grants.matches(['npm', 'test'])).toBe(false);
    appendFileSync(file(), `\n${grantRecord}\n`); // the same line again, after its tombstone
    expect(store().matches(['npm', 'test']), 'a replayed line').toBe(false);
    const tombstone = nonEmptyLines()[1] ?? '';
    writeFile(`\n${tombstone}\n${grantRecord}\n`); // the tombstone moved above the grant
    expect(store().matches(['npm', 'test']), 'a reordered tombstone').toBe(false);
  });

  it('two records for one argv (two processes remembered it at the same moment) are one listed grant, and one revoke withdraws both', () => {
    const key = useKey();
    writeFile(
      `\n${grantLine(key, canonicalRoot(project), ['npm', 'test'], 'twin-a')}\n${grantLine(key, canonicalRoot(project), ['npm', 'test'], 'twin-b')}\n`,
    );
    const grants = store();
    const listed = grants.list();
    expect(listed.ok && listed.grants.map((g) => g.id)).toEqual(['twin-a']);
    expect(grants.revoke(1)).toMatchObject({ ok: true, id: 'twin-a', ids: ['twin-a', 'twin-b'] });
    expect(grants.matches(['npm', 'test']), 'the twin did not keep the command approved').toBe(
      false,
    );
    expect(nonEmptyLines().filter((line) => line.includes('"revoked"'))).toHaveLength(2);
  });

  it('revokeById names an identity: it takes the grant that holds the id (or a twin’s id), with every record, and is blind to positions', () => {
    const key = useKey();
    writeFile(
      `\n${grantLine(key, canonicalRoot(project), ['npm', 'test'], 'twin-a')}\n${grantLine(key, canonicalRoot(project), ['npm', 'test'], 'twin-b')}\n${grantLine(key, canonicalRoot(project), ['git', 'status'], 'solo')}\n`,
    );
    const grants = store();
    // The twin's own id, not the listed one, still names the grant: both records are withdrawn.
    expect(grants.revokeById('twin-b')).toMatchObject({
      ok: true,
      id: 'twin-a',
      ids: ['twin-a', 'twin-b'],
    });
    expect(grants.matches(['npm', 'test'])).toBe(false);
    expect(grants.matches(['git', 'status']), 'the other grant is untouched').toBe(true);
    expect(nonEmptyLines().filter((line) => line.includes('"revoked"'))).toHaveLength(2);
    // A grant that is gone is gone: the same id again, and an id that never existed, name nothing.
    expect(grants.revokeById('twin-a')).toEqual({ ok: false, reason: 'no-such-grant' });
    expect(grants.revokeById('never')).toEqual({ ok: false, reason: 'no-such-grant' });
    // What is left is still withdrawn by its own id, wherever it now sits in the list.
    expect(grants.revokeById('solo')).toMatchObject({ ok: true, id: 'solo', ids: ['solo'] });
    expect(grants.matches(['git', 'status'])).toBe(false);
  });

  it('revokeById reads the store like revoke does: a file that does not parse is unreadable, never an empty store', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    appendFileSync(file(), 'not a line\n');
    expect(store().revokeById('grant-1')).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('two overlapping remembers in one process make exactly one record', async () => {
    const a = store();
    const b = store();
    const [first, second] = await Promise.all([
      a.remember(['npm', 'test']),
      b.remember(['npm', 'test']),
    ]);
    expect([first, second].filter((r) => r.ok && !r.alreadyRemembered)).toHaveLength(1);
    expect([first, second].filter((r) => r.ok && r.alreadyRemembered)).toHaveLength(1);
    expect(nonEmptyLines()).toHaveLength(1);
  });
});

describe('revoking and listing', () => {
  it('lists this root’s live grants by 1-based index, and a tombstone removes exactly one', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    await grants.remember(['git', 'status']);
    await grants.remember(['cat', 'a']);
    expect(grants.revoke(2)).toEqual({
      ok: true,
      id: 'grant-2',
      ids: ['grant-2'],
      program: 'git',
      args: 1,
    });
    expect(grants.matches(['git', 'status'])).toBe(false);
    expect(grants.matches(['npm', 'test'])).toBe(true);
    const listed = grants.list();
    expect(listed.ok && listed.grants.map((g) => [g.index, g.id])).toEqual([
      [1, 'grant-1'],
      [2, 'grant-3'],
    ]);
    // Append-only: the file grew by a tombstone; nothing was rewritten.
    expect(
      text()
        .split('\n')
        .filter((l) => l !== ''),
    ).toHaveLength(4);
  });

  it('refuses an index that is not there, and lists nothing from another root', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    expect(grants.revoke(0)).toEqual({ ok: false, reason: 'no-such-grant' });
    expect(grants.revoke(2)).toEqual({ ok: false, reason: 'no-such-grant' });
    const other = mkdtempSync(join(tmpdir(), 'relavium-grants-other-'));
    try {
      const listed = store(other).list();
      expect(listed.ok && listed.grants).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('a revoked argv can be remembered again (a later line wins)', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    grants.revoke(1);
    expect(grants.matches(['npm', 'test'])).toBe(false);
    expect((await grants.remember(['npm', 'test'])).ok).toBe(true);
    expect(grants.matches(['npm', 'test'])).toBe(true);
  });

  it('revokeAll removes the file, every root’s grants with it, and is the recovery from a bad file', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    appendFileSync(file(), '\nnot json\n');
    expect(grants.list().ok).toBe(false);
    expect(grants.revokeAll()).toEqual({ ok: true, removed: true });
    expect(existsSync(file())).toBe(false);
    expect(
      keychain.entries.has(COMMAND_GRANTS_KEY_ACCOUNT),
      'the store’s own revokeAll forgets the key too',
    ).toBe(false);
    expect(grants.revokeAll()).toEqual({ ok: true, removed: false });
    expect(grants.list()).toEqual({ ok: true, grants: [] });
    expect((await grants.remember(['npm', 'test'])).ok, 'and the store works again').toBe(true);
  });

  it('list is empty, not a fault, before any grant was ever made (no key exists yet); a locked keychain still says no-key', () => {
    expect(keychain.entries.size).toBe(0);
    expect(store().list()).toEqual({ ok: true, grants: [] });
    expect(keychain.entries.size, 'a read never generates the key').toBe(0);
    keychain.failure = 'throws';
    expect(store().list()).toEqual({ ok: false, reason: 'no-key' });
  });

  it('list with no key yet still reports an unreadable file, so the recovery is offered', () => {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), 'not json\n');
    expect(store().list()).toEqual({ ok: false, reason: 'unreadable' });
  });

  it.skipIf(!CAN_REFUSE)(
    'revokeAll that cannot remove the file says so, never "nothing to remove"',
    async () => {
      const grants = store();
      await grants.remember(['npm', 'test']);
      chmodSync(dirname(file()), 0o500); // the directory refuses the unlink
      try {
        expect(grants.revokeAll()).toEqual({ ok: false, reason: 'unwritable' });
        expect(existsSync(file())).toBe(true);
      } finally {
        chmodSync(dirname(file()), 0o700);
      }
    },
  );
});

describe('bounds (ADR-0118 §2)', () => {
  it('refuses the 65th live grant for a root, and Remember is then not offered', async () => {
    const grants = store();
    for (let i = 0; i < COMMAND_GRANT_LIMITS.perRoot; i += 1)
      expect((await grants.remember(['npm', String(i)])).ok).toBe(true);
    expect(await grants.remember(['npm', 'one-more'])).toEqual({ ok: false, reason: 'full' });
    expect(grants.canRemember()).toEqual({ ok: false, reason: 'full' });
    // Revoking one makes room again.
    grants.revoke(1);
    expect(grants.canRemember()).toEqual({ ok: true });
  });

  it('refuses a grant past the machine-wide total even for a root with room', async () => {
    const key = useKey();
    const lines = Array.from({ length: COMMAND_GRANT_LIMITS.total }, (_, i) =>
      grantLine(
        key,
        `/other/root/${String(Math.floor(i / 60))}`,
        ['cmd', String(i)],
        `g${String(i)}`,
      ),
    );
    writeFile(`\n${lines.join('\n')}\n`);
    expect(await store().remember(['npm', 'test'])).toEqual({ ok: false, reason: 'full' });
  });

  it('reads a file past the LINE bound as “no grants” at exactly the boundary: 8,192 lines read, 8,193 do not, blank lines are free', () => {
    useKey();
    const lines = (count: number): string =>
      Array.from({ length: count }, (_, i) => filler(i)).join('\n');
    writeFile(`\n${lines(COMMAND_GRANT_LIMITS.lines)}\n\n\n\n`);
    expect(store().list(), 'the 8,192nd line, with blank lines around it').toEqual({
      ok: true,
      grants: [],
    });
    writeFile(`\n${lines(COMMAND_GRANT_LIMITS.lines + 1)}\n`);
    expect(store().list()).toEqual({ ok: false, reason: 'unreadable' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('more lines than the bound');
  });

  it('reads a file past the SIZE bound as “no grants” at exactly the boundary: 2 MiB reads, 2 MiB + 1 byte does not', () => {
    useKey();
    const padded = (size: number): string => {
      const line = `\n${filler(0)}\n`;
      return line + '\n'.repeat(size - Buffer.byteLength(line));
    };
    writeFile(padded(COMMAND_GRANT_LIMITS.bytes));
    expect(statSync(file()).size).toBe(COMMAND_GRANT_LIMITS.bytes);
    expect(store().list()).toEqual({ ok: true, grants: [] });
    writeFile(padded(COMMAND_GRANT_LIMITS.bytes + 1));
    const fresh = store();
    expect(fresh.list()).toEqual({ ok: false, reason: 'unreadable' });
    expect(messages.join()).toContain('larger than the size bound');
  });

  it('reads a file past the GRANT bounds as “no grants” too: 65 live grants for one root, or 1,025 in all', () => {
    const key = useKey();
    const forRoot = (n: number, root: string, offset = 0): string[] =>
      Array.from({ length: n }, (_, i) =>
        grantLine(key, root, ['cmd', String(i + offset)], `p${String(i + offset)}`),
      );
    writeFile(`\n${forRoot(COMMAND_GRANT_LIMITS.perRoot, canonicalRoot(project)).join('\n')}\n`);
    expect(store().list().ok, '64 for a root').toBe(true);
    writeFile(
      `\n${forRoot(COMMAND_GRANT_LIMITS.perRoot + 1, canonicalRoot(project)).join('\n')}\n`,
    );
    expect(store().list(), '65 for a root').toEqual({ ok: false, reason: 'unreadable' });
    const many = Array.from({ length: COMMAND_GRANT_LIMITS.total + 1 }, (_, i) =>
      grantLine(key, `/r/${String(Math.floor(i / 60))}`, ['cmd', String(i)], `t${String(i)}`),
    );
    writeFile(`\n${many.join('\n')}\n`);
    expect(store().list(), '1,025 in all').toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses to ADD a line when the file would pass the line or size bound, with room for exactly one tombstone', async () => {
    useKey();
    const lines = (count: number): string =>
      `\n${Array.from({ length: count }, (_, i) => filler(i)).join('\n')}\n`;
    writeFile(lines(COMMAND_GRANT_LIMITS.lines - 2));
    expect(store().canRemember(), '8,190 lines: the grant line fits').toEqual({ ok: true });
    writeFile(lines(COMMAND_GRANT_LIMITS.lines - 1));
    expect(store().canRemember(), '8,191 lines: only the tombstone slot is left').toEqual({
      ok: false,
      reason: 'full',
    });
    expect(await store().remember(['npm', 'test'])).toEqual({ ok: false, reason: 'full' });
    const padded = (size: number): string => {
      const line = `\n${filler(0)}\n`;
      return line + '\n'.repeat(size - Buffer.byteLength(line));
    };
    // A grant reserves a record (1,024 bytes) and the tombstone that will withdraw it (256).
    writeFile(padded(COMMAND_GRANT_LIMITS.bytes - 1280));
    expect(store().canRemember(), 'a grant and its tombstone still fit under 2 MiB').toEqual({
      ok: true,
    });
    writeFile(padded(COMMAND_GRANT_LIMITS.bytes - 1279));
    expect(store().canRemember()).toEqual({ ok: false, reason: 'full' });
  });

  it('a revoke that would push the file past the line bound says so instead of making every grant unreadable', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    const extra = (count: number): string =>
      Array.from({ length: count }, (_, i) => filler(i)).join('\n');
    appendFileSync(file(), `\n${extra(COMMAND_GRANT_LIMITS.lines - 2)}\n`); // 1 grant + 8,190 = 8,191 lines
    expect(store().revoke(1)).toMatchObject({ ok: true }); // 8,192: exactly the bound
    expect(store().list(), 'still readable at the bound').toEqual({ ok: true, grants: [] });
    rmSync(file());
    await store().remember(['npm', 'test']);
    appendFileSync(file(), `\n${extra(COMMAND_GRANT_LIMITS.lines - 1)}\n`); // 8,192 lines
    const before = text();
    expect(store().revoke(1)).toEqual({ ok: false, reason: 'full' });
    expect(text(), 'nothing was written').toBe(before);
    expect(
      store().matches(['npm', 'test']),
      'the grant is still readable and live; --all is the recovery',
    ).toBe(true);
    expect(removeCommandGrantsFile(home)).toEqual({ ok: true, removed: true });
  });

  it('a revoke needs room for its tombstone bytes: a file within 256 bytes of the size bound refuses it', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    const pad = (size: number): void => {
      const current = statSync(file()).size;
      appendFileSync(file(), '\n'.repeat(size - current));
    };
    pad(COMMAND_GRANT_LIMITS.bytes - 255);
    const before = text();
    expect(store().revoke(1)).toEqual({ ok: false, reason: 'full' });
    expect(text()).toBe(before);
    rmSync(file());
    await store().remember(['npm', 'test']);
    pad(COMMAND_GRANT_LIMITS.bytes - 256);
    expect(store().revoke(1)).toMatchObject({ ok: true });
  });

  it('the machine-wide total is exact (the 1,024th passes) and a root keeps its own quota when another is full', async () => {
    const key = useKey();
    const fillRoot = (root: string, n: number, tag: string): string[] =>
      Array.from({ length: n }, (_, i) =>
        grantLine(key, root, ['cmd', String(i)], `${tag}${String(i)}`),
      );
    const others = Array.from({ length: 16 }, (_, r) =>
      fillRoot(`/other/${String(r)}`, 60, `o${String(r)}-`),
    ).flat();
    writeFile(`\n${[...others, ...fillRoot('/full/root', 63, 'f')].join('\n')}\n`); // 16*60 + 63 = 1,023
    expect(await store().remember(['npm', 'test'])).toMatchObject({ ok: true }); // the 1,024th
    expect(await store().remember(['npm', 'again'])).toEqual({ ok: false, reason: 'full' });
    writeFile(
      `\n${fillRoot(canonicalRoot(project), COMMAND_GRANT_LIMITS.perRoot, 'p').join('\n')}\n`,
    );
    expect(store().canRemember(), 'this root is full').toEqual({ ok: false, reason: 'full' });
    const otherRoot = mkdtempSync(join(tmpdir(), 'relavium-grants-other-'));
    try {
      expect(store(otherRoot).canRemember(), 'another root is not').toEqual({ ok: true });
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

describe('the keychain (ADR-0118 §2, failure modes)', () => {
  it('generates the key at the first write, stores it, and reads it back; a read never generates one', async () => {
    const grants = store();
    expect(grants.matches(['npm', 'test'])).toBe(false);
    expect(keychain.entries.size, 'reading generated nothing').toBe(0);
    await grants.remember(['npm', 'test']);
    expect(keychain.entries.size).toBe(1);
    expect(
      Buffer.from(keychain.entries.get(COMMAND_GRANTS_KEY_ACCOUNT) ?? '', 'base64'),
    ).toHaveLength(32);
  });

  it('a locked or absent keychain: Remember is not offered, existing grants count as none, nothing is written', async () => {
    await store().remember(['npm', 'test']);
    keychain.failure = 'throws';
    const locked = store();
    expect(locked.matches(['npm', 'test'])).toBe(false);
    expect(locked.canRemember()).toEqual({ ok: false, reason: 'no-key' });
    expect(await locked.remember(['git', 'status'])).toEqual({ ok: false, reason: 'no-key' });
    expect(locked.list()).toEqual({ ok: false, reason: 'no-key' });
    expect(
      text()
        .split('\n')
        .filter((l) => l !== ''),
    ).toHaveLength(1);
  });

  it('a keychain that drops writes is caught before a grant is made', async () => {
    keychain.failure = 'drops-writes';
    const grants = store();
    expect(await grants.remember(['npm', 'test'])).toEqual({ ok: false, reason: 'no-key' });
    expect(existsSync(file())).toBe(false);
  });

  it('a key that was replaced (a lost race, a new installation) makes old grants stop matching: the card asks again', async () => {
    await store().remember(['npm', 'test']);
    keychain.entries.set(COMMAND_GRANTS_KEY_ACCOUNT, Buffer.alloc(32, 1).toString('base64'));
    expect(store().matches(['npm', 'test'])).toBe(false);
  });

  it('a stored entry too short to be a key is not used as one', () => {
    keychain.entries.set(COMMAND_GRANTS_KEY_ACCOUNT, Buffer.alloc(4, 1).toString('base64'));
    expect(store().canRemember()).toEqual({ ok: false, reason: 'no-key' });
  });
});

describe('the file protocol', () => {
  it('refuses a symlink at the grants path for reads AND writes: nothing is followed, nothing is written through it', async () => {
    const target = join(home, 'elsewhere.txt');
    writeFileSync(target, ''); // an empty file would read as “no grants”, so only the refusal can explain a failure
    mkdirSync(join(home, '.relavium'), { recursive: true });
    symlinkSync(target, file());
    const grants = store();
    expect(grants.matches(['npm', 'test'])).toBe(false);
    expect(grants.list()).toEqual({ ok: false, reason: 'unreadable' });
    expect(await grants.remember(['npm', 'test'])).toEqual({ ok: false, reason: 'unreadable' });
    expect(grants.canRemember()).toEqual({ ok: false, reason: 'unreadable' });
    expect(readFileSync(target, 'utf8'), 'nothing was written through the link').toBe('');
    expect(messages.join()).toContain('revoke --all');
    // The recovery removes the link itself and leaves what it pointed at.
    expect(removeCommandGrantsFile(home)).toEqual({ ok: true, removed: true });
    expect(existsSync(target)).toBe(true);
    expect(() => lstatSync(file())).toThrow();
  });

  it('a symlink to a REAL grants file is not followed either: the same grants would otherwise be honoured through a link', async () => {
    await store().remember(['npm', 'test']);
    const real = join(home, 'real-grants.ndjson');
    writeFileSync(real, readFileSync(file()));
    rmSync(file());
    symlinkSync(real, file());
    expect(store().matches(['npm', 'test'])).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'a FIFO at the path is unreadable at once instead of blocking the approval hook',
    () => {
      mkdirSync(join(home, '.relavium'), { recursive: true });
      execFileSync('mkfifo', [file()]);
      // A regression would block this synchronous open for ever and hang the worker instead of failing the test, so a helper
      // process opens the FIFO for writing after a second: that releases a blocked open, and the elapsed time then fails the test.
      const releaser = spawn('sh', ['-c', 'sleep 1; exec 3>"$1"; sleep 2', 'sh', file()], {
        stdio: 'ignore',
      });
      try {
        const started = Date.now();
        expect(store().matches(['npm', 'test'])).toBe(false);
        expect(store().list()).toEqual({ ok: false, reason: 'unreadable' });
        expect(Date.now() - started, 'it did not wait for a writer').toBeLessThan(800);
      } finally {
        releaser.kill('SIGKILL');
      }
    },
  );

  it('a directory at the path is unreadable, and removing it as a file is a failure, not “nothing to remove”', () => {
    mkdirSync(file(), { recursive: true });
    expect(store().list()).toEqual({ ok: false, reason: 'unreadable' });
    expect(removeCommandGrantsFile(home)).toEqual({ ok: false, reason: 'unwritable' });
  });

  it.skipIf(process.platform === 'win32')(
    'creates the file owner-only and heals a looser mode on the next touch',
    async () => {
      const previous = process.umask(0);
      try {
        await store().remember(['npm', 'test']);
        expect(
          statSync(file()).mode & 0o777,
          'created owner-only even with a permissive umask',
        ).toBe(0o600);
        chmodSync(file(), 0o644);
        await store().remember(['git', 'status']);
        expect(statSync(file()).mode & 0o777, 'healed').toBe(0o600);
      } finally {
        process.umask(previous);
      }
    },
  );

  it('two stores appending in turn (two processes) lose no line and remember one grant once', async () => {
    const a = store();
    const b = store();
    await a.remember(['npm', 'test']);
    await b.remember(['git', 'status']);
    await a.remember(['git', 'status']); // already there: idempotent
    expect(nonEmptyLines()).toHaveLength(2);
    expect(a.matches(['git', 'status']) && b.matches(['npm', 'test'])).toBe(true);
  });
});

describe('canRemember and revoke when the store cannot be written', () => {
  it('is offered on a machine that has never remembered anything: no key yet, no file yet', () => {
    expect(keychain.entries.size).toBe(0);
    expect(store().canRemember()).toEqual({ ok: true });
    expect(keychain.entries.size, 'a check never generates the key').toBe(0);
  });

  it('is not offered for an unreadable file', () => {
    writeFile('not json\n');
    expect(store().canRemember()).toEqual({ ok: false, reason: 'unreadable' });
  });

  it.skipIf(!CAN_REFUSE)(
    'is not offered when the file or its directory cannot be written, and a revoke says unwritable',
    async () => {
      await store().remember(['npm', 'test']);
      chmodSync(file(), 0o400);
      try {
        expect(store().canRemember()).toEqual({ ok: false, reason: 'unwritable' });
        expect(await store().remember(['git', 'status'])).toEqual({
          ok: false,
          reason: 'unwritable',
        });
        const before = text();
        expect(store().revoke(1)).toEqual({ ok: false, reason: 'unwritable' });
        expect(text(), 'a revoke that could not be written changed nothing, and said so').toBe(
          before,
        );
        expect(store().matches(['npm', 'test'])).toBe(true);
      } finally {
        chmodSync(file(), 0o600);
      }
      rmSync(file());
      chmodSync(join(home, '.relavium'), 0o500);
      try {
        expect(store().canRemember(), 'no file yet and a directory that refuses').toEqual({
          ok: false,
          reason: 'unwritable',
        });
      } finally {
        chmodSync(join(home, '.relavium'), 0o700);
      }
    },
  );
});

describe('a grant record is authenticated (ADR-0118 §2, review round 2)', () => {
  it('a revoked grant copied under a NEW id does not come back: a record not made with the key is ignored', async () => {
    const grants = store();
    await grants.remember(['make', 'deploy', '--prod']);
    const original = JSON.parse(nonEmptyLines()[0] ?? '{}') as Record<string, unknown>;
    grants.revoke(1);
    appendFileSync(file(), `\n${JSON.stringify({ ...original, id: 'attacker-new-id' })}\n`);
    const fresh = store();
    expect(fresh.matches(['make', 'deploy', '--prod'])).toBe(false);
    // The record that does not verify is counted, so a caller can say a list that shows nothing could not be verified.
    expect(fresh.list()).toEqual({ ok: true, grants: [], ignored: 1 });
    expect(messages.join()).toContain('were not made with this installation');
  });

  it.each([
    ['its label', (record: Record<string, unknown>) => ({ ...record, program: 'ls', args: 0 })],
    [
      'its time',
      (record: Record<string, unknown>) => ({ ...record, at: '2030-01-01T00:00:00.000Z' }),
    ],
    ['its id', (record: Record<string, unknown>) => ({ ...record, id: 'renamed' })],
    ['its mac', (record: Record<string, unknown>) => ({ ...record, mac: 'f'.repeat(64) })],
  ])('a record whose %s was edited is ignored, not trusted', async (_what, edit) => {
    await store().remember(['npm', 'test']);
    const record = JSON.parse(nonEmptyLines()[0] ?? '{}') as Record<string, unknown>;
    writeFile(`\n${JSON.stringify(edit(record))}\n`);
    expect(store().matches(['npm', 'test'])).toBe(false);
  });

  it('a record made under ANOTHER key is ignored without making the store unreadable: the others still match', async () => {
    const other = Buffer.alloc(32, 77);
    writeFile(`\n${grantLine(other, canonicalRoot(project), ['git', 'status'], 'foreign-1')}\n`);
    keychain.entries.set(COMMAND_GRANTS_KEY_ACCOUNT, Buffer.alloc(32, 5).toString('base64'));
    const grants = store();
    expect(grants.matches(['git', 'status'])).toBe(false);
    expect(await grants.remember(['npm', 'test'])).toMatchObject({ ok: true });
    expect(grants.matches(['npm', 'test'])).toBe(true);
    expect(grants.list().ok).toBe(true);
  });

  it('the MAC and the digests have the documented byte layout (an independent re-computation)', () => {
    const key = Buffer.alloc(32, 3);
    const root = createHmac('sha256', key)
      .update('relavium/command-grants/root/v1\0')
      .update('/work/repo', 'utf8')
      .digest('hex');
    expect(rootDigest(key, '/work/repo')).toBe(root);
    const lengthPrefixed = (text: string): Buffer => {
      const bytes = Buffer.from(text, 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return Buffer.concat([length, bytes]);
    };
    const count = Buffer.alloc(4);
    count.writeUInt32BE(2);
    const grant = createHmac('sha256', key)
      .update('relavium/command-grants/grant/v1\0')
      .update(root, 'utf8')
      .update('\0')
      .update(Buffer.concat([count, lengthPrefixed('npm'), lengthPrefixed('test')]))
      .digest('hex');
    expect(grantDigest(key, root, ['npm', 'test'])).toBe(grant);
    const fields = { v: 1 as const, id: 'abc', root, grant, program: 'npm', args: 1, at: AT };
    const mac = createHmac('sha256', key)
      .update(
        ['relavium/command-grants/record/v1', 'abc', root, grant, 'npm', '1', AT].join('\0'),
        'utf8',
      )
      .digest('hex');
    expect(grantRecordMac(key, fields)).toBe(mac);
    expect(grantRecordMac(key, { ...fields, program: undefined })).toBe(
      createHmac('sha256', key)
        .update(
          ['relavium/command-grants/record/v1', 'abc', root, grant, '', '1', AT].join('\0'),
          'utf8',
        )
        .digest('hex'),
    );
  });
});

describe('revoke --all forgets the key, so a restored older copy stops validating', () => {
  it('removes the file and the key; a backup restored afterwards is not trusted under a new key', async () => {
    await store().remember(['npm', 'test']);
    const backup = readFileSync(file());
    expect(removeCommandGrantsFile(home, keychain)).toEqual({ ok: true, removed: true });
    expect(keychain.entries.has(COMMAND_GRANTS_KEY_ACCOUNT)).toBe(false);
    writeFile(backup.toString('utf8')); // the dotfile sync / backup restore
    expect(await store().remember(['git', 'status'])).toMatchObject({ ok: true }); // a new key is generated
    expect(
      store().matches(['npm', 'test']),
      'the restored grant does not verify under the new key',
    ).toBe(false);
    expect(store().matches(['git', 'status'])).toBe(true);
  });

  it('works with a locked keychain (the file goes; the key stays and the failure is ignored)', async () => {
    await store().remember(['npm', 'test']);
    const key = keychain.entries.get(COMMAND_GRANTS_KEY_ACCOUNT);
    expect(key, 'a key exists to be kept').toBeDefined();
    keychain.failure = 'throws';
    expect(removeCommandGrantsFile(home, keychain)).toEqual({ ok: true, removed: true });
    expect(existsSync(file())).toBe(false);
    expect(
      keychain.entries.get(COMMAND_GRANTS_KEY_ACCOUNT),
      'the locked keychain refused the delete, so the key is exactly as it was',
    ).toBe(key);
  });

  it('with a locked keychain and no file, there is nothing to remove, and the failure is ignored there too', () => {
    useKey();
    keychain.failure = 'throws';
    expect(removeCommandGrantsFile(home, keychain)).toEqual({ ok: true, removed: false });
    expect(keychain.entries.has(COMMAND_GRANTS_KEY_ACCOUNT)).toBe(true);
  });

  it('the store’s own revokeAll with a locked keychain removes the file and leaves the key', async () => {
    const grants = store();
    await grants.remember(['npm', 'test']);
    keychain.failure = 'throws';
    expect(grants.revokeAll()).toEqual({ ok: true, removed: true });
    expect(existsSync(file())).toBe(false);
    expect(keychain.entries.has(COMMAND_GRANTS_KEY_ACCOUNT)).toBe(true);
  });

  it('keeps the key when the file could not be removed: the grants in it still verify', () => {
    mkdirSync(file(), { recursive: true }); // a directory cannot be unlinked as a file
    useKey();
    expect(removeCommandGrantsFile(home, keychain)).toEqual({ ok: false, reason: 'unwritable' });
    expect(keychain.entries.has(COMMAND_GRANTS_KEY_ACCOUNT)).toBe(true);
  });

  it('clears an unusable (short) key entry too, which is the recovery from it', () => {
    keychain.entries.set(COMMAND_GRANTS_KEY_ACCOUNT, Buffer.alloc(8).toString('base64'));
    expect(removeCommandGrantsFile(home, keychain)).toEqual({ ok: true, removed: false });
    expect(keychain.entries.size).toBe(0);
  });
});

describe('the key (ADR-0118 §2, failure modes, round 2)', () => {
  it('a 31-byte entry is not a key anywhere, nothing is regenerated over it, and 32 bytes is one', async () => {
    keychain.entries.set(COMMAND_GRANTS_KEY_ACCOUNT, Buffer.alloc(31, 1).toString('base64'));
    const stored = keychain.entries.get(COMMAND_GRANTS_KEY_ACCOUNT);
    const grants = store();
    expect(grants.matches(['npm', 'test'])).toBe(false);
    expect(grants.list()).toEqual({ ok: false, reason: 'no-key' });
    expect(grants.revoke(1)).toEqual({ ok: false, reason: 'no-key' });
    expect(grants.canRemember()).toEqual({ ok: false, reason: 'no-key' });
    expect(await grants.remember(['npm', 'test'])).toEqual({ ok: false, reason: 'no-key' });
    expect(keychain.entries.get(COMMAND_GRANTS_KEY_ACCOUNT), 'not overwritten').toBe(stored);
    expect(existsSync(file())).toBe(false);
    keychain.entries.set(COMMAND_GRANTS_KEY_ACCOUNT, Buffer.alloc(32, 1).toString('base64'));
    expect(await store().remember(['npm', 'test'])).toMatchObject({ ok: true });
  });

  it('a keychain that keeps only a truncated value is caught on the read-back: no grant is written', async () => {
    keychain.failure = 'truncates';
    expect(await store().remember(['npm', 'test'])).toEqual({ ok: false, reason: 'no-key' });
    expect(existsSync(file())).toBe(false);
  });

  it('revoke with no key yet is “no such grant”; with a locked keychain the key is checked BEFORE the file', () => {
    expect(store().revoke(1)).toEqual({ ok: false, reason: 'no-such-grant' });
    writeFile('not json\n');
    keychain.failure = 'throws';
    expect(store().revoke(1)).toEqual({ ok: false, reason: 'no-key' });
    expect(store().canRemember()).toEqual({ ok: false, reason: 'no-key' });
  });

  it('an unreadable file does not make remember generate a key it can never use', async () => {
    writeFile('not json\n');
    expect(await store().remember(['npm', 'test'])).toEqual({ ok: false, reason: 'unreadable' });
    expect(keychain.entries.size).toBe(0);
  });
});

describe('the strict shape of a line, and what is merely ignored', () => {
  it.each([
    ['an extra field on a grant', (r: Record<string, unknown>) => ({ ...r, extra: 1 })],
    ['a non-integer argument count', (r: Record<string, unknown>) => ({ ...r, args: 1.5 })],
    ['an argument count past the cap', (r: Record<string, unknown>) => ({ ...r, args: 100_001 })],
    ['an id with a slash', (r: Record<string, unknown>) => ({ ...r, id: 'a/b' })],
    ['an id that is not a string', (r: Record<string, unknown>) => ({ ...r, id: 7 })],
    ['a program with a path in it', (r: Record<string, unknown>) => ({ ...r, program: '/bin/ls' })],
    ['a missing mac', (r: Record<string, unknown>) => ({ ...r, mac: undefined })],
    ['a version other than 1', (r: Record<string, unknown>) => ({ ...r, v: 2 })],
  ])('%s makes the whole store unreadable', async (_what, edit) => {
    await store().remember(['npm', 'test']);
    const record = JSON.parse(nonEmptyLines()[0] ?? '{}') as Record<string, unknown>;
    appendFileSync(file(), `\n${JSON.stringify(edit(record))}\n`);
    expect(store().list()).toEqual({ ok: false, reason: 'unreadable' });
  });

  it.each([
    ['a tombstone with a free-text time', { v: 1, revoked: 'x', at: 'later' }],
    ['a tombstone with a bad id', { v: 1, revoked: 'a b', at: AT }],
    ['a tombstone with an extra field', { v: 1, revoked: 'x', at: AT, why: 'because' }],
  ])('%s makes the whole store unreadable', async (_what, line) => {
    await store().remember(['npm', 'test']);
    appendFileSync(file(), `\n${JSON.stringify(line)}\n`);
    expect(store().list()).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('the first record with an id wins: a later one cannot reuse it for another argv', () => {
    const key = useKey();
    const root = canonicalRoot(project);
    writeFile(
      `\n${grantLine(key, root, ['git', 'status'], 'same-id')}\n${grantLine(key, root, ['rm', '-rf', 'x'], 'same-id')}\n`,
    );
    const grants = store();
    expect(grants.matches(['git', 'status'])).toBe(true);
    expect(grants.matches(['rm', '-rf', 'x'])).toBe(false);
  });

  it('whitespace-only lines are free and carriage returns are tolerated', () => {
    const key = useKey();
    const line = grantLine(key, canonicalRoot(project), ['git', 'status'], 'crlf-1');
    writeFile(`\r\n   \r\n${line}\r\n\t\r\n`);
    expect(store().matches(['git', 'status'])).toBe(true);
  });

  it('a PATH lookup that rejects still remembers the grant, as an unnamed program', async () => {
    const grants = store(project, {
      findProgram: () => Promise.reject(new Error('PATH exploded')),
    });
    expect(await grants.remember(['npm', 'test'])).toMatchObject({ ok: true });
    const listed = grants.list();
    expect(listed.ok && listed.grants[0]?.program).toBe(UNNAMED_PROGRAM);
  });

  it('each distinct failure is reported once: a first failure does not use up the notice for a later one', () => {
    writeFile('not json\n');
    const grants = store();
    useKey();
    grants.matches(['a']);
    grants.matches(['a']);
    expect(messages).toHaveLength(1);
    writeFile(`\n${'x'.repeat(10)}\n`.replace('xxxxxxxxxx', '{"v":1}'));
    grants.matches(['a']);
    expect(messages).toHaveLength(2);
  });
});

describe('the write path does not trust the read that came before it', () => {
  it.skipIf(process.platform === 'win32')(
    'a symlink swapped in after the read is not written through, and a FIFO swapped in is not waited on',
    async () => {
      const target = join(home, 'elsewhere.txt');
      writeFileSync(target, '');
      await store().remember(['npm', 'test']);
      const swap = (replace: () => void) => ({
        // `newId` runs after the file was read and before it is appended to.
        newId: () => {
          rmSync(file());
          replace();
          return 'swapped';
        },
      });
      const linked = store(
        project,
        swap(() => symlinkSync(target, file())),
      );
      expect(await linked.remember(['git', 'status'])).toEqual({ ok: false, reason: 'unwritable' });
      expect(readFileSync(target, 'utf8'), 'nothing was written through the link').toBe('');
      rmSync(file());
      await store().remember(['npm', 'test']);
      const fifo = store(
        project,
        swap(() => execFileSync('mkfifo', [file()])),
      );
      const started = Date.now();
      expect(await fifo.remember(['git', 'status'])).toEqual({ ok: false, reason: 'unwritable' });
      expect(Date.now() - started, 'did not wait for a reader').toBeLessThan(2000);
    },
  );
});

describe('an unreadable path is never read as an empty store (round 2)', () => {
  it.skipIf(!CAN_REFUSE)(
    'a directory that cannot be inspected hides the file: list and revoke are unreadable, and --all is a failure, not “nothing to remove”',
    async () => {
      await store().remember(['npm', 'test']);
      chmodSync(dirname(file()), 0o000);
      try {
        expect(store().list()).toEqual({ ok: false, reason: 'unreadable' });
        expect(store().revoke(1)).toEqual({ ok: false, reason: 'unreadable' });
        expect(store().canRemember()).toEqual({ ok: false, reason: 'unreadable' });
        expect(removeCommandGrantsFile(home)).toEqual({ ok: false, reason: 'unwritable' });
      } finally {
        chmodSync(dirname(file()), 0o700);
      }
      expect(existsSync(file())).toBe(true);
    },
  );

  it('a directory at the path says to remove it by hand, not that --all does', () => {
    mkdirSync(file(), { recursive: true });
    store().list();
    expect(messages.join()).toContain('by hand');
    expect(messages.join()).not.toContain('revoke --all');
  });

  it.skipIf(process.platform === 'win32')(
    'a case-variant spelling of the project root shares its grants where the file system folds case',
    async () => {
      await store().remember(['npm', 'test']);
      // The last segment only: a symlink in the leading path (macOS /var) would be resolved and hide the difference.
      const variant = join(dirname(project), basename(project).replace(/^r/u, 'R'));
      if (!existsSync(variant) || lstatSync(variant).ino !== lstatSync(project).ino) return; // a case-sensitive file system
      expect(store(variant).matches(['npm', 'test'])).toBe(true);
    },
  );
});

describe('twins and the bounds together', () => {
  it('revoking a twinned grant needs a line for EACH twin: at the line bound it is refused, one line sooner it works', () => {
    const key = useKey();
    const root = canonicalRoot(project);
    const twins = [
      grantLine(key, root, ['npm', 'test'], 't-a'),
      grantLine(key, root, ['npm', 'test'], 't-b'),
    ];
    const filler2 = (count: number): string[] => Array.from({ length: count }, (_, i) => filler(i));
    writeFile(`\n${[...twins, ...filler2(COMMAND_GRANT_LIMITS.lines - 3)].join('\n')}\n`); // 8,191 lines
    expect(store().revoke(1)).toEqual({ ok: false, reason: 'full' });
    writeFile(`\n${[...twins, ...filler2(COMMAND_GRANT_LIMITS.lines - 4)].join('\n')}\n`); // 8,190 lines
    expect(store().revoke(1)).toMatchObject({ ok: true });
    expect(store().list()).toEqual({ ok: true, grants: [] });
  });

  it('revoking a twinned grant needs the tombstone BYTES for each twin', () => {
    const key = useKey();
    const root = canonicalRoot(project);
    const twins = `\n${grantLine(key, root, ['npm', 'test'], 't-a')}\n${grantLine(key, root, ['npm', 'test'], 't-b')}\n`;
    const pad = (size: number): string => twins + '\n'.repeat(size - Buffer.byteLength(twins));
    writeFile(pad(COMMAND_GRANT_LIMITS.bytes - 511));
    expect(store().revoke(1)).toEqual({ ok: false, reason: 'full' });
    writeFile(pad(COMMAND_GRANT_LIMITS.bytes - 512));
    expect(store().revoke(1)).toMatchObject({ ok: true });
  });
});
