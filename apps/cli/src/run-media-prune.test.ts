import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  linkSync,
  symlinkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { run } from './run.js';
import { captureIo } from './test-support.js';

const isolated = vi.hoisted(() => ({
  home: '',
  services: vi.fn(() => {
    throw new Error('PRIVATE_SERVICE_SENTINEL');
  }),
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => isolated.home,
}));
vi.mock('./secrets/os-keychain.js', () => ({ createOsKeychainStore: isolated.services }));
vi.mock('./db/open.js', () => ({ openLocalDb: isolated.services }));
vi.mock('./config/load.js', async (original) => ({
  ...(await original<typeof import('./config/load.js')>()),
  loadResolvedConfig: isolated.services,
  resolveHomeDir: isolated.services,
}));
vi.mock('./engine/catalog-refresh.js', async (original) => ({
  ...(await original<typeof import('./engine/catalog-refresh.js')>()),
  loadCachedCatalog: isolated.services,
}));

vi.mock('./engine/providers.js', async (original) => ({
  ...(await original<typeof import('./engine/providers.js')>()),
  createProviderResolver: isolated.services,
}));
vi.mock('./history/open.js', async (original) => ({
  ...(await original<typeof import('./history/open.js')>()),
  openHistoryStore: isolated.services,
}));

beforeEach(() => {
  isolated.home = mkdtempSync(join(tmpdir(), 'private-media-maintenance-'));
  isolated.services.mockClear();
});
afterEach(() => rmSync(isolated.home, { recursive: true, force: true }));
const nonce = '12345678-1234-4234-8234-123456789abc';
function legacy() {
  const root = join(isolated.home, '.relavium', 'media');
  mkdirSync(join(root, 'ab'), { recursive: true });
  const first = join(root, `stream.${nonce}.tmp`);
  const second = join(root, 'ab', `${'c'.repeat(62)}.${nonce}.tmp`);
  const nearby = join(root, `unrelated.${nonce}.tmp`);
  for (const file of [first, second, nearby]) writeFileSync(file, 'PRIVATE_BYTES_SENTINEL');
  return { root, first, second, nearby };
}
for (const flags of [
  [],
  ['--legacy-offline'],
  ['--force'],
  ['--legacy-offline=true', '--force'],
  ['--legacy-offline', '--force=true'],
  ['--legacy-offline', '--force=PRIVATE_ARGUMENT_SENTINEL'],
  ['--legacy-offline', '--force', 'PRIVATE_ARGUMENT_SENTINEL'],
]) {
  it(`MEDIA_MAINTENANCE_LAZY_REFUSAL: ${flags.join(' ') || 'no flags'} touches no service and deletes nothing`, async () => {
    const f = legacy();
    const io = captureIo();
    expect(
      await run(['node', 'relavium', 'media', 'prune-temporaries', ...flags], io.io),
      'MEDIA_MAINTENANCE_LAZY_REFUSAL',
    ).toBe(2);
    expect(existsSync(f.first)).toBe(true);
    expect(io.err()).not.toContain('PRIVATE_ARGUMENT_SENTINEL');
    expect(isolated.services, 'MEDIA_MAINTENANCE_LAZY_REFUSAL').toHaveBeenCalledTimes(0);
  });
}
for (const json of [false, true]) {
  it(`MEDIA_MAINTENANCE_CANONICAL_ROOT: real deletion and count-only output json=${json}`, async () => {
    const f = legacy();
    const io = captureIo();
    expect(
      await run(
        [
          'node',
          'relavium',
          'media',
          'prune-temporaries',
          '--legacy-offline',
          '--force',
          ...(json ? ['--json'] : []),
        ],
        io.io,
      ),
    ).toBe(0);
    expect(existsSync(f.first), 'MEDIA_MAINTENANCE_CANONICAL_ROOT').toBe(false);
    expect(existsSync(f.second), 'MEDIA_MAINTENANCE_CANONICAL_ROOT').toBe(false);
    expect(readFileSync(f.nearby, 'utf8')).toBe('PRIVATE_BYTES_SENTINEL');
    expect(isolated.services).toHaveBeenCalledTimes(0);
    expect(io.out()).not.toContain(isolated.home);
    expect(io.out()).not.toContain('PRIVATE_');
    if (json) expect(JSON.parse(io.out())).toMatchObject({ removed: 2, retained: 0 });
  });
}
it('MEDIA_MAINTENANCE_ABSENT: an absent CAS stays absent without any service access', async () => {
  const io = captureIo();
  expect(
    await run(
      ['node', 'relavium', 'media', 'prune-temporaries', '--legacy-offline', '--force'],
      io.io,
    ),
  ).toBe(0);
  expect(existsSync(join(isolated.home, '.relavium')), 'MEDIA_MAINTENANCE_ABSENT').toBe(false);
  expect(isolated.services).toHaveBeenCalledTimes(0);
});
it('MEDIA_MAINTENANCE_LIVE: a current new producer prevents every legacy deletion', async () => {
  const f = legacy();
  writeFileSync(join(f.root, `media-v1.${process.pid}.${nonce}.tmp`), 'live');
  const io = captureIo();
  expect(
    await run(
      ['node', 'relavium', 'media', 'prune-temporaries', '--legacy-offline', '--force'],
      io.io,
    ),
  ).toBe(2);
  expect(existsSync(f.first), 'MEDIA_MAINTENANCE_LIVE').toBe(true);
  expect(existsSync(f.second), 'MEDIA_MAINTENANCE_LIVE').toBe(true);
  expect(isolated.services).toHaveBeenCalledTimes(0);
});

it('MEDIA_MAINTENANCE_NATIVE_WRITER: an actual held producer survives refusal and then publishes', async () => {
  const f = legacy();
  const child = fork(
    fileURLToPath(new URL('./engine/fixtures/media-prune-producer.ts', import.meta.url)),
    [f.root],
    {
      execArgv: [
        '--experimental-strip-types',
        '--import',
        new URL('./engine/fixtures/media-prune-register.ts', import.meta.url).href,
      ],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let diagnostic = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostic += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const writing = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Synthetic producer readiness deadline')),
      5000,
    );
    child.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'stage' in message &&
        message.stage === 'writing'
      ) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`Synthetic producer exited: ${diagnostic}`));
    });
  });
  try {
    await writing;
    const io = captureIo();
    expect(
      await run(
        ['node', 'relavium', 'media', 'prune-temporaries', '--legacy-offline', '--force'],
        io.io,
      ),
      'MEDIA_MAINTENANCE_NATIVE_WRITER',
    ).toBe(2);
    expect(existsSync(f.first)).toBe(true);
    const done = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Synthetic producer completion deadline')),
        5000,
      );
      child.on('message', (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'done' in message &&
          message.done === true
        ) {
          clearTimeout(timer);
          resolve(message);
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Synthetic producer exited before completion'));
      });
    });
    child.send('release');
    const result = await done;
    if (typeof result !== 'object' || result === null || !('handle' in result))
      throw new Error('Missing native producer result');
    expect(result.handle, 'MEDIA_MAINTENANCE_NATIVE_WRITER').toMatch(/^media:\/\/sha256-/);
    await exited;
    expect(child.exitCode).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});

for (const kind of ['root', 'shard', 'file-symlink', 'hardlink'] as const) {
  it(`MEDIA_MAINTENANCE_CONTAINMENT: ${kind} preserves pinned-root rules and unrelated bytes`, async () => {
    const f = legacy();
    const outside = join(isolated.home, 'outside');
    mkdirSync(outside);
    const witness = join(outside, 'witness');
    writeFileSync(witness, 'PRIVATE_OUTSIDE_BYTES');
    if (kind === 'root') {
      rmSync(f.root, { recursive: true });
      symlinkSync(outside, f.root, 'dir');
    } else if (kind === 'shard') {
      rmSync(join(f.root, 'ab'), { recursive: true });
      symlinkSync(outside, join(f.root, 'ab'), 'dir');
    } else {
      rmSync(f.first);
      if (kind === 'hardlink') linkSync(witness, f.first);
      else symlinkSync(witness, f.first);
    }
    const io = captureIo();
    expect(
      await run(
        ['node', 'relavium', 'media', 'prune-temporaries', '--legacy-offline', '--force', '--json'],
        io.io,
      ),
      'MEDIA_MAINTENANCE_CONTAINMENT',
    ).toBe(kind === 'root' ? 0 : 9);
    // Initial root aliases are admitted and pinned by ADR-0105; linked descendants are refused.
    expect(readFileSync(witness, 'utf8')).toBe('PRIVATE_OUTSIDE_BYTES');
    expect(io.out() + io.err()).not.toContain(isolated.home);
    expect(io.out() + io.err()).not.toContain('PRIVATE_');
    expect(isolated.services).toHaveBeenCalledTimes(0);
  });
}
