import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { createNodeFsCapability } from './fs.js';
import { createFsPathPolicy } from './fs-policy.js';

vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  return {
    ...native,
    realpathSync: Object.assign(vi.fn(native.realpathSync), {
      native: native.realpathSync.native,
    }),
  };
});

let base: string | undefined;
afterEach(() => {
  if (base !== undefined) rmSync(base, { recursive: true, force: true });
});

it('FS_CAUSAL_NATIVE_CANONICAL_ROOT preserves native file access when the legacy resolver retains an alias', async () => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-native-canonical-')));
  const workspace = join(base, 'workspace');
  const alias = join(base, 'legacy-spelling');
  mkdirSync(workspace);
  symlinkSync(workspace, alias, 'junction');
  writeFileSync(join(workspace, 'ok.txt'), 'allowed');
  writeFileSync(join(base, 'outside.txt'), 'outside');

  // Windows' legacy walker can retain an 8.3 spelling while the native promise API
  // expands it. Reproduce that mismatch on every OS using a real alias, leaving
  // native canonicalization and all subsequent filesystem operations untouched.
  vi.mocked(realpathSync).mockReturnValue(alias);
  const fs = createNodeFsCapability({
    tier: 'sandboxed',
    workspaceDir: alias,
    pathPolicy: createFsPathPolicy({ workspaceDir: alias }),
    readOnly: false,
  });
  const content = await fs.readFile('ok.txt', {}).then(
    (result) => result.content,
    () => undefined,
  );
  expect(content, 'FS_CAUSAL_NATIVE_CANONICAL_ROOT').toBe('allowed');
  expect((await fs.listDirectory('.', {})).entries.map((entry) => entry.name)).toContain('ok.txt');
  await expect(fs.readFile('../outside.txt', {})).rejects.toThrow(/scope/);
  await expect(fs.writeFile('../outside.txt', 'no', {})).rejects.toThrow(/scope/);
  await expect(fs.writeFile('.azure/tokens', 'no', { createDirs: true })).rejects.toThrow(
    /credential|protected/,
  );
});
