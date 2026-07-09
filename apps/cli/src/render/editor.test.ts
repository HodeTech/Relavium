import { describe, expect, it } from 'vitest';

import {
  openInEditor,
  parseEditorCommand,
  resolveEditor,
  type EditorExit,
  type OpenInEditorDeps,
  type TempDocument,
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
});
