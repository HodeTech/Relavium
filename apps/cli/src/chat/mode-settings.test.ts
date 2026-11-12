import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatMode } from '@relavium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadResolvedConfig } from '../config/load.js';
import type { ConfigWriteResult, PreparedConfigWrite } from '../config/write.js';
import {
  NATIVE_PROMPT_CANCEL,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { runModeSettings, type ModeSettingsOptions } from './mode-settings.js';
import { createStartingModeRuntime } from './starting-mode.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(initial: ChatMode = 'auto', interactive = true) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-mode-settings-'));
  roots.push(root);
  const home = join(root, 'home'),
    cwd = join(root, 'workspace');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(cwd);
  const configPath = join(home, '.relavium', 'config.toml');
  writeFileSync(configPath, `[preferences]\ndefault_mode = "${initial}"\ntheme = "kept"\n`);
  const runtime = createStartingModeRuntime(loadResolvedConfig({ cwd, home }), interactive);
  const answers: Array<string | symbol> = [];
  const confirmations: Array<boolean | symbol> = [];
  const cancel = new AbortController();
  const select = vi.fn<NativePromptFlow['select']>(async () => {
    await Promise.resolve();
    return answers.shift() ?? NATIVE_PROMPT_CANCEL;
  });
  const confirm = vi.fn<NativePromptFlow['confirm']>(async () => {
    await Promise.resolve();
    return confirmations.shift() ?? NATIVE_PROMPT_CANCEL;
  });
  const flow = {
    begin: vi.fn(() => cancel.signal),
    end: vi.fn(async () => {
      await Promise.resolve();
    }),
    cancel: () => cancel.abort(),
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
  const options: ModeSettingsOptions = {
    runtime,
    cwd,
    interactive,
    flow,
    publish,
    assertAdmitting: () => {},
    notice,
  };
  return {
    options,
    runtime,
    flow,
    answers,
    confirmations,
    cancel,
    publish,
    notice,
    configPath,
    cwd,
  };
}

describe('shared explicit mode settings', () => {
  it('does not open or write headlessly', async () => {
    const f = fixture('auto', false);
    await runModeSettings(f.options);
    expect(f.flow.begin).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.notice).toHaveBeenCalledWith(
      expect.stringContaining('Non-interactive chat stays in ask'),
    );
  });

  it('changes only current mode in live chat, without a preference write or auto re-admission', async () => {
    const f = fixture('ask');
    const onCurrentMode = vi.fn<(mode: ChatMode) => void>();
    f.answers.push('accept-edits');
    await runModeSettings({ ...f.options, currentMode: () => 'ask', onCurrentMode });
    expect(onCurrentMode).toHaveBeenCalledExactlyOnceWith('accept-edits');
    expect(f.publish).not.toHaveBeenCalled();
    expect(readFileSync(f.configPath, 'utf8')).toContain('default_mode = "ask"');
    expect(() =>
      f.runtime.authority.resolve(() => ({
        mode: 'auto',
        globalMode: 'auto',
        source: 'global',
        hintShown: false,
      })),
    ).toThrow();
    expect(f.flow.end).toHaveBeenCalledOnce();
  });

  it('requires explicit risk confirmation for current auto without restoring startup authority', async () => {
    const f = fixture('ask');
    const onCurrentMode = vi.fn<(mode: ChatMode) => void>();
    f.answers.push('auto');
    f.confirmations.push(true);
    await runModeSettings({ ...f.options, currentMode: () => 'ask', onCurrentMode });
    expect(f.flow.confirm).toHaveBeenCalledWith(expect.stringContaining('without approval'), false);
    expect(onCurrentMode).toHaveBeenCalledExactlyOnceWith('auto');
    expect(f.publish).not.toHaveBeenCalled();
    expect(() =>
      f.runtime.authority.resolve(() => ({
        mode: 'auto',
        globalMode: 'auto',
        source: 'global',
        hintShown: false,
      })),
    ).toThrow();
  });

  it.each([false, NATIVE_PROMPT_CANCEL])(
    'selecting a startup mode saves nothing when confirmation is %s',
    async (answer) => {
      const f = fixture();
      const old = f.runtime.resolve(f.cwd).startingMode;
      f.answers.push('ask');
      f.confirmations.push(answer);
      await runModeSettings(f.options);
      expect(f.publish).not.toHaveBeenCalled();
      expect(() => f.runtime.authority.assertDispatch(old, 'write_file')).not.toThrow();
      expect(f.flow.end).toHaveBeenCalledOnce();
    },
  );

  it('live default action is separate from current selection and preserves unrelated preferences', async () => {
    const f = fixture();
    const onCurrentMode = vi.fn<(mode: ChatMode) => void>();
    f.answers.push('save-startup', 'plan');
    f.confirmations.push(true);
    await runModeSettings({ ...f.options, currentMode: () => 'auto', onCurrentMode });
    expect(onCurrentMode).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledOnce();
    const saved = readFileSync(f.configPath, 'utf8');
    expect(saved).toContain('default_mode = "plan"');
    expect(saved).toContain('theme = "kept"');
    expect(f.flow.select.mock.calls[0]?.[0].options).toContainEqual(
      expect.objectContaining({ value: 'save-startup' }),
    );
  });

  it.each(['prepare', 'publish'] as const)(
    'confirmed narrowing revokes before failed %s and does not leak the error',
    async (failure) => {
      const f = fixture();
      const old = f.runtime.resolve(f.cwd).startingMode;
      f.answers.push('ask');
      f.confirmations.push(true);
      const refused = () => {
        expect(() => f.runtime.authority.assertDispatch(old, 'write_file')).toThrow('revoked');
        throw new Error('private-path-and-key');
      };
      await runModeSettings({
        ...f.options,
        ...(failure === 'prepare' ? { prepare: refused } : { publish: refused }),
      });
      expect(
        () => f.runtime.authority.assertDispatch(old, 'write_file'),
        'W2_STARTUP_CONFIRMED_NARROWING',
      ).toThrow('revoked');
      expect(f.notice).toHaveBeenCalledWith(
        'Startup default was not saved. Startup auto remains revoked for this invocation.',
      );
      expect(JSON.stringify(f.notice.mock.calls)).not.toContain('private-path');
      expect(f.flow.end).toHaveBeenCalledOnce();
    },
  );

  it.each(['confirmed', 'unconfirmed'] as const)(
    're-admits auto only after actual %s publication',
    async (durability) => {
      const f = fixture('ask');
      f.answers.push('auto');
      f.confirmations.push(true);
      await runModeSettings({
        ...f.options,
        publish: (prepared, assertAdmitting) => {
          expect(() =>
            f.runtime.authority.assertDispatch(
              { mode: 'auto', origin: 'configured', authority: f.runtime.authority },
              'write_file',
            ),
          ).toThrow();
          prepared.publish(assertAdmitting);
          return { durability } satisfies ConfigWriteResult;
        },
      });
      expect(f.runtime.resolve(f.cwd).startingMode.mode).toBe('auto');
      expect(f.flow.confirm).toHaveBeenCalledWith(
        expect.stringContaining('Protected-path and permission denials still apply'),
        false,
      );
      expect(f.notice).toHaveBeenCalledWith(
        expect.stringContaining(
          durability === 'unconfirmed' ? 'durability could not be confirmed' : 'saved: auto',
        ),
      );
    },
  );

  it('failed auto publication does not widen authority', async () => {
    const f = fixture('ask');
    f.answers.push('auto');
    f.confirmations.push(true);
    await runModeSettings({
      ...f.options,
      publish: () => {
        throw new Error('private');
      },
    });
    expect(() =>
      f.runtime.authority.resolve(() => ({
        mode: 'auto',
        globalMode: 'auto',
        source: 'global',
        hintShown: false,
      })),
    ).toThrow();
    expect(JSON.stringify(f.notice.mock.calls)).not.toContain('private');
  });

  it.each(['narrower', 'invalid'] as const)(
    'a later %s config observation wins over a pending successful auto publication',
    async (observation) => {
      const f = fixture('ask');
      f.answers.push('auto');
      f.confirmations.push(true);
      let release: (() => void) | undefined;
      const complete = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const settings = runModeSettings({
        ...f.options,
        publish: async (prepared, assertAdmitting) => {
          const result = prepared.publish(assertAdmitting);
          entered?.();
          await complete;
          return result;
        },
      });
      await ready;
      writeFileSync(
        f.configPath,
        `[preferences]\ndefault_mode = "${observation === 'narrower' ? 'plan' : 'private-invalid'}"`,
      );
      if (observation === 'narrower') f.runtime.read(f.cwd);
      else expect(() => f.runtime.read(f.cwd)).toThrow();
      release?.();
      await settings;
      expect(
        () =>
          f.runtime.authority.resolve(() => ({
            mode: 'auto',
            globalMode: 'auto',
            source: 'global',
            hintShown: false,
          })),
        'W2_STARTUP_STALE_AUTO_ADMISSION',
      ).toThrow('no longer admitted');
      expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('default saved: auto'));
    },
  );

  it('post-publication cancellation preserves the saved fact without widening auto admission', async () => {
    const f = fixture('ask');
    f.answers.push('auto');
    f.confirmations.push(true);
    await runModeSettings({
      ...f.options,
      publish: (prepared, assertAdmitting) => {
        const result = prepared.publish(assertAdmitting);
        f.cancel.abort();
        return result;
      },
    });
    expect(readFileSync(f.configPath, 'utf8')).toContain('default_mode = "auto"');
    expect(() => f.runtime.resolve(f.cwd)).toThrow('no longer admitted');
    expect(f.notice).toHaveBeenCalledWith(
      'Startup default was published. Startup auto was not re-admitted for this invocation.',
    );
  });

  it('a replaced original owner cannot widen admission after publication', async () => {
    const f = fixture('ask');
    f.answers.push('auto');
    f.confirmations.push(true);
    let active = true;
    await runModeSettings({
      ...f.options,
      assertAdmitting: () => {
        if (!active) throw new Error('private-stale-owner');
      },
      publish: (prepared, assertAdmitting) => {
        const result = prepared.publish(assertAdmitting);
        active = false;
        return result;
      },
    });
    expect(() => f.runtime.resolve(f.cwd)).toThrow('no longer admitted');
    expect(f.notice).toHaveBeenCalledWith(
      'Startup default was published. Startup auto was not re-admitted for this invocation.',
    );
    expect(JSON.stringify(f.notice.mock.calls)).not.toContain('private-stale-owner');
  });

  it('does not end an unacquired prompt and reports end failure without its raw payload', async () => {
    const f = fixture();
    f.flow.begin.mockImplementationOnce(() => {
      throw new Error('private-begin');
    });
    await runModeSettings(f.options);
    expect(f.flow.end).not.toHaveBeenCalled();
    expect(JSON.stringify(f.notice.mock.calls)).not.toContain('private-begin');
    f.flow.end.mockRejectedValueOnce(new Error('private-cleanup'));
    await expect(runModeSettings(f.options)).rejects.toMatchObject({
      code: 'cli_internal',
    });
  });

  it('shows repository overrides in both disclosure and confirmation without changing current mode', async () => {
    const f = fixture('ask');
    mkdirSync(join(f.cwd, '.relavium'));
    writeFileSync(join(f.cwd, '.relavium', 'project.toml'), '[chat]\ndefault_mode = "plan"\n');
    f.answers.push('accept-edits');
    f.confirmations.push(true);
    await runModeSettings(f.options);
    expect(f.flow.note).toHaveBeenCalledWith(
      expect.stringContaining('project override selects plan'),
    );
    expect(f.flow.confirm).toHaveBeenCalledWith(
      expect.stringContaining('will not change this effective start'),
      false,
    );
    expect(f.runtime.resolve(f.cwd).startingMode.mode).toBe('plan');
  });

  it('the supplied publisher owns rewrite disclosure and receives a cancellable final guard', async () => {
    const f = fixture();
    f.answers.push('ask');
    f.confirmations.push(true);
    let prepared: PreparedConfigWrite | undefined;
    await runModeSettings({
      ...f.options,
      publish: (value, assertAdmitting) => {
        prepared = value;
        expect(value.rewriteNeeded).toBe(true);
        f.cancel.abort();
        return value.publish(assertAdmitting);
      },
    });
    expect(prepared).toBeDefined();
    expect(readFileSync(f.configPath, 'utf8')).toContain('default_mode = "auto"');
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('auto remains revoked'));
  });

  it('read errors revoke authority and release the owned flow with a fixed notice', async () => {
    const f = fixture();
    const old = f.runtime.resolve(f.cwd).startingMode;
    writeFileSync(f.configPath, '[preferences]\ndefault_mode = "private-invalid"');
    await runModeSettings(f.options);
    expect(f.flow.select).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(() => f.runtime.authority.assertDispatch(old, 'write_file')).toThrow('revoked');
    expect(JSON.stringify(f.notice.mock.calls)).not.toContain('private-invalid');
    expect(f.flow.end).toHaveBeenCalledOnce();
  });
});
