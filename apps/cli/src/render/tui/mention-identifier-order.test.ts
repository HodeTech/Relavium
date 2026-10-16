import type { FsCapability } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import { createMentionReader, foldMentionKey, type MentionState } from './mention.js';

const ENTRIES: ReadonlyArray<{ name: string; type: 'file' | 'directory' }> = [
  { name: 'Z.ts', type: 'file' },
  { name: 'Z', type: 'directory' },
  { name: 'tie', type: 'directory' },
  { name: 'tie.ts', type: 'file' },
  { name: 'aB.ts', type: 'file' },
  { name: 'a_b', type: 'directory' },
  { name: 'Tie', type: 'directory' },
  { name: 'Tie.ts', type: 'file' },
  { name: 'A-b.ts', type: 'file' },
  { name: 'aB', type: 'directory' },
  { name: 'a_b.ts', type: 'file' },
  { name: 'A-b', type: 'directory' },
  { name: 'ä.ts', type: 'file' },
  { name: 'ä', type: 'directory' },
  { name: 'node_modules', type: 'directory' },
  { name: 'dist', type: 'directory' },
  { name: 'ignored-dir', type: 'directory' },
  { name: 'ignored.txt', type: 'file' },
  { name: 'hidden.txt', type: 'file' },
];

function fsFixture(): FsCapability {
  return {
    readFile: (path) => {
      const content =
        path === '.gitignore' ? 'ignored*\n' : path === '.relaviumignore' ? 'hidden*\n' : '';
      return Promise.resolve({
        content,
        mimeType: 'text/plain',
        sizeBytes: content.length,
        lastModified: '',
      });
    },
    writeFile: () => Promise.reject(new Error('mention fixture is read-only')),
    listDirectory: () =>
      Promise.resolve({
        entries: ENTRIES.map((entry) => ({ ...entry, sizeBytes: 0, lastModified: '' })),
      }),
  };
}

describe('actual mention reader folded identifier ordering', () => {
  for (const dir of ['', 'src/lib']) {
    it(`[MENTION-IDENTIFIERS] ${dir || 'root'} preserves type groups, folded casing, stable ties and parent priority`, async () => {
      const reader = createMentionReader(fsFixture());
      const collation = vi.spyOn(String.prototype, 'localeCompare');
      try {
        const candidates = await reader.list(dir);
        const ordinary = dir === '' ? candidates : candidates.slice(1);
        expect(
          ordinary.map(({ name }) => name),
          '[MENTION-FOLDED-ORDINAL] actual reader retains raw names and incoming folded ties',
        ).toEqual([
          'A-b',
          'a_b',
          'aB',
          'tie',
          'Tie',
          'Z',
          'ä',
          'A-b.ts',
          'a_b.ts',
          'aB.ts',
          'tie.ts',
          'Tie.ts',
          'Z.ts',
          'ä.ts',
        ]);
        expect(ordinary.map(({ type }) => type)).toEqual([
          'directory',
          'directory',
          'directory',
          'directory',
          'directory',
          'directory',
          'directory',
          'file',
          'file',
          'file',
          'file',
          'file',
          'file',
          'file',
        ]);
        expect(ordinary.map(({ path }) => path)).toEqual(
          dir === ''
            ? [
                'A-b',
                'a_b',
                'aB',
                'tie',
                'Tie',
                'Z',
                'ä',
                'A-b.ts',
                'a_b.ts',
                'aB.ts',
                'tie.ts',
                'Tie.ts',
                'Z.ts',
                'ä.ts',
              ]
            : [
                'src/lib/A-b',
                'src/lib/a_b',
                'src/lib/aB',
                'src/lib/tie',
                'src/lib/Tie',
                'src/lib/Z',
                'src/lib/ä',
                'src/lib/A-b.ts',
                'src/lib/a_b.ts',
                'src/lib/aB.ts',
                'src/lib/tie.ts',
                'src/lib/Tie.ts',
                'src/lib/Z.ts',
                'src/lib/ä.ts',
              ],
        );
        if (dir === '') expect(candidates.some(({ name }) => name === '..')).toBe(false);
        else
          expect(
            candidates[0],
            '[MENTION-PARENT] synthetic parent precedes every normal candidate',
          ).toEqual({ name: '..', type: 'directory', path: 'src' });
        expect(
          collation,
          '[MENTION-NO-AMBIENT] case folding does not reintroduce ambient collation',
        ).not.toHaveBeenCalled();
        const state: MentionState = {
          dir,
          filter: '',
          candidates: ordinary,
          selected: 0,
          loading: false,
        };
        expect(foldMentionKey('', { return: true }, state)).toEqual({
          kind: 'descend',
          dir: dir === '' ? 'A-b' : 'src/lib/A-b',
        });
        expect(foldMentionKey('', { tab: true }, { ...state, selected: 7 })).toEqual({
          kind: 'accept',
          path: dir === '' ? 'A-b.ts' : 'src/lib/A-b.ts',
        });
      } finally {
        collation.mockRestore();
      }
    });
  }
});
