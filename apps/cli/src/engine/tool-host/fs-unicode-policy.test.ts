import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createNodeFsCapability, isProtectedPolicyPath } from './fs.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'rlv-unicode-policy-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it.each(['.ſsh', '.ſſh', '.baſhrc'])(
  'keeps Unicode aliases of protected labels denied: %s',
  async (name) => {
    // Long s has a case alias on case-insensitive APFS. Policy also conservatively denies it elsewhere.
    expect(isProtectedPolicyPath(join(root, name))).toBe(true);
    const fs = createNodeFsCapability({
      operatorHomeDir: root,
      tier: 'sandboxed',
      workspaceDir: root,
      readOnly: false,
    });
    await expect(
      fs.prepareWrite?.({ kind: 'write', path: name, content: 'no' }),
    ).rejects.toMatchObject({ code: 'tool_denied' });
  },
);

it('refuses credential reads when the real directory spelling contains a Unicode case alias', async () => {
  await mkdir(join(root, '.ſsh'));
  await writeFile(join(root, '.ſsh', 'canary'), 'SYNTHETIC_ALIAS_CANARY');
  const fs = createNodeFsCapability({
    operatorHomeDir: root,
    tier: 'sandboxed',
    workspaceDir: root,
    readOnly: true,
  });
  await expect(fs.readFile('.ſsh/canary', {})).rejects.toMatchObject({ code: 'tool_denied' });
  expect(await readFile(join(root, '.ſsh', 'canary'), 'utf8')).toBe('SYNTHETIC_ALIAS_CANARY');
  await writeFile(join(root, '普通-ſ.txt'), 'ordinary');
  expect((await fs.readFile('普通-ſ.txt', {})).content).toBe('ordinary');
});
