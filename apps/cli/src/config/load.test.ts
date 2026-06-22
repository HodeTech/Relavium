import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GlobalConfigSchema } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError } from './errors.js';
import { loadConfigFile, loadResolvedConfig } from './load.js';

describe('loadConfigFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-load-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses and validates a global config', () => {
    const file = join(dir, 'config.toml');
    writeFileSync(file, 'update_channel = "beta"\n[preferences]\ndefault_model = "m"\n');
    expect(loadConfigFile(file, GlobalConfigSchema)).toEqual({
      update_channel: 'beta',
      preferences: { default_model: 'm' },
    });
  });

  it('returns undefined for an absent file (a missing layer is not an error)', () => {
    expect(loadConfigFile(join(dir, 'nope.toml'), GlobalConfigSchema)).toBeUndefined();
  });

  it('throws a file-attributed ConfigError (exit 2) on malformed TOML', () => {
    const file = join(dir, 'bad.toml');
    writeFileSync(file, 'this is = = not valid toml');
    let thrown: unknown;
    try {
      loadConfigFile(file, GlobalConfigSchema);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    if (thrown instanceof ConfigError) {
      expect(thrown.exitCode).toBe(2);
      expect(thrown.code).toBe('config_error');
      expect(thrown.filePath).toBe(file);
      expect(thrown.message).toContain(file);
      expect(thrown.message.toLowerCase()).toContain('toml');
    }
  });

  it('rejects an unknown key — strict schema accepts no stray/secret keys', () => {
    const file = join(dir, 'config.toml');
    writeFileSync(file, 'api_key = "should-never-be-here"\n');
    expect(() => loadConfigFile(file, GlobalConfigSchema)).toThrowError(ConfigError);
  });
});

describe('loadResolvedConfig', () => {
  let home: string;
  let project: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'relavium-home-'));
    project = mkdtempSync(join(tmpdir(), 'relavium-proj-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('merges the global and project layers, the project winning (last-writer-wins)', () => {
    mkdirSync(join(home, '.relavium'), { recursive: true });
    writeFileSync(
      join(home, '.relavium', 'config.toml'),
      '[preferences]\ndefault_model = "global-model"\n',
    );
    mkdirSync(join(project, '.relavium'), { recursive: true });
    writeFileSync(
      join(project, '.relavium', 'project.toml'),
      '[defaults]\nmodel = "project-model"\nfs_scope = "project"\n',
    );

    const { config, projectConfigDir } = loadResolvedConfig({ cwd: project, home });
    expect(config.defaultModel).toBe('project-model');
    expect(config.fsScope).toBe('project');
    expect(projectConfigDir).toBe(join(project, '.relavium'));
  });

  it('falls back to the global layer when outside any project', () => {
    mkdirSync(join(home, '.relavium'), { recursive: true });
    writeFileSync(
      join(home, '.relavium', 'config.toml'),
      '[preferences]\ndefault_model = "global-model"\n',
    );
    const elsewhere = mkdtempSync(join(tmpdir(), 'relavium-cwd-'));
    try {
      const { config, projectConfigDir } = loadResolvedConfig({ cwd: elsewhere, home });
      expect(config.defaultModel).toBe('global-model');
      expect(projectConfigDir).toBeUndefined();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('honors --config as the global layer override', () => {
    const explicit = join(home, 'custom.toml');
    writeFileSync(explicit, '[preferences]\ndefault_model = "explicit-model"\n');
    const elsewhere = mkdtempSync(join(tmpdir(), 'relavium-cwd-'));
    try {
      const { config } = loadResolvedConfig({ cwd: elsewhere, home, configPath: explicit });
      expect(config.defaultModel).toBe('explicit-model');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
