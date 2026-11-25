/**
 * The startup-default hand-off of the chat's `/mode` popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6; the 2026-11-25 ruling: "New chats" writes the global startup default and keeps today's consent rules). `runStartupDefaultSave`
 * runs the startup branch of `runModeSettings` for a mode chosen in the popup: the branch's one selection is answered with that mode and never
 * drawn, and everything else is today's: the effective-startup note, the confirmation that defaults to No (`auto` states its effect first),
 * the revocation a confirmed narrowing makes, the publication and its words. It never changes the session's own mode. A new file: the count
 * of `mode-settings.test.ts` is pinned by the secrets and causal controls.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHAT_MODES, type ChatMode } from '@relavium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadResolvedConfig } from '../config/load.js';
import {
  NATIVE_PROMPT_CANCEL,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { MODE_EFFECT } from './mode-effects.js';
import {
  runStartupDefaultSave,
  type ModeSettingsOptions,
  type StartupDefaultSaveOptions,
} from './mode-settings.js';
import { createStartingModeRuntime } from './starting-mode.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A startup-default save over a real config file and runtime, on a flow of fakes whose confirmations the test answers. */
function fixture(initial: ChatMode = 'ask', interactive = true) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-mode-startup-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(cwd);
  const configPath = join(home, '.relavium', 'config.toml');
  const original = `[preferences]\ndefault_mode = "${initial}"\ntheme = "kept"\n`;
  writeFileSync(configPath, original);
  const runtime = createStartingModeRuntime(loadResolvedConfig({ cwd, home }), interactive);
  const confirmations: Array<boolean | symbol> = [];
  const select = vi.fn<NativePromptFlow['select']>(() => Promise.resolve(NATIVE_PROMPT_CANCEL));
  const confirm = vi.fn<NativePromptFlow['confirm']>(async () => {
    await Promise.resolve();
    return confirmations.shift() ?? NATIVE_PROMPT_CANCEL;
  });
  const flow = {
    begin: vi.fn(() => new AbortController().signal),
    end: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(),
    note: vi.fn(),
    busy: vi.fn(),
    select,
    confirm,
    pick: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
    text: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
    password: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
  } satisfies NativePromptFlow;
  const notice = vi.fn<(text: string) => void>();
  const publish = vi.fn<ModeSettingsOptions['publish']>((prepared, assertAdmitting) =>
    prepared.publish(assertAdmitting),
  );
  const options: StartupDefaultSaveOptions = {
    runtime,
    cwd,
    interactive,
    flow,
    publish,
    assertAdmitting: () => {},
    notice,
  };
  return { options, runtime, flow, confirmations, publish, notice, configPath, original, cwd };
}

describe('saving the mode chosen in the popup as the startup default', () => {
  it('auto asks its confirmation, defaulting to No and stating its effect first; declining writes nothing', async () => {
    const f = fixture('ask');
    f.confirmations.push(false);
    await runStartupDefaultSave(f.options, 'auto');
    expect(f.flow.confirm).toHaveBeenCalledExactlyOnceWith(
      `${MODE_EFFECT.auto.full} Save auto as the global startup default?`,
      false,
    );
    expect(f.publish).not.toHaveBeenCalled();
    expect(readFileSync(f.configPath, 'utf8')).toBe(f.original);
    expect(f.notice).not.toHaveBeenCalled();
    expect(f.flow.end).toHaveBeenCalledOnce();
  });

  it('a card left with `Esc` (cancelled) writes nothing either', async () => {
    const f = fixture('ask');
    f.confirmations.push(NATIVE_PROMPT_CANCEL);
    await runStartupDefaultSave(f.options, 'auto');
    expect(f.publish).not.toHaveBeenCalled();
    expect(readFileSync(f.configPath, 'utf8')).toBe(f.original);
  });

  it('auto confirmed is published through the writer, keeps the other preferences, re-admits auto and says so', async () => {
    const f = fixture('ask');
    f.confirmations.push(true);
    await runStartupDefaultSave(f.options, 'auto');
    expect(f.publish).toHaveBeenCalledOnce();
    const saved = readFileSync(f.configPath, 'utf8');
    expect(saved).toContain('default_mode = "auto"');
    expect(saved).toContain('theme = "kept"');
    expect(f.runtime.resolve(f.cwd).startingMode.mode).toBe('auto');
    expect(f.notice).toHaveBeenCalledExactlyOnceWith('Global startup default saved: auto.');
  });

  it('a confirmed narrowing revokes the startup auto before it publishes (the branch’s own revocation)', async () => {
    const f = fixture('auto');
    const old = f.runtime.resolve(f.cwd).startingMode;
    f.confirmations.push(true);
    await runStartupDefaultSave(
      {
        ...f.options,
        publish: (prepared, assertAdmitting) => {
          expect(() => f.runtime.authority.assertDispatch(old, 'write_file')).toThrow('revoked');
          return prepared.publish(assertAdmitting);
        },
      },
      'plan',
    );
    expect(() => f.runtime.authority.assertDispatch(old, 'write_file')).toThrow('revoked');
    expect(readFileSync(f.configPath, 'utf8')).toContain('default_mode = "plan"');
  });

  it.each(CHAT_MODES)(
    'the branch’s selection is answered with %s and never drawn; the effective-startup note comes first',
    async (mode) => {
      const f = fixture('ask');
      f.confirmations.push(false);
      await runStartupDefaultSave(f.options, mode);
      expect(f.flow.select).not.toHaveBeenCalled();
      expect(f.flow.note).toHaveBeenCalledWith('Effective startup: ask. Global default: ask.');
      expect(f.flow.confirm).toHaveBeenCalledWith(
        expect.stringContaining(`Save ${mode} as the global startup default?`),
        false,
      );
    },
  );

  it('never asks about or changes the session’s own mode, even when the caller’s options carry a live chat’s', async () => {
    const f = fixture('ask');
    const onCurrentMode = vi.fn<(mode: ChatMode) => void>();
    const live: ModeSettingsOptions = {
      ...f.options,
      currentMode: () => 'ask',
      onCurrentMode,
    };
    f.confirmations.push(true);
    await runStartupDefaultSave(live, 'plan');
    expect(onCurrentMode).not.toHaveBeenCalled();
    expect(f.flow.select).not.toHaveBeenCalled();
    expect(readFileSync(f.configPath, 'utf8')).toContain('default_mode = "plan"');
    expect(f.notice).toHaveBeenCalledExactlyOnceWith('Global startup default saved: plan.');
  });

  it('never opens or writes headlessly', async () => {
    const f = fixture('ask', false);
    await runStartupDefaultSave(f.options, 'auto');
    expect(f.flow.begin).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.notice).toHaveBeenCalledWith(
      expect.stringContaining('Non-interactive chat stays in ask'),
    );
  });
});
