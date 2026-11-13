import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createNodeFsCapability } from './fs.js';

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
