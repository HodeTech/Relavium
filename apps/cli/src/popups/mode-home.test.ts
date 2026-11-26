/**
 * The bare Home's `/mode` as a popup (ADR-0148 §1, §3, §6; MVP-11 Appendix A): the startup-default writer's own flow (`runModeSettings`),
 * framed `Mode · Confirm · Done`, its confirmation the chord card. The real channel on a manual clock, a real starting-mode runtime over a
 * temporary operator home, and the real config writer: nothing touches an operator's home or working directory.
 *
 * - Mode: the four modes with their whole effect, opened on the global default, under the flow's note of the effective start;
 * - Confirm: a chord card that says what is written, to which file and what stays; only an `allow` the guard let through writes (a held
 *   `Ctrl+Y`, `Enter`, `Ctrl+N`, `Esc` and `Ctrl+C` never do); `Esc` steps back to Mode, opened on the mode chosen;
 * - Done: persistent, names the file, in the tone of what happened (a write that failed is drawn as one);
 * - the writer's own guards stay: a confirmed narrowing revokes startup `auto`, a confirmed `auto` states its effect first and is admitted
 *   again only after it was written.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHAT_MODES, type ChatMode } from '@relavium/shared';
import type { Key } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MODE_DESCRIPTION } from '../chat/chat-mode.js';
import { MODE_EFFECT } from '../chat/mode-effects.js';
import type { ModeSettingsOptions } from '../chat/mode-settings.js';
import { createStartingModeRuntime } from '../chat/starting-mode.js';
import { loadResolvedConfig } from '../config/load.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
import {
  MODE_HOME_STEPS,
  MODE_HOME_TITLE,
  MODE_KEEP_LABEL,
  MODE_SAVE_LABEL,
  MODE_STAYS_LINE,
  MODE_UNCHANGED,
  modeFileLine,
  modeWriteLine,
  runHomeModeSettings,
} from './mode-home.js';

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const ENTER: Key = { ...none, return: true };
const ESCAPE: Key = { ...none, escape: true };
const DOWN: Key = { ...none, downArrow: true };
const UP: Key = { ...none, upArrow: true };
const CTRL: Key = { ...none, ctrl: true };

const SHOWN_AT = 10_000;
const PAST_THE_GUARDS_MS = 6000;
const WAIT = { timeout: 5000, interval: 2 } as const;
const TARGET = '~/.relavium/config.toml';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface RigOptions {
  readonly initial?: ChatMode;
  readonly publish?: ModeSettingsOptions['publish'];
}

/** An operator home whose global default is `initial`, the real runtime over it, and the popup running on the real channel. */
function rig(options: RigOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-mode-home-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(cwd);
  const configPath = join(home, '.relavium', 'config.toml');
  const written = `[preferences]\ndefault_mode = "${options.initial ?? 'ask'}"\ntheme = "kept"\n`;
  writeFileSync(configPath, written);
  const runtime = createStartingModeRuntime(loadResolvedConfig({ cwd, home }), true);
  let clock = SHOWN_AT;
  const channel = createNativePromptChannel({ now: () => clock });
  channel.ui.bindVisibility(() => true);
  const publish = vi.fn<ModeSettingsOptions['publish']>(
    options.publish ?? ((prepared, assertAdmitting) => prepared.publish(assertAdmitting)),
  );
  const result = runHomeModeSettings({
    runtime,
    cwd,
    interactive: true,
    flow: channel.flow,
    target: TARGET,
    assertAdmitting: () => {},
    publish,
  });
  const snapshot = () => channel.ui.getSnapshot();
  return {
    runtime,
    channel,
    publish,
    result,
    snapshot,
    config: () => readFileSync(configPath, 'utf8'),
    unchanged: written,
    press: (input: string, key: Key) => channel.ui.input(input, key),
    advance: (ms: number) => {
      clock += ms;
    },
    /** Wait for a prompt of `kind`, paint it, and (unless `guarded`) let its guards pass. */
    async stepUp(kind: 'select' | 'chord', guarded = false) {
      await vi.waitFor(() => expect(snapshot().kind).toBe(kind), WAIT);
      channel.ui.shown(snapshot());
      if (!guarded) clock += PAST_THE_GUARDS_MS;
    },
    async lastStep() {
      await vi.waitFor(() => expect(snapshot().final).toBeDefined(), WAIT);
      const step = snapshot();
      channel.ui.shown(step);
      clock += PAST_THE_GUARDS_MS;
      return step;
    },
  };
}
type Rig = ReturnType<typeof rig>;

/** Choose `mode` on the first step, from the row the list opened on (the global default). */
async function choose(r: Rig, mode: ChatMode): Promise<void> {
  await r.stepUp('select');
  const delta = CHAT_MODES.indexOf(mode) - r.snapshot().selected;
  for (let i = 0; i < Math.abs(delta); i += 1) {
    r.press('', delta > 0 ? DOWN : UP);
    r.channel.ui.shown(r.snapshot());
  }
  r.press('', ENTER);
}

describe('step 1, Mode: the choice', () => {
  it('is the popup’s first step: the four modes, each with its whole effect, opened on the global default, under the effective start', async () => {
    const r = rig({ initial: 'plan' });
    await r.stepUp('select');
    const step = r.snapshot();
    expect(step.popup).toMatchObject({
      title: MODE_HOME_TITLE,
      origin: 'home',
      stepIndex: 0,
      stepCount: 3,
      stepNames: [...MODE_HOME_STEPS],
    });
    expect(step.options.map((option) => [option.value, option.hint])).toEqual(
      CHAT_MODES.map((mode) => [mode, MODE_DESCRIPTION[mode]]),
    );
    expect(step.options[step.selected]?.value, 'opened on the global default').toBe('plan');
    expect(step.note).toBe('Effective startup: plan. Global default: plan.');
    r.press('', ESCAPE);
    expect(await r.result, 'closed before it asked: nothing to say').toBeUndefined();
    expect(r.config()).toBe(r.unchanged);
  });
});

describe('step 2, Confirm: the chord card', () => {
  it('says what is written, to which file and what stays, on the rail’s second step', async () => {
    const r = rig();
    await choose(r, 'plan');
    await r.stepUp('chord');
    const step = r.snapshot();
    expect(step.popup).toMatchObject({ title: MODE_HOME_TITLE, stepIndex: 1 });
    expect(step.message).toBe('Save plan as the global startup default?');
    expect(step.details).toEqual([modeWriteLine('plan'), modeFileLine(TARGET), MODE_STAYS_LINE]);
    expect(step.options.map((option) => option.label)).toEqual([MODE_SAVE_LABEL, MODE_KEEP_LABEL]);
    r.press('n', CTRL);
    expect(await r.result).toBe(MODE_UNCHANGED);
  });

  it('only a Ctrl+Y the guard let through writes: Enter, a bare y and a Ctrl+Y inside the lockout write nothing', async () => {
    const r = rig();
    await choose(r, 'plan');
    await r.stepUp('chord', true);
    r.press('', ENTER);
    r.press('y', none);
    r.press('y', CTRL); // inside the lockout from the card's measured frame
    expect(r.snapshot().kind, 'the card is still open').toBe('chord');
    expect(r.publish).not.toHaveBeenCalled();
    expect(r.config()).toBe(r.unchanged);
    r.advance(PAST_THE_GUARDS_MS);
    r.press('y', CTRL);
    await r.lastStep();
    expect(r.publish).toHaveBeenCalledOnce();
  });

  it('a held Ctrl+Y never confirms: each repeat inside the lockout restarts it, and only a deliberate press after a quiet gap writes', async () => {
    const r = rig();
    await choose(r, 'plan');
    await r.stepUp('chord', true);
    // A key held from the moment the card appeared, repeating every 100 ms for three lockouts.
    for (let elapsed = 0; elapsed < 3 * APPROVAL_LOCKOUT_MS; elapsed += 100) {
      r.press('y', CTRL);
      r.advance(100);
    }
    expect(r.snapshot().kind).toBe('chord');
    expect(r.publish).not.toHaveBeenCalled();
    r.advance(PAST_THE_GUARDS_MS);
    r.press('y', CTRL);
    await r.lastStep();
    expect(r.publish).toHaveBeenCalledOnce();
  });

  it('a held Enter chooses the mode and then answers nothing on the card', async () => {
    const r = rig();
    await r.stepUp('select');
    r.press('', DOWN);
    r.channel.ui.shown(r.snapshot());
    r.press('', ENTER);
    await vi.waitFor(() => expect(r.snapshot().kind).toBe('chord'), WAIT);
    r.channel.ui.shown(r.snapshot());
    for (let repeat = 0; repeat < 40; repeat += 1) {
      r.press('', ENTER);
      r.advance(100);
    }
    r.advance(PAST_THE_GUARDS_MS);
    r.press('', ENTER);
    expect(r.snapshot().kind).toBe('chord');
    expect(r.publish).not.toHaveBeenCalled();
    r.press('n', CTRL);
    expect(await r.result).toBe(MODE_UNCHANGED);
  });

  it.each([
    ['Ctrl+N', 'n', CTRL],
    ['Ctrl+C', 'c', CTRL],
  ])(
    '%s writes nothing, opens no Done step and says so in one notification',
    async (_name, input, key) => {
      const r = rig();
      await choose(r, 'plan');
      await r.stepUp('chord');
      r.press(input, key);
      expect(await r.result).toBe(MODE_UNCHANGED);
      expect(r.publish).not.toHaveBeenCalled();
      expect(r.config()).toBe(r.unchanged);
    },
  );

  it('Esc steps back to the choice, opened on the mode chosen; Esc there closes, writing nothing and saying nothing', async () => {
    const r = rig();
    await choose(r, 'accept-edits');
    await r.stepUp('chord');
    r.press('', ESCAPE);
    await r.stepUp('select');
    const step = r.snapshot();
    expect(step.popup).toMatchObject({ title: MODE_HOME_TITLE, stepIndex: 0 });
    expect(step.options[step.selected]?.value).toBe('accept-edits');
    r.press('', ESCAPE);
    expect(await r.result).toBeUndefined();
    expect(r.publish).not.toHaveBeenCalled();
    expect(r.config()).toBe(r.unchanged);
  });
});

describe('step 3, Done: persistent, naming the file', () => {
  it('a narrowing written: the file holds it, startup auto is revoked, and the step closes with Enter', async () => {
    const r = rig({ initial: 'auto' });
    const revoke = vi.spyOn(r.runtime.authority, 'revoke');
    await choose(r, 'plan');
    await r.stepUp('chord');
    r.press('y', CTRL);
    const step = await r.lastStep();
    expect(step.final).toBe('ok');
    expect(step.popup).toMatchObject({ title: MODE_HOME_TITLE, stepIndex: 2 });
    expect(step.message).toBe('Startup default: plan · applies to new chats');
    expect(step.details).toEqual([TARGET]);
    expect(r.config()).toContain('default_mode = "plan"');
    expect(r.config(), 'the file’s other settings stay').toContain('theme = "kept"');
    expect(revoke).toHaveBeenCalled();
    r.press('', ENTER);
    expect(await r.result, 'the Done step said it: no notification').toBeUndefined();
  });

  it('auto: the confirmation states its effect first, and it is admitted again only after it was written', async () => {
    const r = rig();
    const admit = vi.spyOn(r.runtime.authority, 'admitConfirmedAutoDefault');
    await choose(r, 'auto');
    await r.stepUp('chord');
    expect(r.snapshot().message).toBe(
      `${MODE_EFFECT.auto.full} Save auto as the global startup default?`,
    );
    expect(admit).not.toHaveBeenCalled();
    r.press('y', CTRL);
    const step = await r.lastStep();
    expect(admit).toHaveBeenCalledOnce();
    expect(r.publish.mock.invocationCallOrder[0]).toBeLessThan(
      admit.mock.invocationCallOrder[0] ?? 0,
    );
    expect(step.final).toBe('ok');
    expect(r.config()).toContain('default_mode = "auto"');
    r.press('', ESCAPE);
    expect(await r.result).toBeUndefined();
  });

  it('a write that fails is a failed Done step that says why in the flow’s own sentence', async () => {
    const r = rig({
      publish: () => {
        throw new Error('disk full');
      },
    });
    await choose(r, 'plan');
    await r.stepUp('chord');
    r.press('y', CTRL);
    const step = await r.lastStep();
    expect(step.final).toBe('failed');
    expect(step.message).toBe('Startup default not saved; startup auto stays revoked');
    expect(step.details).toEqual([
      TARGET,
      'Startup default was not saved. Startup auto remains revoked for this invocation.',
    ]);
    expect(r.config()).toBe(r.unchanged);
    r.press('', ENTER);
    expect(await r.result).toBeUndefined();
  });
});
