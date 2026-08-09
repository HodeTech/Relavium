import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
    writeFileSync(file, 'api_key' + ' = "should-never-be-here"\n');
    expect(() => loadConfigFile(file, GlobalConfigSchema)).toThrowError(ConfigError);
  });

  it('never echoes a config value in a schema-error message (hygiene)', () => {
    const file = join(dir, 'config.toml');
    writeFileSync(file, 'update_channel' + ' = "super-secret-leak-me"\n');
    let thrown: unknown;
    try {
      loadConfigFile(file, GlobalConfigSchema);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    if (thrown instanceof ConfigError) {
      expect(thrown.message).not.toContain('super-secret-leak-me');
      expect(thrown.message).toContain('update_channel'); // the field path is named
    }
  });

  it('rejects a config file over the size limit before parsing', () => {
    const file = join(dir, 'big.toml');
    writeFileSync(file, `x = "${'a'.repeat(256 * 1024)}"\n`);
    let thrown: unknown;
    try {
      loadConfigFile(file, GlobalConfigSchema);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    if (thrown instanceof ConfigError) {
      expect(thrown.exitCode).toBe(2);
      expect(thrown.message.toLowerCase()).toContain('size limit');
    }
  });

  it('rejects a path that is present but not a regular file (a directory)', () => {
    const subdir = join(dir, 'a-directory');
    mkdirSync(subdir);
    let thrown: unknown;
    try {
      loadConfigFile(subdir, GlobalConfigSchema);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    if (thrown instanceof ConfigError) {
      expect(thrown.exitCode).toBe(2);
      expect(thrown.message).toContain('is not a regular file');
    }
  });
});

/**
 * #33 — `config/write.ts` applies `0600` at WRITE time only, so a layer that predates that guard, or one a
 * user, an editor, a `cp` or a restored backup left permissive, stayed world-readable forever. `history.db`
 * already self-heals on open (ADR-0050); this is the config twin. POSIX-only — `chmod` is a documented no-op
 * on Windows.
 */
describe('loadConfigFile — the 0600 re-assert on read (#33)', () => {
  // Opt-in since #W15-13: only the canonical global config self-heals. See the two tests at the end of this
  // block for the layers that must NOT.
  const HEAL = { selfHealMode: true } as const;
  const POSIX = process.platform !== 'win32';
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-load-mode-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const modeOf = (path: string): number => statSync(path).mode & 0o777;

  it.skipIf(!POSIX)('tightens a world-readable config layer on load', () => {
    const file = join(dir, 'config.toml');
    writeFileSync(file, 'update_channel = "beta"\n');
    chmodSync(file, 0o644);
    // …and still returns the parsed config: the self-heal is a side effect, never a gate.
    expect(loadConfigFile(file, GlobalConfigSchema, HEAL)).toEqual({ update_channel: 'beta' });
    expect(modeOf(file)).toBe(0o600);
  });

  it.skipIf(!POSIX)(
    'leaves an already-0600 layer alone (no needless syscall on the common path)',
    () => {
      const file = join(dir, 'config.toml');
      writeFileSync(file, 'update_channel = "beta"\n');
      chmodSync(file, 0o600);
      expect(loadConfigFile(file, GlobalConfigSchema, HEAL)).toEqual({ update_channel: 'beta' });
      expect(modeOf(file)).toBe(0o600);
    },
  );

  it.skipIf(!POSIX)(
    'NEVER throws when the mode cannot be changed — a config layer holds no secrets',
    () => {
      // A read-only parent directory blocks the chmod. Unlike `history.db`, the at-rest guarantee does not rest
      // on this, so a permissive-but-readable config must still load rather than failing startup.
      const readOnlyDir = join(dir, 'locked');
      mkdirSync(readOnlyDir);
      const file = join(readOnlyDir, 'config.toml');
      writeFileSync(file, 'update_channel = "beta"\n');
      chmodSync(file, 0o444);
      chmodSync(readOnlyDir, 0o500);
      try {
        expect(loadConfigFile(file, GlobalConfigSchema, HEAL)).toEqual({ update_channel: 'beta' });
      } finally {
        chmodSync(readOnlyDir, 0o700); // so the temp dir can be swept
      }
    },
  );

  it.skipIf(!POSIX)(
    'does NOT touch a layer that did not opt in — project configs are committed (#W15-13)',
    () => {
      // `config-spec.md` says `workspace.toml` / `project.toml` are committed and shared. Healing them meant
      // that merely READING a project's config rewrote a mode in the user's repo, surfacing as an unexplained
      // `git diff` on a file the CLI was only supposed to read.
      const file = join(dir, 'project.toml');
      writeFileSync(file, 'update_channel = "beta"\n');
      chmodSync(file, 0o644);
      expect(loadConfigFile(file, GlobalConfigSchema)).toEqual({ update_channel: 'beta' });
      expect(modeOf(file)).toBe(0o644); // unchanged
    },
  );

  it.skipIf(!POSIX)('does NOT follow a symlink when healing (#W15-13)', () => {
    // `stat` followed the link to get here and `chmod` would follow it too, changing the mode of whatever the
    // link points at — a file this heal has no business touching.
    const target = join(dir, 'elsewhere.toml');
    const link = join(dir, 'config.toml');
    writeFileSync(target, 'update_channel = "beta"\n');
    chmodSync(target, 0o644);
    symlinkSync(target, link);
    expect(loadConfigFile(link, GlobalConfigSchema, HEAL)).toEqual({ update_channel: 'beta' });
    expect(modeOf(target)).toBe(0o644); // the link's target is left exactly as it was
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
