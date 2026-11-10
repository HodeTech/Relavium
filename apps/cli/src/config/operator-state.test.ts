import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GlobalConfigSchema } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({ stage: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  let directoryFd: number | undefined;
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (args[1] === 'r' && faults.stage === 'dir-open') throw new Error('injected');
      const fd = fs.openSync(...args);
      directoryFd = args[1] === 'r' ? fd : undefined;
      return fd;
    },
    fsyncSync: (fd: number) => {
      if (faults.stage === (fd === directoryFd ? 'dir-fsync' : 'file-fsync'))
        throw new Error('injected');
      fs.fsyncSync(fd);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (faults.stage === 'rename') throw new Error('injected');
      fs.renameSync(...args);
    },
  };
});

import { loadConfigFile, loadResolvedConfig } from './load.js';
import {
  ConfigWriteRefusedError,
  globalConfigPath,
  prepareGlobalPreferences,
  prepareKeychainUnavailableAcknowledged,
  prepareStandardEnvKeyConsent,
} from './write.js';

describe('operator config publication', () => {
  let home: string;
  let target: string;
  beforeEach(() => {
    faults.stage = '';
    home = mkdtempSync(join(tmpdir(), 'relavium-operator-'));
    target = globalConfigPath(home);
    mkdirSync(join(home, '.relavium'));
    writeFileSync(target, '[preferences]\ntheme = "dark"\n');
  });
  afterEach(() => {
    faults.stage = '';
    rmSync(home, { recursive: true, force: true });
  });

  it('round trips the closed settings while preserving unrelated values', () => {
    const prepared = prepareStandardEnvKeyConsent('gemini', home);
    expect(prepared.rewriteNeeded).toBe(true);
    expect(readFileSync(target, 'utf8')).not.toContain('standard_env');
    prepared.publish();
    prepareKeychainUnavailableAcknowledged(true, home).publish();
    expect(loadConfigFile(target, GlobalConfigSchema)?.preferences).toEqual({
      theme: 'dark',
      standard_env_key_consent: { gemini: 'GEMINI_API_KEY' },
      keychain_unavailable_acknowledged: true,
    });
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it.each(['file-fsync', 'rename'])(
    'leaves the original on pre-publication %s failure',
    (stage) => {
      const before = readFileSync(target, 'utf8');
      const prepared = prepareStandardEnvKeyConsent('openai', home);
      faults.stage = stage;
      expect(() => prepared.publish()).toThrow();
      expect(readFileSync(target, 'utf8')).toBe(before);
      expect(
        loadConfigFile(target, GlobalConfigSchema)?.preferences?.standard_env_key_consent,
      ).toBeUndefined();
    },
  );

  it.each(['dir-open', 'dir-fsync'])('reports published but unconfirmed on %s failure', (stage) => {
    const prepared = prepareStandardEnvKeyConsent('anthropic', home);
    faults.stage = stage;
    expect(prepared.publish()).toEqual({ durability: 'unconfirmed' });
    expect(
      loadConfigFile(target, GlobalConfigSchema)?.preferences?.standard_env_key_consent,
    ).toEqual({ anthropic: 'ANTHROPIC_API_KEY' });
  });

  it('rejects live and dangling links before reading and preserves both', () => {
    const referent = join(home, 'referent');
    writeFileSync(referent, 'invalid !');
    rmSync(target);
    symlinkSync(referent, target);
    expect(() => prepareGlobalPreferences({ defaultModel: 'm' }, home)).toThrow(
      ConfigWriteRefusedError,
    );
    expect(readFileSync(referent, 'utf8')).toBe('invalid !');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    rmSync(referent);
    expect(() => prepareStandardEnvKeyConsent('openai', home)).toThrow(ConfigWriteRefusedError);
    expect(readlinkSync(target)).toBe(referent);
    expect(existsSync(referent)).toBe(false);
  });

  it('rechecks symlinks and admission at publication', () => {
    const prepared = prepareStandardEnvKeyConsent('openai', home);
    const marker = new Error('cancelled');
    expect(() =>
      prepared.publish(() => {
        throw marker;
      }),
    ).toThrow(marker);
    rmSync(target);
    symlinkSync(join(home, 'absent'), target);
    expect(() => prepared.publish()).toThrow(ConfigWriteRefusedError);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it('checks admission again immediately before rename and leaves no grant', () => {
    const before = readFileSync(target, 'utf8');
    const prepared = prepareStandardEnvKeyConsent('openai', home);
    let calls = 0;
    const cancelled = new Error('cancelled');
    expect(() =>
      prepared.publish(() => {
        if (++calls === 2) throw cancelled;
      }),
    ).toThrow(cancelled);
    expect(calls).toBe(2);
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(
      loadResolvedConfig({ cwd: home, home }).globalConfig?.preferences?.standard_env_key_consent,
    ).toBeUndefined();
  });

  it('checks final symlink again after admission immediately before rename', () => {
    const prepared = prepareStandardEnvKeyConsent('openai', home);
    const referent = join(home, 'referent');
    writeFileSync(referent, 'untouched');
    let calls = 0;
    expect(() =>
      prepared.publish(() => {
        if (++calls === 2) {
          rmSync(target);
          symlinkSync(referent, target);
        }
      }),
    ).toThrow(ConfigWriteRefusedError);
    expect(readFileSync(referent, 'utf8')).toBe('untouched');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it('rejects project and workspace operator declarations with a fixed value-free diagnostic', () => {
    const project = join(home, 'project');
    mkdirSync(join(project, '.relavium'), { recursive: true });
    for (const name of ['project.toml', 'workspace.toml']) {
      const path = join(project, '.relavium', name);
      writeFileSync(path, '[preferences]\nkeychain_unavailable_acknowledged = "secret-value"\n');
      expect(() => loadResolvedConfig({ cwd: project, home })).toThrow(
        'Remove it from project/workspace config and configure it only in the selected global config.',
      );
      try {
        loadResolvedConfig({ cwd: project, home });
      } catch (err) {
        expect(String(err)).not.toContain('secret-value');
      }
      rmSync(path);
    }
  });

  it('separates the selected validated global state from project resolution', () => {
    const selected = join(home, 'selected.toml');
    writeFileSync(
      selected,
      '[preferences.standard_env_key_consent]\ndeepseek = "DEEPSEEK_API_KEY"\n',
    );
    const loaded = loadResolvedConfig({ cwd: home, home, configPath: selected });
    expect(loaded.globalConfigPath).toBe(selected);
    expect(loaded.globalConfig?.preferences?.standard_env_key_consent).toEqual({
      deepseek: 'DEEPSEEK_API_KEY',
    });
  });
});
