import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GlobalConfigSchema, type GlobalConfig } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError } from './errors.js';
import { loadConfigFile } from './load.js';
import { globalConfigPath, writeGlobalDefaultModel } from './write.js';

/** Read the global config back through the SAME validating loader the rest of the CLI uses. */
function readBack(home: string): GlobalConfig | undefined {
  return loadConfigFile<GlobalConfig>(globalConfigPath(home), GlobalConfigSchema);
}

describe('writeGlobalDefaultModel', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'relavium-write-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('creates ~/.relavium/config.toml with [preferences].default_model on a fresh home (round-trip)', () => {
    writeGlobalDefaultModel('claude-sonnet-4-6', home);
    expect(readBack(home)).toEqual({ preferences: { default_model: 'claude-sonnet-4-6' } });
  });

  it('preserves every other config key (update_channel, theme, mcp_servers) — merges only default_model', () => {
    // Seed an existing, valid global config carrying unrelated keys the write must NOT drop.
    mkdirSync(globalDir(home), { recursive: true });
    writeFileSync(
      globalConfigPath(home),
      [
        'update_channel = "beta"',
        '[preferences]',
        'theme = "dark"',
        '[[mcp_servers]]',
        'name = "fs"',
        'transport = "stdio"',
        'command = "some-cmd"',
        '',
      ].join('\n'),
    );

    writeGlobalDefaultModel('gpt-4o', home);

    expect(readBack(home)).toEqual({
      update_channel: 'beta',
      preferences: { theme: 'dark', default_model: 'gpt-4o' },
      mcp_servers: [{ name: 'fs', transport: 'stdio', command: 'some-cmd' }],
    });
  });

  it('overwrites an existing default_model in place (last write wins)', () => {
    writeGlobalDefaultModel('first-model', home);
    writeGlobalDefaultModel('second-model', home);
    expect(readBack(home)?.preferences?.default_model).toBe('second-model');
  });

  it('emits only schema keys — a secret could never be written (no api_key field exists to set)', () => {
    writeGlobalDefaultModel('a-model', home);
    const text = readFileSync(globalConfigPath(home), 'utf8');
    // Structural guarantee (the typed setter): the emitted TOML mentions only the model, no key-ish token.
    expect(text).toContain('default_model');
    expect(text).toContain('a-model');
    expect(text.toLowerCase()).not.toContain('api_key');
    expect(text.toLowerCase()).not.toContain('secret');
    // And it re-parses cleanly (strict schema) — no stray key slipped in.
    expect(() => readBack(home)).not.toThrow();
  });

  it('writes the file 0600 inside the 0700 directory (owner-only at rest)', () => {
    if (process.platform === 'win32') return; // POSIX mode bits do not apply on Windows
    writeGlobalDefaultModel('a-model', home);
    expect(statSync(globalConfigPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(globalDir(home)).mode & 0o777).toBe(0o700);
  });

  it('leaves no temp file behind after a successful write (the temp is renamed, not orphaned)', () => {
    writeGlobalDefaultModel('a-model', home);
    const leftovers = readdirSync(globalDir(home)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('throws a ConfigError rather than clobbering a malformed existing config', () => {
    mkdirSync(globalDir(home), { recursive: true });
    const target = globalConfigPath(home);
    writeFileSync(target, 'this is = = not valid toml');
    let thrown: unknown;
    try {
      writeGlobalDefaultModel('a-model', home);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    // The user's broken file is untouched — we refuse to overwrite it.
    expect(readFileSync(target, 'utf8')).toBe('this is = = not valid toml');
  });

  it('never echoes the model value or a config value in a schema-error message (hygiene)', () => {
    // An existing config with a stray key makes the LOAD (via loadConfigFile) throw; assert the message is value-free.
    mkdirSync(globalDir(home), { recursive: true });
    writeFileSync(globalConfigPath(home), 'stray_key' + ' = "leak-me-please"\n');
    let thrown: unknown;
    try {
      writeGlobalDefaultModel('the-new-model', home);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    if (thrown instanceof ConfigError) {
      expect(thrown.message).not.toContain('leak-me-please');
      expect(thrown.message).not.toContain('the-new-model');
    }
  });
});

describe('globalConfigPath', () => {
  it('is ~/.relavium/config.toml under the given home', () => {
    const home = '/some/home';
    expect(globalConfigPath(home)).toBe(join(home, '.relavium', 'config.toml'));
  });
});

/** `~/.relavium` — local mirror of the path helper so tests don't reach into paths.ts internals. */
function globalDir(home: string): string {
  return join(home, '.relavium');
}
