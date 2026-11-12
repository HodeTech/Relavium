import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  captureFsStageInventory,
  FsStageInventoryError,
  normalizeNodeFsIdentity,
} from './fs-stage-inventory.js';
import { createSyntheticPinnedStage } from './fs-stage.test-support.js';
import { createNodeFsCapability } from './fs.js';
import { openLocalDb } from '../../db/open.js';
import { prepareGlobalPreferences } from '../../config/write.js';

let home: string;
let workspace: string;
let index: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'relavium-stage-index-')));
  workspace = join(home, 'project');
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(join(home, '.relavium-fs-private-v1'), { mode: 0o700 });
  index = join(home, '.relavium-fs-private-v1', 'fs-staging-v1');
  await mkdir(index, { mode: 0o700 });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it('protects the private index namespace and its opened objects independently of pinned stages', async () => {
  const lock = join(index, 'inventory.lock');
  const reservation = join(index, `${'a'.repeat(32)}.reserved`);
  await writeFile(lock, '', { mode: 0o600 });
  await writeFile(reservation, '', { mode: 0o600 });
  const inventory = await captureFsStageInventory(home);
  for (const path of [index, lock, reservation, join(index, 'uncreated', 'record')])
    expect(() => inventory.assertPath(path)).toThrow(FsStageInventoryError);
  for (const path of [index, lock, reservation]) {
    const identity = await stat(path, { bigint: true });
    expect(() => inventory.assertIdentity(identity)).toThrow(FsStageInventoryError);
  }
  expect(() =>
    inventory.assertPath(join(home, '.relavium-fs-private-v1-ordinary', 'out')),
  ).not.toThrow();
  expect(() => inventory.assertPath(join(workspace, 'ordinary'))).not.toThrow();
});

it('protects the canonical index namespace before it exists, including a home alias', async () => {
  await rm(index, { recursive: true });
  const alias = join(home, 'operator-home-alias');
  await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const inventory = await captureFsStageInventory(alias);
  for (const path of [
    index,
    join(index, 'new'),
    join(alias, '.relavium-fs-private-v1', 'fs-staging-v1'),
  ])
    expect(() => inventory.assertPath(path)).toThrow(FsStageInventoryError);
  expect(await readdir(join(home, '.relavium-fs-private-v1'))).toEqual([]);
});

it('rejects any retired index even when the dedicated index is missing', async () => {
  await rm(index, { recursive: true });
  const shared = join(home, '.relavium');
  await mkdir(shared);
  const inventory = await captureFsStageInventory(home);
  expect(() => inventory.assertPath(join(shared, 'fs-staging-v1', 'record'))).toThrow();
  expect(() => inventory.assertPath(join(home, '.relavium-fs-private-v1'))).toThrow();
  const legacy = join(shared, 'fs-staging-v1');
  await mkdir(legacy);
  await expect(captureFsStageInventory(home)).rejects.toThrow('operator recovery required');
  expect(await readdir(legacy)).toEqual([]);
  await rm(legacy, { recursive: true });
  await symlink(workspace, legacy, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(captureFsStageInventory(home)).rejects.toThrow('operator recovery required');
  expect((await stat(workspace)).isDirectory()).toBe(true);
});

it('publishes after real Home DB and configuration initialize the shared parent', async () => {
  await rm(join(home, '.relavium-fs-private-v1'), { recursive: true });
  const database = openLocalDb(home);
  database.close();
  prepareGlobalPreferences(
    { defaultModel: 'gpt-4o-mini', defaultProvider: 'openai' },
    home,
  ).publish();
  const shared = join(home, '.relavium');
  const before = await stat(shared, { bigint: true });
  const config = await readFile(join(shared, 'config.toml'));
  const db = await readFile(join(shared, 'history.db'));
  const capability = createNodeFsCapability({
    tier: 'full',
    workspaceDir: workspace,
    operatorHomeDir: home,
    readOnly: false,
  });
  const prepared = await capability.prepareWrite!({
    kind: 'write',
    path: 'target',
    content: 'reviewed',
  });
  try {
    await prepared.execute();
    expect(await readFile(join(workspace, 'target'), 'utf8')).toBe('reviewed');
    const after = await stat(shared, { bigint: true });
    expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode]);
    expect(await readFile(join(shared, 'config.toml'))).toEqual(config);
    expect(await readFile(join(shared, 'history.db'))).toEqual(db);
    expect((await stat(index)).isDirectory()).toBe(true);
    expect(await readdir(shared)).not.toContain('fs-staging-v1');
  } finally {
    await prepared.release();
  }
});

it.runIf(process.platform === 'win32')(
  'folds Windows index case, trailing-dot and alternate-stream spellings',
  async () => {
    const inventory = await captureFsStageInventory(home);
    for (const path of [index.toUpperCase(), `${index}.`, `${index}:stream`])
      expect(() => inventory.assertPath(path)).toThrow(FsStageInventoryError);
  },
);

it.skipIf(process.platform === 'win32')(
  'rejects an opened hard-link alias to a recorded stage and permits an ordinary file',
  async () => {
    const { stage, payload } = await createSyntheticPinnedStage(home, workspace);
    const alias = join(workspace, 'alias');
    const ordinary = join(workspace, 'ordinary');
    await link(payload, alias);
    await symlink(alias, join(workspace, 'indirect'));
    await writeFile(ordinary, 'ordinary');
    const ordinaryId = await stat(ordinary, { bigint: true });
    const inventory = await captureFsStageInventory(home);
    expect(() => inventory.assertIdentity(ordinaryId)).not.toThrow();
    const aliasId = await stat(alias, { bigint: true });
    expect(() => inventory.assertIdentity(aliasId)).toThrow(FsStageInventoryError);
    const stageId = await stat(stage, { bigint: true });
    expect(() => inventory.assertIdentity(stageId)).toThrow(FsStageInventoryError);
    const capability = createNodeFsCapability({
      tier: 'full',
      workspaceDir: workspace,
      operatorHomeDir: home,
      readOnly: true,
    });
    expect((await capability.readFile('ordinary', {})).content).toBe('ordinary');
    await expect(capability.readFile('alias', {})).rejects.toBeInstanceOf(FsStageInventoryError);
    await expect(capability.readFile('indirect', {})).rejects.toBeInstanceOf(FsStageInventoryError);
    await expect(capability.listDirectory('.', {})).rejects.toBeInstanceOf(FsStageInventoryError);
    await expect(capability.readFile('*', { glob: true })).rejects.toBeInstanceOf(
      FsStageInventoryError,
    );
    await expect(capability.findFiles?.('.', { glob: '*' })).rejects.toBeInstanceOf(
      FsStageInventoryError,
    );
    await expect(capability.searchFiles?.('.', { pattern: 'synthetic' })).rejects.toBeInstanceOf(
      FsStageInventoryError,
    );
    const writable = createNodeFsCapability({
      tier: 'full',
      workspaceDir: workspace,
      operatorHomeDir: home,
      readOnly: false,
    });
    await expect(writable.writeFile('alias', 'new', {})).rejects.toBeInstanceOf(
      FsStageInventoryError,
    );
  },
);

it.skipIf(process.platform === 'win32')(
  'fails closed on an incomplete ownership record',
  async () => {
    await writeFile(join(index, `${'a'.repeat(32)}.record`), '{', { mode: 0o600 });
    await expect(captureFsStageInventory(home)).rejects.toBeInstanceOf(FsStageInventoryError);
  },
);

it('never treats a relative or empty home as workspace authority', async () => {
  for (const invalid of ['', '.', 'relative-home'])
    await expect(captureFsStageInventory(invalid)).rejects.toBeInstanceOf(FsStageInventoryError);
});

it.skipIf(process.platform === 'win32')(
  'refuses oversized records and an insecure index directory',
  async () => {
    const path = join(index, `${'a'.repeat(32)}.record`);
    await writeFile(path, Buffer.alloc(16 * 1024 + 1), { mode: 0o600 });
    await expect(captureFsStageInventory(home)).rejects.toBeInstanceOf(FsStageInventoryError);
    await rm(path);
    await chmod(index, 0o755);
    await expect(captureFsStageInventory(home)).rejects.toBeInstanceOf(FsStageInventoryError);
  },
);

it.skipIf(process.platform === 'win32')(
  'permits ordinary reads during reserved and partially prepared pre-payload states',
  async () => {
    const nonce = 'a'.repeat(32);
    await writeFile(join(index, 'inventory.lock'), '', { mode: 0o600 });
    await writeFile(join(index, `${nonce}.reserved`), '', { mode: 0o600 });
    await writeFile(join(index, `${nonce}.prepare`), Buffer.from('partial'), { mode: 0o600 });
    const ordinary = join(workspace, 'ordinary');
    await writeFile(ordinary, 'ordinary');
    const inventory = await captureFsStageInventory(home);
    expect(() => inventory.assertIdentity({ dev: 1n, ino: 1n })).not.toThrow();
    const capability = createNodeFsCapability({
      tier: 'full',
      workspaceDir: workspace,
      operatorHomeDir: home,
      readOnly: true,
    });
    expect((await capability.readFile('ordinary', {})).content).toBe('ordinary');
  },
);

it.skipIf(process.platform === 'win32')(
  'bounds distinct reservations without treating transition files as extra records',
  async () => {
    for (let value = 0; value < 128; value++) {
      const nonce = value.toString(16).padStart(32, '0');
      await writeFile(join(index, `${nonce}.reserved`), '', { mode: 0o600 });
      await writeFile(join(index, `${nonce}.prepare`), Buffer.alloc(16 * 1024), { mode: 0o600 });
    }
    await expect(captureFsStageInventory(home)).resolves.toBeDefined();
    await writeFile(join(index, `${'f'.repeat(32)}.reserved`), '', { mode: 0o600 });
    await expect(captureFsStageInventory(home)).rejects.toBeInstanceOf(FsStageInventoryError);
  },
);

it.skipIf(process.platform === 'win32')(
  'rejects reserved bytes, unknown entries, linked records and an aliased index',
  async () => {
    const path = join(index, `${'a'.repeat(32)}.reserved`);
    await writeFile(path, 'unexpected', { mode: 0o600 });
    await expect(captureFsStageInventory(home)).rejects.toBeInstanceOf(FsStageInventoryError);
    await rm(path);
    const unknown = join(index, 'unexpected');
    await writeFile(unknown, '', { mode: 0o600 });
    await expect(captureFsStageInventory(home)).rejects.toBeInstanceOf(FsStageInventoryError);
    await rm(unknown);
    await writeFile(path, '', { mode: 0o600 });
    await link(path, join(workspace, 'record-alias'));
    await expect(captureFsStageInventory(home)).rejects.toBeInstanceOf(FsStageInventoryError);
    await rm(path);
    await rm(index, { recursive: true });
    const replacement = join(home, 'replacement');
    await mkdir(replacement, { mode: 0o700 });
    await symlink(replacement, index);
    await expect(captureFsStageInventory(home)).rejects.toBeInstanceOf(FsStageInventoryError);
  },
);

it('normalizes only bounded Windows signed-inode values without changing POSIX semantics', () => {
  const high = (1n << 63n) + 31n;
  expect(normalizeNodeFsIdentity({ dev: 7n, ino: high - (1n << 64n) }, 'win32')).toEqual({
    dev: 7n,
    ino: high,
  });
  expect(normalizeNodeFsIdentity({ dev: 0xffff_ffffn, ino: -1n }, 'win32')).toEqual({
    dev: 0xffff_ffffn,
    ino: (1n << 64n) - 1n,
  });
  expect(normalizeNodeFsIdentity({ dev: 0n, ino: 12n }, 'win32')).toEqual({ dev: 0n, ino: 12n });
  for (const identity of [
    { dev: -1n, ino: 1n },
    { dev: 1n << 32n, ino: 1n },
    { dev: 1n, ino: -(1n << 63n) - 1n },
    { dev: 1n, ino: 1n << 64n },
  ])
    expect(() => normalizeNodeFsIdentity(identity, 'win32')).toThrow(FsStageInventoryError);
  const posix = { dev: 1n << 80n, ino: -(1n << 90n) };
  expect(normalizeNodeFsIdentity(posix, 'linux')).toBe(posix);
  expect(normalizeNodeFsIdentity(posix, 'darwin')).toBe(posix);
});

it.skipIf(process.platform === 'win32')(
  'denies a synthetic Windows high-bit inode alias in both signed and unsigned Node forms',
  async () => {
    await createSyntheticPinnedStage(home, workspace);
    const name = (await readdir(index)).find((entry) => entry.endsWith('.record'));
    if (!name) throw new Error('fixture record missing');
    const path = join(index, name);
    const original = await readFile(path);
    const oldOwnerLength = original.readUInt16LE(20);
    const locatorLength = original.readUInt16LE(22);
    const sid = Buffer.from('S-1-5-21-1');
    const record = Buffer.concat([
      original.subarray(0, 56),
      sid,
      original.subarray(56 + oldOwnerLength),
    ]);
    record.writeUInt16LE(sid.length, 20);
    const payloadIdentity = 56 + sid.length + locatorLength + 80;
    const unsignedIno = (1n << 63n) + 99n;
    record.writeBigUInt64LE(17n, payloadIdentity + 24);
    record.writeBigUInt64LE(unsignedIno, payloadIdentity + 32);
    await writeFile(path, record);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platform) throw new Error('platform descriptor unavailable');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const inventory = await captureFsStageInventory(home);
      expect(() => inventory.assertIdentity({ dev: 17n, ino: unsignedIno })).toThrow(
        FsStageInventoryError,
      );
      expect(() => inventory.assertIdentity({ dev: 17n, ino: unsignedIno - (1n << 64n) })).toThrow(
        FsStageInventoryError,
      );
      expect(() => inventory.assertIdentity({ dev: 17n, ino: 55n })).not.toThrow();
      expect(() => inventory.assertIdentity({ dev: 17n, ino: 1n << 64n })).toThrow(
        FsStageInventoryError,
      );
      expect(() => inventory.assertIdentity({ dev: 1n << 32n, ino: 55n })).toThrow(
        FsStageInventoryError,
      );
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  },
);
