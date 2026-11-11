import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({ path: '', mode: '', root: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
      if (String(args[0]) === faults.path) {
        if (faults.mode === 'foreign-content')
          fs.writeFileSync(join(faults.root, 'workflows', 'foreign.txt'), 'preserve');
        if (faults.mode === 'replace') {
          fs.renameSync(faults.root, `${faults.root}.moved`);
          fs.mkdirSync(faults.root);
          fs.writeFileSync(join(faults.root, 'foreign.txt'), 'preserve replacement');
        }
        throw new Error('synthetic mkdir failure');
      }
      return fs.mkdirSync(...args);
    },
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      if (
        faults.mode === 'identity' &&
        String(args[0]) === faults.root &&
        fs.existsSync(faults.root)
      )
        throw new Error('synthetic identity failure');
      return fs.lstatSync(...args);
    },
  };
});

import { prepareProjectInit } from './project-init.js';
import { findProjectConfigDir, globalConfigDir } from '../config/paths.js';
import { resolveProjectDirectory } from '../config/project-directory.js';

describe('project initialization and global exclusion', () => {
  let root: string;
  let home: string;
  let cwd: string;
  beforeEach(() => {
    faults.path = '';
    faults.mode = '';
    faults.root = '';
    root = mkdtempSync(join(tmpdir(), 'relavium-project-init-'));
    home = join(root, 'home');
    cwd = join(home, 'project');
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => {
    faults.path = '';
    faults.mode = '';
    faults.root = '';
    rmSync(root, { recursive: true, force: true });
  });
  const link = (target: string, path: string): void =>
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');

  it('prepares without writing, then creates only the marker, workflows and agents', () => {
    const prepared = prepareProjectInit(cwd, home);
    const marker = join(cwd, '.relavium');
    expect(prepared.directories).toEqual([
      marker,
      join(marker, 'workflows'),
      join(marker, 'agents'),
    ]);
    expect(readdirSync(cwd)).toEqual([]);
    expect(prepared.publish()).toEqual({
      status: 'created',
      projectConfigDir: marker,
      created: prepared.directories,
    });
    expect(readdirSync(marker).sort()).toEqual(['agents', 'workflows']);
    expect(readdirSync(join(marker, 'agents'))).toEqual([]);
    expect(readdirSync(join(marker, 'workflows'))).toEqual([]);
    expect(readdirSync(home)).toEqual(['project']);
  });

  it('does not repair or alter an existing marker and identifies an ancestor from nested cwd', () => {
    const marker = join(cwd, '.relavium');
    mkdirSync(marker);
    writeFileSync(join(marker, 'sentinel'), 'untouched');
    const nested = join(cwd, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const prepared = prepareProjectInit(nested, home);
    expect(prepared.alreadyInitialized).toBe(true);
    expect(prepared.directories).toEqual([]);
    expect(prepared.publish()).toEqual({
      status: 'already-initialized',
      projectConfigDir: marker,
      created: [],
    });
    expect(readdirSync(marker)).toEqual(['sentinel']);
    expect(readFileSync(join(marker, 'sentinel'), 'utf8')).toBe('untouched');
    expect(existsSync(join(nested, '.relavium'))).toBe(false);
  });

  it.each([false, true])(
    'refuses a final marker symlink before ancestor discovery (dangling=%s)',
    (dangling) => {
      mkdirSync(join(home, '.relavium'));
      const target = join(root, 'elsewhere');
      if (!dangling) mkdirSync(target);
      const marker = join(cwd, '.relavium');
      link(target, marker);
      expect(() => prepareProjectInit(cwd, home)).toThrow('symbolic link');
      expect(lstatSync(marker).isSymbolicLink()).toBe(true);
      if (!dangling) expect(readdirSync(target)).toEqual([]);
    },
  );

  it('refuses a non-directory marker without changing it', () => {
    const marker = join(cwd, '.relavium');
    writeFileSync(marker, 'not a directory');
    expect(() => prepareProjectInit(cwd, home)).toThrow('not a directory');
    expect(readFileSync(marker, 'utf8')).toBe('not a directory');
  });

  it('excludes global config and artifacts from discovery without altering their bytes', () => {
    const global = globalConfigDir(home);
    mkdirSync(join(global, 'workflows'), { recursive: true });
    writeFileSync(join(global, 'project.toml'), '[defaults]\nmodel = "must-not-load"\n');
    writeFileSync(join(global, 'workflows', 'legacy.yaml'), 'preserve');
    expect(findProjectConfigDir(cwd, home)).toBeUndefined();
    expect(prepareProjectInit(cwd, home).publish().projectConfigDir).toBe(join(cwd, '.relavium'));
    expect(readFileSync(join(global, 'project.toml'), 'utf8')).toContain('must-not-load');
    expect(readFileSync(join(global, 'workflows', 'legacy.yaml'), 'utf8')).toBe('preserve');
  });

  it('refuses home/global cwd and canonical aliases, including a marker linked to global', () => {
    const global = globalConfigDir(home);
    mkdirSync(global);
    const homeAlias = join(root, 'home-alias');
    const globalAlias = join(root, 'global-alias');
    link(home, homeAlias);
    link(global, globalAlias);
    for (const path of [home, homeAlias, global, globalAlias]) {
      expect(findProjectConfigDir(path, home)).toBeUndefined();
      expect(() => prepareProjectInit(path, home)).toThrow(/global state/u);
      expect(() => resolveProjectDirectory(path, home)).toThrow(/global state/u);
    }
    link(global, join(cwd, '.relavium'));
    expect(findProjectConfigDir(cwd, home)).toBeUndefined();
    expect(() => resolveProjectDirectory(cwd, home)).toThrow(/global state/u);
    expect(() => prepareProjectInit(cwd, home)).toThrow('symbolic link');
    expect(readdirSync(global)).toEqual([]);
  });

  it('rechecks a new ancestor marker after preparation and does not nest another project', () => {
    const prepared = prepareProjectInit(cwd, home);
    const ancestor = join(root, '.relavium');
    // Home is a discovery boundary; use a separate outside-home working tree.
    const outside = join(root, 'outside', 'nested');
    mkdirSync(outside, { recursive: true });
    const outsidePlan = prepareProjectInit(outside, home);
    mkdirSync(ancestor);
    expect(outsidePlan.publish()).toEqual({
      status: 'already-initialized',
      projectConfigDir: ancestor,
      created: [],
    });
    expect(existsSync(join(outside, '.relavium'))).toBe(false);
    expect(prepared.publish().status).toBe('created');
  });

  it('cleans only its own empty directories after a partial mkdir failure', () => {
    const prepared = prepareProjectInit(cwd, home);
    faults.path = join(prepared.projectConfigDir, 'agents');
    expect(() => prepared.publish()).toThrow('could not complete');
    expect(existsSync(prepared.projectConfigDir)).toBe(false);
  });

  it('cancels between directory publications and returns the original cancellation after cleanup', () => {
    const prepared = prepareProjectInit(cwd, home);
    const cancellation = new Error('synthetic cancellation');
    let checks = 0;
    expect(() =>
      prepared.publish(() => {
        if (++checks >= 4) throw cancellation;
      }),
    ).toThrow(cancellation);
    expect(existsSync(prepared.projectConfigDir)).toBe(false);
  });

  it('preserves the exact per-publication admission refusal without calling it again during cleanup', () => {
    const prepared = prepareProjectInit(cwd, home);
    let checks = 0;
    let refused: Error | undefined;
    let observed: unknown;
    try {
      prepared.publish(() => {
        if (++checks === 4) {
          refused = new Error('original admission refusal');
          throw refused;
        }
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(refused);
    expect(refused).toBeDefined();
    expect(checks).toBe(4);
    expect(existsSync(prepared.projectConfigDir)).toBe(false);
  });

  it.each(['foreign-content', 'replace', 'identity'])(
    'preserves concurrent content or unverifiable identity (%s)',
    (mode) => {
      const prepared = prepareProjectInit(cwd, home);
      faults.root = prepared.projectConfigDir;
      faults.mode = mode;
      faults.path = mode === 'identity' ? '' : join(prepared.projectConfigDir, 'agents');
      expect(() => prepared.publish()).toThrow('cleanup could not be confirmed');
      expect(existsSync(prepared.projectConfigDir)).toBe(true);
      if (mode === 'foreign-content')
        expect(readFileSync(join(faults.root, 'workflows', 'foreign.txt'), 'utf8')).toBe(
          'preserve',
        );
      if (mode === 'replace')
        expect(readFileSync(join(faults.root, 'foreign.txt'), 'utf8')).toBe('preserve replacement');
    },
  );

  it('rechecks a symlink inserted after preparation before writing anything', () => {
    const prepared = prepareProjectInit(cwd, home);
    const target = join(root, 'foreign');
    mkdirSync(target);
    link(target, prepared.projectConfigDir);
    expect(() => prepared.publish()).toThrow('symbolic link');
    expect(readdirSync(target)).toEqual([]);
  });
});
