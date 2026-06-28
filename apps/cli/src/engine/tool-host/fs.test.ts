import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolUnavailableError } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createNodeFsCapability,
  FsCapabilityError,
  FsScopeDeniedError,
  type NodeFsCapabilityConfig,
} from './fs.js';

/** An aborted signal for cancellation tests (AbortSignalLike: aborted + the two listener no-ops). */
const ABORTED = { aborted: true, addEventListener: () => undefined, removeEventListener: () => undefined };

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

  it('rejects a `..` traversal that escapes the workspace — FATAL tool_denied, not retryable', async () => {
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET');
    const err: unknown = await sandboxed()
      .readFile('../outside/secret.txt', {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FsScopeDeniedError);
    // A deterministic scope denial must be fatal so it never burns the node-retry budget (error-handling.md).
    if (err instanceof FsScopeDeniedError) {
      expect(err.code).toBe('tool_denied');
      expect(err.retryable).toBe(false);
    }
  });

  it('rejects an absolute path outside the workspace', async () => {
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET');
    await expect(sandboxed().readFile(join(outside, 'secret.txt'), {})).rejects.toBeInstanceOf(
      FsScopeDeniedError,
    );
  });

  it('rejects reading THROUGH a symlink that escapes the workspace', async () => {
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET');
    await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'));
    // The path is lexically in-workspace, but realpath resolves it to `outside` — the jail must reject it.
    await expect(sandboxed().readFile('link.txt', {})).rejects.toBeInstanceOf(FsScopeDeniedError);
  });

  it('rejects reading through a symlinked ANCESTOR directory escaping the workspace', async () => {
    await writeFile(join(outside, 'secret.txt'), 'SECRET');
    await symlink(outside, join(workspace, 'linkdir'), 'dir');
    // realpath resolves the ancestor symlink before the scope check, so the read is blocked.
    await expect(sandboxed().readFile('linkdir/secret.txt', {})).rejects.toBeInstanceOf(
      FsScopeDeniedError,
    );
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

  it('skips a binary match but still returns the text matches', async () => {
    await writeFile(join(workspace, 'text.ts'), 'TEXT');
    await writeFile(join(workspace, 'bin.ts'), Buffer.from([0x41, 0x00, 0x42]));
    const result = await sandboxed().readFile('*.ts', { glob: true });
    expect(result.content).toContain('TEXT');
    expect(result.content).not.toContain('bin.ts');
  });

  it('throws when every match is binary', async () => {
    await writeFile(join(workspace, 'only.ts'), Buffer.from([0x00, 0x01]));
    await expect(sandboxed().readFile('*.ts', { glob: true })).rejects.toThrow(/binary/);
  });

  it('rejects when the ACCUMULATED glob size exceeds maxReadBytes', async () => {
    await writeFile(join(workspace, 'a.ts'), 'AAAA'); // 4 bytes
    await writeFile(join(workspace, 'b.ts'), 'BBBB'); // 4 bytes — 8 total > 6
    await expect(sandboxed({ maxReadBytes: 6 }).readFile('*.ts', { glob: true })).rejects.toThrow(
      /limit/,
    );
  });

  it('caps the glob read at maxGlobMatches', async () => {
    for (let i = 0; i < 5; i += 1) await writeFile(join(workspace, `f${i}.ts`), 'x');
    const result = await sandboxed({ maxGlobMatches: 2 }).readFile('*.ts', { glob: true });
    // each match contributes one `===== fN.ts =====` header; the cap bounds the surfaced set to 2 of the 5.
    expect(result.content.match(/===== f\d\.ts =====/g)?.length).toBe(2);
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

  it('overwrites (replaces, not appends) an existing file', async () => {
    await sandboxed().writeFile('f.txt', 'old', {});
    await sandboxed().writeFile('f.txt', 'new', {});
    expect((await sandboxed().readFile('f.txt', {})).content).toBe('new');
  });

  it('rejects a write that escapes the workspace via `..` — FATAL tool_denied', async () => {
    await expect(sandboxed().writeFile('../outside/evil.txt', 'x', {})).rejects.toBeInstanceOf(
      FsScopeDeniedError,
    );
  });

  it('refuses to write THROUGH a symlink at the final component', async () => {
    await writeFile(join(outside, 'target.txt'), 'original');
    await symlink(join(outside, 'target.txt'), join(workspace, 'evil.txt'));
    await expect(sandboxed().writeFile('evil.txt', 'pwned', {})).rejects.toBeInstanceOf(
      FsScopeDeniedError,
    );
    expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('original'); // never clobbered
  });

  it('refuses a write through a symlinked ANCESTOR directory escaping the workspace', async () => {
    await symlink(outside, join(workspace, 'linkdir'), 'dir');
    await expect(
      sandboxed().writeFile('linkdir/evil.txt', 'x', { createDirs: true }),
    ).rejects.toBeInstanceOf(FsScopeDeniedError);
  });

  it('refuses to APPEND through a symlink at the final component (the append path)', async () => {
    await writeFile(join(outside, 'target.txt'), 'original');
    await symlink(join(outside, 'target.txt'), join(workspace, 'evil.txt'));
    await expect(
      sandboxed().writeFile('evil.txt', 'appended', { append: true }),
    ).rejects.toBeInstanceOf(FsScopeDeniedError);
    expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('original'); // never clobbered
  });
});

describe('createNodeFsCapability — read-only profile (2.5.A chat)', () => {
  it('fail-closes write_file as ToolUnavailableError (→ tool_unavailable), never touching disk', async () => {
    const fs = sandboxed({ readOnly: true });
    await expect(fs.writeFile('x.txt', 'data', {})).rejects.toBeInstanceOf(ToolUnavailableError);
  });

  it('fail-closes an APPEND too (append is a write)', async () => {
    await writeFile(join(workspace, 'log.txt'), 'a');
    await expect(
      sandboxed({ readOnly: true }).writeFile('log.txt', 'b', { append: true }),
    ).rejects.toBeInstanceOf(ToolUnavailableError);
    expect(await readFile(join(workspace, 'log.txt'), 'utf8')).toBe('a'); // untouched
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
      FsScopeDeniedError,
    );
  });

  it('matches `?`, mid-path `**`, and a literal tail across a recursive listing', async () => {
    await mkdir(join(workspace, 'a', 'mid'), { recursive: true });
    await writeFile(join(workspace, 'a', 'mid', 'x.ts'), 'x');
    await writeFile(join(workspace, 'a', 'y.ts'), 'y');
    const r = await sandboxed().listDirectory('.', { recursive: true, glob: 'a/**/x.ts' });
    expect(r.entries.map((e) => e.name)).toEqual(['a/mid/x.ts']);
    const q = await sandboxed().listDirectory('.', { recursive: true, glob: 'a/?.ts' });
    expect(q.entries.map((e) => e.name)).toEqual(['a/y.ts']); // `?` is one char, does not cross `/`
  });

  it('caps the number of listed entries', async () => {
    for (let i = 0; i < 5; i += 1) await writeFile(join(workspace, `f${i}.txt`), 'x');
    const { entries } = await sandboxed({ maxGlobMatches: 3 }).listDirectory('.', {});
    expect(entries.length).toBe(3);
  });
});

describe('createNodeFsCapability — cancellation + malformed paths', () => {
  it('aborts read / write / list on an already-aborted signal', async () => {
    await writeFile(join(workspace, 'a.txt'), 'x');
    const fs = sandboxed();
    await expect(fs.readFile('a.txt', {}, ABORTED)).rejects.toThrow(/abort/);
    await expect(fs.listDirectory('.', {}, ABORTED)).rejects.toThrow(/abort/);
    await expect(fs.writeFile('new.txt', 'y', {}, ABORTED)).rejects.toThrow(/abort/);
    await expect(fs.readFile('new.txt', {})).rejects.toBeInstanceOf(FsCapabilityError); // never created
  });

  it('rejects an empty path and a UNC path', async () => {
    await expect(sandboxed().readFile('', {})).rejects.toBeInstanceOf(FsCapabilityError);
    await expect(sandboxed().readFile('\\\\server\\share', {})).rejects.toBeInstanceOf(
      FsScopeDeniedError,
    );
  });
});

describe('createNodeFsCapability — tiers', () => {
  it('sandboxed tier allows the optional tmp root (read + write)', async () => {
    const tmp = join(workspace, '..', 'tmproot');
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, 't.txt'), 'tmp-ok');
    const fs = sandboxed({ tmpDir: tmp });
    expect((await fs.readFile(join(tmp, 't.txt'), {})).content).toBe('tmp-ok');
    const written = await fs.writeFile(join(tmp, 'w.txt'), 'tmp-written', {});
    expect(written.bytesWritten).toBe('tmp-written'.length);
    expect((await fs.readFile(join(tmp, 'w.txt'), {})).content).toBe('tmp-written');
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

  it('project tier rejects a path in NEITHER the workspace NOR extraRoots', async () => {
    const third = join(workspace, '..', 'third');
    await mkdir(third, { recursive: true });
    await writeFile(join(third, 'secret.txt'), 'NOT ALLOWED');
    const fs = createNodeFsCapability({
      tier: 'project',
      workspaceDir: workspace,
      extraRoots: [outside], // `third` is deliberately NOT in the allowlist
      readOnly: false,
    });
    await expect(fs.readFile(join(third, 'secret.txt'), {})).rejects.toBeInstanceOf(
      FsScopeDeniedError,
    );
  });
});
