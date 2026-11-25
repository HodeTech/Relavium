/**
 * The `/mode` popup's "New chats" hand-off, as the popup receives it ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §6; MVP-11 step 5, F2): `saveStartupDefaultForPopup` runs the startup-default writer's real flow (`runStartupDefaultSave`, its card, its
 * confirmation, its publication) and returns what it came to as a result, which the popup says in a few words on the host's channel; none of
 * the flow's sentences goes anywhere else. Every path of the real flow is driven here, so a sentence the flow adds or rewords turns a case red
 * (`startupDefaultResultOf` reads the flow's own words). The words said are `mode-popup.test.ts`'s. A new file: the count of
 * `mode-settings.test.ts` is pinned by the secrets and causal controls.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatMode } from '@relavium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadResolvedConfig } from '../config/load.js';
import {
  NATIVE_PROMPT_CANCEL,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import {
  saveStartupDefaultForPopup,
  startupDefaultResultOf,
  type ModeSettingsOptions,
  type StartupDefaultHandOffOptions,
  type StartupDefaultSaveResult,
} from './mode-settings.js';
import { createStartingModeRuntime } from './starting-mode.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A hand-off over a real config file and runtime, on a flow of fakes whose confirmations the test answers. */
function fixture(initial: ChatMode = 'ask', interactive = true) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-mode-handoff-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(cwd);
  const configPath = join(home, '.relavium', 'config.toml');
  const original = `[preferences]\ndefault_mode = "${initial}"\n`;
  writeFileSync(configPath, original);
  const runtime = createStartingModeRuntime(loadResolvedConfig({ cwd, home }), interactive);
  const confirmations: Array<boolean | symbol> = [];
  const cancel = new AbortController();
  const flow = {
    begin: vi.fn(() => cancel.signal),
    end: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(),
    note: vi.fn(),
    busy: vi.fn(),
    select: vi.fn<NativePromptFlow['select']>(() => Promise.resolve(NATIVE_PROMPT_CANCEL)),
    confirm: vi.fn<NativePromptFlow['confirm']>(async () => {
      await Promise.resolve();
      return confirmations.shift() ?? NATIVE_PROMPT_CANCEL;
    }),
    pick: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
    text: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
    password: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
  } satisfies NativePromptFlow;
  const failures: unknown[] = [];
  const options: StartupDefaultHandOffOptions = {
    runtime,
    cwd,
    interactive,
    flow,
    publish: (prepared, assertAdmitting) => prepared.publish(assertAdmitting),
    assertAdmitting: () => {},
    failure: (cause) => failures.push(cause),
  };
  return { options, runtime, flow, confirmations, cancel, failures, configPath, original, cwd };
}

const SAVED: StartupDefaultSaveResult = {
  kind: 'saved',
  durability: 'confirmed',
  autoAfterRestart: false,
  unfinished: false,
};

describe('what the hand-off came to, through the real flow', () => {
  it.each([false, NATIVE_PROMPT_CANCEL])(
    'a confirmation answered %s (declined, or left with Esc) is unchanged: nothing written, the card still had its note',
    async (answer) => {
      const f = fixture('ask');
      f.confirmations.push(answer);
      expect(await saveStartupDefaultForPopup(f.options, 'auto')).toEqual({ kind: 'unchanged' });
      expect(readFileSync(f.configPath, 'utf8')).toBe(f.original);
      // The card is not residue: its note and its confirmation are drawn as before.
      expect(f.flow.note).toHaveBeenCalledWith('Effective startup: ask. Global default: ask.');
      expect(f.flow.confirm).toHaveBeenCalledOnce();
    },
  );

  it('a flow cancelled under the card (its signal aborted) is unchanged, not a failure', async () => {
    const f = fixture('ask');
    f.flow.confirm.mockImplementationOnce(() => {
      f.cancel.abort();
      return Promise.resolve(true);
    });
    expect(await saveStartupDefaultForPopup(f.options, 'auto')).toEqual({ kind: 'unchanged' });
    expect(readFileSync(f.configPath, 'utf8')).toBe(f.original);
  });

  it.each(['plan', 'ask', 'accept-edits', 'auto'] as const)(
    'a confirmed %s is saved, confirmed, and applies to new chats',
    async (mode) => {
      const f = fixture(mode === 'ask' ? 'plan' : 'ask');
      f.confirmations.push(true);
      expect(await saveStartupDefaultForPopup(f.options, mode)).toEqual(SAVED);
      expect(readFileSync(f.configPath, 'utf8')).toContain(`default_mode = "${mode}"`);
      expect(f.failures).toEqual([]);
    },
  );

  it('a write whose durability could not be confirmed says so', async () => {
    const f = fixture('ask');
    f.confirmations.push(true);
    const result = await saveStartupDefaultForPopup(
      {
        ...f.options,
        publish: (prepared, assertAdmitting) => ({
          ...prepared.publish(assertAdmitting),
          durability: 'unconfirmed',
        }),
      },
      'plan',
    );
    expect(result).toEqual({ ...SAVED, durability: 'unconfirmed' });
  });

  it('a project setting that selects another mode where the chat started: saved, and overridden by the project', async () => {
    const f = fixture('ask');
    mkdirSync(join(f.cwd, '.relavium'));
    writeFileSync(join(f.cwd, '.relavium', 'project.toml'), '[chat]\ndefault_mode = "plan"\n');
    f.confirmations.push(true);
    expect(await saveStartupDefaultForPopup(f.options, 'accept-edits')).toEqual({
      ...SAVED,
      overriddenBy: 'project',
    });
  });

  it('auto saved while a newer narrower observation revoked startup auto: saved, but auto applies after a restart (the stale-auto refusal)', async () => {
    const f = fixture('ask');
    f.confirmations.push(true);
    const result = await saveStartupDefaultForPopup(
      {
        ...f.options,
        publish: (prepared, assertAdmitting) => {
          // A config read elsewhere observed a narrower mode after the confirmation: the admission must refuse.
          f.runtime.authority.revoke();
          return prepared.publish(assertAdmitting);
        },
      },
      'auto',
    );
    expect(result).toEqual({ ...SAVED, autoAfterRestart: true });
    expect(readFileSync(f.configPath, 'utf8')).toContain('default_mode = "auto"');
  });

  it('auto published, then the chat stopped admitting before its admission: saved (durability not said), auto after a restart', async () => {
    const f = fixture('ask');
    f.confirmations.push(true);
    let closing = false;
    const result = await saveStartupDefaultForPopup(
      {
        ...f.options,
        assertAdmitting: () => {
          if (closing) throw new Error('the chat is closing');
        },
        publish: (prepared, assertAdmitting) => {
          const written = prepared.publish(assertAdmitting);
          closing = true;
          return written;
        },
      },
      'auto',
    );
    expect(result).toEqual({
      kind: 'saved',
      durability: 'unknown',
      autoAfterRestart: true,
      unfinished: false,
    });
  });

  it('a confirmed narrowing that could not be prepared: refused, and startup auto stays revoked', async () => {
    const f = fixture('auto');
    f.confirmations.push(true);
    const result = await saveStartupDefaultForPopup(
      {
        ...f.options,
        prepare: () => {
          throw new Error('PRIVATE prepare failure');
        },
      },
      'plan',
    );
    expect(result).toEqual({ kind: 'refused', autoRevoked: true });
    expect(readFileSync(f.configPath, 'utf8')).toBe(f.original);
  });

  it('auto that could not be published: refused, nothing revoked by it', async () => {
    const f = fixture('ask');
    f.confirmations.push(true);
    const publish: ModeSettingsOptions['publish'] = () => {
      throw new Error('PRIVATE publish failure');
    };
    expect(await saveStartupDefaultForPopup({ ...f.options, publish }, 'auto')).toEqual({
      kind: 'refused',
      autoRevoked: false,
    });
    expect(readFileSync(f.configPath, 'utf8')).toBe(f.original);
  });

  it('a headless runtime saves nothing and is refused (the popup never offers it there)', async () => {
    const f = fixture('ask', false);
    expect(await saveStartupDefaultForPopup(f.options, 'plan')).toEqual({
      kind: 'refused',
      autoRevoked: false,
    });
    expect(f.flow.begin).not.toHaveBeenCalled();
  });

  it('never rejects: a fault after the result (its prompt not released) is the owner’s, and the result stands', async () => {
    const f = fixture('ask');
    f.confirmations.push(true);
    f.flow.end.mockRejectedValueOnce(new Error('PRIVATE release failure'));
    expect(await saveStartupDefaultForPopup(f.options, 'plan')).toEqual(SAVED);
    expect(f.failures).toHaveLength(1);
    expect(f.failures[0]).toMatchObject({ code: 'cli_internal' });
  });

  it('a fault before the flow said anything is the owner’s too, and is a refusal (nothing is said to be saved)', async () => {
    const f = fixture('ask');
    f.confirmations.push(false);
    f.flow.end.mockRejectedValueOnce(new Error('PRIVATE release failure'));
    expect(await saveStartupDefaultForPopup(f.options, 'plan')).toEqual({
      kind: 'refused',
      autoRevoked: false,
    });
    expect(f.failures).toHaveLength(1);
  });
});

describe('the flow’s sentence read back (`startupDefaultResultOf`)', () => {
  it('the published-but-unfinished sentence (no path of the popup reaches it: its notice cannot throw) is saved, unfinished', () => {
    expect(
      startupDefaultResultOf('Startup default was published; mode settings could not finish.'),
    ).toEqual({ kind: 'saved', durability: 'unknown', autoAfterRestart: false, unfinished: true });
  });

  it('a workspace override is read as the workspace', () => {
    expect(
      startupDefaultResultOf(
        'Global startup default saved: plan. workspace override selects ask; saving globally will not change this effective start.',
      ),
    ).toEqual({ ...SAVED, overriddenBy: 'workspace' });
  });

  it('a sentence it does not know is read as nothing saved, never as saved', () => {
    expect(startupDefaultResultOf('Something else entirely.')).toEqual({
      kind: 'refused',
      autoRevoked: false,
    });
  });
});
