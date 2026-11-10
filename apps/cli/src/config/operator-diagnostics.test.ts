import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GlobalConfigSchema } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run } from '../run.js';
import { captureIo } from '../test-support.js';
import { ConfigError, OperatorConfigError } from './errors.js';
import { loadConfigFile, loadResolvedConfig } from './load.js';
import { prepareStandardEnvKeyConsent } from './write.js';

const marker = 'marker-credential-secret';
describe('operator preference diagnostic boundary', () => {
  let home: string;
  let config: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'operator-path-sentinel-'));
    config = join(home, 'global.toml');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const globalCases = [
    [
      'unknown source key',
      `[preferences.standard_env_key_consent]\n"${marker}" = "OPENAI_API_KEY"\n`,
      'standard_env_key_consent',
    ],
    [
      'mismatched source literal',
      `[preferences.standard_env_key_consent]\nopenai = "${marker}"\n`,
      'standard_env_key_consent',
    ],
    [
      'wrong consent table type',
      `[preferences]\nstandard_env_key_consent = "${marker}"\n`,
      'standard_env_key_consent',
    ],
    [
      'wrong acknowledgement type',
      `[preferences]\nkeychain_unavailable_acknowledged = "${marker}"\n`,
      'keychain_unavailable_acknowledged',
    ],
  ] as const;

  it.each(globalCases)(
    'makes %s a fixed recoverable path-free ConfigError',
    (_label, text, setting) => {
      writeFileSync(config, text);
      let caught: unknown;
      try {
        loadConfigFile(config, GlobalConfigSchema);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect(caught).toBeInstanceOf(OperatorConfigError);
      if (!(caught instanceof ConfigError)) throw new Error('expected config error');
      expect(caught.code).toBe('config_error');
      expect(caught.exitCode).toBe(2);
      expect(caught.message).toContain(setting);
      expect(caught.message).toContain('selected global config');
      expect(caught.message).not.toContain(home);
      expect(caught.message).not.toContain(marker);
      expect(caught.filePath).toBe('');
      expect(caught.cause).toBeUndefined();
      expect(JSON.stringify(caught)).not.toContain(home);
      expect(JSON.stringify(caught)).not.toContain(marker);
    },
  );

  it.each(['project.toml', 'workspace.toml'])(
    'refuses each known operator setting in %s without a path or value',
    (name) => {
      const project = join(home, 'project');
      mkdirSync(join(project, '.relavium'), { recursive: true });
      for (const [setting, value] of [
        ['standard_env_key_consent', `"${marker}"`],
        ['keychain_unavailable_acknowledged', `"${marker}"`],
      ] as const) {
        writeFileSync(join(project, '.relavium', name), `[preferences]\n${setting} = ${value}\n`);
        let caught: unknown;
        try {
          loadResolvedConfig({ cwd: project, home, configPath: config });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        if (!(caught instanceof ConfigError)) throw new Error('expected config error');
        expect(caught.message).toContain(setting);
        expect(caught.message).toContain('Remove it from project/workspace');
        expect(caught.message).not.toContain(home);
        expect(caught.message).not.toContain(marker);
        expect(caught.cause).toBeUndefined();
      }
    },
  );

  it('keeps unrelated legacy config diagnostics file-attributed', () => {
    writeFileSync(config, '[preferences]\nunknown_legacy = 1\n');
    expect(() => loadConfigFile(config, GlobalConfigSchema)).toThrow(config);
    expect(() => loadConfigFile(config, GlobalConfigSchema)).toThrow('unknown_legacy');
  });

  it('preserves the writer’s recoverable ConfigError identity without exposing the original config', () => {
    writeFileSync(
      config,
      `[preferences.standard_env_key_consent]\n"${marker}" = "OPENAI_API_KEY"\n`,
    );
    expect(() => prepareStandardEnvKeyConsent('openai', home, config)).toThrow(ConfigError);
    try {
      prepareStandardEnvKeyConsent('openai', home, config);
    } catch (err) {
      expect(String(err)).not.toContain(home);
      expect(String(err)).not.toContain(marker);
    }
  });

  const outputModes: readonly { readonly name: string; readonly flags: readonly string[] }[] = [
    { name: 'plain', flags: [] },
    { name: 'json', flags: ['--json'] },
    { name: 'verbose', flags: ['--verbose'] },
    { name: 'json verbose', flags: ['--json', '--verbose'] },
  ];
  for (const mode of outputModes) {
    it.each(globalCases)(
      `routes %s through actual CLI ${mode.name} without reflection`,
      async (_label, text, setting) => {
        writeFileSync(config, text);
        const captured = captureIo({ CI: '1', HOME: home });
        const code = await run(
          ['node', 'relavium', '--cwd', home, '--config', config, ...mode.flags, 'chat'],
          captured.io,
        );
        expect(code).toBe(2);
        expect(captured.out()).toBe('');
        expect(captured.err()).toContain(setting);
        expect(captured.err()).toContain('selected global config');
        expect(captured.err()).not.toContain(marker);
        expect(captured.err()).not.toContain(home);
        if (mode.flags.includes('--json')) {
          const envelope: unknown = JSON.parse(captured.err());
          expect(envelope).toMatchObject({ type: 'error', code: 'config_error' });
        }
      },
    );
    it.each(['project.toml', 'workspace.toml'])(
      `routes misplaced settings from %s through CLI ${mode.name}`,
      async (name) => {
        const project = join(home, 'project');
        mkdirSync(join(project, '.relavium'), { recursive: true });
        writeFileSync(
          join(project, '.relavium', name),
          `[preferences]\nkeychain_unavailable_acknowledged = "${marker}"\n`,
        );
        const captured = captureIo({ CI: '1', HOME: home });
        const code = await run(
          ['node', 'relavium', '--cwd', project, '--config', config, ...mode.flags, 'chat'],
          captured.io,
        );
        expect(code).toBe(2);
        expect(captured.out()).toBe('');
        expect(captured.err()).toContain('keychain_unavailable_acknowledged');
        expect(captured.err()).toContain('Remove it from project/workspace');
        expect(captured.err()).not.toContain(marker);
        expect(captured.err()).not.toContain(home);
      },
    );
  }
});
