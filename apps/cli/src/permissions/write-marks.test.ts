import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import {
  COMMAND_GRANT_LIMITS,
  COMMAND_GRANTS_KEY_ACCOUNT,
  commandGrantsPath,
  createCommandGrantStore,
  removeCommandGrantsFile,
  type CommandGrantStore,
} from './command-grants.js';
import {
  COMMAND_WRITE_MARKS_FILE,
  WRITE_MARK_LIMITS,
  latestWriteMark,
  markMac,
  readWriteMarks,
  recordWriteMark,
  removeWriteMarks,
} from './write-marks.js';

/** ADR-0138: the write marks. The module over a real temp directory, then the store that uses it over an in-memory keychain. */
class FakeKeychain implements KeychainStore {
  readonly entries = new Map<string, string>();
  failure: 'none' | 'throws' = 'none';
  get(account: string): string | null {
    if (this.failure === 'throws') throw new KeychainUnavailableError('locked');
    return this.entries.get(account) ?? null;
  }
  set(account: string, secret: string): void {
    if (this.failure === 'throws') throw new KeychainUnavailableError('locked');
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
let messages: string[];
let counter = 0;
let clock = Date.parse('2026-11-21T10:00:00.000Z');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'relavium-marks-home-'));
  project = mkdtempSync(join(tmpdir(), 'relavium-marks-project-'));
  other = mkdtempSync(join(tmpdir(), 'relavium-marks-other-'));
  keychain = new FakeKeychain();
  messages = [];
  counter = 0;
  clock = Date.parse('2026-11-21T10:00:00.000Z');
});
afterEach(() => {
  for (const directory of [home, project, other])
    rmSync(directory, { recursive: true, force: true });
});

const CAN_REFUSE = process.platform !== 'win32' && process.getuid?.() !== 0;
const KEY = Buffer.alloc(32, 7);
const ROOT_A = 'a'.repeat(64);
const ROOT_B = 'b'.repeat(64);
const at = (ms: number): Date => new Date(ms);
const marksFile = (): string => join(dirname(commandGrantsPath(home)), COMMAND_WRITE_MARKS_FILE);

describe('the write-mark file', () => {
  it('is absent until a write is recorded, then holds one authenticated mark per root, owner-only', () => {
    expect(readWriteMarks(marksFile(), KEY)).toEqual({ kind: 'absent' });
    expect(recordWriteMark(marksFile(), KEY, ROOT_A, at(clock))).toEqual({ ok: true });
    const read = readWriteMarks(marksFile(), KEY);
    expect(read.kind).toBe('ready');
    if (read.kind !== 'ready') throw new Error('unreachable');
    expect(read.marks).toHaveLength(1);
    expect(read.marks[0]).toMatchObject({
      root: ROOT_A,
      at: new Date(clock).toISOString(),
      ms: clock,
    });
    expect(read.marks[0]?.mac).toBe(markMac(KEY, ROOT_A, new Date(clock).toISOString()));
    if (process.platform !== 'win32') expect(statSync(marksFile()).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(marksFile())).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps every root’s mark, moves one forward, and never moves one backwards (a clock set back keeps the later mark)', () => {
    recordWriteMark(marksFile(), KEY, ROOT_A, at(clock));
    recordWriteMark(marksFile(), KEY, ROOT_B, at(clock + 1000));
    recordWriteMark(marksFile(), KEY, ROOT_A, at(clock + 5000));
    let read = readWriteMarks(marksFile(), KEY);
    if (read.kind !== 'ready') throw new Error('unreadable');
    expect(latestWriteMark(read.marks, ROOT_A)).toBe(clock + 5000);
    expect(latestWriteMark(read.marks, ROOT_B)).toBe(clock + 1000);
    recordWriteMark(marksFile(), KEY, ROOT_A, at(clock - 60_000));
    read = readWriteMarks(marksFile(), KEY);
    if (read.kind !== 'ready') throw new Error('unreadable');
    expect(latestWriteMark(read.marks, ROOT_A)).toBe(clock + 5000);
    expect(read.marks).toHaveLength(2);
  });

  it('drops the oldest root past the bound, not the newest', () => {
    for (let index = 0; index < WRITE_MARK_LIMITS.roots + 3; index += 1) {
      const root = index.toString(16).padStart(64, '0');
      expect(recordWriteMark(marksFile(), KEY, root, at(clock + index * 1000)).ok).toBe(true);
    }
    const read = readWriteMarks(marksFile(), KEY);
    if (read.kind !== 'ready') throw new Error('unreadable');
    expect(read.marks).toHaveLength(WRITE_MARK_LIMITS.roots);
    const newest = (WRITE_MARK_LIMITS.roots + 2).toString(16).padStart(64, '0');
    expect(latestWriteMark(read.marks, newest)).toBeDefined();
    expect(latestWriteMark(read.marks, (0).toString(16).padStart(64, '0'))).toBeUndefined();
  });

  it('ignores a mark that was not made with this key (forged or from an overwritten key), without making the file unreadable', () => {
    recordWriteMark(marksFile(), KEY, ROOT_A, at(clock));
    const forged = JSON.parse(readFileSync(marksFile(), 'utf8')) as {
      v: number;
      marks: { root: string; at: string; mac: string }[];
    };
    forged.marks.push({ root: ROOT_B, at: new Date(clock).toISOString(), mac: 'c'.repeat(64) });
    writeFileSync(marksFile(), JSON.stringify(forged));
    const read = readWriteMarks(marksFile(), KEY);
    if (read.kind !== 'ready') throw new Error('unreadable');
    expect(latestWriteMark(read.marks, ROOT_A)).toBe(clock);
    expect(latestWriteMark(read.marks, ROOT_B)).toBeUndefined();
    // Under another key nothing verifies at all.
    const stranger = readWriteMarks(marksFile(), Buffer.alloc(32, 9));
    expect(stranger.kind === 'ready' && stranger.marks.length === 0).toBe(true);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a different shape', JSON.stringify({ v: 2, marks: [] })],
    ['an extra field', JSON.stringify({ v: 1, marks: [], extra: true })],
    [
      'a mark with an extra field',
      JSON.stringify({
        v: 1,
        marks: [{ root: ROOT_A, at: '2026-11-21T10:00:00Z', mac: ROOT_B, x: 1 }],
      }),
    ],
    [
      'a time that is not a time',
      JSON.stringify({ v: 1, marks: [{ root: ROOT_A, at: '2026-13-45T99:00:00Z', mac: ROOT_B }] }),
    ],
  ])('reads %s as unreadable, and a record refuses to overwrite it', (_name, content) => {
    mkdirSync(dirname(marksFile()), { recursive: true });
    writeFileSync(marksFile(), content);
    expect(readWriteMarks(marksFile(), KEY).kind).toBe('unreadable');
    expect(recordWriteMark(marksFile(), KEY, ROOT_A, at(clock))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    expect(readFileSync(marksFile(), 'utf8')).toBe(content);
  });

  it('refuses a file over the size bound', () => {
    mkdirSync(dirname(marksFile()), { recursive: true });
    writeFileSync(marksFile(), ' '.repeat(WRITE_MARK_LIMITS.bytes + 1));
    expect(readWriteMarks(marksFile(), KEY)).toMatchObject({
      kind: 'unreadable',
      why: 'it is larger than the size bound',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symbolic link at the path, reads and writes, and writes nothing through it',
    () => {
      mkdirSync(dirname(marksFile()), { recursive: true });
      const target = join(other, 'target.json');
      writeFileSync(target, '{"v":1,"marks":[]}');
      symlinkSync(target, marksFile());
      expect(readWriteMarks(marksFile(), KEY)).toMatchObject({
        kind: 'unreadable',
        why: 'it is a symbolic link',
      });
      expect(recordWriteMark(marksFile(), KEY, ROOT_A, at(clock)).ok).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('{"v":1,"marks":[]}');
    },
  );

  it('refuses a directory at the path', () => {
    mkdirSync(marksFile(), { recursive: true });
    expect(readWriteMarks(marksFile(), KEY)).toMatchObject({
      kind: 'unreadable',
      why: 'it is a directory',
    });
  });

  it.skipIf(!CAN_REFUSE)(
    'says unwritable, and leaves no sibling behind, when the directory cannot be written',
    () => {
      mkdirSync(dirname(marksFile()), { recursive: true });
      chmodSync(dirname(marksFile()), 0o500);
      try {
        expect(recordWriteMark(marksFile(), KEY, ROOT_A, at(clock))).toEqual({
          ok: false,
          reason: 'unwritable',
        });
      } finally {
        chmodSync(dirname(marksFile()), 0o700);
      }
      expect(readdirSync(dirname(marksFile()))).toEqual([]);
    },
  );

  it('removeWriteMarks reports true when there is nothing to remove and when it removed the file', () => {
    expect(removeWriteMarks(marksFile())).toBe(true);
    recordWriteMark(marksFile(), KEY, ROOT_A, at(clock));
    expect(existsSync(marksFile())).toBe(true);
    expect(removeWriteMarks(marksFile())).toBe(true);
    expect(existsSync(marksFile())).toBe(false);
  });
});

function store(root: string): CommandGrantStore {
  return createCommandGrantStore({
    homeDir: home,
    projectRoot: root,
    keychain,
    notify: (message) => messages.push(message),
    now: () => new Date(clock),
    newId: () => `grant-${String(++counter)}`,
    findProgram: (name) => Promise.resolve(name === 'npm' ? '/usr/bin/npm' : undefined),
  });
}

const TEST = ['npm', 'test'];

describe('a remembered grant against the writes recorded for its project (ADR-0138)', () => {
  it('stands, with no write recorded, and is `none` for a command nobody remembered', async () => {
    const grants = store(project);
    expect(grants.standing(TEST)).toBe('none');
    await grants.remember(TEST);
    expect(grants.standing(TEST)).toBe('fresh');
    expect(grants.standing(['npm', 'run', 'build'])).toBe('none');
    expect(grants.standing([])).toBe('none');
  });

  it('recording a write before any key exists writes no file and creates no key: there is no grant to protect', () => {
    const grants = store(project);
    expect(grants.noteFileWrite()).toBe(true);
    expect(existsSync(marksFile())).toBe(false);
    expect(keychain.entries.size).toBe(0);
  });

  it('a write recorded AFTER the grant outdates it (`matches` still says it is remembered); one BEFORE it does not; the same instant does', async () => {
    const grants = store(project);
    clock += 1000;
    expect(grants.noteFileWrite()).toBe(true); // before any grant: no key yet, nothing recorded
    await grants.remember(TEST);
    expect(grants.standing(TEST)).toBe('fresh');
    clock += 1000;
    expect(grants.noteFileWrite()).toBe(true);
    expect(grants.standing(TEST)).toBe('stale');
    expect(grants.matches(TEST)).toBe(true);
    // A grant made after the write stands again; one made at the very instant of the write does not (a strictly later time is needed).
    const sameInstant = store(project);
    await sameInstant.remember(['npm', 'ci']);
    expect(sameInstant.noteFileWrite()).toBe(true);
    expect(sameInstant.standing(['npm', 'ci'])).toBe('stale');
    clock += 1000;
    await sameInstant.remember(['npm', 'run', 'x']);
    expect(sameInstant.standing(['npm', 'run', 'x'])).toBe('fresh');
  });

  it('another project’s write does not outdate this project’s grant, and the mark survives a new store (a new chat)', async () => {
    await store(project).remember(TEST);
    clock += 1000;
    expect(store(other).noteFileWrite()).toBe(true);
    expect(store(project).standing(TEST)).toBe('fresh');
    expect(store(project).noteFileWrite()).toBe(true);
    expect(store(project).standing(TEST)).toBe('stale');
  });

  it('Remember on an outdated grant renews it: a new record, one grant in the list, both records withdrawn together', async () => {
    const grants = store(project);
    const first = await grants.remember(TEST);
    clock += 1000;
    grants.noteFileWrite();
    expect(grants.standing(TEST)).toBe('stale');
    clock += 1000;
    const renewed = await grants.remember(TEST);
    expect(renewed).toMatchObject({ ok: true, alreadyRemembered: false });
    expect(renewed.ok && first.ok && renewed.id !== first.id).toBe(true);
    expect(grants.standing(TEST)).toBe('fresh');
    const listed = grants.list();
    expect(listed.ok && listed.grants).toHaveLength(1);
    expect(listed.ok && listed.grants[0]?.grantedAt).toBe(new Date(clock).toISOString());
    const revoked = grants.revoke(1);
    expect(revoked.ok && revoked.ids).toHaveLength(2);
    expect(grants.standing(TEST)).toBe('none');
  });

  it('a root at its grant bound can still RENEW a grant (a twin adds no grant), while a new command there is refused as full', async () => {
    const grants = store(project);
    for (let index = 0; index < COMMAND_GRANT_LIMITS.perRoot; index += 1) {
      expect(await grants.remember(['npm', 'run', String(index)])).toMatchObject({ ok: true });
    }
    expect(await grants.remember(['npm', 'run', 'one-too-many'])).toEqual({
      ok: false,
      reason: 'full',
    });
    clock += 1000;
    grants.noteFileWrite();
    expect(grants.standing(['npm', 'run', '0'])).toBe('stale');
    clock += 1000;
    expect(await grants.remember(['npm', 'run', '0'])).toMatchObject({
      ok: true,
      alreadyRemembered: false,
    });
    expect(grants.standing(['npm', 'run', '0'])).toBe('fresh');
  });

  it('a write applied while the keychain is unavailable still outdates the grants made before it: recorded keyless, once told (security sitting)', async () => {
    const grants = store(project);
    await grants.remember(TEST);
    clock += 1000;
    keychain.failure = 'throws'; // locked: no key, so no root digest and no MAC can be made
    const lockedChat = store(project);
    expect(lockedChat.noteFileWrite()).toBe(true);
    expect(messages.filter((message) => message.includes('without the keychain'))).toHaveLength(1);
    const recorded = JSON.parse(readFileSync(marksFile(), 'utf8')) as { unkeyed?: string };
    expect(recorded.unkeyed).toBe(new Date(clock).toISOString());
    keychain.failure = 'none';
    // The keychain answers again: the grant verifies, and it is older than the keyless write.
    expect(store(project).standing(TEST)).toBe('stale');
    // A grant made after the write stands; another project's grants made before it are outdated too (the write has no root).
    clock += 1000;
    await store(project).remember(['npm', 'ci']);
    expect(store(project).standing(['npm', 'ci'])).toBe('fresh');
    await store(other).remember(TEST); // made after: fresh
    expect(store(other).standing(TEST)).toBe('fresh');
  });

  it('a keyless write that cannot be recorded says so and returns false; an unreadable file is not replaced', () => {
    keychain.failure = 'throws';
    mkdirSync(dirname(marksFile()), { recursive: true });
    writeFileSync(marksFile(), 'garbage');
    expect(store(project).noteFileWrite()).toBe(false);
    expect(readFileSync(marksFile(), 'utf8')).toBe('garbage');
    expect(messages.some((message) => message.includes('cannot be read'))).toBe(true);
  });

  it('a rewrite keeps the entries it cannot verify (another key’s), so a chat with an old key cannot erase what a newer key wrote', () => {
    const foreignKey = Buffer.alloc(32, 3);
    recordWriteMark(marksFile(), foreignKey, ROOT_B, at(clock + 5000));
    recordWriteMark(marksFile(), KEY, ROOT_A, at(clock));
    const file = JSON.parse(readFileSync(marksFile(), 'utf8')) as {
      marks: { root: string; mac: string }[];
    };
    expect(file.marks.map((mark) => mark.root).sort()).toEqual([ROOT_A, ROOT_B].sort());
    expect(file.marks.find((mark) => mark.root === ROOT_B)?.mac).toBe(
      markMac(foreignKey, ROOT_B, new Date(clock + 5000).toISOString()),
    );
    // ...and the entry that does not verify under KEY is still only ignored when read with KEY.
    const read = readWriteMarks(marksFile(), KEY);
    expect(read.kind === 'ready' && latestWriteMark(read.marks, ROOT_B)).toBe(undefined);
  });

  it('a chat that cached a key the keychain has since replaced signs its mark with the current key', async () => {
    const chatA = store(project);
    await chatA.remember(['npm', 'ci']);
    expect(chatA.matches(['npm', 'ci'])).toBe(true); // chat A now holds key K1
    removeCommandGrantsFile(home, keychain); // another terminal: `revoke --all`
    const chatB = store(project);
    await chatB.remember(TEST); // creates K2
    expect(store(project).standing(TEST)).toBe('fresh');
    clock += 1000;
    // Chat A is the only one that writes a file: it must sign under K2, the key in the keychain now, or nothing verifies its mark.
    expect(chatA.noteFileWrite()).toBe(true);
    expect(store(project).standing(TEST)).toBe('stale');
  });

  it('`revoke --all` that cannot remove the grants leaves the marks that outdate them', async () => {
    const grants = store(project);
    await grants.remember(TEST);
    clock += 1000;
    grants.noteFileWrite();
    expect(grants.standing(TEST)).toBe('stale');
    // A directory where the grants file should be: the removal fails, the way an immutable file would.
    rmSync(commandGrantsPath(home), { force: true });
    mkdirSync(commandGrantsPath(home));
    expect(removeCommandGrantsFile(home, keychain)).toEqual({ ok: false, reason: 'unwritable' });
    expect(existsSync(marksFile())).toBe(true);
    expect(keychain.entries.has(COMMAND_GRANTS_KEY_ACCOUNT)).toBe(true);
  });

  it('Remember is not offered while the marks file cannot be read: a record added then could not make anything fresh', async () => {
    const grants = store(project);
    await grants.remember(TEST);
    expect(grants.canRemember()).toEqual({ ok: true });
    writeFileSync(marksFile(), 'garbage');
    expect(grants.canRemember()).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('the card’s gate lets a grant at the per-root bound be RENEWED, and still refuses a new command there', async () => {
    const grants = store(project);
    for (let index = 0; index < COMMAND_GRANT_LIMITS.perRoot; index += 1) {
      await grants.remember(['npm', 'run', String(index)]);
    }
    expect(grants.canRemember(['npm', 'run', 'new'])).toEqual({ ok: false, reason: 'full' });
    expect(grants.canRemember()).toEqual({ ok: false, reason: 'full' });
    expect(grants.canRemember(['npm', 'run', '0'])).toEqual({ ok: true });
  });

  it('Remember over a grant that nothing can renew (the marks cannot be read) is refused, not reported as remembered', async () => {
    const grants = store(project);
    await grants.remember(TEST);
    writeFileSync(marksFile(), 'garbage');
    const lines = (): number =>
      readFileSync(commandGrantsPath(home), 'utf8')
        .split('\n')
        .filter((line) => line !== '').length;
    const before = lines();
    expect(await grants.remember(TEST)).toEqual({ ok: false, reason: 'unreadable' });
    expect(lines()).toBe(before);
  });

  it('a reset keychain (the key is gone, the file is not) says on `list` that records were ignored, instead of an empty list', async () => {
    await store(project).remember(TEST);
    keychain.entries.delete(COMMAND_GRANTS_KEY_ACCOUNT);
    const listed = store(project).list();
    expect(listed).toEqual({ ok: true, grants: [], ignored: 1 });
    expect(messages.some((message) => message.includes('not made with this installation'))).toBe(
      true,
    );
  });

  it('Remember on a grant that stands is reported, not duplicated', async () => {
    const grants = store(project);
    await grants.remember(TEST);
    const again = await grants.remember(TEST);
    expect(again).toMatchObject({ ok: true, alreadyRemembered: true });
    const lines = readFileSync(commandGrantsPath(home), 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    expect(lines).toHaveLength(1);
  });

  it('a mark file that cannot be read makes every grant stale, tells so once, and is never overwritten', async () => {
    const grants = store(project);
    await grants.remember(TEST);
    writeFileSync(marksFile(), 'garbage');
    expect(grants.standing(TEST)).toBe('stale');
    expect(grants.standing(TEST)).toBe('stale');
    expect(messages.filter((message) => message.includes('write-mark file'))).toHaveLength(1);
    expect(grants.noteFileWrite()).toBe(false);
    expect(readFileSync(marksFile(), 'utf8')).toBe('garbage');
    expect(messages.some((message) => message.includes('cannot be read'))).toBe(true);
  });

  it('a mark made under another key is ignored: the grant stands (nothing the forger can add makes a command run unasked)', async () => {
    const grants = store(project);
    await grants.remember(TEST);
    clock += 1000;
    recordWriteMark(marksFile(), Buffer.alloc(32, 1), 'f'.repeat(64), at(clock));
    expect(grants.standing(TEST)).toBe('fresh');
  });

  it('`revoke --all` removes the marks with the grants and the key', async () => {
    const grants = store(project);
    await grants.remember(TEST);
    clock += 1000;
    grants.noteFileWrite();
    expect(existsSync(marksFile())).toBe(true);
    expect(removeCommandGrantsFile(home, keychain)).toEqual({ ok: true, removed: true });
    expect(existsSync(marksFile())).toBe(false);
    expect(keychain.entries.has(COMMAND_GRANTS_KEY_ACCOUNT)).toBe(false);
  });

  it('a Remember reads the keychain afresh: a key another process cleared is regenerated, and the grant matches in a new process', async () => {
    const grants = store(project);
    await grants.remember(TEST);
    expect(grants.matches(TEST)).toBe(true); // the key is now cached in this store
    // Another process ran `revoke --all`: the file and the key are gone.
    removeCommandGrantsFile(home, keychain);
    expect(keychain.entries.has(COMMAND_GRANTS_KEY_ACCOUNT)).toBe(false);
    const written = await grants.remember(['npm', 'ci']);
    expect(written).toMatchObject({ ok: true, alreadyRemembered: false });
    // A grant reported as remembered must be one the next process can verify.
    expect(store(project).matches(['npm', 'ci'])).toBe(true);
  });
});
