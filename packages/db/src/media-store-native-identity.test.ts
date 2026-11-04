import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  type BigIntStats,
  type StatOptions,
} from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesystemMediaStore } from './media-store.js';
import { MediaStoreFilesystemError, MediaStorePaths } from './media-store-paths.js';
import { scanMediaFile } from './media-store-read.js';

interface IdentityFixture {
  readonly fakes: Map<string, bigint>;
  readonly mkdirs: string[];
  beforeLstat: ((path: string) => void) | undefined;
  afterOpen: ((path: string, file: FileHandle) => void) | undefined;
  substitute: (info: unknown, exact: BigIntStats | undefined) => void;
}

/**
 * POSIX inodes stay far below 2^53, so these cases substitute every identity the store reads: each real
 * (dev, ino) becomes 2^60 + k. Distinct substitutes stay distinct as bigints but share one Number (the
 * spacing there is 256), so a read without `{ bigint: true }` or a comparison through Number lets a real
 * replacement compare equal, as a 64-bit Windows file ID can.
 */
const fixture = vi.hoisted((): IdentityFixture => {
  const fakes = new Map<string, bigint>();
  return {
    fakes,
    mkdirs: [],
    beforeLstat: undefined,
    afterOpen: undefined,
    substitute: (info, exact) => {
      if (exact === undefined || typeof info !== 'object' || info === null || !('ino' in info))
        return;
      const key = `${exact.dev}:${exact.ino}`;
      const value = fakes.get(key) ?? (1n << 60n) + BigInt(fakes.size);
      fakes.set(key, value);
      Object.defineProperty(info, 'ino', {
        value: typeof info.ino === 'bigint' ? value : Number(value),
      });
    },
  };
});
vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  return {
    ...native,
    lstatSync: (...args: Parameters<typeof native.lstatSync>) => {
      fixture.beforeLstat?.(String(args[0]));
      const info = native.lstatSync(...args);
      fixture.substitute(info, native.lstatSync(args[0], { bigint: true, throwIfNoEntry: false }));
      return info;
    },
    statSync: (...args: Parameters<typeof native.statSync>) => {
      const info = native.statSync(...args);
      fixture.substitute(info, native.statSync(args[0], { bigint: true, throwIfNoEntry: false }));
      return info;
    },
  };
});
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return {
    ...native,
    open: async (...args: Parameters<typeof native.open>) => {
      const file = await native.open(...args);
      const stat = file.stat.bind(file);
      Object.defineProperty(file, 'stat', {
        configurable: true,
        value: async (options?: StatOptions) => {
          const info = await stat(options);
          fixture.substitute(info, await stat({ bigint: true }));
          return info;
        },
      });
      fixture.afterOpen?.(String(args[0]), file);
      return file;
    },
    mkdir: (...args: Parameters<typeof native.mkdir>) => {
      fixture.mkdirs.push(String(args[0]));
      return native.mkdir(...args);
    },
  };
});

const bytes = Buffer.from('exact native identity media fixtures');
const digest = createHash('sha256').update(bytes).digest('hex');
let base: string;
let root: string;
beforeEach(() => {
  fixture.fakes.clear();
  fixture.mkdirs.length = 0;
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-media-native-identity-')));
  root = join(base, 'store');
});
afterEach(() => {
  fixture.beforeLstat = undefined;
  fixture.afterOpen = undefined;
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

/** The fixture must make the original and its replacement collide as Numbers and only as Numbers. */
function expectNumberCollision(original: bigint, replacement: bigint): void {
  expect(replacement).not.toBe(original);
  expect(Number(replacement)).toBe(Number(original));
}

function refusal(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    if (error instanceof MediaStoreFilesystemError) return error.reason;
    throw error;
  }
}

async function outcome(action: Promise<unknown>): Promise<string> {
  return action.then(
    () => 'completed',
    (error: unknown) => (error instanceof MediaStoreFilesystemError ? error.reason : 'other'),
  );
}

/** An old producer temporary whose owner the sweep sees as gone. */
function abandonedTemporary(): string {
  mkdirSync(root, { mode: 0o700 });
  const source = join(root, `media-v1.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(source, new Uint8Array([5, 6]), { mode: 0o600 });
  age(source);
  return source;
}
function age(path: string): void {
  const old = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(path, old, old);
}
function absentOwners(onCheck: () => void = () => undefined): void {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    onCheck();
    throw Object.assign(new Error('fixture absent owner'), { code: 'ESRCH' });
  });
}

describe('the media store root pin compares exact native identities', () => {
  it('refuses a replaced root directory whose identity collides as a Number', () => {
    const paths = new MediaStorePaths(root);
    expect(paths.root(true)).toBe(root);
    const original = statSync(root, { bigint: true }).ino;
    // Keep the original alive so the platform cannot recycle its inode for the replacement.
    renameSync(root, `${root}-old`);
    mkdirSync(root);
    expectNumberCollision(original, statSync(root, { bigint: true }).ino);
    expect(
      refusal(() => paths.root(false)),
      'CAS_ROOT_PIN_PRECISION',
    ).toBe('unsafe_path');
  });

  it('refuses an unchanged root alias whose target was replaced (the canonical identity)', () => {
    const alias = join(base, 'alias');
    mkdirSync(root);
    symlinkSync(root, alias, 'junction');
    const paths = new MediaStorePaths(alias);
    expect(paths.root(false)).toBe(root);
    const original = statSync(root, { bigint: true }).ino;
    const entry = lstatSync(alias, { bigint: true }).ino;
    renameSync(root, `${root}-old`);
    mkdirSync(root);
    expectNumberCollision(original, statSync(root, { bigint: true }).ino);
    expect(lstatSync(alias, { bigint: true }).ino).toBe(entry);
    expect(
      refusal(() => paths.root(false)),
      'CAS_ROOT_PIN_PRECISION',
    ).toBe('unsafe_path');
  });

  it('refuses a replaced root alias whose target is unchanged (the entry identity)', () => {
    const alias = join(base, 'alias');
    mkdirSync(root);
    symlinkSync(root, alias, 'junction');
    const paths = new MediaStorePaths(alias);
    expect(paths.root(false)).toBe(root);
    const canonical = statSync(root, { bigint: true }).ino;
    const original = lstatSync(alias, { bigint: true }).ino;
    renameSync(alias, `${alias}-old`);
    symlinkSync(root, alias, 'junction');
    expectNumberCollision(original, lstatSync(alias, { bigint: true }).ino);
    expect(statSync(root, { bigint: true }).ino).toBe(canonical);
    expect(
      refusal(() => paths.root(false)),
      'CAS_ROOT_PIN_PRECISION',
    ).toBe('unsafe_path');
  });
});

describe('media ownership compares exact native identities', () => {
  it('refuses to publish a producer temporary replaced after its exclusive open', async () => {
    const store = new FilesystemMediaStore(root);
    const moved = join(base, 'producer-original');
    let temp: string | undefined;
    let identities: { original: bigint; replacement: bigint } | undefined;
    fixture.afterOpen = (path) => {
      if (!basename(path).startsWith('media-v1.')) return;
      fixture.afterOpen = undefined;
      temp = path;
      // The swap lands after the producer's exclusive open and before its first ownership check.
      renameSync(path, moved);
      writeFileSync(path, 'replacement', { mode: 0o600 });
      identities = {
        original: lstatSync(moved, { bigint: true }).ino,
        replacement: lstatSync(path, { bigint: true }).ino,
      };
    };
    const result = await outcome(store.put(bytes, 'audio/L16'));
    if (temp === undefined || identities === undefined)
      throw new Error('the producer was not swapped');
    expectNumberCollision(identities.original, identities.replacement);
    const left = existsSync(temp) ? readFileSync(temp, 'utf8') : undefined;
    const published = existsSync(join(root, digest.slice(0, 2), digest.slice(2)));
    expect({ result, left, published }, 'CAS_OWNED_IDENTITY_PRECISION').toEqual({
      result: 'unsafe_path',
      left: 'replacement',
      published: false,
    });
  });

  it('refuses to claim into a replaced claim directory', async () => {
    const source = abandonedTemporary();
    const moved = join(base, 'claim-original');
    let identities: { original: bigint; replacement: bigint } | undefined;
    // The sweep's first ownership check of its source runs after the claim directory is pinned.
    fixture.beforeLstat = (path) => {
      if (path !== source) return;
      const name = readdirSync(root).find((entry) => entry.startsWith('media-claim-v2.'));
      if (name === undefined) return;
      fixture.beforeLstat = undefined;
      const dir = join(root, name);
      const original = lstatSync(dir, { bigint: true }).ino;
      renameSync(dir, moved);
      mkdirSync(dir, { mode: 0o700 });
      identities = { original, replacement: lstatSync(dir, { bigint: true }).ino };
    };
    absentOwners();
    const result = await new FilesystemMediaStore(root).sweepTemporaries();
    if (identities === undefined) throw new Error('the claim directory was not swapped');
    expectNumberCollision(identities.original, identities.replacement);
    expect(
      { result, source: existsSync(source), moved: readdirSync(moved) },
      'MEDIA_TEMP_SAME_PRECISION',
    ).toEqual({
      result: { removed: 0, retained: 1, reasons: { unsafe_entry: 1 } },
      source: true,
      moved: [],
    });
  });

  it('refuses a producer temporary replaced before its claim begins', async () => {
    const source = abandonedTemporary();
    const moved = join(base, 'producer-original');
    let identities: { original: bigint; replacement: bigint } | undefined;
    // The owner check runs after the sweep's snapshot of the temporary and before its claim.
    absentOwners(() => {
      if (identities !== undefined) return;
      renameSync(source, moved);
      writeFileSync(source, 'replacement', { mode: 0o600 });
      age(source);
      identities = {
        original: lstatSync(moved, { bigint: true }).ino,
        replacement: lstatSync(source, { bigint: true }).ino,
      };
    });
    const result = await new FilesystemMediaStore(root).sweepTemporaries();
    if (identities === undefined) throw new Error('the producer was not swapped');
    expectNumberCollision(identities.original, identities.replacement);
    // nativeFile refuses before any claim directory exists; the later owned-file check would not.
    expect(
      {
        result,
        claims: fixture.mkdirs.filter((path) => basename(path).startsWith('media-claim-v2.')),
        left: readFileSync(source, 'utf8'),
      },
      'MEDIA_TEMP_NATIVE_FILE_PRECISION',
    ).toEqual({
      result: { removed: 0, retained: 1, reasons: { unsafe_entry: 1 } },
      claims: [],
      left: 'replacement',
    });
  });
});

describe('a media read compares its descriptor stats exactly', () => {
  it('refuses a second descriptor stat whose identity differs only beyond a Number (no real filesystem does this)', async () => {
    const store = new FilesystemMediaStore(root);
    expect(await store.put(bytes, 'audio/L16')).toBe(`media://sha256-${digest}`);
    const path = join(root, digest.slice(0, 2), digest.slice(2));
    let identities: { first: bigint; second: bigint } | undefined;
    fixture.afterOpen = (opened, file) => {
      if (opened !== path) return;
      fixture.afterOpen = undefined;
      const stat = file.stat.bind(file);
      let first: bigint | undefined;
      Object.defineProperty(file, 'stat', {
        value: async (options?: StatOptions) => {
          const info = await stat(options);
          if (typeof info.ino !== 'bigint') return info;
          if (first === undefined) first = info.ino;
          else {
            Object.defineProperty(info, 'ino', { value: first + 1n });
            identities = { first, second: first + 1n };
          }
          return info;
        },
      });
    };
    const result = await outcome(scanMediaFile(new MediaStorePaths(root), digest, false));
    if (identities === undefined) throw new Error('the second stat was not reached');
    expectNumberCollision(identities.first, identities.second);
    expect(result, 'MEDIA_FD_IDENTITY_PRECISION').toBe('unsafe_path');
  });
});
