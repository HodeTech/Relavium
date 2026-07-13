import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GlobalConfigSchema, type GlobalConfig } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError } from './errors.js';
import { loadConfigFile } from './load.js';
import {
  globalConfigPath,
  writeFileAtomic,
  writeGlobalDefaultModel,
  writeGlobalPreferences,
} from './write.js';

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

  it('persists [preferences].default_provider alongside default_model, round-tripping both (ADR-0059)', () => {
    // The provider is persisted at pick time so the next chat over an id the prefix cannot place still resolves.
    writeGlobalPreferences({ defaultModel: 'chat-latest', defaultProvider: 'openai' }, home);
    expect(readBack(home)).toEqual({
      preferences: { default_model: 'chat-latest', default_provider: 'openai' },
    });
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

  it('writes to an explicit targetPath (the --config override), leaving ~/.relavium untouched', () => {
    const explicit = join(home, 'custom-config.toml');
    writeGlobalDefaultModel('gpt-4o', home, explicit);
    // The explicit file received the write (round-trips)...
    expect(loadConfigFile<GlobalConfig>(explicit, GlobalConfigSchema)).toEqual({
      preferences: { default_model: 'gpt-4o' },
    });
    // ...and the canonical ~/.relavium/config.toml was NOT created (the write targeted the override file only).
    expect(existsSync(globalConfigPath(home))).toBe(false);
  });

  it('preserves keys and writes 0600 when targeting an explicit --config path', () => {
    const explicit = join(home, 'custom.toml');
    writeFileSync(explicit, 'update_channel = "beta"\n[preferences]\ntheme = "dark"\n');
    writeGlobalDefaultModel('m', home, explicit);
    expect(loadConfigFile<GlobalConfig>(explicit, GlobalConfigSchema)).toEqual({
      update_channel: 'beta',
      preferences: { theme: 'dark', default_model: 'm' },
    });
    if (process.platform !== 'win32') {
      expect(statSync(explicit).mode & 0o777).toBe(0o600); // atomic-write owner-only mode holds for either target
    }
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

  it('cleans up the temp file (the catch path) when the atomic rename fails', () => {
    const dir = globalDir(home);
    mkdirSync(dir, { recursive: true });
    // Force the rename to fail deterministically: renameSync(tempFile, target) where `target` is a DIRECTORY ⇒
    // EISDIR. This exercises writeFileAtomic's catch path (temp created + fsync'd, THEN rename throws) — proving
    // the temp is unlinked (delete the `unlinkSync(tmp)` in write.ts and this test fails on an orphaned .tmp).
    const target = join(dir, 'config.toml');
    mkdirSync(target, { recursive: true });
    expect(() => writeFileAtomic(dir, target, 'update_channel = "stable"\n')).toThrow(ConfigError);
    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('round-trips the tricky mcp_servers shapes (args array + env sub-table + a second network server) untouched', () => {
    // The round-trip risk lives in the nested shapes (args arrays, env sub-tables) — not the flat command case.
    // Seed them, write only default_model, and assert the whole config survives the serialize→reparse cycle.
    mkdirSync(globalDir(home), { recursive: true });
    writeFileSync(
      globalConfigPath(home),
      [
        '[preferences]',
        'theme = "light"',
        '[[mcp_servers]]',
        'name = "fs"',
        'transport = "stdio"',
        'command = "npx server-filesystem"',
        'args = ["--root", "/tmp"]',
        '[mcp_servers.env]',
        'TOKEN = "{{secrets.gh}}"',
        '[[mcp_servers]]',
        'name = "web"',
        'transport = "http"',
        'url = "https://example.com/mcp"',
        '',
      ].join('\n'),
    );

    writeGlobalDefaultModel('a-model', home);

    expect(readBack(home)).toEqual({
      preferences: { theme: 'light', default_model: 'a-model' },
      mcp_servers: [
        {
          name: 'fs',
          transport: 'stdio',
          command: 'npx server-filesystem',
          args: ['--root', '/tmp'],
          env: { TOKEN: '{{secrets.gh}}' },
        },
        { name: 'web', transport: 'http', url: 'https://example.com/mcp' },
      ],
    });
  });

  it('refuses to write (throws, never creates the file) when the model serializes to non-round-tripping TOML', () => {
    // A lone UTF-16 surrogate is a valid JS string (so it passes schema validation) but stringifies to an
    // invalid TOML escape that parseToml rejects. The round-trip self-check (ADR-0063 §3) must catch it BEFORE
    // the atomic rename, so config.toml is never created. This is the exact guarantee the hardening added —
    // WITHOUT this test, silently dropping the verifyRoundTrips() call would still pass the whole suite.
    let thrown: unknown;
    try {
      writeGlobalDefaultModel('sentinel:\uD800:model', home);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    if (thrown instanceof ConfigError) {
      expect(thrown.message).not.toContain('sentinel:'); // value-free message (no echoed model value)
    }
    // The atomic contract: a rejected write leaves no target and no orphan temp.
    expect(existsSync(globalConfigPath(home))).toBe(false);
    expect(readdirSync(globalDir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
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

describe('writeGlobalPreferences (ADR-0066 §6 — the /models effort sub-step write)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'relavium-write-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('writes [preferences].reasoning_effort alone (round-trip)', () => {
    writeGlobalPreferences({ reasoningEffort: 'high' }, home);
    expect(readBack(home)).toEqual({ preferences: { reasoning_effort: 'high' } });
  });

  it('writes default_model AND reasoning_effort together in one atomic write', () => {
    writeGlobalPreferences({ defaultModel: 'deepseek-v4-flash', reasoningEffort: 'max' }, home);
    expect(readBack(home)).toEqual({
      preferences: { default_model: 'deepseek-v4-flash', reasoning_effort: 'max' },
    });
  });

  it('a model-only write PRESERVES an existing reasoning_effort (partial merge — an absent field is unchanged)', () => {
    // Seed a prior effort default, then write only the model — the effort must survive (the ADR-0066 §6 partial-merge
    // guarantee, so setting a model in the picker never silently clears the user's effort preference).
    writeGlobalPreferences({ reasoningEffort: 'low' }, home);
    writeGlobalPreferences({ defaultModel: 'gpt-4o' }, home);
    expect(readBack(home)).toEqual({
      preferences: { reasoning_effort: 'low', default_model: 'gpt-4o' },
    });
  });

  it('an invalid tier is rejected by the schema round-trip (value-free ConfigError), file untouched', () => {
    // The typed setter only accepts a `ReasoningEffort`, but a cast-through would fail the strict re-validation
    // rather than reach disk — pin that the schema is the guard (ADR-0063 §3), not the caller's discipline.
    expect(() => writeGlobalPreferences({ reasoningEffort: 'ludicrous' as never }, home)).toThrow(
      ConfigError,
    );
    expect(existsSync(globalConfigPath(home))).toBe(false); // nothing written on a rejected value
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
