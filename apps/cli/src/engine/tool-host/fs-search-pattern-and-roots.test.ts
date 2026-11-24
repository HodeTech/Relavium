import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeFsCapability, FsCapabilityError } from './fs.js';

// Two edges of the search tools that the skip tests do not reach: a pattern the line-by-line scan could never match (P1-8), and a
// scan of a granted root, which no workspace ignore rule governs (P2, PR #102 review).

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'relavium-search-edges-')));
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

describe('search_files refuses a pattern with a line break (the scan is per line)', () => {
  it.each([
    ['LF', 'alpha\nbeta'],
    ['CRLF', 'alpha\r\nbeta'],
    ['lone CR', 'alpha\rbeta'],
    ['a trailing LF', 'alpha\n'],
  ])('refuses %s with a fixed sentence, before the walk reads anything', async (_name, pattern) => {
    // The file does hold the two lines: the old result was a complete-looking "no match" for text that is there.
    await writeFile(join(root, 'a.txt'), 'alpha\nbeta\n');
    const error = await capability()
      .searchFiles?.('.', { pattern })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(error).toBeInstanceOf(FsCapabilityError);
    const message = error instanceof Error ? error.message : '';
    expect(message).toMatch(/line break.*one line at a time/);
    expect(message, 'the pattern is the model own text and is not echoed').not.toContain('alpha');
  });

  it('still searches a single line that holds the first half of the refused pattern', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha\nbeta\n');
    const result = await capability().searchFiles?.('.', { pattern: 'alpha' });
    expect(result?.matches.map((match) => match.line)).toEqual([1]);
    expect(result?.stats.incomplete).toBe(false);
  });

  it('does not touch find_files, whose glob has no line semantics', async () => {
    await writeFile(join(root, 'a.txt'), 'x\n');
    const result = await capability().findFiles?.('.', { glob: '*.txt' });
    expect(result?.files.map((file) => file.path)).toEqual(['a.txt']);
  });
});

describe('a workspace ignore file does not govern the scan of a granted root', () => {
  async function scenario(corrupt: () => Promise<void>) {
    const workspace = join(root, 'workspace');
    const extra = join(root, 'extra');
    await Promise.all([mkdir(workspace), mkdir(extra)]);
    await writeFile(join(workspace, 'inside.txt'), 'needle\n');
    await writeFile(join(extra, 'granted.txt'), 'needle\n');
    await corrupt();
    return {
      extra,
      fs: createNodeFsCapability({
        operatorHomeDir: root,
        tier: 'project',
        workspaceDir: workspace,
        extraRoots: [extra],
        readOnly: true,
      }),
    };
  }

  it.each(['.gitignore', '.relaviumignore'])(
    'scans the granted root completely though the workspace %s uses syntax the host cannot apply',
    async (name) => {
      const { fs, extra } = await scenario(async () => {
        // A character class is unsupported ignore syntax: a workspace scan cannot be called complete under it.
        await writeFile(join(root, 'workspace', name), '[ab]\n');
      });
      const searched = await fs.searchFiles?.(extra, { pattern: 'needle' });
      expect(searched?.matches).toHaveLength(1);
      expect(searched?.stats).toMatchObject({ incomplete: false, unreadable: 0 });
      expect(searched?.stats.limit).toBeUndefined();
      const found = await fs.findFiles?.(extra, { glob: '*.txt' });
      expect(found?.files).toHaveLength(1);
      expect(found?.stats).toMatchObject({ incomplete: false, unreadable: 0 });
    },
  );

  it.each(['.gitignore', '.relaviumignore'])(
    'scans the granted root completely though the workspace %s is a dangling link',
    async (name) => {
      const { fs, extra } = await scenario(async () => {
        await symlink(
          join(root, 'workspace', 'missing-ignore'),
          join(root, 'workspace', name),
          process.platform === 'win32' ? 'junction' : 'file',
        );
      });
      const searched = await fs.searchFiles?.(extra, { pattern: 'needle' });
      expect(searched?.matches).toHaveLength(1);
      expect(searched?.stats).toMatchObject({ incomplete: false, unreadable: 0 });
    },
  );

  it.each(['.gitignore', '.relaviumignore'])(
    'still ends a scan of the workspace itself on the same unsupported %s',
    async (name) => {
      const { fs } = await scenario(async () => {
        await writeFile(join(root, 'workspace', name), '[ab]\n');
      });
      const searched = await fs.searchFiles?.('.', { pattern: 'needle' });
      expect(searched?.stats).toMatchObject({ incomplete: true, limit: 'ignore' });
      const found = await fs.findFiles?.('.', { glob: '*.txt' });
      expect(found?.stats).toMatchObject({ incomplete: true, limit: 'ignore' });
    },
  );

  it('keeps applying the workspace rules to a workspace subdirectory (the ignore file is still loaded)', async () => {
    const { fs } = await scenario(async () => {
      await writeFile(join(root, 'workspace', '.gitignore'), 'hidden.txt\n');
      await writeFile(join(root, 'workspace', 'hidden.txt'), 'needle\n');
    });
    const searched = await fs.searchFiles?.('.', { pattern: 'needle' });
    expect(searched?.matches.map((match) => match.path)).toEqual(['inside.txt']);
    expect(searched?.stats.incomplete).toBe(false);
  });
});
