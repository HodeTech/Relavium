import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSessionOutputStore,
  SESSION_OUTPUT_LIMITS,
  SessionOutputStoreError,
  type SessionOutputStore,
} from './session-output-store.js';

const MODEL_LIMITS = { maxBytes: 32, maxLines: 2 };
let home: string;
let stores: SessionOutputStore[];
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'relavium-output-store-')));
  stores = [];
});
afterEach(async () => {
  await Promise.allSettled(stores.map((store) => store.close()));
  await rm(home, { recursive: true, force: true });
});
async function create(
  options: Omit<Parameters<typeof createSessionOutputStore>[0], 'homeDir'> = {},
): Promise<SessionOutputStore> {
  const store = await createSessionOutputStore({ homeDir: home, ...options });
  stores.push(store);
  return store;
}
const parent = (): string => join(home, '.relavium', 'session-outputs-v1');
async function rootOf(store: SessionOutputStore): Promise<string> {
  const spilled = await store.spill('root probe', MODEL_LIMITS);
  const instance = spilled.ref.split('/')[2];
  const name = (await readdir(parent())).find((entry) => entry.endsWith(`.${instance}`));
  if (name === undefined) throw new SessionOutputStoreError('io');
  return join(parent(), name);
}
function gate(): { entered: Promise<void>; wait: () => Promise<void>; release: () => void } {
  let enter = (): void => {};
  let release = (): void => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    wait: async () => {
      enter();
      await waiting;
    },
    release,
  };
}
async function orphan(pid: number, unexpected = false): Promise<string> {
  await mkdir(parent(), { recursive: true, mode: 0o700 });
  const instance = randomUUID();
  const root = join(parent(), `output-v1.${pid}.${instance}`);
  await mkdir(root, { mode: 0o700 });
  const info = await lstat(root, { bigint: true });
  await writeFile(
    join(root, '.owner.json'),
    JSON.stringify({
      version: 1,
      pid,
      instance,
      dev: info.dev.toString(),
      ino: info.ino.toString(),
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, unexpected ? 'unmarked.txt' : `${randomUUID()}.txt`),
    'orphan private content',
    { mode: 0o600 },
  );
  return root;
}

describe('private session-instance output store', () => {
  it('seals admission and reports uncertainty when the first native temp fstat fails', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--import',
        new URL('../fixtures/usage-coverage-crash-register.mjs', import.meta.url).href,
        '--input-type=module',
        '-e',
        `
          import fs from 'node:fs/promises';
          import {syncBuiltinESMExports} from 'node:module';
          import {join} from 'node:path';
          const originalOpen = fs.open;
          let inject = true;
          fs.open = async (...args) => {
            const handle = await originalOpen(...args);
            if (inject && String(args[0]).endsWith('.tmp'))
              handle.stat = async () => { throw Object.assign(new Error('fixture fstat fault'), {code: 'EIO'}); };
            return handle;
          };
          syncBuiltinESMExports();
          const {createSessionOutputStore} = await import(${JSON.stringify(new URL('./session-output-store.ts', import.meta.url).href)});
          const store = await createSessionOutputStore({homeDir: process.argv[1], limits: {files: 2}});
          const failures = [];
          for (let index = 0; index < 3; index++) {
            try { await store.spill('fixture private bytes', {}); }
            catch (error) { failures.push({reason: error.reason, cleanupUncertain: error.cleanupUncertain}); }
          }
          inject = false;
          let retry;
          try { await store.spill('healthy fixture bytes', {}); retry = 'succeeded'; }
          catch (error) { retry = error.reason; }
          const parent = join(process.argv[1], '.relavium', 'session-outputs-v1');
          const root = join(parent, (await fs.readdir(parent))[0]);
          const temps = (await fs.readdir(root)).filter(name => name.endsWith('.tmp')).length;
          let close;
          try { await store.close(); close = 'succeeded'; }
          catch (error) { close = error.reason; }
          process.stdout.write(JSON.stringify({failures, temps, retry, close}));
        `,
        home,
      ],
      { encoding: 'utf8', timeout: 4000 },
    );
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(
      JSON.stringify({
        failures: [
          { reason: 'io', cleanupUncertain: true },
          { reason: 'closed', cleanupUncertain: false },
          { reason: 'closed', cleanupUncertain: false },
        ],
        temps: 1,
        retry: 'closed',
        close: 'cleanup',
      }),
    );
  });

  it('rolls back a failed initializer before marker publication and allows a clean retry', async () => {
    let attempts = 0;
    const options = {
      testHooks: {
        afterMarkerOpen: async (): Promise<void> => {
          attempts++;
          if (attempts !== 1) return;
          const rootName = (await readdir(parent()))[0];
          if (rootName === undefined) throw new SessionOutputStoreError('io');
          const root = join(parent(), rootName);
          expect(await readFile(join(root, '.owner.json'), 'utf8')).toBe('');
          // Simulate a failed partial metadata write using the already captured exclusive inode.
          await writeFile(join(root, '.owner.json'), '{"version":');
          throw new SessionOutputStoreError('quota');
        },
      },
    };
    await expect(create(options)).rejects.toMatchObject({
      reason: 'quota',
      message: 'session output store: quota',
      cleanupUncertain: false,
    });
    expect(await readdir(parent())).toEqual([]);
    expect((await lstat(parent())).isDirectory()).toBe(true);
    expect((await lstat(join(home, '.relavium'))).isDirectory()).toBe(true);
    const store = await create(options);
    const output = await store.spill('healthy retry', MODEL_LIMITS);
    expect((await store.read(output.ref, {})).content).toBe('healthy retry');
  });

  it('retains aliased initializer markers and preserves the primary safe failure', async () => {
    const alias = join(home, 'initializer-marker-alias');
    let failedRoot: string | undefined;
    await expect(
      create({
        testHooks: {
          afterMarkerOpen: async () => {
            const rootName = (await readdir(parent()))[0];
            if (rootName === undefined) throw new SessionOutputStoreError('io');
            failedRoot = join(parent(), rootName);
            await link(join(failedRoot, '.owner.json'), alias);
            throw new SessionOutputStoreError('quota');
          },
        },
      }),
    ).rejects.toMatchObject({
      reason: 'quota',
      message: 'session output store: quota',
      cleanupUncertain: true,
    });
    if (failedRoot === undefined) throw new SessionOutputStoreError('io');
    expect(await readdir(failedRoot)).toEqual(['.owner.json']);
    expect(await readFile(alias, 'utf8')).toBe('');
    expect((await lstat(alias)).nlink).toBe(2);
    const retry = await create();
    expect(retry.startupSweep).toMatchObject({ removed: 0, retained: 1 });
    expect((await lstat(failedRoot)).isDirectory()).toBe(true);
  });

  it('retains foreign entries during initializer rollback without deleting its own marker', async () => {
    let failedRoot: string | undefined;
    await expect(
      create({
        testHooks: {
          afterMarkerOpen: async () => {
            const rootName = (await readdir(parent()))[0];
            if (rootName === undefined) throw new SessionOutputStoreError('io');
            failedRoot = join(parent(), rootName);
            await writeFile(join(failedRoot, 'foreign'), 'preserved foreign bytes', {
              mode: 0o600,
            });
            throw new Error('native initializer path and secret bytes');
          },
        },
      }),
    ).rejects.toMatchObject({
      reason: 'io',
      message: 'session output store: io',
      cleanupUncertain: true,
    });
    if (failedRoot === undefined) throw new SessionOutputStoreError('io');
    expect((await readdir(failedRoot)).sort()).toEqual(['.owner.json', 'foreign']);
    expect(await readFile(join(failedRoot, 'foreign'), 'utf8')).toBe('preserved foreign bytes');
    const retry = await create();
    expect(retry.startupSweep).toMatchObject({ removed: 0, retained: 1 });
    expect(await readFile(join(failedRoot, 'foreign'), 'utf8')).toBe('preserved foreign bytes');
  });

  it('returns opaque refs, reads Unicode, and gives concurrent same-process instances distinct custody', async () => {
    const [first, second] = await Promise.all([create(), create()]);
    const [one, two] = await Promise.all([
      first.spill('hello λ\nnext\n', MODEL_LIMITS),
      second.spill('other', MODEL_LIMITS),
    ]);
    expect(one.ref).toMatch(/^output:\/\/[0-9a-f-]+\/[0-9a-f-]+$/);
    expect(one.ref).not.toContain(home);
    expect(one.byteLength).toBe(Buffer.byteLength('hello λ\nnext\n'));
    expect((await first.read(one.ref, {})).content).toBe('hello λ\nnext\n');
    await expect(second.read(one.ref, {})).rejects.toMatchObject({ reason: 'invalid_ref' });
    await first.close();
    expect((await second.read(two.ref, {})).content).toBe('other');
    expect(second.startupSweep.removed).toBe(0);
  });

  it('creates private regular one-link files and 0700 directories on POSIX', async () => {
    const store = await create();
    const root = await rootOf(store);
    for (const dir of [join(home, '.relavium'), parent(), root]) {
      const info = await lstat(dir);
      expect(info.isDirectory()).toBe(true);
      if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o700);
    }
    for (const entry of await readdir(root)) {
      const info = await lstat(join(root, entry));
      expect(info.isFile()).toBe(true);
      expect(info.nlink).toBe(1);
      if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);
    }
  });

  it('slices inclusive lines and exclusive UTF-8 byte ranges with explicit omitted bytes', async () => {
    const store = await create();
    const text = 'a\r\nλ\nlast';
    const output = await store.spill(text, MODEL_LIMITS);
    expect(
      await store.read(output.ref, { range: { unit: 'lines', start: 2, end: 2 } }),
    ).toMatchObject({
      content: 'λ\n',
      sizeBytes: Buffer.byteLength(text),
      range: { unit: 'lines', start: 2, end: 2, startByte: 3, endByte: 6, omittedBytes: 7 },
    });
    expect(
      (await store.read(output.ref, { range: { unit: 'bytes', start: 3, end: 5 } })).content,
    ).toBe('λ');
    for (const range of [
      { unit: 'bytes', start: 4, end: 5 },
      { unit: 'bytes', start: 4, end: 4 },
      { unit: 'bytes', start: -1, end: 3 },
      { unit: 'bytes', start: 0, end: 100 },
      { unit: 'lines', start: 0, end: 1 },
      { unit: 'lines', start: 4, end: 4 },
    ] as const)
      await expect(store.read(output.ref, { range })).rejects.toMatchObject({
        reason: 'invalid_range',
      });
    await expect(store.read(output.ref, { glob: true })).rejects.toMatchObject({
      reason: 'invalid_range',
    });
  });

  it('preserves a ranged BOM and treats an empty file as zero source lines', async () => {
    const store = await create();
    const text = '\uFEFFx\n';
    const output = await store.spill(text, MODEL_LIMITS);
    expect(
      (await store.read(output.ref, { range: { unit: 'lines', start: 1, end: 1 } })).content,
    ).toBe(text);
    expect(
      (
        await store.read(output.ref, {
          range: { unit: 'bytes', start: 0, end: Buffer.byteLength(text) },
        })
      ).content,
    ).toBe(text);
    await expect(
      store.read(output.ref, { range: { unit: 'lines', start: 2, end: 2 } }),
    ).rejects.toMatchObject({ reason: 'invalid_range' });
    const empty = await store.spill('', MODEL_LIMITS);
    expect((await store.read(empty.ref, {})).content).toBe('');
    expect(
      (await store.read(empty.ref, { range: { unit: 'bytes', start: 0, end: 0 } })).content,
    ).toBe('');
    await expect(
      store.read(empty.ref, { range: { unit: 'lines', start: 1, end: 1 } }),
    ).rejects.toMatchObject({ reason: 'invalid_range' });
  });

  it('refuses malformed, arbitrary-path, guessed, and decorated references', async () => {
    const store = await create();
    const output = await store.spill('content', MODEL_LIMITS);
    for (const ref of [
      home,
      '../file',
      `${output.ref}?range=1`,
      output.ref.replace('output:', 'file:'),
      `output://${randomUUID()}/${randomUUID()}`,
      `${output.ref}/..`,
      output.ref.toUpperCase(),
    ])
      await expect(store.read(ref, {})).rejects.toMatchObject({ reason: 'invalid_ref' });
  });

  it('refuses NUL and invalid UTF-8 without returning replacement text', async () => {
    const store = await create();
    const nul = await store.spill('a\0b', MODEL_LIMITS);
    await expect(store.read(nul.ref, {})).rejects.toMatchObject({ reason: 'invalid_text' });
    const root = await rootOf(store);
    const output = await store.spill('ok', MODEL_LIMITS);
    const name = `${output.ref.split('/')[3]}.txt`;
    await writeFile(join(root, name), Buffer.from([0xff, 0xfe]));
    await expect(store.read(output.ref, {})).rejects.toMatchObject({ reason: 'invalid_text' });
  });

  it('reserves byte/file quotas before concurrent work, and releases failed reservations', async () => {
    const store = await create({ limits: { fileBytes: 4, totalBytes: 6, files: 2 } });
    await expect(store.spill('12345', MODEL_LIMITS)).rejects.toMatchObject({ reason: 'quota' });
    const results = await Promise.allSettled([
      store.spill('1234', MODEL_LIMITS),
      store.spill('1234', MODEL_LIMITS),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await store.spill('12', MODEL_LIMITS);
    await expect(store.spill('', MODEL_LIMITS)).rejects.toMatchObject({ reason: 'quota' });
    expect(SESSION_OUTPUT_LIMITS).toEqual({
      fileBytes: 16 * 1024 * 1024,
      totalBytes: 64 * 1024 * 1024,
      files: 64,
    });
  });

  it('publishes only complete files, retains pending writes, and joins them before close cleanup', async () => {
    const block = gate();
    const store = await create({ testHooks: { beforeWriteChunk: block.wait } });
    const write = store.spill('pending private output', MODEL_LIMITS);
    await block.entered;
    const rootName = (await readdir(parent()))[0];
    if (rootName === undefined) throw new SessionOutputStoreError('io');
    const root = join(parent(), rootName);
    expect((await readdir(root)).filter((name) => name.endsWith('.txt'))).toEqual([]);
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toHaveLength(1);
    let closed = false;
    const close = store.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(store.spill('new', MODEL_LIMITS)).rejects.toMatchObject({ reason: 'closed' });
    block.release();
    await write;
    await close;
    expect(await readdir(parent())).toEqual([]);
    await store.close();
  });

  it('joins admitted reads before deleting and seal refuses fresh reads', async () => {
    const block = gate();
    const store = await create({ testHooks: { beforeReadChunk: block.wait } });
    const output = await store.spill('reading', MODEL_LIMITS);
    const reading = store.read(output.ref, {});
    await block.entered;
    const close = store.close();
    await expect(store.read(output.ref, {})).rejects.toMatchObject({ reason: 'closed' });
    expect(await readdir(parent())).toHaveLength(1);
    block.release();
    expect((await reading).content).toBe('reading');
    await close;
    expect(await readdir(parent())).toEqual([]);
  });

  it('preserves the exact abort reason and removes partially written bytes before settling', async () => {
    const block = gate();
    let chunks = 0;
    const store = await create({
      testHooks: {
        beforeWriteChunk: async () => {
          if (++chunks === 2) await block.wait();
        },
      },
    });
    const controller = new AbortController();
    const reason = Object.freeze({ localAbort: true });
    const work = store.spill('x'.repeat(128 * 1024), MODEL_LIMITS, controller.signal);
    await block.entered;
    controller.abort(reason);
    block.release();
    await expect(work).rejects.toBe(reason);
    const rootName = (await readdir(parent()))[0];
    if (rootName === undefined) throw new SessionOutputStoreError('io');
    expect(await readdir(join(parent(), rootName))).toEqual(['.owner.json']);
    await store.spill('replacement', MODEL_LIMITS);
  });

  it('fails partial native publication without exposing partial files or raw errors', async () => {
    let chunks = 0;
    const store = await create({
      testHooks: {
        beforeWriteChunk: () => {
          if (++chunks === 2) throw new Error('private native path and secret content');
          return Promise.resolve();
        },
      },
    });
    await expect(store.spill('x'.repeat(128 * 1024), MODEL_LIMITS)).rejects.toMatchObject({
      reason: 'io',
      message: 'session output store: io',
    });
    const rootName = (await readdir(parent()))[0];
    if (rootName === undefined) throw new SessionOutputStoreError('io');
    expect(await readdir(join(parent(), rootName))).toEqual(['.owner.json']);
    const retry = await store.spill('healthy retry', MODEL_LIMITS);
    expect((await store.read(retry.ref, {})).content).toBe('healthy retry');
  });

  it('preserves exact read cancellation and joins the native producer', async () => {
    const block = gate();
    const store = await create({ testHooks: { beforeReadChunk: block.wait } });
    const output = await store.spill('read cancellation', MODEL_LIMITS);
    const controller = new AbortController();
    const reason = new SessionOutputStoreError('aborted');
    const reading = store.read(output.ref, {}, controller.signal);
    await block.entered;
    controller.abort(reason);
    const close = store.close();
    block.release();
    await expect(reading).rejects.toBe(reason);
    await close;
  });

  it('refuses symlink/hardlink substitutions for reads and cleanup without touching the outside target', async () => {
    for (const kind of ['symlink', 'hardlink'] as const) {
      const store = await create();
      const root = await rootOf(store);
      const output = await store.spill('owned', MODEL_LIMITS);
      const name = `${output.ref.split('/')[3]}.txt`;
      const outside = join(home, `${kind}-outside`);
      await writeFile(outside, 'outside protected bytes', { mode: 0o600 });
      await rm(join(root, name));
      if (kind === 'symlink') await symlink(outside, join(root, name));
      else await link(outside, join(root, name));
      await expect(store.read(output.ref, {})).rejects.toMatchObject({ reason: 'unsafe_path' });
      await expect(store.close()).rejects.toMatchObject({ reason: 'cleanup' });
      expect(await readFile(outside, 'utf8')).toBe('outside protected bytes');
      expect((await readdir(root)).includes('.owner.json')).toBe(true);
    }
  });

  it('revokes a moved/replaced root for publication, read, and deletion', async () => {
    const store = await create();
    const root = await rootOf(store);
    const output = await store.spill('owned', MODEL_LIMITS);
    const moved = `${root}-moved`;
    await rename(root, moved);
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, 'replacement'), 'do not delete', { mode: 0o600 });
    await expect(store.read(output.ref, {})).rejects.toMatchObject({ reason: 'unsafe_path' });
    await expect(store.spill('new', MODEL_LIMITS)).rejects.toMatchObject({ reason: 'unsafe_path' });
    await expect(store.close()).rejects.toMatchObject({ reason: 'cleanup' });
    expect(await readFile(join(root, 'replacement'), 'utf8')).toBe('do not delete');
    expect((await readdir(moved)).length).toBeGreaterThan(1);
  });

  it('refuses publication when a producer inode acquires a hard-link alias', async () => {
    const block = gate();
    const store = await create({ testHooks: { beforeWriteChunk: block.wait } });
    const spilling = store.spill('private producer bytes', MODEL_LIMITS);
    await block.entered;
    const rootName = (await readdir(parent()))[0];
    if (rootName === undefined) throw new SessionOutputStoreError('io');
    const root = join(parent(), rootName);
    const temp = (await readdir(root)).find((name) => name.endsWith('.tmp'));
    if (temp === undefined) throw new SessionOutputStoreError('io');
    const alias = join(home, 'producer-alias');
    await link(join(root, temp), alias);
    block.release();
    await expect(spilling).rejects.toMatchObject({ reason: 'unsafe_path' });
    expect((await readdir(root)).some((name) => name.endsWith('.txt'))).toBe(false);
    await expect(store.close()).rejects.toMatchObject({ reason: 'cleanup' });
    expect((await lstat(alias)).isFile()).toBe(true);
    await expect(store.spill('retry', MODEL_LIMITS)).rejects.toMatchObject({ reason: 'closed' });
  });

  it('refuses planted files during cleanup and returns one honest idempotent cleanup failure', async () => {
    const store = await create();
    const root = await rootOf(store);
    await writeFile(join(root, 'unmarked'), 'retain', { mode: 0o600 });
    const first = store.close();
    const second = store.close();
    expect(second).toBe(first);
    await expect(first).rejects.toMatchObject({ reason: 'cleanup' });
    expect(await readFile(join(root, 'unmarked'), 'utf8')).toBe('retain');
  });

  it('sweeps only marked, inode-matching dead owners and preserves live/reused/unknown ownership', async () => {
    const dead = await orphan(2000000001);
    const live = await orphan(process.pid);
    const unknown = await orphan(2000000002);
    const unmarked = await orphan(2000000003, true);
    const store = await create({
      testHooks: {
        ownerState: (pid) =>
          pid === 2000000001 || pid === 2000000003
            ? 'dead'
            : pid === process.pid
              ? 'live'
              : 'unknown',
      },
    });
    expect(store.startupSweep).toEqual({ removed: 1, retained: 3, incomplete: false });
    await expect(lstat(dead)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const root of [live, unknown, unmarked])
      expect((await lstat(root)).isDirectory()).toBe(true);
  });

  it('preserves inode-mismatched ownership markers and symlink/hardlink orphan children', async () => {
    const mismatched = await orphan(2000000001);
    const marker = await readFile(join(mismatched, '.owner.json'), 'utf8');
    await writeFile(join(mismatched, '.owner.json'), marker.replace(/"ino":"[^"]+"/, '"ino":"0"'));
    const linked = await orphan(2000000002);
    const outside = join(home, 'outside');
    await writeFile(outside, 'untouched', { mode: 0o600 });
    await link(outside, join(linked, `${randomUUID()}.txt`));
    const symlinked = await orphan(2000000003);
    await symlink(outside, join(symlinked, `${randomUUID()}.txt`));
    const store = await create({ testHooks: { ownerState: () => 'dead' } });
    expect(store.startupSweep).toEqual({ removed: 0, retained: 3, incomplete: false });
    expect(await readFile(outside, 'utf8')).toBe('untouched');
  });

  it('reclaims an actual crashed child producer while preserving a native live owner', async () => {
    await mkdir(parent(), { recursive: true, mode: 0o700 });
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs');
      const {join} = require('node:path');
      const {randomUUID} = require('node:crypto');
      const instance = randomUUID();
      const root = join(process.argv[1], 'output-v1.' + process.pid + '.' + instance);
      fs.mkdirSync(root, {mode: 0o700});
      const info = fs.lstatSync(root, {bigint: true});
      fs.writeFileSync(join(root, '.owner.json'), JSON.stringify({version: 1, pid: process.pid, instance, dev: info.dev.toString(), ino: info.ino.toString()}), {mode: 0o600});
      fs.writeFileSync(join(root, randomUUID() + '.tmp'), 'crashed bytes', {mode: 0o600});
      process.kill(process.pid, 'SIGKILL');
    `,
        parent(),
      ],
      { encoding: 'utf8' },
    );
    expect(child.signal).toBe('SIGKILL');
    const alive = await orphan(process.pid);
    const store = await create();
    expect(store.startupSweep).toEqual({ removed: 1, retained: 1, incomplete: false });
    expect((await lstat(alive)).isDirectory()).toBe(true);
  });

  it('bounds startup inspection and preserves unmarked directories', async () => {
    await mkdir(parent(), { recursive: true, mode: 0o700 });
    for (let index = 0; index < 130; index++)
      await mkdir(join(parent(), `unknown-${index}`), { mode: 0o700 });
    const store = await create();
    expect(store.startupSweep).toEqual({ removed: 0, retained: 128, incomplete: true });
    expect(await readdir(parent())).toHaveLength(131);
  });

  it('refuses a linked or permissive trusted anchor and keeps native errors content-free', async () => {
    const outside = join(home, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(home, '.relavium'));
    await expect(create()).rejects.toMatchObject({
      reason: 'unsafe_path',
      message: 'session output store: unsafe_path',
    });
    await rm(join(home, '.relavium'));
    if (process.platform !== 'win32') {
      await mkdir(join(home, '.relavium'), { mode: 0o755 });
      await expect(create()).rejects.toMatchObject({ reason: 'unsafe_path' });
    }
  });
});
