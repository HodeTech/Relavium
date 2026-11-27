/**
 * The persistent write of the startup default, drawn as a popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3, §6, dated note of 2026-11-27; MVP-11 unit 8 §6, OD-25): THE ONE confirmation and Done step of `/mode`, a chat's `[s]` and the Home's `Enter`
 * on another mode alike. The startup-default writer's own flow (`runStartupDefaultSave`) framed `Mode · Confirm · Done`, its confirmation the chord
 * card. The real channel on a manual clock, a real starting-mode runtime over a temporary operator home, and the real config writer: nothing touches an
 * operator's home or working directory.
 *
 * - Confirm: a chord card that says what is written, to which file, what saving does to it and (a chat) what stays; `auto` states its risk above the
 *   question; only an `allow` the guard let through writes (a held `Ctrl+Y`, a `Ctrl+Y` from before the card appeared, `Enter`, `Ctrl+N`, `Esc` and
 *   `Ctrl+C` never do); `Esc` steps back (the outcome says `back`, nothing written);
 * - Done: persistent, names the file, in the tone of what happened;
 * - the writer's own guards stay: a confirmed narrowing revokes startup `auto`, a confirmed `auto` is admitted again only after it was written;
 * - the words are one set for both surfaces: they differ only in the origin on the top edge and the chat's "stays" line.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ChatMode } from '@relavium/shared';
import type { Key } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MODE_EFFECT } from '../chat/mode-effects.js';
import type { ModeSettingsOptions } from '../chat/mode-settings.js';
import { createStartingModeRuntime } from '../chat/starting-mode.js';
import { loadResolvedConfig } from '../config/load.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
import {
  CONFIRM_AUTO_LINE,
  CONFIRM_CREATES_LINE,
  CONFIRM_REWRITE_LINE,
  confirmChatStaysLine,
  confirmDetails,
  confirmFileLine,
  confirmQuestion,
  confirmWritesLine,
  MODE_CONFIRM_STEPS,
  MODE_CONFIRM_TITLE,
  MODE_KEEP_LABEL,
  MODE_SAVE_LABEL,
  saveChatStartupDefault,
  splitConfirmMessage,
  STARTUP_UNCHANGED,
} from './mode-confirm.js';
import { MODE_NOT_COMPLETED } from './mode-popup.js';
import { saveHomeStartupDefault } from './mode-home.js';
import type { StartupDefaultOutcome } from './settings-port.js';

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
  readonly mode?: ChatMode;
  readonly surface?: 'home' | 'chat';
  /** The chat's own mode, said to stay (a chat only). */
  readonly inChat?: ChatMode;
  readonly publish?: ModeSettingsOptions['publish'];
  /** The runtime's read of the configuration throws when the flow asks it. */
  readonly readThrows?: boolean;
  /** The global configuration is made unparseable after the Home opened, before `/mode` reads it. */
  readonly corrupt?: boolean;
  /** A project file selects another mode: the confirmation names the override. */
  readonly projectMode?: ChatMode;
  /** No config file exists yet: saving creates it. */
  readonly noFile?: boolean;
  /** The raw flow's `end` rejects (the prompt could not be released). */
  readonly endThrows?: boolean;
  /** The persistent last step cannot be drawn: the flow's `select` with a `final` rejects. */
  readonly doneThrows?: boolean;
}

/** An operator home whose global default is `initial`, the real runtime over it, and the flow running on the real channel. */
function rig(options: RigOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-mode-confirm-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(cwd);
  const configPath = join(home, '.relavium', 'config.toml');
  const written = `[preferences]\ndefault_mode = "${options.initial ?? 'ask'}"\ntheme = "kept"\n`;
  if (options.noFile !== true) writeFileSync(configPath, written);
  if (options.projectMode !== undefined) {
    mkdirSync(join(cwd, '.relavium'));
    writeFileSync(
      join(cwd, '.relavium', 'project.toml'),
      `[chat]\ndefault_mode = "${options.projectMode}"\n`,
    );
  }
  const real = createStartingModeRuntime(loadResolvedConfig({ cwd, home }), true);
  const runtime: typeof real =
    options.readThrows === true
      ? {
          ...real,
          read: () => {
            throw new Error('the configuration could not be read');
          },
        }
      : real;
  if (options.corrupt === true)
    writeFileSync(configPath, `${written}[preferences\ndefault_mode="x27\n`, 'utf8');
  let clock = SHOWN_AT;
  const channel = createNativePromptChannel({ now: () => clock });
  channel.ui.bindVisibility(() => true);
  const publish = vi.fn<ModeSettingsOptions['publish']>(
    options.publish ?? ((prepared, assertAdmitting) => prepared.publish(assertAdmitting)),
  );
  const failure = vi.fn<(cause: unknown) => void>();
  const base =
    options.endThrows === true
      ? {
          ...channel.flow,
          end: () => Promise.reject(new Error('the prompt could not be released')),
        }
      : channel.flow;
  const flow =
    options.doneThrows === true
      ? {
          ...base,
          select: (request: Parameters<typeof channel.flow.select>[0]) =>
            request.final === undefined
              ? base.select(request)
              : Promise.reject(new Error('the result could not be drawn')),
        }
      : base;
  const common = {
    runtime,
    cwd,
    interactive: true,
    flow,
    target: TARGET,
    assertAdmitting: () => {},
    publish,
    failure,
  };
  const mode = options.mode ?? 'plan';
  const result =
    options.surface === 'chat'
      ? saveChatStartupDefault(common, mode, options.inChat ?? 'ask')
      : saveHomeStartupDefault(common, mode);
  const snapshot = () => channel.ui.getSnapshot();
  return {
    runtime,
    channel,
    publish,
    failure,
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

describe('the words of the confirmation: one set for both surfaces', () => {
  it('the question, what is written, the file, what saving does to it and what stays for the chat', () => {
    expect(confirmQuestion('plan')).toBe('Save plan as your startup default?');
    expect(confirmWritesLine('accept-edits')).toBe(
      'Writes default_mode = accept-edits for new chats.',
    );
    expect(confirmFileLine(TARGET)).toBe('File: ~/.relavium/config.toml');
    expect(CONFIRM_REWRITE_LINE).toBe(
      'Saving rewrites the file: its comments and ordering are not kept.',
    );
    expect(confirmChatStaysLine('ask')).toBe('This chat stays in ask mode.');
    expect([MODE_SAVE_LABEL, MODE_KEEP_LABEL]).toEqual(['Save it', 'Save nothing']);
    expect(MODE_CONFIRM_STEPS).toEqual(['Mode', 'Confirm', 'Done']);
  });

  it('the body: what is written, `auto`’s extra line, the file, rewrite or create, an override, and a chat’s “stays” line', () => {
    const base = { target: TARGET, exists: true, parts: {} } as const;
    expect(confirmDetails({ ...base, mode: 'plan' })).toEqual([
      confirmWritesLine('plan'),
      confirmFileLine(TARGET),
      CONFIRM_REWRITE_LINE,
    ]);
    expect(confirmDetails({ ...base, mode: 'plan', exists: false })).toEqual([
      confirmWritesLine('plan'),
      confirmFileLine(TARGET),
      CONFIRM_CREATES_LINE,
    ]);
    expect(
      confirmDetails({
        ...base,
        mode: 'auto',
        inChat: 'ask',
        parts: { override: 'Project override.' },
      }),
    ).toEqual([
      confirmWritesLine('auto'),
      CONFIRM_AUTO_LINE,
      confirmFileLine(TARGET),
      CONFIRM_REWRITE_LINE,
      'Project override.',
      confirmChatStaysLine('ask'),
    ]);
  });

  it('the writer’s message is split into its risk, its question and the override it names; a message in any other shape is left whole', () => {
    const question = 'Save plan as the global startup default?';
    expect(splitConfirmMessage(question, 'plan')).toEqual({});
    expect(
      splitConfirmMessage(
        `${question} project override selects ask; saving globally will not change this effective start.`,
        'plan',
      ),
    ).toEqual({
      override:
        'Project override selects ask; saving globally will not change this effective start.',
    });
    expect(
      splitConfirmMessage(
        `${MODE_EFFECT.auto.full} Save auto as the global startup default?`,
        'auto',
      ),
    ).toEqual({
      risk: MODE_EFFECT.auto.full,
    });
    // auto without its risk sentence, another mode's question, an added sentence glued on: not the writer's shape, so the card draws it whole
    expect(splitConfirmMessage('Save auto as the global startup default?', 'auto')).toBeUndefined();
    expect(splitConfirmMessage(question, 'ask')).toBeUndefined();
    expect(splitConfirmMessage(`${question}Extra`, 'plan')).toBeUndefined();
    expect(splitConfirmMessage('Something else entirely', 'plan')).toBeUndefined();
  });
});

describe('Confirm: the chord card', () => {
  it.each(['home', 'chat'] as const)(
    'says what is written, to which file and what saving does to it, on the rail’s second step, framed from %s',
    async (surface) => {
      const r = rig({ surface, inChat: 'accept-edits' });
      await r.stepUp('chord');
      const step = r.snapshot();
      expect(step.popup).toMatchObject({
        title: MODE_CONFIRM_TITLE,
        origin: surface,
        stepIndex: 1,
        stepCount: 3,
        stepNames: [...MODE_CONFIRM_STEPS],
      });
      expect(step.message).toBe('Save plan as your startup default?');
      expect(step.details).toEqual([
        confirmWritesLine('plan'),
        confirmFileLine(TARGET),
        CONFIRM_REWRITE_LINE,
        ...(surface === 'chat' ? [confirmChatStaysLine('accept-edits')] : []),
      ]);
      expect(step.options.map((option) => option.label)).toEqual([
        MODE_SAVE_LABEL,
        MODE_KEEP_LABEL,
      ]);
      r.press('n', CTRL);
      expect(await r.result).toEqual({ kind: 'notice', text: STARTUP_UNCHANGED });
    },
  );

  it('a first save (no file yet) says it creates the file, not that it rewrites one', async () => {
    const r = rig({ noFile: true });
    await r.stepUp('chord');
    expect(r.snapshot().details).toContain(CONFIRM_CREATES_LINE);
    expect(r.snapshot().details).not.toContain(CONFIRM_REWRITE_LINE);
    r.press('n', CTRL);
    await r.result;
  });

  it('a project that selects another mode is named on the card: the writer’s override sentence, split off the question', async () => {
    const r = rig({ projectMode: 'ask', mode: 'accept-edits' });
    await r.stepUp('chord');
    const step = r.snapshot();
    expect(step.message).toBe('Save accept-edits as your startup default?');
    expect(step.details).toContain(
      'Project override selects ask; saving globally will not change this effective start.',
    );
    r.press('n', CTRL);
    await r.result;
  });

  it('auto: the risk sentence comes before the question, in the card’s own words, the extra line is in the body, and it is admitted again only after it was written', async () => {
    const r = rig({ mode: 'auto' });
    const admit = vi.spyOn(r.runtime.authority, 'admitConfirmedAutoDefault');
    await r.stepUp('chord');
    const step = r.snapshot();
    expect(step.message).toBe(`${MODE_EFFECT.auto.full} Save auto as your startup default?`);
    expect(step.details).toContain(CONFIRM_AUTO_LINE);
    expect(admit).not.toHaveBeenCalled();
    r.press('y', CTRL);
    const done = await r.lastStep();
    expect(admit).toHaveBeenCalledOnce();
    expect(r.publish.mock.invocationCallOrder[0]).toBeLessThan(
      admit.mock.invocationCallOrder[0] ?? 0,
    );
    expect(done.final).toBe('ok');
    expect(r.config()).toContain('default_mode = "auto"');
    r.press('', ESCAPE);
    expect(await r.result).toEqual({ kind: 'said' });
  });

  it('only a Ctrl+Y the guard let through writes: Enter, a bare y and a Ctrl+Y inside the lockout write nothing', async () => {
    const r = rig();
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

  it('a Ctrl+Y held from BEFORE the card appeared never confirms: its repeats through the moment the card opens are no answer, the lockout counts from the card’s appearance', async () => {
    const r = rig();
    // The key goes down while the list is still on screen (no card yet) and repeats through the card's appearance.
    for (let held = 0; held < 20; held += 1) {
      r.press('y', CTRL);
      r.advance(50);
    }
    await vi.waitFor(() => expect(r.snapshot().kind).toBe('chord'), WAIT);
    r.channel.ui.shown(r.snapshot());
    for (let held = 0; held < 60; held += 1) {
      r.press('y', CTRL);
      r.advance(50);
    }
    expect(r.snapshot().kind, 'still asking').toBe('chord');
    expect(r.publish).not.toHaveBeenCalled();
    expect(r.config()).toBe(r.unchanged);
    r.advance(PAST_THE_GUARDS_MS);
    r.press('n', CTRL);
    expect(await r.result).toEqual({ kind: 'notice', text: STARTUP_UNCHANGED });
  });

  it('a held Enter (the key that handed the mode over) answers nothing on the card, however long it is held', async () => {
    const r = rig();
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
    expect(await r.result).toEqual({ kind: 'notice', text: STARTUP_UNCHANGED });
  });

  it.each([
    ['Ctrl+N', 'n', CTRL],
    ['Ctrl+C', 'c', CTRL],
  ])(
    '%s writes nothing, opens no Done step and says so in one notification',
    async (_name, input, key) => {
      const r = rig();
      await r.stepUp('chord');
      r.press(input, key);
      expect(await r.result).toEqual({ kind: 'notice', text: STARTUP_UNCHANGED });
      expect(r.publish).not.toHaveBeenCalled();
      expect(r.config()).toBe(r.unchanged);
      expect(STARTUP_UNCHANGED).toBe('Startup default unchanged');
    },
  );

  it('Esc steps back: the outcome says `back` (the host opens the list again on the mode chosen), nothing is written, nothing is said', async () => {
    const r = rig({ mode: 'accept-edits' });
    await r.stepUp('chord');
    r.press('', ESCAPE);
    expect(await r.result).toEqual({ kind: 'back' });
    expect(r.publish).not.toHaveBeenCalled();
    expect(r.config()).toBe(r.unchanged);
    expect(r.snapshot().active, 'the popup is closed').toBe(false);
  });
});

describe('Done: persistent, naming the file', () => {
  it('a narrowing written: the file holds it, startup auto is revoked, and the step closes with Enter', async () => {
    const r = rig({ initial: 'auto' });
    const revoke = vi.spyOn(r.runtime.authority, 'revoke');
    await r.stepUp('chord');
    r.press('y', CTRL);
    const step = await r.lastStep();
    expect(step.final).toBe('ok');
    expect(step.popup).toMatchObject({ title: MODE_CONFIRM_TITLE, stepIndex: 2 });
    expect(step.message).toBe('Startup default: plan · applies to new chats');
    expect(step.details).toEqual([TARGET]);
    expect(r.config()).toContain('default_mode = "plan"');
    expect(r.config(), 'the file’s other settings stay').toContain('theme = "kept"');
    expect(revoke).toHaveBeenCalled();
    r.press('', ENTER);
    expect(await r.result, 'the Done step said it: no notification').toEqual({ kind: 'said' });
  });

  it('a write that fails is a failed Done step that says why in the flow’s own sentence', async () => {
    const r = rig({
      publish: () => {
        throw new Error('disk full');
      },
    });
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
    expect(await r.result).toEqual({ kind: 'said' });
  });

  it('`Esc` on the Done step closes it too, and a write that happened is never unsaid by it', async () => {
    const r = rig();
    await r.stepUp('chord');
    r.press('y', CTRL);
    await r.lastStep();
    r.press('', ESCAPE);
    expect(await r.result).toEqual({ kind: 'said' });
    expect(r.config()).toContain('default_mode = "plan"');
  });
});

/** The writer's own sentence for a refusal before anything was saved (`chat/mode-settings.ts`, `modeSettingsFailure`). */
describe('a flow that refuses before it asks anything (unit 7 round 2 sitting #3: the popup said nothing)', () => {
  it.each([
    ['the configuration read throws', { readThrows: true }],
    ['the configuration became unparseable after the Home opened (mbroken)', { corrupt: true }],
  ] as const)(
    '%s: its own sentence is the one notification; no card is asked, no Done step is drawn, nothing is written',
    async (_name, options) => {
      const r = rig(options);
      const before = r.config();
      const outcome: StartupDefaultOutcome = await r.result;
      expect(outcome).toEqual({ kind: 'notice', text: MODE_NOT_COMPLETED });
      expect(r.publish).not.toHaveBeenCalled();
      expect(r.snapshot().final, 'no Done step').toBeUndefined();
      expect(r.snapshot().active, 'the popup is closed').toBe(false);
      expect(r.config(), 'nothing was written').toBe(before);
    },
  );
});

describe('a fault is the host’s, and never an unhandled rejection', () => {
  it('a Done step that cannot be drawn after the write: the failure is reported and the flow’s sentence stands as ONE notification (the write is not unsaid)', async () => {
    const r = rig({ doneThrows: true });
    await r.stepUp('chord');
    r.press('y', CTRL);
    expect(await r.result).toEqual({
      kind: 'notice',
      text: 'Startup default: plan · applies to new chats',
    });
    expect(r.failure).toHaveBeenCalledOnce();
    expect(r.config()).toContain('default_mode = "plan"');
  });

  it('a prompt that cannot be released after the result was said: the failure is reported, the sentence stands as one notification', async () => {
    const r = rig({ endThrows: true });
    await r.stepUp('chord');
    r.press('y', CTRL);
    await r.lastStep();
    r.press('', ENTER); // the Done step said it; closing it ends the frame, and the raw `end` rejects
    // The Done step said what happened: the fault after it does not unsay it, and does not reject
    expect(await r.result).toEqual({ kind: 'said' });
    expect(r.failure).toHaveBeenCalledOnce();
    expect(r.config()).toContain('default_mode = "plan"');
  });
});
