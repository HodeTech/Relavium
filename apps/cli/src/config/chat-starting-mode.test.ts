import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHAT_MODES, GlobalConfigSchema, ProjectConfigSchema } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfigFile, loadResolvedConfig } from './load.js';
import { resolveConfig } from './resolve.js';
import {
  globalConfigPath,
  prepareChatModeHintShown,
  prepareDefaultChatMode,
  prepareGlobalPreferences,
} from './write.js';

describe('starting mode resolution and operator publication', () => {
  let root: string;
  let home: string;
  let workspace: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-starting-mode-'));
    home = join(root, 'home');
    workspace = join(root, 'workspace');
    mkdirSync(home);
    mkdirSync(join(workspace, '.relavium'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves project > workspace > global > ask with source attribution', () => {
    const global = GlobalConfigSchema.parse({ preferences: { default_mode: 'auto' } });
    const shared = ProjectConfigSchema.parse({ chat: { default_mode: 'plan' } });
    const project = ProjectConfigSchema.parse({ chat: { default_mode: 'accept-edits' } });
    expect(resolveConfig({ global, workspace: shared, project }).chat).toMatchObject({
      defaultMode: 'accept-edits',
      defaultModeSource: 'project',
    });
    expect(resolveConfig({ global, workspace: shared }).chat).toMatchObject({
      defaultMode: 'plan',
      defaultModeSource: 'workspace',
    });
    expect(resolveConfig({ global }).chat).toMatchObject({
      defaultMode: 'auto',
      defaultModeSource: 'global',
    });
    expect(resolveConfig({}).chat).toMatchObject({
      defaultMode: 'ask',
      defaultModeSource: 'fallback',
    });
  });

  it('validates a shadowed workspace auto before returning the project choice', () => {
    writeFileSync(join(workspace, '.relavium/workspace.toml'), '[chat]\ndefault_mode="auto"\n');
    writeFileSync(join(workspace, '.relavium/project.toml'), '[chat]\ndefault_mode="ask"\n');
    expect(
      () => loadResolvedConfig({ cwd: workspace, home }),
      'W2_STARTUP_REPOSITORY_AUTO_REFUSAL',
    ).toThrow('chat.default_mode');
  });

  it('reports the invalid field and file without echoing its value', () => {
    const target = join(workspace, '.relavium/project.toml');
    const value = 'PRIVATE_MODE_CANARY';
    writeFileSync(target, `[chat]\ndefault_mode="${value}"\n`);
    let failure: unknown;
    try {
      loadResolvedConfig({ cwd: workspace, home });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('expected config refusal');
    expect(failure.message).toContain(target);
    expect(failure.message).toContain('chat.default_mode');
    expect(failure.message).not.toContain(value);
  });

  it.each(CHAT_MODES)(
    'publishes operator default %s without losing unrelated preferences',
    (mode) => {
      prepareGlobalPreferences(
        { defaultModel: 'operator-model', defaultProvider: 'openai' },
        home,
      ).publish();
      const original = readFileSync(globalConfigPath(home), 'utf8');
      const prepared = prepareDefaultChatMode(mode, home);
      expect(prepared.rewriteNeeded).toBe(true);
      expect(readFileSync(globalConfigPath(home), 'utf8')).toBe(original);
      prepared.publish();
      prepareChatModeHintShown(home).publish();
      expect(loadConfigFile(globalConfigPath(home), GlobalConfigSchema)?.preferences).toEqual({
        default_model: 'operator-model',
        default_provider: 'openai',
        default_mode: mode,
        default_mode_hint_shown: true,
      });
      if (process.platform !== 'win32')
        expect(statSync(globalConfigPath(home)).mode & 0o777).toBe(0o600);
    },
  );

  it('preparation and revoked publication leave an absent global file absent', () => {
    const prepared = prepareDefaultChatMode('auto', home);
    expect(prepared.rewriteNeeded).toBe(false);
    expect(existsSync(globalConfigPath(home))).toBe(false);
    expect(() =>
      prepared.publish(() => {
        throw new Error('owner stopped');
      }),
    ).toThrow('owner stopped');
    expect(existsSync(globalConfigPath(home))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses an operator config symlink without touching its target',
    () => {
      const target = join(root, 'target.toml');
      const selected = join(root, 'selected.toml');
      writeFileSync(target, '[preferences]\ndefault_mode="ask"\n');
      symlinkSync(target, selected);
      expect(() => prepareDefaultChatMode('auto', home, selected)).toThrow();
      expect(readFileSync(target, 'utf8')).toBe('[preferences]\ndefault_mode="ask"\n');
    },
  );
});
