import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '../process/errors.js';
import { configFileLabel, faultForTranscript, pathFreeConfigError } from './config-error-text.js';
import { ConfigError, OperatorConfigError } from './errors.js';
import { loadResolvedConfig } from './load.js';

/** The ConfigError a real load of a broken file raises, so the message under test is the one the product builds. */
function loadFault(options: { cwd: string; home: string }): ConfigError {
  try {
    loadResolvedConfig(options);
  } catch (cause) {
    if (cause instanceof ConfigError) return cause;
    throw cause;
  }
  throw new Error('the load was expected to fail');
}

describe('config errors drawn into a transcript are path-free (RUNCORE-3)', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-cfgtext-home-')));
    // A project inside the operator's home, as a checkout usually is.
    cwd = join(home, 'work', 'repo');
    mkdirSync(join(cwd, '.relavium'), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('names a broken global config from `~`, without the home it lives in', () => {
    mkdirSync(join(home, '.relavium'), { recursive: true });
    writeFileSync(join(home, '.relavium', 'config.toml'), 'not = [valid');
    const fault = loadFault({ cwd, home });
    expect(fault.message, 'the shell keeps the full path').toContain(home);

    const shown = pathFreeConfigError(fault, { cwd, homeDir: home });
    expect(shown).toBeInstanceOf(ConfigError);
    expect(shown.message.startsWith(`~${sep}.relavium${sep}config.toml: is not valid TOML`)).toBe(
      true,
    );
    expect(shown.message).not.toContain(home);
    expect(shown.filePath, 'the error still names its file for whoever may act on it').toBe(
      fault.filePath,
    );
  });

  it('names a broken project config relative to the project, with neither the project root nor the home', () => {
    writeFileSync(join(cwd, '.relavium', 'project.toml'), 'not = [valid');
    const fault = loadFault({ cwd, home });
    expect(fault.message).toContain(cwd);

    const shown = pathFreeConfigError(fault, { cwd, homeDir: home });
    expect(shown.message.startsWith(`.relavium${sep}project.toml: is not valid TOML`)).toBe(true);
    expect(shown.message).not.toContain(cwd);
    expect(shown.message).not.toContain(home);
  });

  it('names a project config above the working directory by a relative path, never an absolute one', () => {
    writeFileSync(join(cwd, '.relavium', 'project.toml'), 'not = [valid');
    const sub = join(cwd, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const fault = loadFault({ cwd: sub, home });

    const shown = pathFreeConfigError(fault, { cwd: sub, homeDir: home });
    expect(shown.message).not.toContain(home);
    expect(
      shown.message.startsWith(`~${sep}work${sep}repo${sep}.relavium${sep}project.toml:`),
    ).toBe(true);
  });

  it('falls back to the relative label, then the bare file name, for a file outside both roots', () => {
    const elsewhere = join(tmpdir(), 'relavium-elsewhere', 'custom.toml');
    const label = configFileLabel(elsewhere, { cwd, homeDir: home });
    expect(isAbsolute(label), 'a relative label, never an absolute path').toBe(false);
    expect(label.endsWith('custom.toml')).toBe(true);
  });

  it('keeps the error it was given, and one that names no file, as they are', () => {
    const operator = new OperatorConfigError('standard_env_key_consent', false);
    expect(pathFreeConfigError(operator, { cwd, homeDir: home })).toBe(operator);
    const relative = new ConfigError('custom.toml', 'is invalid.');
    expect(pathFreeConfigError(relative, { cwd, homeDir: home })).toBe(relative);
  });

  it('only changes a ConfigError: any other fault is returned untouched', () => {
    const other = new CliError('invalid_invocation', `bad thing at ${cwd}`);
    expect(faultForTranscript(other, { cwd, homeDir: home })).toBe(other);
    const plain = new Error('x');
    expect(faultForTranscript(plain, { cwd, homeDir: home })).toBe(plain);
  });
});
