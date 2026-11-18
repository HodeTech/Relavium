import { chmodSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNodeFsCapability } from './fs.js';
import * as nativeMetadata from './fs-native-metadata.js';
import type { NativeMetadataWriteAdapter } from './fs-native-metadata.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'relavium-native-handoff-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
function fixture() {
  const path = join(root, 'file');
  const adapter = {
    protocolVersion: () => 1,
    requiresCreationMaskProbe: vi.fn(() => false),
    createWriteCancellation: vi.fn(() => ({})),
    cancelWrite: vi.fn(),
    recoverMetadataStaging: vi.fn(() => Promise.resolve(undefined)),
    prepareExistingMetadata: vi.fn(() => Promise.resolve({})),
    existingMetadataIdentity: vi.fn(async () => {
      const info = await stat(path, { bigint: true });
      return { dev: info.dev.toString(), ino: info.ino.toString() };
    }),
    releaseExistingMetadata: vi.fn(() => Promise.resolve(undefined)),
    prepareNewMetadata: vi.fn(() => Promise.resolve({})),
    recheckNewMetadata: vi.fn(() => Promise.resolve(undefined)),
    releaseNewMetadata: vi.fn(() => Promise.resolve(undefined)),
    stageExistingMetadata: vi.fn(() => Promise.resolve({})),
    stageNewMetadata: vi.fn(() => Promise.resolve({})),
    publishMetadata: vi.fn(() => Promise.resolve(undefined)),
    releaseMetadataStage: vi.fn(() => Promise.resolve(undefined)),
  } satisfies NativeMetadataWriteAdapter;
  vi.spyOn(nativeMetadata, 'loadNativeMetadataWriteAdapter').mockResolvedValue(adapter);
  const fs = createNodeFsCapability({
    operatorHomeDir: root,
    tier: 'sandboxed',
    workspaceDir: root,
    readOnly: false,
  });
  return { path, adapter, fs };
}
it.each(['bytes', 'mode'] as const)(
  'rejects %s changing during native read-only preparation with the same identity',
  async (change) => {
    const f = fixture();
    await writeFile(f.path, 'old');
    await chmod(f.path, 0o600);
    f.adapter.prepareExistingMetadata.mockImplementation(async () => {
      if (change === 'bytes') await writeFile(f.path, 'bad');
      else await chmod(f.path, 0o640);
      return {};
    });
    await expect(
      f.fs.prepareWrite!({ kind: 'write', path: 'file', content: 'new' }),
    ).rejects.toMatchObject({ reason: 'stale_file' });
    expect(f.adapter.releaseExistingMetadata).toHaveBeenCalledOnce();
    expect(f.adapter.stageExistingMetadata).not.toHaveBeenCalled();
  },
);
it('rejects a changed original version before native policy capture', async () => {
  const f = fixture();
  await writeFile(f.path, 'old');
  await chmod(f.path, 0o600);
  f.adapter.requiresCreationMaskProbe.mockImplementationOnce(() => {
    chmodSync(f.path, 0o640);
    return false;
  });
  await expect(
    f.fs.prepareWrite!({ kind: 'write', path: 'file', content: 'new' }),
  ).rejects.toMatchObject({ reason: 'stale_file' });
  expect(f.adapter.prepareExistingMetadata).not.toHaveBeenCalled();
});
it('resolves the execution mask before the final strict version proof and native dispatch', async () => {
  const f = fixture();
  await writeFile(f.path, 'old');
  await chmod(f.path, 0o600);
  const prepared = await f.fs.prepareWrite!({ kind: 'write', path: 'file', content: 'new' });
  f.adapter.requiresCreationMaskProbe.mockImplementationOnce(() => {
    chmodSync(f.path, 0o640);
    return false;
  });
  await expect(prepared.execute()).rejects.toMatchObject({ reason: 'stale_file' });
  expect(f.adapter.stageExistingMetadata).not.toHaveBeenCalled();
  expect(await readFile(f.path, 'utf8')).toBe('old');
  await prepared.release();
});
it('resolves the execution mask before the final missing-target proof', async () => {
  const f = fixture();
  const prepared = await f.fs.prepareWrite!({ kind: 'write', path: 'file', content: 'new' });
  f.adapter.requiresCreationMaskProbe.mockImplementationOnce(() => {
    writeFileSync(f.path, 'winner');
    return false;
  });
  await expect(prepared.execute()).rejects.toMatchObject({ reason: 'stale_file' });
  expect(f.adapter.stageNewMetadata).not.toHaveBeenCalled();
  expect(await readFile(f.path, 'utf8')).toBe('winner');
  await prepared.release();
});
it('joins new-parent native preparation before the final missing-target proof', async () => {
  const f = fixture();
  const prepared = await f.fs.prepareWrite!({
    kind: 'write',
    path: 'parent/file',
    content: 'new',
    createDirs: true,
  });
  f.adapter.prepareNewMetadata.mockImplementationOnce(async () => {
    await writeFile(join(root, 'parent/file'), 'winner');
    return {};
  });
  await expect(prepared.execute()).rejects.toMatchObject({ reason: 'stale_file' });
  expect(f.adapter.stageNewMetadata).not.toHaveBeenCalled();
  expect(await readFile(join(root, 'parent/file'), 'utf8')).toBe('winner');
  await prepared.release();
});

it('keeps execution-mask failure after the claim on the fixed attention path', async () => {
  const f = fixture();
  await writeFile(f.path, 'old');
  const prepared = await f.fs.prepareWrite!({ kind: 'write', path: 'file', content: 'new' });
  f.adapter.requiresCreationMaskProbe.mockImplementationOnce(() => {
    throw new Error('private-mask-details');
  });
  await expect(prepared.execute()).rejects.toMatchObject({
    runErrorCode: 'effect_needs_attention',
    retryable: false,
    recoverable: false,
  });
  expect(f.adapter.stageExistingMetadata).not.toHaveBeenCalled();
  await prepared.release();
});
