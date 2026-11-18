import { randomBytes } from 'node:crypto';
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
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  captureFsStageInventory,
  FsStageInventoryError,
  normalizeNodeFsIdentity,
} from './fs-stage-inventory.js';
import { createSyntheticPinnedStage } from './fs-stage.test-support.js';
import { createNodeFsCapability } from './fs.js';
import { loadNativeMetadataWriteAdapter } from './fs-native-metadata.js';
import { openLocalDb } from '../../db/open.js';
import { prepareGlobalPreferences } from '../../config/write.js';

// A committed record can vanish between the directory read and the lstat/open/re-lstat of it (a concurrent write
// completing removes its record). The window is microseconds wide, so the tests open it deterministically through the
// real calls: `decide` may delete the file just before the real call ('unlink') or fail it outright ('vanish').
type Decision = 'pass' | 'unlink' | 'vanish' | 'unlinkAfter' | 'replace' | 'nlink0';
const seam = vi.hoisted(() => ({
  decide: undefined as undefined | ((op: 'lstat' | 'open', name: string, call: number) => Decision),
  calls: new Map<string, number>(),
  log: [] as string[],
}));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  const intercept = async (op: 'lstat' | 'open', target: unknown): Promise<Decision> => {
    if (typeof target !== 'string' || !target.includes('fs-staging-v1')) return 'pass';
    const name = target.slice(target.lastIndexOf('/') + 1);
    const call = (seam.calls.get(`${op}:${name}`) ?? 0) + 1;
    seam.calls.set(`${op}:${name}`, call);
    seam.log.push(`${op}:${name}`);
    const decision = seam.decide?.(op, name, call) ?? 'pass';
    if (decision === 'unlink') {
      await native.unlink(target);
      seam.log.push(`unlink:${name}`);
    }
    if (decision === 'replace') {
      // The name stays, but another file (a new inode) takes it between the lstat and the open. The old
      // inode is kept alive by a hard link outside the scanned directory, so that it cannot be reused.
      await native.link(target, join(dirname(dirname(target)), `keeper-${name}`));
      await native.unlink(target);
      await native.writeFile(target, '', { mode: 0o600 });
      seam.log.push(`replace:${name}`);
    }
    if (decision === 'vanish')
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    return decision;
  };
  return {
    ...native,
    lstat: async (...args: Parameters<typeof native.lstat>) => {
      const decision = await intercept('lstat', args[0]);
      const stats = await native.lstat(...args);
      if (decision !== 'nlink0' || typeof args[0] !== 'string') return stats;
      // The entry is in the middle of being unlinked: `lstat` succeeds with a link count of zero (macOS), and
      // the file is gone by the time anything looks again.
      await native.unlink(args[0]);
      seam.log.push(`nlink0:${args[0].slice(args[0].lastIndexOf('/') + 1)}`);
      return Object.assign(
        Object.create(Object.getPrototypeOf(stats) as object) as typeof stats,
        stats,
        {
          nlink: 0n,
        },
      );
    },
    open: async (...args: Parameters<typeof native.open>) => {
      const decision = await intercept('open', args[0]);
      const handle = await native.open(...args);
      if (decision === 'unlinkAfter' && typeof args[0] === 'string') {
        // The entry disappears AFTER the real open succeeded: the reader now holds an unlinked file.
        await native.unlink(args[0]);
        seam.log.push(`unlinkAfter:${args[0].slice(args[0].lastIndexOf('/') + 1)}`);
      }
      return handle;
    },
    opendir: async (...args: Parameters<typeof native.opendir>) => {
      if (typeof args[0] === 'string' && args[0].endsWith('fs-staging-v1'))
        seam.log.push('opendir:index');
      return native.opendir(...args);
    },
  };
});

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
  seam.decide = undefined;
  seam.calls.clear();
  seam.log.length = 0;
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

it.runIf(process.platform === 'win32')(
  'bounds raw Windows component admission before an OS path lookup',
  async () => {
    const inventory = await captureFsStageInventory(home);
    for (const fill of [' ', '.']) {
      const target = join(workspace, `${fill.repeat(64 * 1024 - 1)}X`);
      const start = performance.now();
      expect(() => inventory.assertPath(target)).not.toThrow();
      expect(performance.now() - start, 'MVP3_WINDOWS_STAGE_ADMISSION_LINEAR').toBeLessThan(500);
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'protects v1 and v2 identities and refuses mismatched or unknown protocol pairs',
  async () => {
    const old = await createSyntheticPinnedStage(home, workspace);
    const newer = await createSyntheticPinnedStage(home, workspace);
    const records = (await readdir(index)).filter((name) => name.endsWith('.record'));
    const newPath = join(index, records[1]!);
    const newRecord = await readFile(newPath);
    newRecord.write('RVSTG002', 0, 'ascii');
    newRecord[8] = 2;
    await writeFile(newPath, newRecord);
    const inventory = await captureFsStageInventory(home);
    const awaitedIdentities = new Map(
      await Promise.all(
        [old.stage, old.payload, newer.stage, newer.payload].map(
          async (path) => [path, await stat(path, { bigint: true })] as const,
        ),
      ),
    );
    for (const path of [old.stage, old.payload, newer.stage, newer.payload]) {
      expect(() => inventory.assertIdentity(awaitedIdentities.get(path)!)).toThrow(
        FsStageInventoryError,
      );
    }
    for (const [magic, version] of [
      ['RVSTG001', 2],
      ['RVSTG002', 1],
      ['RVSTG003', 3],
    ] as const) {
      const bad = Buffer.from(newRecord);
      bad.write(magic, 0, 'ascii');
      bad[8] = version;
      await writeFile(newPath, bad);
      await expect(captureFsStageInventory(home)).rejects.toBeInstanceOf(FsStageInventoryError);
    }
  },
);

it('protects native-produced v2 records and rejects unknown native record versions', async () => {
  // This native interoperability fixture must let the adapter create its own
  // protected hierarchy; Node's mode alone cannot establish the Windows DACL.
  await rm(join(home, '.relavium-fs-private-v1'), { recursive: true });
  const adapter = await loadNativeMetadataWriteAdapter();
  const mask = process.platform === 'win32' ? undefined : process.umask();
  const prepared: unknown[] = [];
  const stages: unknown[] = [];
  const nonces = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')];
  const records = nonces.map((nonce) => join(index, `${nonce}.record`));
  const originals: Buffer[] = [];
  try {
    for (const [position, nonce] of nonces.entries()) {
      const entry = await adapter.prepareNewMetadata(
        join(workspace, `native-target-${position}`),
        mask,
      );
      prepared.push(entry);
      const stage = await adapter.stageNewMetadata(
        entry,
        home,
        Buffer.from('native payload'),
        nonce,
        mask,
        adapter.createWriteCancellation(),
      );
      stages.push(stage);
      originals.push(await readFile(records[position]!));
      expect(originals[position]!.subarray(0, 9)).toEqual(Buffer.from('RVSTG002\x02'));
    }
    // Preserve a native-produced body and identities while exercising the legacy wire pair.
    const legacy = Buffer.from(originals[0]!);
    legacy.write('RVSTG001', 0, 'ascii');
    legacy[8] = 1;
    await writeFile(records[0]!, legacy);
    const inventory = await captureFsStageInventory(home);
    for (const nonce of nonces) {
      const stage = join(workspace, `.relavium-fs-stage-v1.${process.pid}.${nonce}`);
      const stageIdentity = await stat(stage, { bigint: true });
      const payloadIdentity = await stat(join(stage, 'payload'), { bigint: true });
      expect(() => inventory.assertIdentity(stageIdentity)).toThrow(FsStageInventoryError);
      expect(() => inventory.assertIdentity(payloadIdentity)).toThrow(FsStageInventoryError);
    }
    const unknown = Buffer.from(originals[1]!);
    unknown.write('RVSTG003', 0, 'ascii');
    unknown[8] = 3;
    await writeFile(records[1]!, unknown);
    await expect(captureFsStageInventory(home)).rejects.toBeInstanceOf(FsStageInventoryError);
  } finally {
    for (const [position, bytes] of originals.entries()) await writeFile(records[position]!, bytes);
    for (const stage of stages.reverse()) await adapter.releaseMetadataStage(stage);
    for (const entry of prepared.reverse()) await adapter.releaseNewMetadata(entry);
  }
});

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
    // The native scan tolerates eight more nonces than the 128 a reservation may reach (a lockless pin can
    // overshoot), and so does this reader; the ninth is refused. The bytes stay at their bound throughout.
    for (let value = 128; value < 136; value++) {
      const nonce = value.toString(16).padStart(32, '0');
      await writeFile(join(index, `${nonce}.reserved`), '', { mode: 0o600 });
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

// Where in `captureEntry` a committed `.record` can vanish: the first lstat, the open, the post-read re-lstat.
const VANISH_WINDOWS = [
  { window: 'lstat', op: 'lstat', nth: 1 },
  { window: 'open', op: 'open', nth: 1 },
  { window: 're-lstat after the read', op: 'lstat', nth: 2 },
] as const;

describe.skipIf(process.platform === 'win32')('a committed record that vanishes mid-scan', () => {
  it.each(VANISH_WINDOWS)(
    'retries the whole scan once when it vanishes at the $window and still protects the survivor',
    async ({ op, nth }) => {
      const gone = await createSyntheticPinnedStage(home, workspace);
      const kept = await createSyntheticPinnedStage(home, workspace);
      const goneName = `${/\.([a-f0-9]{32})$/.exec(gone.stage)?.[1]}.record`;
      seam.decide = (callOp, name, call) =>
        name === goneName && callOp === op && call === nth ? 'unlink' : 'pass';
      const inventory = await captureFsStageInventory(home);
      // The vanish really happened, and the index was read AGAIN (a whole-scan retry, not a skipped entry).
      expect(seam.log).toContain(`unlink:${goneName}`);
      expect(seam.log.filter((entry) => entry === 'opendir:index')).toHaveLength(2);
      // The coherent second snapshot protects the surviving record's stage.
      for (const path of [kept.stage, kept.payload]) {
        const identity = await stat(path, { bigint: true });
        expect(() => inventory.assertIdentity(identity)).toThrow(FsStageInventoryError);
      }
    },
  );

  it("drops a pin the abandoned attempt took of the vanished record's own inode, keeping the survivor's", async () => {
    const gone = await createSyntheticPinnedStage(home, workspace);
    const kept = await createSyntheticPinnedStage(home, workspace);
    const nameOf = (stage: string): string => `${/\.([a-f0-9]{32})$/.exec(stage)?.[1]}.record`;
    const goneName = nameOf(gone.stage);
    // The record file's own identity is pinned (protectIdentity(before)) BEFORE the re-lstat that finds it gone, so
    // the abandoned attempt leaves a pin behind that the coherent retry must not inherit.
    const goneRecord = await stat(join(index, goneName), { bigint: true });
    const keptRecord = await stat(join(index, nameOf(kept.stage)), { bigint: true });
    seam.decide = (callOp, name, call) =>
      name === goneName && callOp === 'lstat' && call === 2 ? 'unlink' : 'pass';
    const inventory = await captureFsStageInventory(home);
    expect(seam.log).toContain(`unlink:${goneName}`);
    expect(seam.log.filter((entry) => entry === 'opendir:index')).toHaveLength(2);
    // The vanished record's inode is no longer protected: no stale pin from the abandoned snapshot.
    expect(() => inventory.assertIdentity(goneRecord)).not.toThrow();
    // The surviving record's own inode and its stage are protected by the retry's snapshot.
    for (const identity of [
      keptRecord,
      await stat(kept.stage, { bigint: true }),
      await stat(kept.payload, { bigint: true }),
    ])
      expect(() => inventory.assertIdentity(identity)).toThrow(FsStageInventoryError);
  });

  it.each(VANISH_WINDOWS)(
    'keeps the fatal inventory error, after a bounded number of scans, when it keeps vanishing at the $window',
    async ({ op, nth }) => {
      await createSyntheticPinnedStage(home, workspace);
      const target = (await readdir(index)).find((entry) => entry.endsWith('.record'));
      if (!target) throw new Error('fixture record missing');
      // Every scan reaches the same vanish point. The re-lstat is identified by ORDER (an lstat of the record after
      // its open in the same scan), not by call parity, so an extra lstat of the file cannot shift which one fails.
      let opened = false;
      seam.decide = (callOp, name) => {
        if (name !== target) return 'pass';
        if (callOp === 'open') {
          opened = true;
          return op === 'open' ? 'vanish' : 'pass';
        }
        const afterRead = opened;
        opened = false;
        if (op === 'open') return 'pass';
        return nth === 1 || afterRead ? 'vanish' : 'pass';
      };
      const failure = await captureFsStageInventory(home).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FsStageInventoryError);
      expect(failure).toMatchObject({
        message: 'filesystem staging inventory is unavailable or unsafe',
      });
      // Exactly SCAN_ATTEMPTS (3) whole scans: the first plus two retries, then the error stands.
      expect(seam.log.filter((entry) => entry === 'opendir:index')).toHaveLength(3);
    },
  );
});

it.skipIf(process.platform === 'win32')(
  'still tolerates a vanishing reservation or prepare file without a retry',
  async () => {
    const nonce = 'b'.repeat(32);
    await writeFile(join(index, `${nonce}.reserved`), '', { mode: 0o600 });
    await writeFile(join(index, `${nonce}.prepare`), '', { mode: 0o600 });
    seam.decide = (_op, name) =>
      name.endsWith('.reserved') || name.endsWith('.prepare') ? 'unlink' : 'pass';
    await expect(captureFsStageInventory(home)).resolves.toBeDefined();
    // Both injected unlinks really fired (so the tolerance below was exercised), and neither caused a second scan.
    expect(seam.log).toContain(`unlink:${nonce}.reserved`);
    expect(seam.log).toContain(`unlink:${nonce}.prepare`);
    expect(seam.log.filter((entry) => entry === 'opendir:index')).toHaveLength(1);
  },
);

it.skipIf(process.platform === 'win32')(
  'tolerates a reservation or prepare file that is unlinked after it was opened, without a retry',
  async () => {
    const nonce = 'c'.repeat(32);
    await writeFile(join(index, `${nonce}.reserved`), '', { mode: 0o600 });
    await writeFile(join(index, `${nonce}.prepare`), '', { mode: 0o600 });
    seam.decide = (op, name) =>
      op === 'open' && (name.endsWith('.reserved') || name.endsWith('.prepare'))
        ? 'unlinkAfter'
        : 'pass';
    await expect(captureFsStageInventory(home)).resolves.toBeDefined();
    // Both unlinks really happened after the open (so the reader held a link-count-zero file), and
    // neither made a second scan or a failure.
    expect(seam.log).toContain(`unlinkAfter:${nonce}.reserved`);
    expect(seam.log).toContain(`unlinkAfter:${nonce}.prepare`);
    expect(seam.log.filter((entry) => entry === 'opendir:index')).toHaveLength(1);
  },
);

it.skipIf(process.platform === 'win32')(
  'runs the whole scan again for a committed record that is unlinked after it was opened',
  async () => {
    const nonce = 'd'.repeat(32);
    await writeFile(join(index, `${nonce}.record`), 'not a record', { mode: 0o600 });
    seam.decide = (op, name) =>
      op === 'open' && name === `${nonce}.record` && !seam.log.includes(`unlinkAfter:${name}`)
        ? 'unlinkAfter'
        : 'pass';
    // The first scan loses the record under it and runs again; the second scan no longer lists it.
    await expect(captureFsStageInventory(home)).resolves.toBeDefined();
    expect(seam.log).toContain(`unlinkAfter:${nonce}.record`);
    expect(seam.log.filter((entry) => entry === 'opendir:index')).toHaveLength(2);
  },
);

it.skipIf(process.platform === 'win32')(
  'still refuses a reservation whose name is now held by another file, because the name is not absent',
  async () => {
    const nonce = 'e'.repeat(32);
    await writeFile(join(index, `${nonce}.reserved`), '', { mode: 0o600 });
    seam.decide = (op, name) => (op === 'open' && name.endsWith('.reserved') ? 'replace' : 'pass');
    await expect(captureFsStageInventory(home)).rejects.toBeInstanceOf(FsStageInventoryError);
    expect(seam.log).toContain(`replace:${nonce}.reserved`);
  },
);

it.skipIf(process.platform === 'win32')(
  'tolerates a reservation or prepare file whose lstat already reads link count zero, without a retry',
  async () => {
    const nonce = 'f'.repeat(32);
    await writeFile(join(index, `${nonce}.reserved`), '', { mode: 0o600 });
    await writeFile(join(index, `${nonce}.prepare`), '', { mode: 0o600 });
    seam.decide = (op, name) =>
      op === 'lstat' && (name.endsWith('.reserved') || name.endsWith('.prepare'))
        ? 'nlink0'
        : 'pass';
    await expect(captureFsStageInventory(home)).resolves.toBeDefined();
    expect(seam.log).toContain(`nlink0:${nonce}.reserved`);
    expect(seam.log).toContain(`nlink0:${nonce}.prepare`);
    expect(seam.log.filter((entry) => entry === 'opendir:index')).toHaveLength(1);
  },
);

it.skipIf(process.platform === 'win32')(
  'runs the whole scan again for a committed record whose lstat reads link count zero, at either lstat',
  async () => {
    for (const which of [1, 2]) {
      const nonce = which === 1 ? 'a'.repeat(32) : 'b'.repeat(32);
      seam.calls.clear();
      seam.log.length = 0;
      await writeFile(join(index, `${nonce}.record`), 'not a record', { mode: 0o600 });
      // Call 1 is the lstat before the open; call 2 is the final lstat after the read.
      seam.decide = (op, name, call) =>
        op === 'lstat' && name === `${nonce}.record` && call === which ? 'nlink0' : 'pass';
      await expect(captureFsStageInventory(home)).resolves.toBeDefined();
      expect(seam.log).toContain(`nlink0:${nonce}.record`);
      expect(seam.log.filter((entry) => entry === 'opendir:index')).toHaveLength(2);
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'tolerates a small overshoot of the nonce bound that the native scan tolerates, and refuses a larger one',
  async () => {
    const create = async (n: number): Promise<void> => {
      await writeFile(join(index, `${n.toString(16).padStart(32, '0')}.reserved`), '', {
        mode: 0o600,
      });
    };
    for (let n = 0; n < 136; n++) await create(n);
    await expect(captureFsStageInventory(home)).resolves.toBeDefined();
    await create(136);
    await expect(captureFsStageInventory(home)).rejects.toBeInstanceOf(FsStageInventoryError);
  },
);
