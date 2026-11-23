import { link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
