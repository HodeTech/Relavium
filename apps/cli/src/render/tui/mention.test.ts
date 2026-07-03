import { describe, expect, it } from 'vitest';

import type { FsCapability } from '@relavium/core';

import {
  createMentionReader,
  estimateTokens,
  foldMentionKey,
  formatMentionInjection,
  mentionOpensAt,
  visibleMentions,
  type MentionState,
} from './mention.js';

const CANDIDATES = [
  { name: 'src', type: 'directory' as const, path: 'src' },
  { name: 'app.ts', type: 'file' as const, path: 'app.ts' },
  { name: 'README.md', type: 'file' as const, path: 'README.md' },
];
const STATE: MentionState = {
  dir: '',
  filter: '',
  candidates: CANDIDATES,
  selected: 0,
  loading: false,
};

describe('@-mention completion model (2.5.D step 4)', () => {
  it('visibleMentions filters by a case-insensitive substring of the name', () => {
    expect(visibleMentions(STATE)).toEqual(CANDIDATES); // no filter ⇒ all
    expect(visibleMentions({ ...STATE, filter: 'READ' }).map((c) => c.name)).toEqual(['README.md']);
    expect(visibleMentions({ ...STATE, filter: 'zz' })).toEqual([]);
  });

  it('foldMentionKey: arrows move (clamped), Enter/Tab accept a file or descend a dir', () => {
    expect(foldMentionKey('', { downArrow: true }, STATE)).toEqual({
      kind: 'state',
      state: { ...STATE, selected: 1 },
    });
    expect(foldMentionKey('', { upArrow: true }, STATE)).toEqual({
      kind: 'state',
      state: { ...STATE, selected: 0 },
    }); // clamp at 0
    expect(foldMentionKey('', { return: true }, STATE)).toEqual({ kind: 'descend', dir: 'src' }); // selected=0 is the dir
    expect(foldMentionKey('', { tab: true }, { ...STATE, selected: 1 })).toEqual({
      kind: 'accept',
      path: 'app.ts',
    }); // a file
    expect(foldMentionKey('/', {}, STATE)).toEqual({ kind: 'descend', dir: 'src' }); // '/' descends the selected dir
  });

  it('foldMentionKey: filter edits, backspace trims / closes, Esc closes, multi-char paste dropped', () => {
    expect(foldMentionKey('a', {}, STATE)).toEqual({
      kind: 'state',
      state: { ...STATE, filter: 'a', selected: 0 },
    });
    expect(foldMentionKey('', { backspace: true }, { ...STATE, filter: 'ab' })).toEqual({
      kind: 'state',
      state: { ...STATE, filter: 'a', selected: 0 },
    });
    // Backspace PAST the filter deletes the '@' — restore nothing.
    expect(foldMentionKey('', { backspace: true }, STATE)).toEqual({ kind: 'close', restore: '' });
    // Esc restores the literal keystrokes ('@' + filter) so nothing typed is silently eaten.
    expect(foldMentionKey('', { escape: true }, STATE)).toEqual({ kind: 'close', restore: '@' });
    expect(foldMentionKey('', { escape: true }, { ...STATE, filter: 'sr' })).toEqual({
      kind: 'close',
      restore: '@sr',
    });
    expect(foldMentionKey('pasted blob', {}, STATE)).toEqual({ kind: 'state', state: STATE }); // multi-char ⇒ dropped
    expect(foldMentionKey('😀', {}, STATE)).toEqual({
      kind: 'state',
      state: { ...STATE, filter: '😀', selected: 0 },
    }); // a single astral code point still extends
  });

  it('accepts nothing (closes, restoring the keystrokes) when the filtered list is empty', () => {
    expect(foldMentionKey('', { return: true }, { ...STATE, filter: 'zz' })).toEqual({
      kind: 'close',
      restore: '@zz',
    });
  });

  it('mentionOpensAt: `@` opens only at a word boundary (start or after whitespace), else stays literal', () => {
    expect(mentionOpensAt('', 0)).toBe(true); // start of buffer
    expect(mentionOpensAt('hi ', 3)).toBe(true); // right after a space
    expect(mentionOpensAt('a\nb\n', 4)).toBe(true); // right after a newline
    expect(mentionOpensAt('foo', 3)).toBe(false); // mid-word (email/handle) ⇒ literal '@'
    expect(mentionOpensAt('foo', 0)).toBe(true); // cursor at start, text follows
    expect(mentionOpensAt('x', 99)).toBe(false); // clamped/past-end cursor ⇒ charAt('') ⇒ not whitespace
  });

  it('estimateTokens is a ~4-bytes/token heuristic; formatMentionInjection frames untrusted content + safe path', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(401)).toBe(101);
    const out = formatMentionInjection('src/a"b<c>.ts', 'const x = 1;');
    expect(out).toBe('\n\n<file path="src/abc.ts">\nconst x = 1;\n</file>'); // quotes/angle-brackets stripped from the path
    expect(out).toContain('const x = 1;'); // content verbatim
    // A crafted filename (POSIX allows a newline) can neither break the attribute nor forge a second frame — the
    // control chars AND the framing chars are stripped from the path; the content is left verbatim (untrusted data).
    const crafted = formatMentionInjection('a\n<file path="fake">\nb', 'legit');
    expect(crafted).toBe('\n\n<file path="afile path=fakeb">\nlegit\n</file>');
  });
});

describe('createMentionReader — over the FsCapability jail (2.5.D step 4)', () => {
  const fsMock = (
    entriesByDir: Record<string, { name: string; type: 'file' | 'directory' }[]>,
    files: Record<string, string>,
  ): FsCapability => ({
    readFile: (path) =>
      Promise.resolve({
        content: files[path] ?? '',
        mimeType: 'text/plain',
        sizeBytes: (files[path] ?? '').length,
        lastModified: '',
      }),
    writeFile: () => Promise.reject(new Error('read-only')),
    listDirectory: (dir) =>
      Promise.resolve({
        entries: (entriesByDir[dir] ?? []).map((e) => ({ ...e, sizeBytes: 0, lastModified: '' })),
      }),
  });

  it('list skips noise dirs, sorts dirs-first then by name, and builds workspace-relative paths', async () => {
    const reader = createMentionReader(
      fsMock(
        {
          '.': [
            { name: 'node_modules', type: 'directory' }, // noise ⇒ dropped
            { name: 'src', type: 'directory' },
            { name: 'b.ts', type: 'file' },
            { name: 'Alpha', type: 'directory' },
          ],
        },
        {},
      ),
    );
    const out = await reader.list('');
    expect(out.map((c) => c.name)).toEqual(['Alpha', 'src', 'b.ts']); // dirs first (alpha-sorted), then files
    expect(out.find((c) => c.name === 'src')?.path).toBe('src');
  });

  it('list of a subdir builds nested paths; read goes through fs.readFile (jail/floor/binary enforced there)', async () => {
    const reader = createMentionReader(
      fsMock({ src: [{ name: 'app.ts', type: 'file' }] }, { 'src/app.ts': 'hello' }),
    );
    const listed = await reader.list('src');
    expect(listed).toEqual([{ name: 'app.ts', type: 'file', path: 'src/app.ts' }]);
    expect(await reader.read('src/app.ts')).toEqual({ content: 'hello', sizeBytes: 5 });
  });
});
