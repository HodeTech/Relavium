import { existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/** A switchable `writeFile` fault, so the "a partial write must not strand the conversation" path is driven for real
 *  (an ENOSPC/EIO cannot be provoked portably). Everything else in `node:fs/promises` stays real. */
const fsFault = vi.hoisted(() => ({
  writeFileError: undefined as Error | undefined,
  rmError: undefined as Error | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (fsFault.writeFileError !== undefined) throw fsFault.writeFileError;
      return actual.writeFile(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (fsFault.rmError !== undefined) throw fsFault.rmError;
      return actual.rm(...args);
    },
  };
});

import {
  nodeCreateTempDocument,
  openInEditor,
  parseEditorCommand,
  resolveEditor,
  type EditorExit,
  type OpenInEditorDeps,
  type TempDocument,
  disposePendingTempDirs,
  pendingTempDirCount,
} from './editor.js';

/**
 * The `$EDITOR` hatch (2.6.F Step 5d, ADR-0068 §e). The load-bearing properties: the temp file holding the
 * conversation is removed on EVERY path, nothing is spawned (and no file written) when no editor is configured,
 * `$EDITOR` is tokenized WITHOUT a shell, and no fault escapes as a raw throw.
 */

describe('parseEditorCommand — tokenize WITHOUT a shell', () => {
  it('splits a bare command and its flags', () => {
    expect(parseEditorCommand('vim')).toEqual({ command: 'vim', args: [] });
    expect(parseEditorCommand('code -w')).toEqual({ command: 'code', args: ['-w'] });
    expect(parseEditorCommand('  subl   --wait  ')).toEqual({ command: 'subl', args: ['--wait'] });
  });

  it('honours quoting so a path with spaces survives', () => {
    expect(parseEditorCommand('"/Applications/My Editor/bin/ed" -n')).toEqual({
      command: '/Applications/My Editor/bin/ed',
      args: ['-n'],
    });
    expect(parseEditorCommand("'/opt/my ed' --wait")).toEqual({
      command: '/opt/my ed',
      args: ['--wait'],
    });
  });

  it('SECURITY: shell metacharacters are inert literal TOKENS, never operators (spawn runs with shell:false)', () => {
    // If this were handed to a shell, `; rm -rf ~` would execute. Tokenized, `;` is just an argv string that the
    // editor will treat as a filename — and the editor is the user's own $EDITOR anyway.
    expect(parseEditorCommand('vim; rm -rf ~')).toEqual({
      command: 'vim;',
      args: ['rm', '-rf', '~'],
    });
    expect(parseEditorCommand('vim $(whoami)')).toEqual({ command: 'vim', args: ['$(whoami)'] });
    expect(parseEditorCommand('vim | tee /etc/passwd')).toEqual({
      command: 'vim',
      args: ['|', 'tee', '/etc/passwd'],
    });
  });

  it('returns undefined for a blank / whitespace-only / empty-quoted value', () => {
    expect(parseEditorCommand('')).toBeUndefined();
    expect(parseEditorCommand('   ')).toBeUndefined();
    expect(parseEditorCommand('""')).toBeUndefined(); // an empty command is not a command
  });
});

describe('resolveEditor — $VISUAL wins over $EDITOR', () => {
  it('prefers VISUAL (the full-screen editor — we are handing over a full screen)', () => {
    expect(resolveEditor({ VISUAL: 'code -w', EDITOR: 'vi' })).toEqual({
      command: 'code',
      args: ['-w'],
    });
  });

  it('falls back to EDITOR when VISUAL is unset or blank', () => {
    expect(resolveEditor({ EDITOR: 'nano' })).toEqual({ command: 'nano', args: [] });
    expect(resolveEditor({ VISUAL: '   ', EDITOR: 'nano' })).toEqual({
      command: 'nano',
      args: [],
    });
  });

  it('returns undefined when NEITHER is set — never falls back to `vi` (an unexitable trap for a novice)', () => {
    expect(resolveEditor({})).toBeUndefined();
    expect(resolveEditor({ VISUAL: '', EDITOR: '' })).toBeUndefined();
  });
});

/** A recording harness: every disposal + spawn is traced so the cleanup contract is asserted on each path. */
const harness = (
  over: Partial<OpenInEditorDeps> & { exit?: EditorExit; spawnThrows?: Error } = {},
): { deps: OpenInEditorDeps; trace: string[] } => {
  const trace: string[] = [];
  const document: TempDocument = {
    path: '/tmp/relavium-transcript-xyz/transcript.md',
    dispose: () => {
      trace.push('dispose');
      return Promise.resolve();
    },
  };
  const deps: OpenInEditorDeps = {
    env: { EDITOR: 'vim' },
    createTempDocument: (contents) => {
      trace.push(`temp:${contents.length}`);
      return Promise.resolve(document);
    },
    spawnEditor: (command, args, file) => {
      trace.push(`spawn:${command} ${[...args, file].join(' ')}`);
      if (over.spawnThrows !== undefined) return Promise.reject(over.spawnThrows);
      return Promise.resolve(over.exit ?? { code: 0, signal: null });
    },
    ...over,
  };
  return { deps, trace };
};

describe('openInEditor', () => {
  it('writes the transcript, spawns the editor with the FILE appended, and disposes the temp file', async () => {
    const { deps, trace } = harness();
    await expect(openInEditor(deps, 'hello')).resolves.toEqual({ kind: 'closed', exitCode: 0 });
    expect(trace).toEqual([
      'temp:5',
      'spawn:vim /tmp/relavium-transcript-xyz/transcript.md',
      'dispose',
    ]);
  });

  it('passes the configured FLAGS before the file (so `code -w <file>` waits)', async () => {
    const { deps, trace } = harness({ env: { VISUAL: 'code -w' } });
    await openInEditor(deps, 'x');
    expect(trace[1]).toBe('spawn:code -w /tmp/relavium-transcript-xyz/transcript.md');
  });

  it('NO editor configured ⇒ `unavailable`, and NOTHING is spawned or written to disk', async () => {
    const { deps, trace } = harness({ env: {} });
    await expect(openInEditor(deps, 'hello')).resolves.toEqual({ kind: 'unavailable' });
    expect(trace).toEqual([]); // the conversation never touched the filesystem
  });

  it('a non-zero editor exit is still `closed` (the user’s editor failed, not us)', async () => {
    const { deps, trace } = harness({ exit: { code: 1, signal: null } });
    await expect(openInEditor(deps, 'x')).resolves.toEqual({ kind: 'closed', exitCode: 1 });
    expect(trace).toContain('dispose');
  });

  it('the editor cannot be STARTED ⇒ `failed` (never a raw throw), and the temp file is STILL disposed', async () => {
    const { deps, trace } = harness({ spawnThrows: new Error('ENOENT') });
    await expect(openInEditor(deps, 'x')).resolves.toEqual({
      kind: 'failed',
      message: 'could not start vim',
    });
    expect(trace).toContain('dispose'); // the conversation is not left on disk
  });

  it('the editor is KILLED by a signal ⇒ `failed`, and the temp file is STILL disposed', async () => {
    const { deps, trace } = harness({ exit: { code: null, signal: 'SIGKILL' } });
    await expect(openInEditor(deps, 'x')).resolves.toEqual({
      kind: 'failed',
      message: 'vim was terminated by SIGKILL',
    });
    expect(trace).toContain('dispose');
  });

  it('a temp-file creation fault ⇒ `failed`, nothing spawned, nothing to dispose', async () => {
    const { deps, trace } = harness({
      createTempDocument: () => Promise.reject(new Error('EACCES')),
    });
    await expect(openInEditor(deps, 'x')).resolves.toEqual({
      kind: 'failed',
      message: 'could not create a temporary file for the transcript',
    });
    expect(trace).toEqual([]);
  });

  it('a THROWING disposer cannot turn a successful edit into a failure', async () => {
    const { deps } = harness({
      createTempDocument: () =>
        Promise.resolve({
          path: '/tmp/x/transcript.md',
          dispose: () => Promise.reject(new Error('EBUSY')),
        }),
    });
    await expect(openInEditor(deps, 'x')).resolves.toEqual({ kind: 'closed', exitCode: 0 });
  });

  it('SECURITY: a failed disposal is REPORTED with its path — a leaked transcript is never silently retained', async () => {
    // The Step-5d-2 Sonnet review: `.catch(() => undefined)` was the one teardown in the codebase that swallowed its
    // own failure, and the one whose whole job is keeping the conversation off disk (Windows EBUSY/EPERM).
    const reported: { path: string; error: unknown }[] = [];
    const boom = new Error('EBUSY');
    const { deps } = harness({
      onDisposeFailed: (path, error) => reported.push({ path, error }),
      createTempDocument: () =>
        Promise.resolve({
          path: '/tmp/relavium-transcript-abc/transcript.md',
          dispose: () => Promise.reject(boom),
        }),
    });
    await expect(openInEditor(deps, 'x')).resolves.toEqual({ kind: 'closed', exitCode: 0 });
    expect(reported).toEqual([{ path: '/tmp/relavium-transcript-abc/transcript.md', error: boom }]);
  });

  it('reports a failed disposal even when the EDITOR itself failed (both faults surface, neither masks the other)', async () => {
    const reported: string[] = [];
    const { deps } = harness({
      spawnThrows: new Error('ENOENT'),
      onDisposeFailed: (path) => reported.push(path),
      createTempDocument: () =>
        Promise.resolve({ path: '/tmp/x/t.md', dispose: () => Promise.reject(new Error('EBUSY')) }),
    });
    await expect(openInEditor(deps, 'x')).resolves.toEqual({
      kind: 'failed',
      message: 'could not start vim',
    });
    expect(reported).toEqual(['/tmp/x/t.md']);
  });
});

/**
 * `nodeCreateTempDocument` — the real filesystem adapter. It is tested against the real disk because the properties
 * that matter (permissions, and the hard-exit net) are properties of the OS, not of our orchestration.
 */
/** The transcript directories currently in the OS temp dir — compared as a BEFORE/AFTER diff, never absolutely
 *  (the temp dir is shared with other test files, other vitest workers, and stale runs). */
const transcriptDirs = (): string[] =>
  readdirSync(tmpdir()).filter((name) => name.startsWith('relavium-transcript-'));

describe('nodeCreateTempDocument — the private temp document + its hard-exit net', () => {
  it('writes a 0600 file inside a 0700 private directory', async () => {
    const doc = await nodeCreateTempDocument('the conversation');
    try {
      expect(existsSync(doc.path)).toBe(true);
      expect(statSync(doc.path).mode & 0o777).toBe(0o600); // owner-only: it holds the conversation
      expect(statSync(dirname(doc.path)).mode & 0o777).toBe(0o700);
    } finally {
      await doc.dispose();
    }
  });

  it('dispose removes the WHOLE directory (any editor swap/backup file with it) and drops it from the pending set', async () => {
    const pendingBefore = pendingTempDirCount();
    const doc = await nodeCreateTempDocument('x');
    expect(pendingTempDirCount()).toBe(pendingBefore + 1); // pending while the file lives
    const dir = dirname(doc.path);
    await doc.dispose();
    expect(existsSync(dir)).toBe(false);
    expect(pendingTempDirCount()).toBe(pendingBefore); // …and reclaimed after
  });

  it('the exit net is ONE process listener, however many documents are open', async () => {
    // A listener PER document only ever came off on a SUCCESSFUL `rm` — which it must, since a failing `rm` is
    // exactly when the last-ditch net is needed. On a host where cleanup persistently fails (an AV scanner holding
    // every new file), that accumulated one listener per `/edit` until Node printed a `MaxListenersExceededWarning`
    // onto the alt buffer (Step-6h Sonnet review). Reproduced at five.
    const before = process.listenerCount('exit');
    const docs = await Promise.all([
      nodeCreateTempDocument('a'),
      nodeCreateTempDocument('b'),
      nodeCreateTempDocument('c'),
    ]);
    expect(process.listenerCount('exit')).toBeLessThanOrEqual(before + 1);
    await Promise.all(docs.map((d) => d.dispose()));
    expect(process.listenerCount('exit')).toBeLessThanOrEqual(before + 1);
  });

  it('a FAILING dispose keeps the directory PENDING, and the one exit net reclaims every one of them', async () => {
    const doc1 = await nodeCreateTempDocument('conversation one');
    const doc2 = await nodeCreateTempDocument('conversation two');
    const dirs = [dirname(doc1.path), dirname(doc2.path)];
    const pendingBefore = pendingTempDirCount();

    fsFault.rmError = new Error('EBUSY: resource busy or locked');
    try {
      await expect(doc1.dispose()).rejects.toThrow('EBUSY');
      await expect(doc2.dispose()).rejects.toThrow('EBUSY');
    } finally {
      fsFault.rmError = undefined;
    }
    expect(pendingTempDirCount()).toBe(pendingBefore); // both still pending
    for (const dir of dirs) expect(existsSync(dir)).toBe(true);

    disposePendingTempDirs(); // what the single `'exit'` listener runs
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);
    expect(pendingTempDirCount()).toBe(0);
  });

  it('SECURITY: a FAILED write whose reclaim SUCCEEDS leaves no directory and nothing pending', async () => {
    // The Step-5d-3 Opus review: `mkdtemp` created the private dir and `writeFile` flushed the transcript, and an
    // ENOSPC/EIO mid-write must not leave that directory — holding part of the conversation — on disk.
    const dirsBefore = transcriptDirs();
    const pendingBefore = pendingTempDirCount();
    fsFault.writeFileError = new Error('ENOSPC: no space left on device');
    try {
      await expect(nodeCreateTempDocument('the whole conversation')).rejects.toThrow('ENOSPC');
    } finally {
      fsFault.writeFileError = undefined;
    }
    // No NEW directory, and nothing left in the pending set. A before/after DIFF, never an absolute scan: the OS temp
    // dir is shared with other test files, other vitest workers, and stale runs.
    expect(transcriptDirs().filter((name) => !dirsBefore.includes(name))).toEqual([]);
    expect(pendingTempDirCount()).toBe(pendingBefore);
  });

  it('SECURITY: a FAILED write whose reclaim ALSO fails keeps the dir PENDING and rethrows the WRITE error', async () => {
    // The Step-6h Sonnet finding: registering only AFTER the write meant a write-then-failed-rmSync left the directory
    // with nothing to reclaim it, and a throwing rmSync would MASK the write error. Now the dir is registered first, so
    // the exit net still covers it, and the write error — not the removal error — is what the caller classifies.
    const pendingBefore = pendingTempDirCount();
    fsFault.writeFileError = new Error('EIO: i/o error');
    fsFault.rmError = new Error('EBUSY: resource busy or locked');
    try {
      await expect(nodeCreateTempDocument('the whole conversation')).rejects.toThrow('EIO'); // NOT 'EBUSY'
      expect(pendingTempDirCount()).toBe(pendingBefore + 1); // still registered for the exit net
    } finally {
      fsFault.writeFileError = undefined;
      fsFault.rmError = undefined;
    }
    disposePendingTempDirs(); // the exit net's reclaim — now that rm works again
    expect(pendingTempDirCount()).toBe(0);
  });

  it('SECURITY: the exit net reclaims the transcript on a HARD process.exit() — the path the async finally never runs on', async () => {
    // The Step-5d-2 Sonnet review's critical finding: during a suspension ink has raw mode OFF, so a keyboard Ctrl-C
    // is delivered as a REAL SIGINT to the foreground group; the surface's second-press `process.exit()` halts the
    // event loop while `openInEditor` still awaits the child, so its `async finally` never disposes. Only a
    // synchronous `'exit'` listener can still reclaim the directory. Here we invoke exactly that listener.
    const doc = await nodeCreateTempDocument('the whole conversation');
    const dir = dirname(doc.path);
    expect(existsSync(dir)).toBe(true);

    disposePendingTempDirs(); // exactly what the single `'exit'` listener runs

    expect(existsSync(dir)).toBe(false); // the conversation is NOT left in the OS temp directory
    await doc.dispose(); // idempotent (`force: true`), and it clears the (already-empty) pending entry
    expect(pendingTempDirCount()).toBe(0);
  });
});

/**
 * The temp document's LAST-DITCH cleanup (2.6.F Step 6g, whole-phase Opus review). The file holds the whole
 * conversation. `dispose()` used to remove the `process.on('exit')` net in a `finally`, so a failing `rm` — a Windows
 * `EBUSY` from an AV scanner, an editor that has not released its handle — disarmed the very net that existed for
 * that case, and the transcript survived the process.
 */
describe('nodeCreateTempDocument — the pending set outlives a failing dispose', () => {
  it('a SUCCESSFUL dispose reclaims the directory and clears it from the pending set', async () => {
    const before = pendingTempDirCount();
    const doc = await nodeCreateTempDocument('hello');
    expect(pendingTempDirCount()).toBe(before + 1);
    expect(existsSync(doc.path)).toBe(true);

    await doc.dispose();
    expect(pendingTempDirCount()).toBe(before);
    expect(existsSync(doc.path)).toBe(false);
  });

  it('a FAILING dispose rethrows and keeps it PENDING — the conversation gets one more chance', async () => {
    const before = pendingTempDirCount();
    const doc = await nodeCreateTempDocument('secret conversation');
    fsFault.rmError = new Error('EBUSY');
    try {
      await expect(doc.dispose()).rejects.toThrow('EBUSY');
      expect(pendingTempDirCount()).toBe(before + 1); // still pending
      expect(existsSync(doc.path)).toBe(true); // …and the file is still there, which is exactly why
    } finally {
      fsFault.rmError = undefined;
    }

    await doc.dispose(); // the retry succeeds
    expect(pendingTempDirCount()).toBe(before);
    expect(existsSync(doc.path)).toBe(false);
  });

  it('the file is 0600 inside a 0700 directory', async () => {
    const doc = await nodeCreateTempDocument('hello');
    try {
      expect(statSync(doc.path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(doc.path)).mode & 0o777).toBe(0o700);
    } finally {
      await doc.dispose();
    }
  });
});

/**
 * `openInEditor` NEVER THROWS — its whole contract is to classify every fault into an `EditorOutcome`, because the
 * caller runs it inside a terminal suspension where a rejection strands the terminal (2.6.F Step 6h, Sonnet review).
 */
describe('openInEditor — the cleanup block cannot break the never-throws contract', () => {
  it('a THROWING onDisposeFailed does not override the classified outcome', async () => {
    const outcome = await openInEditor(
      {
        env: { EDITOR: 'true' },
        spawnEditor: () => Promise.resolve({ code: 0, signal: null }),
        createTempDocument: () =>
          Promise.resolve({
            path: '/tmp/relavium-x/transcript.md',
            dispose: () => Promise.reject(new Error('EBUSY')),
          }),
        onDisposeFailed: () => {
          throw new Error('the reporter itself is broken');
        },
      },
      'the whole conversation',
    );
    // Without the guard, the `finally`'s rejection replaces this and `openInEditor` rejects — inside a suspension.
    expect(outcome).toEqual({ kind: 'closed', exitCode: 0 });
  });

  it('a failing dispose is still REPORTED when the reporter behaves', async () => {
    const reported: unknown[] = [];
    const outcome = await openInEditor(
      {
        env: { EDITOR: 'true' },
        spawnEditor: () => Promise.resolve({ code: 0, signal: null }),
        createTempDocument: () =>
          Promise.resolve({
            path: '/tmp/relavium-x/transcript.md',
            dispose: () => Promise.reject(new Error('EBUSY')),
          }),
        onDisposeFailed: (path, error) => reported.push([path, String(error)]),
      },
      'the whole conversation',
    );
    expect(outcome.kind).toBe('closed');
    expect(reported).toHaveLength(1);
  });
});
