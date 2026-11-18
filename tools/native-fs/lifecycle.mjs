/** Fixed-purpose Node-API lifecycle fixtures. Only fresh owned temporary files are mutated. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout, setInterval } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NODE_LIFECYCLE_CASES } from './profile-catalog.mjs';
const require = createRequire(import.meta.url);
const MASK = process.platform === 'win32' ? undefined : process.umask();
const nonce = () => randomBytes(16).toString('hex');
let failureStage = 'addon-load';
function load(binary) {
  const addon = require(binary);
  for (const method of [
    'protocolVersion',
    'requiresCreationMaskProbe',
    'createWriteCancellation',
    'cancelWrite',
    'prepareExistingMetadata',
    'existingMetadataIdentity',
    'releaseExistingMetadata',
    'prepareNewMetadata',
    'releaseNewMetadata',
    'stageExistingMetadata',
    'stageNewMetadata',
    'publishMetadata',
    'releaseMetadataStage',
    'recoverMetadataStaging',
  ])
    assert.equal(typeof addon[method], 'function');
  assert.equal(addon.protocolVersion(), 1);
  assert.equal(typeof addon.requiresCreationMaskProbe(), 'boolean');
  if (process.platform !== 'darwin') assert.equal(addon.requiresCreationMaskProbe(), false);
  return addon;
}
async function fixture(addon, run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-node-metadata-')));
  if (process.platform !== 'win32') chmodSync(root, 0o700);
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const target = join(root, 'target');
  const releases = [];
  const own = (handle, method) => {
    releases.push({ handle, method });
    return handle;
  };
  let failure;
  try {
    await run({ root, home, target, own, token: addon.createWriteCancellation() });
  } catch (error) {
    failure = error;
  } finally {
    for (const { handle, method } of releases.reverse()) {
      try {
        assert.equal(await addon[method](handle), true);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}
function samePolicy(before, after) {
  if (process.platform !== 'win32')
    for (const key of ['uid', 'gid']) assert.equal(after[key], before[key]);
  if (process.platform !== 'win32') assert.equal(after.mode & 0o7777n, before.mode & 0o7777n);
}
function counts(value, removed, retained) {
  assert.deepEqual(Object.keys(value).sort(), ['removed', 'retained']);
  assert.equal(value.removed, removed);
  assert.equal(value.retained, retained);
}
async function stageExisting(addon, context, before, after, append = false) {
  const prepared = context.own(
    await addon.prepareExistingMetadata(context.target, append, MASK),
    'releaseExistingMetadata',
  );
  return context.own(
    await addon.stageExistingMetadata(
      prepared,
      context.home,
      before,
      after,
      nonce(),
      MASK,
      context.token,
    ),
    'releaseMetadataStage',
  );
}
async function stageNew(addon, context, after) {
  const prepared = context.own(
    await addon.prepareNewMetadata(context.target, MASK),
    'releaseNewMetadata',
  );
  return context.own(
    await addon.stageNewMetadata(prepared, context.home, after, nonce(), MASK, context.token),
    'releaseMetadataStage',
  );
}
async function orphanChild(binary, home, target) {
  const addon = load(binary);
  const before = readFileSync(target);
  const prepared = await addon.prepareExistingMetadata(target, false, MASK);
  await addon.stageExistingMetadata(
    prepared,
    home,
    before,
    Buffer.from('orphan payload'),
    nonce(),
    MASK,
    addon.createWriteCancellation(),
  );
  process.stdout.write('NATIVE_STAGE_READY\n');
  setInterval(() => {}, 1000);
  // An interrupted outer harness cannot leave this owned child alive indefinitely.
  setTimeout(() => process.exit(1), 30_000);
}
async function killedProducer(addon, binary, context) {
  writeFileSync(context.target, 'source before');
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), '--orphan', binary, context.home, context.target],
    { stdio: ['ignore', 'pipe', 'pipe'], shell: false },
  );
  let closed = false;
  let output = '';
  let stderr = '';
  const joined = new Promise((resolve) =>
    child.once('close', () => {
      closed = true;
      resolve();
    }),
  );
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('NATIVE_FS_LIFECYCLE_READY_TIMEOUT')), 20_000);
      child.once('error', reject);
      child.once('close', () => {
        if (output !== 'NATIVE_STAGE_READY\n') reject(new Error('NATIVE_FS_LIFECYCLE_EARLY_EXIT'));
      });
      child.stdout.on('data', (bytes) => {
        output += bytes.toString('utf8');
        if (output.length > 1024) reject(new Error('NATIVE_FS_LIFECYCLE_OUTPUT'));
        if (output === 'NATIVE_STAGE_READY\n') resolve();
      });
      child.stderr.on('data', (bytes) => {
        stderr += bytes.toString('utf8');
        if (stderr.length > 16 * 1024) reject(new Error('NATIVE_FS_LIFECYCLE_OUTPUT'));
      });
    });
    counts(await addon.recoverMetadataStaging(context.home, context.token), 0, 1);
    assert.equal(child.kill('SIGKILL'), true);
    await joined;
    counts(await addon.recoverMetadataStaging(context.home, context.token), 1, 0);
    assert.equal(readFileSync(context.target, 'utf8'), 'source before');
  } finally {
    clearTimeout(timer);
    if (!closed && child.pid !== undefined) child.kill('SIGKILL');
    await joined;
  }
}
export async function runLifecycle(binary) {
  binary = resolve(binary);
  failureStage = 'hardlink-create';
  // Real package-manager links, using the exact built inventory and actual addon.
  // The sibling fixture remains on the same filesystem and is removed before return.
  const assetDir = dirname(binary);
  const linkedDir = mkdtempSync(join(dirname(assetDir), '.relavium-native-links-'));
  let primaryFailed = false;
  try {
    for (const name of readdirSync(assetDir)) linkSync(join(assetDir, name), join(linkedDir, name));
    failureStage = 'hardlink-child';
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        'if (require(process.argv[1]).loadFsMetadataAddon().protocolVersion() !== 1) process.exit(1);',
        join(linkedDir, 'loader.cjs'),
      ],
      { shell: false, timeout: 30000, stdio: 'ignore' },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
    assert.ok(statSync(join(linkedDir, 'loader.cjs')).nlink > 1);
    assert.ok(statSync(join(linkedDir, 'native-assets.json')).nlink > 1);
    assert.ok(statSync(join(linkedDir, 'THIRD_PARTY_NOTICES.txt')).nlink > 1);
    assert.ok(statSync(join(linkedDir, basename(binary))).nlink > 1);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (!primaryFailed) failureStage = 'hardlink-cleanup';
    rmSync(linkedDir, { recursive: true, force: true });
  }
  failureStage = 'addon-load';
  const addon = load(binary);
  const cases = [];
  const run = async (name, work) => {
    assert.ok(NODE_LIFECYCLE_CASES.includes(name));
    failureStage = name;
    await fixture(addon, work);
    cases.push(name);
  };
  await run('existing-readonly-bigint-identity', async ({ root, target, own }) => {
    writeFileSync(target, 'before');
    const before = statSync(target, { bigint: true });
    const names = readdirSync(root).sort();
    const prepared = own(
      await addon.prepareExistingMetadata(target, false, MASK),
      'releaseExistingMetadata',
    );
    const identity = await addon.existingMetadataIdentity(prepared);
    assert.deepEqual(Object.keys(identity).sort(), ['dev', 'ino']);
    assert.equal(identity.dev, before.dev.toString());
    assert.equal(identity.ino, before.ino.toString());
    assert.deepEqual(readdirSync(root).sort(), names);
    assert.equal(readFileSync(target, 'utf8'), 'before');
    assert.equal(await addon.releaseExistingMetadata(prepared), true);
    await assert.rejects(addon.existingMetadataIdentity(prepared));
  });
  for (const append of [false, true])
    await run(
      append ? 'existing-append-exact-bytes' : 'existing-replace-exact-bytes',
      async (context) => {
        const before = Buffer.from('before\n');
        const after = Buffer.from(append ? 'before\nafter 🙂\n' : 'reviewed 🙂\n');
        writeFileSync(context.target, before);
        const policy = statSync(context.target, { bigint: true });
        const stage = await stageExisting(addon, context, before, after, append);
        assert.deepEqual(readFileSync(context.target), before);
        assert.equal(await addon.publishMetadata(stage, MASK, context.token), true);
        assert.deepEqual(readFileSync(context.target), after);
        samePolicy(policy, statSync(context.target, { bigint: true }));
        await assert.rejects(addon.publishMetadata(stage, MASK, context.token));
      },
    );
  await run('new-parent-inheritance', async (context) => {
    // Real Node creation deliberately retains the operating system's default policy.
    const shared = join(context.home, '.relavium');
    mkdirSync(shared);
    const config = join(shared, 'config.toml');
    writeFileSync(config, 'synthetic configuration');
    const sharedBefore = statSync(shared, { bigint: true });
    const retired = join(shared, 'fs-staging-v1');
    mkdirSync(retired);
    await assert.rejects(addon.recoverMetadataStaging(context.home, context.token), {
      message: 'RELAVIUM_NATIVE_WRITE:legacy_recovery_required:not_needed',
    });
    assert.equal(existsSync(join(context.home, '.relavium-fs-private-v1')), false);
    assert.deepEqual(readdirSync(retired), []);
    rmdirSync(retired);
    const direct = join(context.root, 'direct');
    writeFileSync(direct, 'direct');
    const policy = statSync(direct, { bigint: true });
    const after = Buffer.from('new reviewed bytes\n');
    const stage = await stageNew(addon, context, after);
    assert.equal(existsSync(context.target), false);
    assert.equal(await addon.publishMetadata(stage, MASK, context.token), true);
    assert.deepEqual(readFileSync(context.target), after);
    samePolicy(policy, statSync(context.target, { bigint: true }));
    const sharedAfter = statSync(shared, { bigint: true });
    assert.equal(sharedAfter.dev, sharedBefore.dev);
    assert.equal(sharedAfter.ino, sharedBefore.ino);
    samePolicy(sharedBefore, sharedAfter);
    assert.equal(readFileSync(config, 'utf8'), 'synthetic configuration');
    assert.equal(existsSync(join(context.home, '.relavium-fs-private-v1', 'fs-staging-v1')), true);
    assert.equal(existsSync(retired), false);
  });
  await run('new-no-clobber', async (context) => {
    const stage = await stageNew(addon, context, Buffer.from('reviewed'));
    writeFileSync(context.target, 'competing creator', { flag: 'wx' });
    await assert.rejects(addon.publishMetadata(stage, MASK, context.token));
    assert.equal(readFileSync(context.target, 'utf8'), 'competing creator');
  });
  await run('existing-byte-change-refusal', async (context) => {
    writeFileSync(context.target, 'before');
    const prepared = context.own(
      await addon.prepareExistingMetadata(context.target, false, MASK),
      'releaseExistingMetadata',
    );
    writeFileSync(context.target, 'external change');
    await assert.rejects(
      addon.stageExistingMetadata(
        prepared,
        context.home,
        Buffer.from('before'),
        Buffer.from('reviewed'),
        nonce(),
        MASK,
        context.token,
      ),
    );
    assert.equal(readFileSync(context.target, 'utf8'), 'external change');
  });
  await run('cancel-before-stage', async (context) => {
    const prepared = context.own(
      await addon.prepareNewMetadata(context.target, MASK),
      'releaseNewMetadata',
    );
    addon.cancelWrite(context.token);
    await assert.rejects(
      addon.stageNewMetadata(
        prepared,
        context.home,
        Buffer.from('reviewed'),
        nonce(),
        MASK,
        context.token,
      ),
    );
    assert.equal(existsSync(context.target), false);
  });
  await run('cancel-before-publish', async (context) => {
    const stage = await stageNew(addon, context, Buffer.from('reviewed'));
    addon.cancelWrite(context.token);
    await assert.rejects(addon.publishMetadata(stage, MASK, context.token));
    assert.equal(existsSync(context.target), false);
  });
  await run('live-producer-recovery-retains', async (context) => {
    await stageNew(addon, context, Buffer.from('reviewed'));
    counts(await addon.recoverMetadataStaging(context.home, context.token), 0, 1);
    assert.equal(existsSync(context.target), false);
  });
  await run('cancelled-recovery-retains', async (context) => {
    await stageNew(addon, context, Buffer.from('reviewed'));
    const cancelled = addon.createWriteCancellation();
    addon.cancelWrite(cancelled);
    await assert.rejects(addon.recoverMetadataStaging(context.home, cancelled));
    counts(await addon.recoverMetadataStaging(context.home, context.token), 0, 1);
  });
  await run('killed-node-producer-recovery', async (context) =>
    killedProducer(addon, binary, context),
  );
  assert.deepEqual(cases, NODE_LIFECYCLE_CASES);
  return { version: 1, cases, requiresCreationMaskProbe: addon.requiresCreationMaskProbe() };
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--orphan' && process.argv.length === 6)
      await orphanChild(process.argv[3], process.argv[4], process.argv[5]);
    else if (process.argv.length === 3)
      console.log(JSON.stringify(await runLifecycle(process.argv[2])));
    else throw new Error('NATIVE_FS_LIFECYCLE_ARGUMENTS');
  } catch {
    console.error(`NATIVE_FS_LIFECYCLE_STAGE:${failureStage}`);
    console.error('NATIVE_FS_LIFECYCLE_FAILED');
    process.exitCode = 1;
  }
}
