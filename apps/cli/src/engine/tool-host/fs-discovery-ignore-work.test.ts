import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNodeFsCapability } from './fs.js';

// A file can vanish between the directory read and the per-entry probes. The windows are a few microseconds, so the
// tests open them deterministically: a probe of a registered path fails with ENOENT exactly as a concurrent unlink
// would. `paths` fails every `lstat` of the path; `bigintLstat` / `bigintStat` fail only the identity-pinning probe
// (the `{ bigint: true }` form) so the window BETWEEN the plain probe and the pin is isolated.
const vanishing = vi.hoisted(() => ({
  paths: new Set<string>(),
  bigintLstat: new Set<string>(),
  bigintStat: new Set<string>(),
  hits: 0,
  fired: [] as string[],
  code: 'ENOENT',
}));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  const asksBigint = (options: unknown): boolean =>
    typeof options === 'object' &&
    options !== null &&
    'bigint' in options &&
    options.bigint === true;
  const enoent = () =>
    Promise.reject(
      Object.assign(new Error(`${vanishing.code}: injected failure`), { code: vanishing.code }),
    );
  return {
    ...native,
    lstat: (...args: Parameters<typeof native.lstat>) => {
      const [path, options] = args;
      if (typeof path === 'string' && vanishing.paths.has(path)) {
        vanishing.hits++;
        return enoent();
      }
      if (typeof path === 'string' && asksBigint(options) && vanishing.bigintLstat.has(path)) {
        vanishing.fired.push(`lstat-bigint:${path}`);
        return enoent();
      }
      return native.lstat(...args);
    },
    stat: (...args: Parameters<typeof native.stat>) => {
      const [path, options] = args;
      if (typeof path === 'string' && asksBigint(options) && vanishing.bigintStat.has(path)) {
        vanishing.fired.push(`stat-bigint:${path}`);
        return enoent();
      }
      return native.stat(...args);
    },
  };
});

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'rlv-ignore-work-')));
});
afterEach(async () => rm(root, { recursive: true, force: true }));
function capability() {
  return createNodeFsCapability({
    operatorHomeDir: root,
    tier: 'sandboxed',
    workspaceDir: root,
    readOnly: true,
  });
}

it.each(
  ['.gitignore', '.relaviumignore'].flatMap((name) =>
    ['find', 'search'].map((tool) => ({ name, tool })),
  ),
)('bounds $tool preprocessing for an admitted 64 KiB $name line', async ({ name, tool }) => {
  await writeFile(join(root, name), `${' '.repeat(64 * 1024 - 2)}x\n`);
  await writeFile(join(root, 'candidate.txt'), 'needle\n');
  const fs = capability();
  const start = performance.now();
  if (tool === 'find') {
    const result = await fs.findFiles?.('.', { glob: '*.txt' });
    expect(result?.files.map((entry) => entry.path)).toEqual(['candidate.txt']);
    expect(result?.stats.incomplete).toBe(false);
  } else {
    const result = await fs.searchFiles?.('.', { pattern: 'needle', glob: '*.txt' });
    expect(result?.matches.map((entry) => entry.path)).toEqual(['candidate.txt']);
    expect(result?.stats.incomplete).toBe(false);
  }
  // The same production path ordinarily takes milliseconds; this catches a second-scale synchronous stall.
  expect(performance.now() - start, 'MVP3_IGNORE_PREPROCESSING_LINEAR').toBeLessThan(1000);
});

it.each([
  { text: 'candidate.txt \n', incomplete: true, files: [] },
  { text: 'candidate.txt\t\r\n', incomplete: true, files: [] },
  { text: 'candidate.txt\r\n', incomplete: false, files: [] },
  { text: '# comment \t\r\n', incomplete: false, files: ['candidate.txt'] },
  { text: ' \t\r\n', incomplete: false, files: ['candidate.txt'] },
])('preserves ignore whitespace admission for $text', async ({ text, incomplete, files }) => {
  await writeFile(join(root, '.gitignore'), text);
  await writeFile(join(root, 'candidate.txt'), 'needle\n');
  const result = await capability().findFiles?.('.', { glob: '*.txt' });
  expect(result?.stats.incomplete).toBe(incomplete);
  if (incomplete) expect(result?.stats.limit).toBe('ignore');
  else expect(result?.files.map((entry) => entry.path)).toEqual(files);
});

it('scans ordinary deep paths with 45 root rules without spending work on comparisons not performed', async () => {
  const deep = join(root, 'abcde', 'abcde', 'abcde', 'abcde', 'abcde');
  await mkdir(deep, { recursive: true });
  await writeFile(
    join(root, '.gitignore'),
    Array.from({ length: 45 }, (_, i) => `excluded${i}/`).join('\n'),
  );
  await Promise.all(
    Array.from({ length: 320 }, (_, i) => writeFile(join(deep, `file${i}.txt`), 'ordinary text\n')),
  );
  const fs = capability();
  const searched = await fs.searchFiles?.('.', { pattern: 'absent needle', glob: '**/*.txt' });
  expect(searched?.stats).toMatchObject({ filesScanned: 320, incomplete: false });
  const found = await fs.findFiles?.('.', { glob: '**/*.txt' });
  expect(found?.files).toHaveLength(200);
  expect(found?.stats.limit).toBe('matches');
});

it('does not apply workspace ignore rules to synthetic parent segments of an extra root', async () => {
  const workspace = join(root, 'workspace'),
    extra = join(root, 'extra');
  await Promise.all([mkdir(workspace), mkdir(extra)]);
  await writeFile(join(workspace, '.gitignore'), '.*\n/visible.txt\n');
  await writeFile(join(workspace, 'visible.txt'), 'needle');
  await writeFile(join(extra, 'visible.txt'), 'needle');
  const fs = createNodeFsCapability({
    operatorHomeDir: root,
    tier: 'project',
    workspaceDir: workspace,
    extraRoots: [extra],
    readOnly: true,
  });
  expect((await fs.findFiles?.('.', { glob: '**/*.txt' }))?.files).toHaveLength(0);
  const found = await fs.findFiles?.(extra, { glob: '**/*.txt' });
  expect(found?.files.map((file) => file.path)).toEqual([join('..', 'extra', 'visible.txt')]);
  expect(found?.stats.incomplete).toBe(false);
  expect((await fs.searchFiles?.(extra, { pattern: 'needle' }))?.matches).toHaveLength(1);
});

it.each(['candidate.txt\n', '# first comment\ncandidate.txt\n'])(
  'honors a UTF-8 BOM before the first ignore rule or comment: %s',
  async (body) => {
    await writeFile(join(root, '.gitignore'), '\ufeff' + body);
    await writeFile(join(root, 'candidate.txt'), 'needle');
    const result = await capability().findFiles?.('.', { glob: '**/*.txt' });
    expect(result?.files.map((file) => file.path)).not.toContain('candidate.txt');
    expect(result?.stats.incomplete).toBe(false);
  },
);

it('stops actual adversarial ignore retries at the work ceiling and reports an incomplete scan', async () => {
  await writeFile(
    join(root, '.gitignore'),
    Array(256)
      .fill(`${'a*'.repeat(100)}z`)
      .join('\n'),
  );
  await Promise.all(
    Array.from({ length: 320 }, (_, i) =>
      writeFile(join(root, `${'a'.repeat(180)}-${i}.txt`), 'needle'),
    ),
  );
  const result = await capability().findFiles?.('.', { glob: '*.nomatch' });
  expect(result?.stats).toMatchObject({ incomplete: true, limit: 'work' });
  expect(result?.stats.entriesVisited).toBeLessThan(320);
});

it.each(['find_files', 'search_files'] as const)(
  '%s skips a file that vanishes between the directory read and its lstat instead of failing the call',
  async (tool) => {
    await writeFile(join(root, 'kept.txt'), 'needle\n');
    await writeFile(join(root, 'gone.txt'), 'needle\n');
    vanishing.paths.clear();
    vanishing.hits = 0;
    vanishing.paths.add(join(root, 'gone.txt'));
    try {
      const fs = capability();
      const paths =
        tool === 'find_files'
          ? (await fs.findFiles?.('.', { glob: '*.txt' }))?.files.map((entry) => entry.path)
          : (await fs.searchFiles?.('.', { pattern: 'needle', glob: '*.txt' }))?.matches.map(
              (entry) => entry.path,
            );
      // The injection really fired on the scan, and the survivors are still reported.
      expect(vanishing.hits).toBeGreaterThan(0);
      expect(paths).toEqual(['kept.txt']);
    } finally {
      vanishing.paths.clear();
    }
  },
);

// The identity-pinning probe (`stat`/`lstat` with `{ bigint: true }`) sits a few lines after the plain probe that
// already tolerates a vanished entry. A file unlinked inside THAT window must be skipped too — only ENOENT — instead
// of failing the whole call (guarded() would turn the raw error into "the filesystem operation failed").
function resetVanishing(): void {
  vanishing.paths.clear();
  vanishing.bigintLstat.clear();
  vanishing.bigintStat.clear();
  vanishing.hits = 0;
  vanishing.fired.length = 0;
  vanishing.code = 'ENOENT';
}

it.each(['find_files', 'search_files'] as const)(
  '%s skips a file that vanishes between its realpath and the identity stat instead of failing the call',
  async (tool) => {
    await writeFile(join(root, 'kept.txt'), 'needle\n');
    await writeFile(join(root, 'gone.txt'), 'needle\n');
    resetVanishing();
    vanishing.bigintStat.add(join(root, 'gone.txt'));
    try {
      const fs = capability();
      const paths =
        tool === 'find_files'
          ? (await fs.findFiles?.('.', { glob: '*.txt' }))?.files.map((entry) => entry.path)
          : (await fs.searchFiles?.('.', { pattern: 'needle', glob: '*.txt' }))?.matches.map(
              (entry) => entry.path,
            );
      expect(vanishing.fired).toEqual([`stat-bigint:${join(root, 'gone.txt')}`]);
      expect(paths).toEqual(['kept.txt']);
    } finally {
      resetVanishing();
    }
  },
);

it('list_directory (recursive) skips an entry that vanishes at the lstat identity probe instead of failing the call', async () => {
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'kept.txt'), 'x');
  await writeFile(join(root, 'sub', 'also.txt'), 'x');
  await writeFile(join(root, 'sub', 'gone.txt'), 'x');
  resetVanishing();
  vanishing.bigintLstat.add(join(root, 'sub', 'gone.txt'));
  try {
    const listing = await capability().listDirectory('.', { recursive: true });
    expect(vanishing.fired).toEqual([`lstat-bigint:${join(root, 'sub', 'gone.txt')}`]);
    expect(listing.entries.map((entry) => entry.name).sort()).toEqual([
      'kept.txt',
      'sub',
      'sub/also.txt',
    ]);
  } finally {
    resetVanishing();
  }
});

// A listed entry is described from its own directory entry and its own lstat: list_directory takes no second,
// target-following identity probe (a symlink's target must not decide whether the link is listed). The follow-stat
// probe is armed on a real entry and must never fire.
it('list_directory never takes a target-following identity probe of an entry', async () => {
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'sub', 'gone.txt'), 'x');
  resetVanishing();
  vanishing.bigintStat.add(join(root, 'sub', 'gone.txt'));
  try {
    const listing = await capability().listDirectory('.', { recursive: true });
    expect(vanishing.fired).toEqual([]);
    expect(listing.entries.map((entry) => entry.name).sort()).toEqual(['sub', 'sub/gone.txt']);
  } finally {
    resetVanishing();
  }
});

it('a glob read skips a match that vanishes between its realpath and the identity stat instead of failing', async () => {
  await writeFile(join(root, 'kept.txt'), 'KEPT');
  await writeFile(join(root, 'gone.txt'), 'GONE');
  resetVanishing();
  vanishing.bigintStat.add(join(root, 'gone.txt'));
  try {
    const result = await capability().readFile('*.txt', { glob: true });
    expect(vanishing.fired).toEqual([`stat-bigint:${join(root, 'gone.txt')}`]);
    expect(result.content).toContain('KEPT');
    expect(result.content).not.toContain('GONE');
  } finally {
    resetVanishing();
  }
});

it('still fails the call when the identity stat fails with anything other than ENOENT', async () => {
  await writeFile(join(root, 'kept.txt'), 'needle\n');
  await writeFile(join(root, 'broken.txt'), 'needle\n');
  resetVanishing();
  vanishing.code = 'EIO';
  vanishing.bigintStat.add(join(root, 'broken.txt'));
  try {
    await expect(capability().findFiles?.('.', { glob: '*.txt' })).rejects.toThrow(
      'the filesystem operation failed',
    );
    expect(vanishing.fired).toEqual([`stat-bigint:${join(root, 'broken.txt')}`]);
  } finally {
    resetVanishing();
  }
});
