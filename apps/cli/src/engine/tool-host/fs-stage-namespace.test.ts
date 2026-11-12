import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  createNodeFsCapability,
  FS_STAGE_DIRECTORY,
  isProtectedPath,
  isSensitiveReadPath,
} from './fs.js';
import { nativeMetadataRuntimeRoots } from './fs-native-metadata.js';

let root: string;
const stageName = `${FS_STAGE_DIRECTORY}.1234-abcdef`;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'relavium-stage-floor-')));
  await mkdir(join(root, stageName));
  await writeFile(join(root, stageName, 'payload.txt'), 'PRIVATE_STAGE_SENTINEL');
  await writeFile(join(root, 'ordinary.txt'), 'ordinary');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('reserves the staging component under folded lexical path variants', () => {
  for (const component of [
    FS_STAGE_DIRECTORY,
    FS_STAGE_DIRECTORY.toUpperCase(),
    `${FS_STAGE_DIRECTORY}. `,
    `${FS_STAGE_DIRECTORY}:stream`,
    `${FS_STAGE_DIRECTORY}.1234-abcdef`,
  ]) {
    expect(isSensitiveReadPath(join(root, component, 'payload.txt'))).toBe(true);
    expect(isProtectedPath(join(root, component, 'payload.txt'))).toBe(true);
  }
  expect(isSensitiveReadPath(join(root, 'ordinary.txt'))).toBe(false);
});

it('requires an explicit operator home instead of skipping stage authority', async () => {
  const fs = createNodeFsCapability({ tier: 'sandboxed', workspaceDir: root, readOnly: true });
  await expect(fs.readFile('ordinary.txt', {})).rejects.toThrow(
    /filesystem staging inventory is unavailable or unsafe/,
  );
});

it('protects the host-derived native runtime from model writes', async () => {
  const fs = createNodeFsCapability({
    tier: 'full',
    workspaceDir: root,
    operatorHomeDir: root,
    readOnly: false,
  });
  for (const runtimeRoot of nativeMetadataRuntimeRoots)
    await expect(fs.writeFile(join(runtimeRoot, 'loader.cjs'), 'replace', {})).rejects.toThrow(
      /filesystem metadata runtime is protected/,
    );
});

it.each(['\ud800', '\udc00', '\ud800A'])(
  'refuses ill-formed UTF-16 in a target or proposed content before native loading',
  async (malformed) => {
    const fs = createNodeFsCapability({
      tier: 'sandboxed',
      workspaceDir: root,
      operatorHomeDir: root,
      readOnly: false,
    });
    await expect(
      fs.prepareWrite?.({ kind: 'write', path: malformed, content: 'ok' }),
    ).rejects.toMatchObject({
      reason: 'unsupported_text',
    });
    await expect(
      fs.prepareWrite?.({ kind: 'write', path: 'ordinary.txt', content: malformed }),
    ).rejects.toMatchObject({
      reason: 'unsupported_text',
    });
    await expect(
      fs.prepareWrite?.({
        kind: 'edit',
        path: 'ordinary.txt',
        oldString: 'ordinary',
        newString: malformed,
      }),
    ).rejects.toMatchObject({ reason: 'unsupported_text' });
    const prepared = await fs.prepareWrite?.({
      kind: 'write',
      path: 'ordinary.txt',
      content: 'valid 😀',
    });
    expect(prepared?.after).toBe('valid 😀');
    expect(await readFile(join(root, 'ordinary.txt'), 'utf8')).toBe('ordinary');
    await prepared?.execute();
    await prepared?.release();
    expect(await readFile(join(root, 'ordinary.txt'), 'utf8')).toBe('valid 😀');
  },
);

it('denies direct and canonical aliases while pruning listing, glob and discovery', async () => {
  await symlink(join(root, stageName), join(root, 'alias'), 'dir');
  const fs = createNodeFsCapability({
    tier: 'sandboxed',
    workspaceDir: root,
    operatorHomeDir: root,
    readOnly: false,
  });
  expect((await fs.readFile('ordinary.txt', {})).content).toBe('ordinary');
  await expect(fs.readFile(`${stageName}/payload.txt`, {})).rejects.toThrow();
  await expect(fs.readFile('alias/payload.txt', {})).rejects.toThrow();
  await expect(fs.writeFile(`${stageName}/payload.txt`, 'change', {})).rejects.toThrow();
  await fs.writeFile('ordinary.txt', 'change', {});
  expect(await readFile(join(root, 'ordinary.txt'), 'utf8')).toBe('change');
  const listing = await fs.listDirectory('.', { recursive: true });
  expect(listing.entries.map((entry) => entry.name)).toContain('ordinary.txt');
  expect(JSON.stringify(listing)).not.toContain(FS_STAGE_DIRECTORY);
  expect(JSON.stringify(listing)).not.toContain('payload.txt');
  const glob = await fs.readFile('**/*.txt', { glob: true });
  expect(glob.content).not.toContain('PRIVATE_STAGE_SENTINEL');
  const found = await fs.findFiles?.('.', { glob: '**/*' });
  expect(JSON.stringify(found)).not.toContain('payload.txt');
  const searched = await fs.searchFiles?.('.', { pattern: 'PRIVATE_STAGE_SENTINEL' });
  expect(searched?.matches).toEqual([]);
});
