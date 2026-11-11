import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createNodeFsCapability, hasObservedRead } from './fs.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'relavium-mvp3-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function capability() {
  return createNodeFsCapability({ tier: 'sandboxed', workspaceDir: root, readOnly: true });
}

it('reads exact line and UTF-8 byte ranges without changing line endings', async () => {
  await writeFile(join(root, 'a'), 'a\r\né\nlast');
  const fs = capability();
  const lines = await fs.readFile('a', { range: { unit: 'lines', start: 2, end: 2 } });
  expect(lines.content).toBe('é\n');
  expect(lines.range).toEqual({
    unit: 'lines',
    start: 2,
    end: 2,
    startByte: 3,
    endByte: 6,
    omittedBytes: 7,
  });
  await expect(fs.readFile('a', { range: { unit: 'bytes', start: 4, end: 4 } })).rejects.toThrow(
    /UTF-8/,
  );
  await expect(fs.readFile('a', { range: { unit: 'lines', start: 4, end: 4 } })).rejects.toThrow(
    /range/,
  );
  await expect(
    fs.readFile('a', { glob: true, range: { unit: 'bytes', start: 0, end: 1 } }),
  ).rejects.toThrow(/glob/);
});

it('certifies only acknowledged host result intervals in the same live scope', async () => {
  const content = 'abcdef';
  const target = join(root, 'a');
  await writeFile(target, content);
  const fs = capability();
  const scope = {};
  const result = await fs.readFile('a', { range: { unit: 'bytes', start: 1, end: 4 } });
  const digest = createHash('sha256').update(content).digest('hex');
  fs.acknowledgeReadResult?.(scope, { ...result });
  expect(hasObservedRead(fs, scope, target, digest, 1, 4)).toBe(false);
  fs.acknowledgeReadResult?.(scope, result);
  expect(hasObservedRead(fs, scope, target, digest, 1, 4)).toBe(false);
  fs.promoteReadScope?.(scope);
  expect(hasObservedRead(fs, scope, target, digest, 1, 4)).toBe(true);
  expect(hasObservedRead(fs, scope, target, 'wrong-digest', 1, 4)).toBe(false);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.range)).toBe(true);
  expect(hasObservedRead(fs, scope, target, digest, 0, 4)).toBe(false);
  expect(hasObservedRead(fs, {}, target, digest, 1, 4)).toBe(false);
  fs.releaseReadScope?.(scope);
  expect(hasObservedRead(fs, scope, target, digest, 1, 4)).toBe(false);
});

it('searches literals and applies root ignore rules and confidentiality', async () => {
  await writeFile(join(root, '.gitignore'), 'ignored\n');
  await writeFile(join(root, 'ignored'), 'x.y\n');
  await writeFile(join(root, 'yes'), 'x.y\nxay\n');
  await writeFile(join(root, '.env'), 'x.y\n');
  const result = await capability().searchFiles?.('.', { pattern: 'x.y' });
  expect(result?.matches.map((m) => [m.path, m.line])).toEqual([['yes', 1]]);
  expect(result?.stats.incomplete).toBe(false);
});

it('reports unsupported ignore input and never follows directory symlinks or hard links', async () => {
  await mkdir(join(root, 'dir'));
  await writeFile(join(root, 'dir', 'data'), 'hello');
  await link(join(root, 'dir', 'data'), join(root, 'alias'));
  await symlink(join(root, 'dir'), join(root, 'linked'));
  const fs = capability();
  const found = await fs.findFiles?.('.', { glob: '**' });
  expect(found?.files.some((file) => file.path === 'alias')).toBe(false);
  expect(found?.files.some((file) => file.path.startsWith('linked/'))).toBe(false);
  await writeFile(join(root, '.gitignore'), '[ab]\n');
  expect((await fs.findFiles?.('.', { glob: '**' }))?.stats).toMatchObject({
    incomplete: true,
    limit: 'ignore',
  });
});

it('labels the result cap and rejects invalid UTF-8', async () => {
  for (let i = 0; i < 205; i++) await writeFile(join(root, `f${i}`), 'x');
  await writeFile(join(root, 'bad'), Buffer.from([0xff]));
  const fs = capability();
  await expect(fs.readFile('bad', {})).rejects.toThrow(/binary/);
  const found = await fs.findFiles?.('.', { glob: 'f*' });
  expect(found?.files).toHaveLength(200);
  expect(found?.stats).toMatchObject({ incomplete: true, limit: 'matches' });
});

it('preserves a UTF-8 BOM and seeks a bounded byte range in a large file', async () => {
  const fs = capability();
  await writeFile(join(root, 'bom'), '\ufeffhello');
  expect((await fs.readFile('bom', {})).content).toBe('\ufeffhello');
  const large = Buffer.alloc(8 * 1024 * 1024 + 1, 97);
  large.write('needle', large.length - 6);
  await writeFile(join(root, 'large'), large);
  const result = await fs.readFile('large', {
    range: { unit: 'bytes', start: large.length - 6, end: large.length },
  });
  expect(result.content).toBe('needle');
  expect(result.sizeBytes).toBe(large.length);
  const scope = {};
  fs.acknowledgeReadResult?.(scope, result);
  fs.promoteReadScope?.(scope);
  const digest = createHash('sha256').update(large).digest('hex');
  expect(
    hasObservedRead(fs, scope, join(root, 'large'), digest, large.length - 6, large.length),
  ).toBe(false);
  large[large.length - 3] = 0;
  await writeFile(join(root, 'large'), large);
  await expect(
    fs.readFile('large', { range: { unit: 'bytes', start: large.length - 6, end: large.length } }),
  ).rejects.toThrow(/binary/);
  large[large.length - 3] = 0xff;
  await writeFile(join(root, 'large'), large);
  await expect(
    fs.readFile('large', { range: { unit: 'bytes', start: large.length - 6, end: large.length } }),
  ).rejects.toThrow(/UTF-8/);
  large[large.length - 3] = 0xc3;
  large[large.length - 2] = 0xa9;
  await writeFile(join(root, 'large'), large);
  await expect(
    fs.readFile('large', {
      range: { unit: 'bytes', start: large.length - 2, end: large.length - 2 },
    }),
  ).rejects.toThrow(/UTF-8/);
});

it('reports the list cap without fabricating an omitted count', async () => {
  for (let i = 0; i < 3; i++) await writeFile(join(root, `f${i}`), 'x');
  const fs = createNodeFsCapability({
    tier: 'sandboxed',
    workspaceDir: root,
    readOnly: true,
    maxGlobMatches: 2,
  });
  const listing = await fs.listDirectory('.', {});
  expect(listing.entries).toHaveLength(2);
  expect(listing).toMatchObject({ truncated: true, incomplete: true });
  expect(listing.omittedEntries).toBeNull();
  expect(listing.entryLimit).toBe(2);
});

it('allows an exact glob match cap and refuses the next matching file', async () => {
  await writeFile(join(root, 'a.txt'), 'a');
  await writeFile(join(root, 'b.txt'), 'b');
  await writeFile(join(root, 'unmatched'), 'x');
  const fs = createNodeFsCapability({
    tier: 'sandboxed',
    workspaceDir: root,
    readOnly: true,
    maxGlobMatches: 2,
  });
  expect((await fs.readFile('*.txt', { glob: true })).content).toContain('a');
  await writeFile(join(root, 'c.txt'), 'c');
  await expect(fs.readFile('*.txt', { glob: true })).rejects.toThrow(/limit/);
});

it('validates discovery strings using declared UTF-8 byte limits', async () => {
  const fs = capability();
  expect((await fs.findFiles?.('.', { glob: 'x'.repeat(4096) }))?.stats).toBeDefined();
  await expect(fs.findFiles?.('.', { glob: 'é'.repeat(2049) })).rejects.toThrow(/glob/);
  expect((await fs.searchFiles?.('.', { pattern: 'é'.repeat(512) }))?.stats).toBeDefined();
  await expect(fs.searchFiles?.('.', { pattern: 'é'.repeat(513) })).rejects.toThrow(/pattern/);
  await expect(fs.findFiles?.('x'.repeat(4097), { glob: '*' })).rejects.toThrow(/path/);
});

it('checks insensitive whole-word boundaries and excerpt position against original Unicode text', async () => {
  await writeFile(join(root, 'adjacent'), 'İNeedle\n𐐀Needle\n');
  await writeFile(join(root, 'found'), `${'İ'.repeat(2000)} Needle end\n`);
  const result = await capability().searchFiles?.('.', {
    pattern: 'needle',
    caseSensitive: false,
    wholeWord: true,
  });
  expect(result?.matches).toHaveLength(1);
  expect(result?.matches[0]?.path).toBe('found');
  expect(result?.matches[0]?.content).toContain('Needle');
});

it('visits a thousand ordinary files with a realistic root ignore file', async () => {
  const rules = Array.from({ length: 50 }, (_, i) => `ignored-directory-${i}/`).join('\n');
  await writeFile(join(root, '.gitignore'), rules);
  await Promise.all(
    Array.from({ length: 1000 }, (_, i) => writeFile(join(root, `file-${i}.txt`), 'x')),
  );
  const result = await capability().findFiles?.('.', { glob: '*.nomatch' });
  expect(result?.stats.entriesVisited).toBe(1001);
  expect(result?.stats.incomplete).toBe(false);
});

it('bounds adversarial matcher work and repeated non-word matches', async () => {
  await writeFile(join(root, 'long'), `${'x'.repeat(200000)}!`);
  const fs = capability();
  const bounded = await fs.searchFiles?.('.', { pattern: 'x'.repeat(100), wholeWord: true });
  expect(bounded?.stats).toMatchObject({ incomplete: true, limit: 'work' });
  const repeated = await fs.searchFiles?.('.', { pattern: 'x', wholeWord: true });
  expect(repeated?.matches).toEqual([]);
  expect(repeated?.stats.incomplete).toBe(false);
});
