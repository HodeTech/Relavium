import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverCatalog } from '../../workflows/catalog.js';
import {
  admitInvocationFsGrants,
  FsPolicyError,
  fsPolicyScopeRoots,
  selectInvocationFsPolicy,
} from './fs-policy.js';

/**
 * POSIX inodes stay far below 2^53, so these cases substitute every identity the code reads: each real
 * (dev, ino) becomes 2^60 + k. Distinct substitutes stay distinct as bigints but share one Number (the
 * spacing there is 256), so a read without `{ bigint: true }` or a comparison through Number lets a real
 * replacement compare equal, as a 64-bit Windows file ID can.
 */
const identities = vi.hoisted(() => {
  const state: { fakes: Map<string, bigint>; beforeOpen: (() => void) | undefined } = {
    fakes: new Map(),
    beforeOpen: undefined,
  };
  return state;
});
vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  const substitute = (info: unknown, exact: BigIntStats | undefined): void => {
    if (exact === undefined || typeof info !== 'object' || info === null || !('ino' in info))
      return;
    const key = `${exact.dev}:${exact.ino}`;
    const value = identities.fakes.get(key) ?? (1n << 60n) + BigInt(identities.fakes.size);
    identities.fakes.set(key, value);
    Object.defineProperty(info, 'ino', {
      value: typeof info.ino === 'bigint' ? value : Number(value),
    });
  };
  return {
    ...native,
    statSync: (...args: Parameters<typeof native.statSync>) => {
      const info = native.statSync(...args);
      substitute(info, native.statSync(args[0], { bigint: true, throwIfNoEntry: false }));
      return info;
    },
    lstatSync: (...args: Parameters<typeof native.lstatSync>) => {
      const info = native.lstatSync(...args);
      substitute(info, native.lstatSync(args[0], { bigint: true, throwIfNoEntry: false }));
      return info;
    },
    fstatSync: (...args: Parameters<typeof native.fstatSync>) => {
      const info = native.fstatSync(...args);
      substitute(info, native.fstatSync(args[0], { bigint: true }));
      return info;
    },
    openSync: (...args: Parameters<typeof native.openSync>) => {
      const before = identities.beforeOpen;
      identities.beforeOpen = undefined;
      before?.();
      return native.openSync(...args);
    },
  };
});

let base: string;
let workspace: string;
beforeEach(() => {
  identities.fakes.clear();
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-native-identity-')));
  workspace = join(base, 'workspace');
  mkdirSync(workspace);
});
afterEach(() => {
  identities.beforeOpen = undefined;
  rmSync(base, { recursive: true, force: true });
});

/** The fixture must make the original and its replacement collide as Numbers and only as Numbers. */
function expectNumberCollision(original: bigint, replacement: bigint): void {
  expect(replacement).not.toBe(original);
  expect(Number(replacement)).toBe(Number(original));
}

function refused(check: () => unknown): boolean {
  try {
    check();
    return false;
  } catch (error) {
    if (error instanceof FsPolicyError) return true;
    throw error;
  }
}

describe('filesystem policy pins compare exact native identities', () => {
  it('refuses a replaced selected directory whose identity collides as a Number', () => {
    const grant = join(base, 'grant');
    const selected = join(grant, 'selected');
    mkdirSync(selected, { recursive: true });
    const policy = selectInvocationFsPolicy(admitInvocationFsGrants([grant]), workspace, [
      selected,
    ]);
    const original = statSync(selected, { bigint: true }).ino;
    // Keep the original alive so the platform cannot recycle its inode for the replacement.
    renameSync(selected, `${selected}-old`);
    mkdirSync(selected);
    expectNumberCollision(original, statSync(selected, { bigint: true }).ino);
    expect(
      refused(() => fsPolicyScopeRoots(policy, workspace, 'project')),
      'FS_ROOT_IDENTITY_PRECISION',
    ).toBe(true);
  });

  it('refuses an unchanged alias whose target was replaced (the canonical identity)', () => {
    const target = join(base, 'target');
    const alias = join(base, 'alias');
    mkdirSync(target);
    symlinkSync(target, alias, 'junction');
    const policy = selectInvocationFsPolicy(admitInvocationFsGrants([alias]), workspace, undefined);
    const original = statSync(target, { bigint: true }).ino;
    const entry = lstatSync(alias, { bigint: true }).ino;
    renameSync(target, `${target}-old`);
    mkdirSync(target);
    expectNumberCollision(original, statSync(target, { bigint: true }).ino);
    expect(lstatSync(alias, { bigint: true }).ino).toBe(entry);
    expect(
      refused(() => fsPolicyScopeRoots(policy, workspace, 'project')),
      'FS_ROOT_IDENTITY_PRECISION',
    ).toBe(true);
  });

  it('refuses a replaced alias whose target is unchanged (the lexical identity)', () => {
    const target = join(base, 'target');
    const alias = join(base, 'alias');
    mkdirSync(target);
    symlinkSync(target, alias, 'junction');
    const policy = selectInvocationFsPolicy(admitInvocationFsGrants([alias]), workspace, undefined);
    const canonical = statSync(target, { bigint: true }).ino;
    const original = lstatSync(alias, { bigint: true }).ino;
    renameSync(alias, `${alias}-old`);
    symlinkSync(target, alias, 'junction');
    expectNumberCollision(original, lstatSync(alias, { bigint: true }).ino);
    expect(statSync(target, { bigint: true }).ino).toBe(canonical);
    expect(
      refused(() => fsPolicyScopeRoots(policy, workspace, 'project')),
      'FS_ROOT_IDENTITY_PRECISION',
    ).toBe(true);
  });
});

describe('the workflow catalog admits an open by exact native identity', () => {
  const workflow = (id: string): string =>
    `schema_version: '1.0'\nworkflow:\n  id: ${id}\n  nodes:\n    - { id: a, type: input }\n    - { id: b, type: output }\n  edges:\n    - { from: a, to: b }\n`;

  it('refuses a catalog file swapped between its admission and its open', () => {
    const configDir = join(base, '.relavium');
    const file = join(configDir, 'workflows', 'hello.yaml');
    mkdirSync(join(configDir, 'workflows'), { recursive: true });
    writeFileSync(file, workflow('hello'));
    // The swap lands after the catalog's admitting stat and before its open.
    identities.beforeOpen = () => {
      renameSync(file, `${file}-old`);
      writeFileSync(file, workflow('swapped'));
    };
    const entries = discoverCatalog({ projectConfigDir: configDir, cwd: base, kind: 'workflows' });
    expect(identities.beforeOpen).toBeUndefined();
    expectNumberCollision(
      statSync(`${file}-old`, { bigint: true }).ino,
      statSync(file, { bigint: true }).ino,
    );
    expect(
      entries.map((entry) => ({ valid: entry.valid, error: entry.error })),
      'CATALOG_IDENTITY_PRECISION',
    ).toEqual([{ valid: false, error: 'not the admitted regular file' }]);
  });
});
