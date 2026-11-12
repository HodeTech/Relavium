import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
