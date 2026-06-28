import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolUnavailableError } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNodeFsCapability, FsCapabilityError, type NodeFsCapabilityConfig } from './fs.js';

/**
 * The node `fs` capability is the 2.5.A security surface — the tests are heavy on the JAIL: traversal,
 * symlink escapes (component and final), the read-only fail-close, and the bounded glob/list walks.
 */

let workspace: string; // a realpath'd temp workspace (so the jail's realpath checks compare cleanly)
let outside: string; // a sibling dir OUTSIDE the workspace — the escape target

beforeEach(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'relavium-fs-')));
  workspace = join(base, 'workspace');
  outside = join(base, 'outside');
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  // Clean up the realpath'd base (the parent of both workspace + outside).
  await rm(join(workspace, '..'), { recursive: true, force: true }).catch(() => undefined);
});

function sandboxed(over: Partial<NodeFsCapabilityConfig> = {}): ReturnType<typeof createNodeFsCapability> {
  return createNodeFsCapability({ tier: 'sandboxed', workspaceDir: workspace, readOnly: false, ...over });
}

describe('createNodeFsCapability — read (jailed)', () => {
  it('reads an in-workspace text file with mime + size + mtime', async () => {
    await writeFile(join(workspace, 'a.md'), '# hello');
    const fs = sandboxed();
    const result = await fs.readFile('a.md', {});
    expect(result.content).toBe('# hello');
    expect(result.mimeType).toBe('text/markdown');
    expect(result.sizeBytes).toBe(Buffer.byteLength('# hello'));
    expect(typeof result.lastModified).toBe('string');
  });

  it('resolves a relative path against the workspace', async () => {
    await mkdir(join(workspace, 'sub'), { recursive: true });
    await writeFile(join(workspace, 'sub', 'x.txt'), 'deep');
    expect((await sandboxed().readFile('sub/x.txt', {})).content).toBe('deep');
  });

  it('rejects a `..` traversal that escapes the workspace', async () => {
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET');
    await expect(sandboxed().readFile('../outside/secret.txt', {})).rejects.toBeInstanceOf(
      FsCapabilityError,
    );
  });

  it('rejects an absolute path outside the workspace', async () => {
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET');
    await expect(sandboxed().readFile(join(outside, 'secret.txt'), {})).rejects.toBeInstanceOf(
      FsCapabilityError,
    );
  });

  it('rejects reading THROUGH a symlink that escapes the workspace', async () => {
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET');
    await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'));
    // The path is lexically in-workspace, but realpath resolves it to `outside` — the jail must reject it.
    await expect(sandboxed().readFile('link.txt', {})).rejects.toBeInstanceOf(FsCapabilityError);
  });

  it('rejects a binary (NUL-containing) file', async () => {
    await writeFile(join(workspace, 'bin'), Buffer.from([0x41, 0x00, 0x42]));
    await expect(sandboxed().readFile('bin', {})).rejects.toThrow(/binary/);
  });

  it('rejects a file over the read byte limit', async () => {
    await writeFile(join(workspace, 'big.txt'), 'xxxxxx');
    await expect(sandboxed({ maxReadBytes: 3 }).readFile('big.txt', {})).rejects.toThrow(/limit/);
  });

  it('rejects a non-existent path', async () => {
    await expect(sandboxed().readFile('nope.txt', {})).rejects.toBeInstanceOf(FsCapabilityError);
  });

  it('rejects a directory path for read_file', async () => {
    await mkdir(join(workspace, 'd'), { recursive: true });
    await expect(sandboxed().readFile('d', {})).rejects.toThrow(/directory/);
  });
});

describe('createNodeFsCapability — glob read', () => {
  it('concatenates the matching text files with per-file headers', async () => {
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'a.ts'), 'AAA');
    await writeFile(join(workspace, 'src', 'b.ts'), 'BBB');
    await writeFile(join(workspace, 'src', 'c.md'), 'CCC'); // not matched
    const result = await sandboxed().readFile('src/*.ts', { glob: true });
    expect(result.content).toContain('AAA');
    expect(result.content).toContain('BBB');
    expect(result.content).not.toContain('CCC');
    expect(result.content).toContain('src/a.ts');
  });

  it('matches across directories with `**`', async () => {
    await mkdir(join(workspace, 'a', 'b'), { recursive: true });
    await writeFile(join(workspace, 'a', 'b', 'deep.ts'), 'DEEP');
    expect((await sandboxed().readFile('**/*.ts', { glob: true })).content).toContain('DEEP');
  });

  it('throws when the glob matches no files', async () => {
    await expect(sandboxed().readFile('*.nothing', { glob: true })).rejects.toThrow(/no files/);
  });

  it('does not read a file symlinked out of the workspace', async () => {
    await writeFile(join(outside, 'leak.ts'), 'LEAKED');
    await symlink(join(outside, 'leak.ts'), join(workspace, 'leak.ts'));
    await writeFile(join(workspace, 'real.ts'), 'REAL');
    const result = await sandboxed().readFile('*.ts', { glob: true });
    expect(result.content).toContain('REAL');
    expect(result.content).not.toContain('LEAKED');
  });
});

describe('createNodeFsCapability — write (read-write profile)', () => {
  it('writes a new file atomically, returning a workspace-relative path', async () => {
    const result = await sandboxed().writeFile('out.txt', 'hi', {});
    expect(result.bytesWritten).toBe(2);
    expect(result.path).toBe('out.txt');
    expect((await sandboxed().readFile('out.txt', {})).content).toBe('hi');
  });

  it('creates parent directories only with createDirs', async () => {
    await expect(sandboxed().writeFile('new/dir/f.txt', 'x', {})).rejects.toThrow(/createDirs/);
    const ok = await sandboxed().writeFile('new/dir/f.txt', 'x', { createDirs: true });
    expect(ok.bytesWritten).toBe(1);
  });

  it('appends to an existing file', async () => {
    await sandboxed().writeFile('log.txt', 'a', {});
    await sandboxed().writeFile('log.txt', 'b', { append: true });
    expect((await sandboxed().readFile('log.txt', {})).content).toBe('ab');
  });

  it('rejects a write that escapes the workspace via `..`', async () => {
    await expect(sandboxed().writeFile('../outside/evil.txt', 'x', {})).rejects.toBeInstanceOf(
      FsCapabilityError,
    );
  });

  it('refuses to write THROUGH a symlink at the final component', async () => {
    await writeFile(join(outside, 'target.txt'), 'original');
    await symlink(join(outside, 'target.txt'), join(workspace, 'evil.txt'));
    await expect(sandboxed().writeFile('evil.txt', 'pwned', {})).rejects.toThrow(/symlink/);
  });

  it('refuses a write through a symlinked ANCESTOR directory escaping the workspace', async () => {
    await symlink(outside, join(workspace, 'linkdir'), 'dir');
    await expect(
      sandboxed().writeFile('linkdir/evil.txt', 'x', { createDirs: true }),
    ).rejects.toBeInstanceOf(FsCapabilityError);
  });
});

describe('createNodeFsCapability — read-only profile (2.5.A chat)', () => {
  it('fail-closes write_file as ToolUnavailableError (→ tool_unavailable), never touching disk', async () => {
    const fs = sandboxed({ readOnly: true });
    await expect(fs.writeFile('x.txt', 'data', {})).rejects.toBeInstanceOf(ToolUnavailableError);
  });

  it('still allows reads in the read-only profile', async () => {
    await writeFile(join(workspace, 'r.txt'), 'readable');
    expect((await sandboxed({ readOnly: true }).readFile('r.txt', {})).content).toBe('readable');
  });
});

describe('createNodeFsCapability — list_directory', () => {
  it('lists immediate entries with type', async () => {
    await writeFile(join(workspace, 'f.txt'), 'x');
    await mkdir(join(workspace, 'sub'), { recursive: true });
    const { entries } = await sandboxed().listDirectory('.', {});
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['f.txt', 'sub']);
    expect(entries.find((e) => e.name === 'sub')?.type).toBe('directory');
  });

  it('recurses and reports POSIX relative names', async () => {
    await mkdir(join(workspace, 'a', 'b'), { recursive: true });
    await writeFile(join(workspace, 'a', 'b', 'deep.txt'), 'x');
    const { entries } = await sandboxed().listDirectory('.', { recursive: true });
    expect(entries.map((e) => e.name)).toContain('a/b/deep.txt');
  });

  it('filters by a glob', async () => {
    await writeFile(join(workspace, 'keep.ts'), 'x');
    await writeFile(join(workspace, 'drop.md'), 'x');
    const { entries } = await sandboxed().listDirectory('.', { glob: '*.ts' });
    expect(entries.map((e) => e.name)).toEqual(['keep.ts']);
  });

  it('does not follow a symlinked directory when recursing (no escape)', async () => {
    await writeFile(join(outside, 'secret.txt'), 'SECRET');
    await symlink(outside, join(workspace, 'linkdir'), 'dir');
    const { entries } = await sandboxed().listDirectory('.', { recursive: true });
    // The symlink itself shows as an entry, but its contents are never walked into.
    expect(entries.map((e) => e.name)).toContain('linkdir');
    expect(entries.map((e) => e.name)).not.toContain('linkdir/secret.txt');
  });

  it('rejects listing a path outside the workspace', async () => {
    await expect(sandboxed().listDirectory('../outside', {})).rejects.toBeInstanceOf(
      FsCapabilityError,
    );
  });
});

describe('createNodeFsCapability — tiers', () => {
  it('sandboxed tier allows the optional tmp root', async () => {
    const tmp = join(workspace, '..', 'tmproot');
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, 't.txt'), 'tmp-ok');
    const fs = sandboxed({ tmpDir: tmp });
    expect((await fs.readFile(join(tmp, 't.txt'), {})).content).toBe('tmp-ok');
  });

  it('full tier reads outside the workspace (the power-user opt-in)', async () => {
    await writeFile(join(outside, 'anywhere.txt'), 'unjailed');
    const fs = createNodeFsCapability({ tier: 'full', workspaceDir: workspace, readOnly: false });
    expect((await fs.readFile(join(outside, 'anywhere.txt'), {})).content).toBe('unjailed');
  });

  it('project tier honours an extraRoots allowlist', async () => {
    await writeFile(join(outside, 'allowed.txt'), 'in-allowlist');
    const fs = createNodeFsCapability({
      tier: 'project',
      workspaceDir: workspace,
      extraRoots: [outside],
      readOnly: false,
    });
    expect((await fs.readFile(join(outside, 'allowed.txt'), {})).content).toBe('in-allowlist');
  });
});
