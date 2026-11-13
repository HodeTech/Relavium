import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadResolvedConfig } from './load.js';
import { applyInvocationDefault } from './invocation-default.js';
import { createStartingModeRuntime } from '../chat/starting-mode.js';

describe('automatic project configuration target boundaries', () => {
  let root: string, home: string, cwd: string, marker: string, globalDir: string;
  const source =
    '[defaults]\nmodel = "global-model"\n[chat]\ndefault_model = "global-chat-model"\n';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-layer-boundary-'));
    home = join(root, 'home');
    cwd = join(home, 'project');
    marker = join(cwd, '.relavium');
    globalDir = join(home, '.relavium');
    mkdirSync(marker, { recursive: true });
    mkdirSync(globalDir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(['workspace.toml', 'project.toml'])(
    'refuses %s pointing into global state with an injected home',
    (name) => {
      const target = join(globalDir, name);
      writeFileSync(target, source);
      symlinkSync(target, join(marker, name));
      expect(() => loadResolvedConfig({ cwd, home })).toThrow('global configuration');
      expect(readFileSync(target, 'utf8')).toBe(source);
    },
  );

  it.each(['workspace.toml', 'project.toml'])(
    'rejects a later %s global alias on the next owned read without reopening it for fallback',
    (name) => {
      writeFileSync(join(globalDir, 'config.toml'), '[preferences]\ndefault_mode="auto"\n');
      const runtime = createStartingModeRuntime(loadResolvedConfig({ cwd, home }), true);
      const { loaded, startingMode } = runtime.resolve(cwd);
      const target = join(globalDir, name);
      writeFileSync(target, source);
      symlinkSync(target, join(marker, name));
      expect(
        applyInvocationDefault(loaded, { model: 'invocation-model', provider: 'openai' }).config
          .chat.defaultModel,
      ).toBe('invocation-model');
      expect(() => runtime.authority.assertDispatch(startingMode, 'write_file')).not.toThrow();
      expect(() => runtime.read(cwd)).toThrow('global configuration');
      expect(() => runtime.authority.assertDispatch(startingMode, 'write_file')).toThrow('revoked');
      expect(readFileSync(target, 'utf8')).toBe(source);
    },
  );

  it.each(['workspace.toml', 'project.toml'])(
    'excludes %s when the canonical global root is nested under the project marker',
    (name) => {
      rmSync(globalDir, { recursive: true });
      const nested = join(marker, 'device-state');
      mkdirSync(nested);
      symlinkSync(nested, globalDir, process.platform === 'win32' ? 'junction' : 'dir');
      const target = join(nested, name);
      writeFileSync(target, source);
      symlinkSync(target, join(marker, name));
      expect(() => loadResolvedConfig({ cwd, home })).toThrow('global configuration');
      expect(readFileSync(target, 'utf8')).toBe(source);
    },
  );

  it.each(['workspace.toml', 'project.toml'])(
    'refuses unresolved %s instead of treating a dangling alias as an absent layer',
    (name) => {
      symlinkSync(join(root, 'missing.toml'), join(marker, name));
      expect(() => loadResolvedConfig({ cwd, home })).toThrow('could not be resolved safely');
    },
  );

  it.each(['workspace.toml', 'project.toml'])(
    'preserves legitimate local %s aliases and their model precedence',
    (name) => {
      const target = join(cwd, 'shared-settings.toml');
      writeFileSync(target, '[chat]\ndefault_model = "local-model"\n');
      symlinkSync(target, join(marker, name));
      const loaded = loadResolvedConfig({ cwd, home });
      expect(loaded.config.chat.defaultModel).toBe('local-model');
      expect(
        applyInvocationDefault(loaded, { model: 'invocation-model', provider: 'openai' }).config
          .chat.defaultModel,
      ).toBe('local-model');
      expect(readFileSync(target, 'utf8')).toBe('[chat]\ndefault_model = "local-model"\n');
    },
  );

  it('preserves explicit operator-config alias reads into global state', () => {
    const target = join(globalDir, 'operator.toml');
    const contents = '[preferences]\ndefault_model = "selected-global-model"\n';
    writeFileSync(target, contents);
    const configPath = join(root, 'selected.toml');
    symlinkSync(target, configPath);
    expect(loadResolvedConfig({ cwd, home, configPath }).config.chat.defaultModel).toBe(
      'selected-global-model',
    );
    expect(readFileSync(target, 'utf8')).toBe(contents);
  });
});
