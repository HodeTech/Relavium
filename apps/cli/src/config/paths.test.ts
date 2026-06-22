import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureGlobalConfigDir, findProjectConfigDir, globalConfigDir } from './paths.js';

describe('globalConfigDir', () => {
  it('is <home>/.relavium', () => {
    expect(globalConfigDir('/home/user')).toBe(join('/home/user', '.relavium'));
  });
});

describe('findProjectConfigDir', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-paths-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds a .relavium directory by walking up from a nested cwd', () => {
    mkdirSync(join(root, '.relavium'));
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(findProjectConfigDir(nested)).toBe(join(root, '.relavium'));
  });

  it('returns undefined when no .relavium exists up to the filesystem root', () => {
    const nested = join(root, 'x');
    mkdirSync(nested);
    expect(findProjectConfigDir(nested)).toBeUndefined();
  });

  it('ignores a .relavium that is a file, not a directory', () => {
    // A regular file named `.relavium` must not be mistaken for the config directory.
    writeFileSync(join(root, '.relavium'), 'not a dir');
    const nested = join(root, 'y');
    mkdirSync(nested);
    expect(findProjectConfigDir(nested)).toBeUndefined();
  });
});

describe('ensureGlobalConfigDir', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'relavium-home-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('creates ~/.relavium and its tmp/ idempotently', () => {
    const dir = ensureGlobalConfigDir(home);
    expect(dir).toBe(join(home, '.relavium'));
    expect(existsSync(join(home, '.relavium', 'tmp'))).toBe(true);
    expect(() => ensureGlobalConfigDir(home)).not.toThrow();
  });
});
