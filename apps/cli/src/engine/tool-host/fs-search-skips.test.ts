import { readdirSync, rmSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeFsCapability } from './fs.js';

// MISC-2 (ADR-0142: a partial result is not an absence). A file inside the searched scope that the search reached and did not read
// is counted by its cause, and the result says `incomplete`, so the model is never told "no match" for a file it never searched.
// Binary and invalid UTF-8 files are the one cause that stays complete: the tool searches UTF-8 text, and counts the others.

const PER_FILE_CEILING = 1024 * 1024;

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'relavium-search-skips-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function capability() {
  return createNodeFsCapability({
    operatorHomeDir: root,
    tier: 'sandboxed',
    workspaceDir: root,
    readOnly: true,
  });
}

describe('search_files says what it did not read', () => {
  it('leaves a clean directory unchanged: every skip count is zero and the result is complete', async () => {
    await writeFile(join(root, 'a.txt'), 'needle here\n');
    await writeFile(join(root, 'b.txt'), 'nothing\n');
    const result = await capability().searchFiles?.('.', { pattern: 'needle' });
    expect(result?.matches.map((match) => match.path)).toEqual(['a.txt']);
    expect(result?.stats).toMatchObject({
      skippedBinary: 0,
      skippedOversize: 0,
      skippedHardLink: 0,
      skippedVanished: 0,
      skippedSymlink: 0,
      unreadable: 0,
      incomplete: false,
    });
    expect(result?.stats.limit).toBeUndefined();
  });

  it('counts an oversized text file, reports the result incomplete with no limit, and keeps searching the rest', async () => {
    // The needle sits in the file the search cannot read: "no match" there would be a claim about text it never saw.
    await writeFile(join(root, 'big.txt'), `${'x'.repeat(PER_FILE_CEILING)}\nneedle\n`);
    await writeFile(join(root, 'small.txt'), 'needle\n');
    const result = await capability().searchFiles?.('.', { pattern: 'needle' });
    expect(result?.matches.map((match) => match.path)).toEqual(['small.txt']);
    expect(result?.stats).toMatchObject({ skippedOversize: 1, incomplete: true });
    expect(result?.stats.limit, 'a skip is not a ceiling').toBeUndefined();
    expect(result?.stats.filesScanned, 'the walk went on past the skipped file').toBe(2);
  });

  it('counts each hard-linked file the jail refuses, and reports the result incomplete', async () => {
    await writeFile(join(root, 'original.txt'), 'needle\n');
    await link(join(root, 'original.txt'), join(root, 'alias.txt'));
    await writeFile(join(root, 'plain.txt'), 'needle\n');
    const result = await capability().searchFiles?.('.', { pattern: 'needle' });
    // Both names of the linked inode are refused; the file with one name is read.
    expect(result?.matches.map((match) => match.path)).toEqual(['plain.txt']);
    expect(result?.stats).toMatchObject({ skippedHardLink: 2, incomplete: true });
    expect(result?.stats.limit).toBeUndefined();
  });

  it('keeps a binary and an invalid UTF-8 file out of the partial verdict, and counts them', async () => {
    await writeFile(join(root, 'nul.bin'), Buffer.from('needle\0needle'));
    await writeFile(join(root, 'latin1.txt'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0xe9, 0x6c]));
    await writeFile(join(root, 'text.txt'), 'needle\n');
    const result = await capability().searchFiles?.('.', { pattern: 'needle' });
    expect(result?.matches.map((match) => match.path)).toEqual(['text.txt']);
    expect(result?.stats).toMatchObject({ skippedBinary: 2, incomplete: false });
  });

  it('reports a hard-linked file to find_files the same way: it is left out of the list, so the list is partial', async () => {
    await writeFile(join(root, 'original.txt'), 'x\n');
    await link(join(root, 'original.txt'), join(root, 'alias.txt'));
    await mkdir(join(root, 'dir'));
    await writeFile(join(root, 'dir', 'plain.txt'), 'x\n');
    const result = await capability().findFiles?.('.', { glob: '**/*.txt' });
    expect(result?.files.map((file) => file.path)).toEqual(['dir/plain.txt']);
    expect(result?.stats).toMatchObject({ skippedHardLink: 2, incomplete: true });
  });
});

// P1-1 (PR #102 review): an unreadable file or directory is a counted skip, never the end of the walk. A skip alone sets no `limit`
// and does not stop the search of the rest (built-in-tools.md). The permission tests are POSIX-only and cannot run as root, which
// reads a mode-000 file anyway. Several locked entries make the old stop observable whatever order the directory lists them in:
// stopping at the first would count exactly one.
const canLock = process.platform !== 'win32' && process.getuid?.() !== 0;
const LOCKED = 6;
const READABLE = 6;

async function lockAll(paths: readonly string[], mode = 0): Promise<() => Promise<void>> {
  for (const path of paths) await chmod(path, mode);
  return async () => {
    for (const path of paths) await chmod(path, 0o700);
  };
}

describe.skipIf(!canLock)('an unreadable entry is a counted skip, not the end of the walk', () => {
  it('search_files counts every unreadable file, reports incomplete with no limit, and still reads each readable sibling', async () => {
    const locked = Array.from({ length: LOCKED }, (_, i) => join(root, `a-locked-${i}.txt`));
    for (const path of locked) await writeFile(path, 'needle\n');
    for (let i = 0; i < READABLE; i++) await writeFile(join(root, `z-open-${i}.txt`), 'needle\n');
    const restore = await lockAll(locked);
    try {
      const result = await capability().searchFiles?.('.', { pattern: 'needle' });
      expect(result?.matches.map((match) => match.path).sort()).toEqual(
        Array.from({ length: READABLE }, (_, i) => `z-open-${i}.txt`),
      );
      expect(result?.stats).toMatchObject({
        unreadable: LOCKED,
        filesScanned: LOCKED + READABLE,
        incomplete: true,
      });
      expect(result?.stats.limit, 'a skip is not a ceiling').toBeUndefined();
    } finally {
      await restore();
    }
  });

  it('find_files counts every unreadable file and still lists each readable sibling', async () => {
    const locked = Array.from({ length: LOCKED }, (_, i) => join(root, `a-locked-${i}.txt`));
    for (const path of locked) await writeFile(path, 'x\n');
    for (let i = 0; i < READABLE; i++) await writeFile(join(root, `z-open-${i}.txt`), 'x\n');
    const restore = await lockAll(locked);
    try {
      const result = await capability().findFiles?.('.', { glob: '*.txt' });
      expect(result?.files.map((file) => file.path).sort()).toEqual(
        Array.from({ length: READABLE }, (_, i) => `z-open-${i}.txt`),
      );
      expect(result?.stats).toMatchObject({ unreadable: LOCKED, incomplete: true });
      expect(result?.stats.limit).toBeUndefined();
    } finally {
      await restore();
    }
  });

  it('search_files counts every unreadable directory and still walks each readable sibling directory', async () => {
    const locked = Array.from({ length: LOCKED }, (_, i) => join(root, `a-locked-${i}`));
    for (const path of locked) await mkdir(path);
    for (let i = 0; i < READABLE; i++) {
      await mkdir(join(root, `z-open-${i}`));
      await writeFile(join(root, `z-open-${i}`, 'f.txt'), 'needle\n');
    }
    const restore = await lockAll(locked);
    try {
      const result = await capability().searchFiles?.('.', { pattern: 'needle' });
      expect(result?.matches).toHaveLength(READABLE);
      expect(result?.stats).toMatchObject({ unreadable: LOCKED, incomplete: true });
      expect(
        result?.stats.limit,
        'a skip is not a ceiling, and an unreadable directory is no ignore rule',
      ).toBeUndefined();
    } finally {
      await restore();
    }
  });

  it('find_files counts every unreadable directory and still walks each readable sibling directory', async () => {
    const locked = Array.from({ length: LOCKED }, (_, i) => join(root, `a-locked-${i}`));
    for (const path of locked) await mkdir(path);
    for (let i = 0; i < READABLE; i++) {
      await mkdir(join(root, `z-open-${i}`));
      await writeFile(join(root, `z-open-${i}`, 'f.txt'), 'x\n');
    }
    const restore = await lockAll(locked);
    try {
      const result = await capability().findFiles?.('.', { glob: '**/*.txt' });
      expect(result?.files).toHaveLength(READABLE);
      expect(result?.stats).toMatchObject({ unreadable: LOCKED, incomplete: true });
      expect(result?.stats.limit).toBeUndefined();
    } finally {
      await restore();
    }
  });

  it.each([
    ['search_files', 'needle'],
    ['find_files', 'x'],
  ] as const)(
    '%s counts a directory it can search but not list, and still walks each sibling directory',
    async (tool, text) => {
      // Execute without read permission: the probe for a nested ignore file succeeds, so the failure is the directory open itself.
      const locked = Array.from({ length: LOCKED }, (_, i) => join(root, `a-locked-${i}`));
      for (const path of locked) await mkdir(path);
      for (let i = 0; i < READABLE; i++) {
        await mkdir(join(root, `z-open-${i}`));
        await writeFile(join(root, `z-open-${i}`, 'f.txt'), `${text}\n`);
      }
      const restore = await lockAll(locked, 0o100);
      try {
        const result =
          tool === 'search_files'
            ? await capability().searchFiles?.('.', { pattern: 'needle' })
            : await capability().findFiles?.('.', { glob: '**/*.txt' });
        const found = result !== undefined && 'matches' in result ? result.matches : result?.files;
        expect(found).toHaveLength(READABLE);
        expect(result?.stats).toMatchObject({ unreadable: LOCKED, incomplete: true });
        expect(result?.stats.limit).toBeUndefined();
      } finally {
        await restore();
      }
    },
  );

  it('keeps an unreadable file before a limit: the walk still stops at a real ceiling, and says which', async () => {
    // A skip must not hide the ceiling that is reached later: `limit` names the ceiling, the skip only adds to the partial verdict.
    const locked = join(root, 'a-locked.txt');
    await writeFile(locked, 'needle\n');
    for (let i = 0; i < 205; i++) await writeFile(join(root, `m${i}.txt`), 'needle\n');
    const restore = await lockAll([locked]);
    try {
      const result = await capability().searchFiles?.('.', { pattern: 'needle' });
      expect(result?.matches).toHaveLength(200);
      expect(result?.stats).toMatchObject({ incomplete: true, limit: 'matches' });
    } finally {
      await restore();
    }
  }, 30_000);
});

// P1-2 (PR #102 review): the walk never follows a directory symlink (built-in-tools.md), but a symlink it did not follow hides
// files it could have read, so it is counted and the result is incomplete. One count covers every link the walk passed over,
// whatever its target, so the count never says whether a target is outside the scope or protected. A link to a regular file
// inside the scope is read as a file and is not a skip.
describe.skipIf(process.platform === 'win32')(
  'a symlink the walk did not follow is counted',
  () => {
    async function outside(): Promise<string> {
      return realpath(await mkdtemp(join(tmpdir(), 'relavium-search-outside-')));
    }

    it('counts a symlinked directory inside the scope and reports the result incomplete', async () => {
      await mkdir(join(root, 'realdir'));
      await writeFile(join(root, 'realdir', 'visible.txt'), 'needle\n');
      await symlink(join(root, 'realdir'), join(root, 'inlink'), 'dir');
      const searched = await capability().searchFiles?.('.', { pattern: 'needle' });
      expect(searched?.matches.map((match) => match.path)).toEqual(['realdir/visible.txt']);
      expect(searched?.stats).toMatchObject({ skippedSymlink: 1, incomplete: true });
      expect(searched?.stats.limit, 'a skip is not a ceiling').toBeUndefined();
      const found = await capability().findFiles?.('.', { glob: '**/*.txt' });
      expect(found?.files.map((file) => file.path)).toEqual(['realdir/visible.txt']);
      expect(found?.stats).toMatchObject({ skippedSymlink: 1, incomplete: true });
    });

    it('counts a symlink whose target is outside the scope, for a directory and for a file, and reads nothing through it', async () => {
      const elsewhere = await outside();
      try {
        await mkdir(join(elsewhere, 'outdir'));
        await writeFile(join(elsewhere, 'outdir', 'secret.txt'), 'needle\n');
        await writeFile(join(elsewhere, 'outfile.txt'), 'needle\n');
        await symlink(join(elsewhere, 'outdir'), join(root, 'linkdir'), 'dir');
        await symlink(join(elsewhere, 'outfile.txt'), join(root, 'linkfile.txt'), 'file');
        await writeFile(join(root, 'plain.txt'), 'needle\n');
        const result = await capability().searchFiles?.('.', { pattern: 'needle' });
        expect(result?.matches.map((match) => match.path)).toEqual(['plain.txt']);
        expect(result?.stats).toMatchObject({ skippedSymlink: 2, incomplete: true });
        expect(JSON.stringify(result)).not.toContain(elsewhere);
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    });

    it('counts a symlink to a protected directory the same way and does not say it is protected', async () => {
      const elsewhere = await outside();
      try {
        await mkdir(join(elsewhere, '.ssh'));
        await writeFile(join(elsewhere, '.ssh', 'id_test'), 'needle\n');
        await symlink(join(elsewhere, '.ssh'), join(root, 'keys'), 'dir');
        const result = await capability().searchFiles?.('.', { pattern: 'needle' });
        expect(result?.matches).toEqual([]);
        expect(result?.stats).toMatchObject({ skippedSymlink: 1, incomplete: true });
        expect(JSON.stringify(result)).not.toMatch(/ssh|protected|confidential/i);
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    });

    it('counts a symlink to a protected directory inside the scope the same way, and does not say it is protected', async () => {
      // The target is in the scope, so only the confidentiality floor keeps it unread; the count is the one a plain directory link gets.
      await mkdir(join(root, '.ssh'));
      await writeFile(join(root, '.ssh', 'id_test'), 'needle\n');
      await symlink(join(root, '.ssh'), join(root, 'keys'), 'dir');
      const result = await capability().searchFiles?.('.', { pattern: 'needle' });
      expect(result?.matches).toEqual([]);
      expect(result?.stats).toMatchObject({ skippedSymlink: 1, incomplete: true });
      expect(JSON.stringify(result)).not.toMatch(/ssh|protected|confidential/i);
    });

    it('counts a symlinked directory even when the glob would not match its name', async () => {
      // The link is named `pkg`, the glob asks for `.ts` files: the files behind the link are what the glob is about.
      await mkdir(join(root, 'real'));
      await writeFile(join(root, 'real', 'a.ts'), 'needle\n');
      await symlink(join(root, 'real'), join(root, 'pkg'), 'dir');
      const result = await capability().searchFiles?.('.', { pattern: 'needle', glob: '**/*.ts' });
      expect(result?.matches.map((match) => match.path)).toEqual(['real/a.ts']);
      expect(result?.stats).toMatchObject({ skippedSymlink: 1, incomplete: true });
    });

    it('counts a link to an out-of-scope file even when the glob excludes its name: the target is never examined', async () => {
      // The host does not stat a target outside the scope to learn that it is a file the glob would not have wanted.
      const elsewhere = await outside();
      try {
        await writeFile(join(elsewhere, 'note.md'), 'needle\n');
        await symlink(join(elsewhere, 'note.md'), join(root, 'note.md'), 'file');
        await writeFile(join(root, 'plain.txt'), 'needle\n');
        const result = await capability().searchFiles?.('.', {
          pattern: 'needle',
          glob: '**/*.txt',
        });
        expect(result?.matches.map((match) => match.path)).toEqual(['plain.txt']);
        expect(result?.stats).toMatchObject({ skippedSymlink: 1, incomplete: true });
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    });

    it('does not count a link to a regular file inside the scope: it is read as a file', async () => {
      await writeFile(join(root, 'target.txt'), 'needle\n');
      await symlink(join(root, 'target.txt'), join(root, 'alias.txt'), 'file');
      const result = await capability().searchFiles?.('.', { pattern: 'needle' });
      expect(result?.matches.map((match) => match.path).sort()).toEqual([
        'alias.txt',
        'target.txt',
      ]);
      expect(result?.stats).toMatchObject({ skippedSymlink: 0, incomplete: false });
    });

    it('does not count a symlink the ignore rules hide, or a link a glob excludes that points at a file', async () => {
      await mkdir(join(root, 'real'));
      await writeFile(join(root, 'real', 'a.txt'), 'needle\n');
      await symlink(join(root, 'real'), join(root, 'hidden'), 'dir');
      await writeFile(join(root, '.gitignore'), 'hidden\n');
      await writeFile(join(root, 'target.txt'), 'needle\n');
      await symlink(join(root, 'target.txt'), join(root, 'skipped.md'), 'file');
      const result = await capability().searchFiles?.('.', { pattern: 'needle', glob: '**/*.txt' });
      expect(result?.matches.map((match) => match.path).sort()).toEqual([
        'real/a.txt',
        'target.txt',
      ]);
      expect(result?.stats).toMatchObject({ skippedSymlink: 0, incomplete: false });
    });
  },
);

// An entry that is listed and gone by the time it is opened is "vanished", not "unreadable": the cause is named by its errno (ENOENT),
// so the model can tell a race from a permission problem. The cancellation signal is polled between the walk's steps, so removing the
// entry from inside one poll opens the window deterministically; every poll position is tried, and none may fail the call.
describe('an entry that vanishes during the walk is a counted skip', () => {
  const SIBLING_BYTES = 'needle\n'.length;
  function removingSignal(target: string, at: number) {
    const controller = new AbortController();
    let polls = 0;
    return {
      get aborted(): boolean {
        if (++polls === at) rmSync(target, { recursive: true, force: true });
        return false;
      },
      addEventListener: controller.signal.addEventListener.bind(controller.signal),
      removeEventListener: controller.signal.removeEventListener.bind(controller.signal),
    };
  }

  for (const kind of ['file', 'directory'] as const) {
    it(`counts a ${kind} removed after it was listed as vanished, never unreadable, and never hides its siblings`, async () => {
      let vanished = 0;
      for (let at = 1; at <= 40; at++) {
        const dir = await mkdtemp(join(root, 'run-'));
        await writeFile(join(dir, 'z.txt'), 'needle\n');
        // Three directories: the one the walk enters first is the one removed, so the others are only walked if a vanished
        // directory does not end the walk (the stack pops the last one listed first).
        for (const name of ['sub0', 'sub1', 'sub2']) {
          await mkdir(join(dir, name));
          await writeFile(join(dir, name, 'a.txt'), 'needle\n');
        }
        const subs = readdirSync(dir).filter((name) => name.startsWith('sub'));
        const gone = subs[subs.length - 1] ?? '';
        const target = kind === 'file' ? join(dir, gone, 'a.txt') : join(dir, gone);
        const fs = createNodeFsCapability({
          operatorHomeDir: root,
          tier: 'sandboxed',
          workspaceDir: root,
          readOnly: true,
        });
        const result = await fs.searchFiles?.(
          dir,
          { pattern: 'needle' },
          removingSignal(target, at),
        );
        const paths = result?.matches.map((match) => match.path) ?? [];
        // Whatever was removed, the sibling file and the directories that were not removed are always read.
        const expected = [
          'z.txt',
          ...subs.filter((name) => name !== gone).map((name) => `${name}/a.txt`),
        ];
        for (const path of expected) {
          expect(
            paths.some((found) => found.endsWith(path)),
            `poll ${at}: ${path}`,
          ).toBe(true);
        }
        // A removed entry the walk never read cannot be "unreadable": it is gone, and its errno says so. (A file that is
        // unlinked while its bytes are being read fails the read's own consistency check: another cause, and unreadable.)
        if (result?.stats.bytesScanned === SIBLING_BYTES * expected.length)
          expect(result.stats.unreadable, `poll ${at}`).toBe(0);
        if (result?.stats.skippedVanished === 1) {
          vanished++;
          expect(result.stats.incomplete).toBe(true);
          expect(result.stats.limit).toBeUndefined();
        }
      }
      expect(vanished, 'some poll position lands between the listing and the open').toBeGreaterThan(
        0,
      );
    }, 30_000);
  }

  it.skipIf(process.platform === 'win32')(
    'counts a dangling symlink as a link the walk did not follow',
    async () => {
      await symlink(join(root, 'missing'), join(root, 'dangling'), 'file');
      await writeFile(join(root, 'plain.txt'), 'needle\n');
      const result = await capability().searchFiles?.('.', { pattern: 'needle' });
      expect(result?.matches.map((match) => match.path)).toEqual(['plain.txt']);
      expect(result?.stats).toMatchObject({ skippedSymlink: 1, unreadable: 0, incomplete: true });
    },
  );
});
