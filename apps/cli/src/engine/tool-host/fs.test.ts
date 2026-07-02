import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** POSIX-only tests (a FIFO is created via `mkfifo`); Windows has no equivalent special file. */
const itPosix = process.platform === 'win32' ? it.skip : it;

import { ToolUnavailableError } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createNodeFsCapability,
  FsCapabilityError,
  FsScopeDeniedError,
  readJailedFile,
  type NodeFsCapabilityConfig,
} from './fs.js';

/** An aborted signal for cancellation tests (AbortSignalLike: aborted + the two listener no-ops). */
const ABORTED = {
  aborted: true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

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

function sandboxed(
  over: Partial<NodeFsCapabilityConfig> = {},
): ReturnType<typeof createNodeFsCapability> {
  return createNodeFsCapability({
    tier: 'sandboxed',
    workspaceDir: workspace,
    readOnly: false,
    ...over,
  });
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

  it('follows an IN-SCOPE symlink to its target — the fd read path preserves symlink-read semantics', async () => {
    // The jail resolves an in-scope symlink to its canonical target and reads THAT (not the link) — so the
    // O_NOFOLLOW on the read fd, which targets the resolved file, never rejects a legitimate in-scope symlink.
    await writeFile(join(workspace, 'inside.txt'), 'INSIDE');
    await symlink(join(workspace, 'inside.txt'), join(workspace, 'alias.txt'));
    expect((await sandboxed().readFile('alias.txt', {})).content).toBe('INSIDE');
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

  itPosix(
    'rejects a FIFO (non-regular file) WITHOUT blocking the open — fail-closed, not a hang',
    async () => {
      // A reader-less FIFO opened O_RDONLY without O_NONBLOCK would BLOCK forever (and `fs.open` takes no signal,
      // so the dispatch could not be cancelled). The fix opens non-blocking + fstat-rejects the non-regular file.
      // If this regresses to a blocking open, the test times out (fail) — it never hangs the suite indefinitely.
      execFileSync('mkfifo', [join(workspace, 'pipe')]);
      await expect(sandboxed().readFile('pipe', {})).rejects.toThrow(/not a regular file/);
    },
    10_000,
  );
});

/**
 * Direct coverage of the post-jail fd read guard (`readJailedFile`) — the IO boundary the jail's `realpath`
 * cannot reach in a black-box `readFile` test (it resolves any symlink to its target first). These pin the
 * TOCTOU-relevant properties: a symlink at the resolved path (a swap after validation) is refused at the fd
 * layer by `O_NOFOLLOW`, and the stat / binary probe / content all come from one open handle.
 */
describe('readJailedFile — the post-jail fd read guard', () => {
  it('refuses a final-component symlink at the fd layer (O_NOFOLLOW) — the swap-after-validation guard', async () => {
    // A symlink at the path readJailedFile is handed (i.e. a swap of the post-realpath target) must fail closed
    // — even though the link points IN-scope, the fd open never follows it (ELOOP/ENOTDIR → fatal tool_denied).
    await writeFile(join(workspace, 'inside.txt'), 'INSIDE');
    const link = join(workspace, 'swapped.txt');
    await symlink(join(workspace, 'inside.txt'), link);
    await expect(readJailedFile(link, 1 << 20)).rejects.toBeInstanceOf(FsScopeDeniedError);
  });

  it('reads a normal file — content, size, and mtime all from the single fd', async () => {
    await writeFile(join(workspace, 'f.txt'), 'hello');
    const result = await readJailedFile(join(workspace, 'f.txt'), 1 << 20);
    expect(result.kind).toBe('file');
    if (result.kind === 'file') {
      expect(result.bytes.toString('utf8')).toBe('hello');
      expect(result.size).toBe(5);
      expect(typeof result.mtimeMs).toBe('number');
    }
  });

  it('flags a binary file from the bounded prefix probe (never charging a full load)', async () => {
    await writeFile(join(workspace, 'bin'), Buffer.from([0x41, 0x00, 0x42]));
    expect((await readJailedFile(join(workspace, 'bin'), 1 << 20)).kind).toBe('binary');
  });

  it('flags an oversize file against the size limit BEFORE reading its content', async () => {
    await writeFile(join(workspace, 'big.txt'), 'xxxxxx'); // 6 bytes
    const result = await readJailedFile(join(workspace, 'big.txt'), 3);
    expect(result.kind).toBe('oversize');
    if (result.kind === 'oversize') expect(result.size).toBe(6);
  });

  it('flags a directory (the caller rejects read_file on a directory)', async () => {
    await mkdir(join(workspace, 'dir'), { recursive: true });
    expect((await readJailedFile(join(workspace, 'dir'), 1 << 20)).kind).toBe('directory');
  });

  itPosix(
    'flags a FIFO as special (opened O_NONBLOCK, so a reader-less pipe never blocks the fstat guard)',
    async () => {
      execFileSync('mkfifo', [join(workspace, 'pipe')]);
      expect((await readJailedFile(join(workspace, 'pipe'), 1 << 20)).kind).toBe('special');
    },
    10_000,
  );
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

  it('a binary match does NOT charge the budget — a text match in budget still reads', async () => {
    await writeFile(join(workspace, 'big.ts'), Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00])); // 6-byte binary
    await writeFile(join(workspace, 'small.ts'), 'OK'); // 2-byte text, within a 3-byte budget
    const result = await sandboxed({ maxReadBytes: 3 }).readFile('*.ts', { glob: true });
    expect(result.content).toContain('OK'); // the binary is skipped before its size is tested against the budget
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

  it('cleans up the temp file when the atomic publish fails — no `.relavium-write.*.tmp` orphan', async () => {
    // Force the rename to fail by pointing the final target at an existing NON-EMPTY directory: `rename(tmp,
    // dir)` throws (ENOTEMPTY/EISDIR/EEXIST). The write must reject, AND the `finally` must remove the temp it
    // created — so a failed publish never strands a `.relavium-write.*.tmp` in the workspace.
    await mkdir(join(workspace, 'busy'), { recursive: true });
    await writeFile(join(workspace, 'busy', 'keep.txt'), 'x'); // non-empty ⇒ the rename onto it always fails
    await expect(sandboxed().writeFile('busy', 'data', {})).rejects.toBeInstanceOf(
      FsCapabilityError,
    );
    const orphans = (await readdir(workspace)).filter((n) => n.startsWith('.relavium-write.'));
    expect(orphans).toEqual([]);
  });
});

describe('createNodeFsCapability — protected paths (denied in EVERY mode, auto included) — ADR-0057', () => {
  it('refuses to write inside `.git/` — FATAL tool_denied, and never creates the dir', async () => {
    await expect(
      sandboxed().writeFile('.git/config', '[evil]', { createDirs: true }),
    ).rejects.toBeInstanceOf(FsScopeDeniedError);
    // The early (pre-mkdir) check means even `createDirs` cannot bring `.git/` into being.
    await expect(readdir(join(workspace, '.git'))).rejects.toThrow();
  });

  it('refuses to write a nested file under `.git/` (a hooks script)', async () => {
    await mkdir(join(workspace, '.git'), { recursive: true });
    await expect(
      sandboxed().writeFile('.git/hooks/pre-commit', '#!/bin/sh\nrm -rf /', { createDirs: true }),
    ).rejects.toBeInstanceOf(FsScopeDeniedError);
  });

  it('refuses to write inside `.relavium/` — the local config/secrets dir', async () => {
    await expect(
      sandboxed().writeFile('.relavium/config.json', '{}', { createDirs: true }),
    ).rejects.toBeInstanceOf(FsScopeDeniedError);
  });

  it('refuses startup/config files by basename (shell rc, X login, .gitconfig, .bash_aliases)', async () => {
    for (const rc of [
      '.zshrc',
      '.bashrc',
      '.profile',
      'config.fish',
      '.bash_aliases',
      '.xprofile',
      '.xinitrc',
      '.xsession',
      '.gitconfig', // user-global git config: core.hooksPath / `[alias] x = !cmd` ⇒ RCE
    ]) {
      await expect(sandboxed().writeFile(rc, 'evil', {})).rejects.toBeInstanceOf(
        FsScopeDeniedError,
      );
    }
  });

  it('matches `.git` case-insensitively (`.GIT/`) — the over-deny is the safe direction', async () => {
    await expect(
      sandboxed().writeFile('.GIT/config', 'x', { createDirs: true }),
    ).rejects.toBeInstanceOf(FsScopeDeniedError);
  });

  it('refuses a Win32-folding trailing-dot/space variant (`.bashrc.`, `.bashrc `, `.git./x`)', async () => {
    // Win32 silently strips trailing dots/spaces at open time, so these land on the REAL protected target;
    // foldPathComponent denies them on every platform (an over-deny on a case-sensitive FS is the safe way).
    for (const name of ['.bashrc.', '.bashrc ', '.gitconfig.', 'profile.ps1 ']) {
      await expect(sandboxed().writeFile(name, 'evil', {})).rejects.toBeInstanceOf(
        FsScopeDeniedError,
      );
    }
    // The folded `.git.` directory segment is caught by the EARLY check, so no `.git.` dir is ever created.
    await expect(
      sandboxed().writeFile('.git./config', 'x', { createDirs: true }),
    ).rejects.toBeInstanceOf(FsScopeDeniedError);
    await expect(readdir(join(workspace, '.git.'))).rejects.toThrow();
  });

  it('refuses a symlink whose REALPATH resolves INTO `.git/` (the post-jail re-check)', async () => {
    await mkdir(join(workspace, '.git'), { recursive: true });
    // `link` is a workspace-relative symlink pointing at the (in-workspace) `.git` dir; writing `link/config`
    // passes the lexical pre-check (no `.git` segment) but the realpath'd finalTarget lands inside `.git/`.
    await symlink(join(workspace, '.git'), join(workspace, 'link'));
    await expect(sandboxed().writeFile('link/config', 'x', {})).rejects.toBeInstanceOf(
      FsScopeDeniedError,
    );
  });

  it('refuses to write inside `.ssh/` — the whole directory is protected (keys, config ProxyCommand, rc)', async () => {
    for (const target of ['.ssh/authorized_keys', '.ssh/config', '.ssh/id_ed25519', '.ssh/rc']) {
      await expect(sandboxed().writeFile(target, 'x', { createDirs: true })).rejects.toBeInstanceOf(
        FsScopeDeniedError,
      );
    }
  });

  it('refuses an NTFS Alternate-Data-Stream variant (`.gitconfig::$DATA` addresses the real `.gitconfig`)', async () => {
    // `name::$DATA` / `name:stream` address the default stream of `name` on NTFS; foldPathComponent takes the
    // pre-`:` part so the bare protected name is matched on every platform (an over-deny on POSIX is safe).
    for (const name of ['.gitconfig::$DATA', '.bashrc:stream', '.git::$DATA/config']) {
      await expect(
        sandboxed().writeFile(name, 'evil', { createDirs: true }),
      ).rejects.toBeInstanceOf(FsScopeDeniedError);
    }
  });

  // NOTE: the writeOne realpath re-check (canonicalTarget) also denies a Win32 8.3 short-name alias
  // (`GITCON~1` → `.gitconfig`) of an EXISTING target — but 8.3 aliasing is an NTFS behavior with no POSIX
  // equivalent (realpath resolves symlinks, not hardlinks/short-names), so it is not reproducible on the CI
  // platform; its pass-path (an existing non-protected target realpaths cleanly) is exercised by the overwrite
  // test above. A final-component SYMLINK — the POSIX aliasing vector — is caught earlier by assertNotSymlink.

  it('ALLOWS a `.gitignore` FILE — only the `.git` DIRECTORY segment is protected', async () => {
    const result = await sandboxed().writeFile('.gitignore', 'node_modules\n', {});
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect((await sandboxed().readFile('.gitignore', {})).content).toBe('node_modules\n');
  });

  it('denies protected paths under the `full` (unjailed) tier too — a tier-independent floor', async () => {
    // ADR-0057: protected paths hold "even where the fs jail would allow them" — `full` is the no-jail case.
    const fullTier = createNodeFsCapability({
      tier: 'full',
      workspaceDir: workspace,
      readOnly: false,
    });
    await expect(
      fullTier.writeFile('.git/config', '[evil]', { createDirs: true }),
    ).rejects.toBeInstanceOf(FsScopeDeniedError);
    await expect(fullTier.writeFile('.bashrc', 'evil', {})).rejects.toBeInstanceOf(
      FsScopeDeniedError,
    );
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
    // And it is reported as a `file`, never `directory` — `dirent.isDirectory()` is false for a symlink, so the
    // reported type can never invite a caller to treat it as recursable (defense in depth beside the walk skip).
    expect(entries.find((e) => e.name === 'linkdir')?.type).toBe('file');
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
    expect(entries).toHaveLength(3);
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
