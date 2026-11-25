/**
 * The `/mode` popup in a chat ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3,
 * §6; `popup-mode-chat-80x24.png`; the two steps of the 2026-11-25 ruling). Step 1 lists the four modes, the one in force marked and opened on,
 * the highlighted mode's whole effect under the list in a room kept for the longest; `Enter` goes to step 2, which names the mode, states its
 * effect where it approves something without a card, and asks where it applies (this chat by default, or new chats). `Enter` there closes the
 * popup and applies: this chat through the session's one setter (which says what it did itself: the popup adds no word, whatever it answered),
 * new chats by handing off to the startup-default writer once the popup has gone (on the work owner, after the key has been handled). `Esc`
 * steps back, then closes; nothing changes unless `Enter` applied.
 */
import { CHAT_MODES, type ChatMode } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { MODE_EFFECT, modeChangedNotice } from '../chat/mode-effects.js';
import type { StartupDefaultSaveResult } from '../chat/mode-settings.js';
import { withGlyphForm } from '../render/tui/glyphs.js';
import { displayWidth } from '../render/tui/viewport.js';
import { formFits, naturalBodyRows, popupBody, popupText } from './frame-model.js';
import { POPUP_FLOOR, POPUP_NOTICE_MAX_COLUMNS, popupInnerWidth } from './geometry.js';
import {
  MODE_CURRENT,
  MODE_INTRO,
  modeContent,
  modeOfRow,
  modeScopeForm,
  modeSpec,
  SCOPE_STEP,
  scopeOf,
  startupDefaultAnnouncement,
} from './mode-popup.js';
import { macrotask, type PopupWorkOwner } from './popup-work.js';
import { currentStep, openFrame, popupLegend, type PopupKey } from './popup-reducer.js';
import type { ModeSettingsPort } from './settings-port.js';
import { DOWN, ENTER, ESC, settingsRig, UP } from './settings.test-support.js';

const END: PopupKey = { end: true };
/** A control character, or a line or paragraph separator (built from their code points: a source file cannot carry them as escapes here). */
const CONTROL = new RegExp(
  `[\\u0000-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  'u',
);
const INNER = popupInnerWidth(POPUP_FLOOR.columns, 'standard');

/** What the startup-default writer's flow comes to in these tests unless a case says otherwise: saved, and it applies to new chats. */
const SAVED: StartupDefaultSaveResult = {
  kind: 'saved',
  durability: 'confirmed',
  autoAfterRestart: false,
  unfinished: false,
};

/**
 * A `/mode` member over fakes: the mode in force `current`, every apply and hand-off recorded; `accepts` is what the setter answers, `result`
 * what the hand-off comes to.
 */
function fakeMode(current: ChatMode, accepts = true, result: StartupDefaultSaveResult = SAVED) {
  let now = current;
  const applied: ChatMode[] = [];
  const saved: ChatMode[] = [];
  const member: ModeSettingsPort = {
    current: () => now,
    apply: (mode) => {
      applied.push(mode);
      if (accepts) now = mode;
      return accepts;
    },
    saveStartupDefault: (mode) => {
      saved.push(mode);
      return Promise.resolve(result);
    },
  };
  return { applied, saved, member, mode: () => now };
}

/** The rig with `/mode` open on `current`, its frame seen and settled. */
function openMode(current: ChatMode = 'ask', accepts = true) {
  const r = settingsRig();
  const mode = fakeMode(current, accepts);
  const opened = r.open({ mode: mode.member }, 'mode');
  expect(opened.opened).toBe(true);
  r.settle();
  return { ...r, mode };
}

const stepIndex = (r: ReturnType<typeof settingsRig>): number | undefined =>
  r.host.getSnapshot().frame?.stepIndex;

/** The form step 2 shows now, or a failure. */
function shownForm(r: ReturnType<typeof settingsRig>) {
  const frame = r.host.getSnapshot().frame;
  if (frame === undefined) throw new Error('no popup');
  const { state } = currentStep(frame);
  if (state.content.kind !== 'form') throw new Error(`not a form: ${state.content.kind}`);
  return { form: state.content, chosen: state.selected };
}

describe('step 1: the modes', () => {
  it('the intro, then each mode: its name, its effect in a few words, `current` after the one in force, and its whole effect', () => {
    const content = modeContent('accept-edits');
    if (content.kind !== 'list') throw new Error('a list');
    const [intro, ...modes] = content.rows;
    expect(intro).toMatchObject({ label: MODE_INTRO, section: true, enabled: false });
    expect(modes.map((row) => [row.id, row.label, row.detail, row.effect])).toEqual(
      CHAT_MODES.map((mode) => [
        mode,
        mode,
        mode === 'accept-edits'
          ? `${MODE_EFFECT[mode].short} · ${MODE_CURRENT}`
          : MODE_EFFECT[mode].short,
        MODE_EFFECT[mode].full,
      ]),
    );
  });

  it.each(CHAT_MODES)('marks only the mode in force (%s) and opens on it', (current) => {
    const content = modeContent(current);
    if (content.kind !== 'list') throw new Error('a list');
    expect(
      content.rows.filter((row) => row.detail?.endsWith(`· ${MODE_CURRENT}`) === true),
    ).toEqual([expect.objectContaining({ id: current })]);
    const r = openMode(current);
    expect(r.rows().highlighted).toBe(current);
  });

  it('the intro is never highlighted and answers nothing: the arrows stop at the first mode', () => {
    const r = openMode('ask');
    r.press('', UP);
    expect(r.rows().highlighted).toBe('ask');
    expect(modeOfRow('intro')).toBeUndefined();
  });

  it('the effect paragraph keeps the room of the longest effect: the frame is the same height on every mode', () => {
    const content = modeContent('ask');
    if (content.kind !== 'list') throw new Error('a list');
    const geometry = { bodyRows: 17, listRows: 17, innerWidth: INNER };
    const heights = content.rows.map(
      (_, selected) => popupBody(content, { selected, offset: 0 }, geometry).lines.length,
    );
    expect(new Set(heights).size).toBe(1);
    // `auto`'s effect, the longest, is stated whole under the list when it is highlighted.
    const onAuto = popupBody(content, { selected: 4, offset: 0 }, geometry).lines.map(
      (line) => line.text,
    );
    expect(onAuto.join(' ').replace(/\s+/gu, ' ')).toContain(MODE_EFFECT.auto.full);
    // The list asks for its rows, a blank row and the longest effect's rows, and fits the inline page of ten rows.
    expect(naturalBodyRows(content, { selected: 0, offset: 0 }, 10, INNER)).toBeLessThanOrEqual(10);
  });

  it('the spec: two steps, Mode and Apply to, under `/mode`; step 1 opens on the mode in force and says `Enter next`', () => {
    const spec = modeSpec('chat', 'plan');
    expect(spec).toMatchObject({ id: 'mode', title: '/mode', origin: 'chat' });
    expect(spec.steps.map((step) => step.name)).toEqual(['Mode', 'Apply to']);
    expect(spec.steps[0]).toMatchObject({ enter: 'next', initialRow: 'plan' });
    const legend = withGlyphForm(false, () => popupLegend(openFrame(spec, 1)));
    expect(legend.items).toEqual([
      { keys: '↑/↓', verb: 'select' },
      { keys: 'Enter', verb: 'next' },
    ]);
    expect(legend.exit).toMatchObject({ class: 'close', keys: 'Esc', verb: 'close' });
  });
});

describe('step 2: where the mode applies', () => {
  it.each(CHAT_MODES)(
    'names %s, offers this chat (the default) or new chats, and states the effect only for a mode that approves without a card',
    (mode) => {
      const form = modeScopeForm(mode);
      expect(form.summary).toBe(`Mode: ${mode}`);
      expect(form.tabs).toBeUndefined();
      expect(form.radio).toMatchObject({
        label: 'Apply to',
        verb: 'apply to',
        initial: 'this-chat',
      });
      expect(form.radio?.options).toEqual([
        {
          id: 'this-chat',
          label: 'This chat',
          detail: 'switches the mode now; the conversation stays',
        },
        {
          id: 'new-chats',
          label: 'New chats',
          detail: 'saves it as your startup default; this chat stays',
        },
      ]);
      expect(form.warning).toBe(
        mode === 'auto' || mode === 'accept-edits' ? MODE_EFFECT[mode].full : undefined,
      );
      // Wholly on the page of the floor, inline included (ten rows), and no row of it cut at the floor's width.
      expect(formFits(form, 10, INNER)).toBe(true);
      for (const line of popupBody(
        form,
        { selected: 0, offset: 0 },
        {
          bodyRows: 10,
          listRows: 10,
          innerWidth: INNER,
        },
      ).lines)
        expect(line.text.endsWith('…')).toBe(false);
    },
  );

  it('the scopes are read by id; anything else is none', () => {
    expect(scopeOf('this-chat')).toBe('this-chat');
    expect(scopeOf('new-chats')).toBe('new-chats');
    expect(scopeOf('chat')).toBeUndefined();
    expect(scopeOf(undefined)).toBeUndefined();
  });

  it('its legend: `↑/↓ apply to · Enter apply`, then `[Ctrl+C] close` and the way back, `Esc back`', () => {
    const r = openMode('ask');
    r.press('', ENTER);
    const frame = r.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('no popup');
    const legend = withGlyphForm(false, () => popupLegend(frame, 17, INNER));
    expect(legend.items).toEqual([
      { keys: '↑/↓', verb: 'apply to' },
      { keys: 'Enter', verb: 'apply' },
      { keys: 'Ctrl+C', verb: 'close' },
    ]);
    expect(legend.exit).toMatchObject({ class: 'step', keys: 'Esc', verb: 'back' });
  });
});

describe('answering the popup', () => {
  it('`Enter` on a mode goes to step 2 for that mode; `Esc` steps back to the highlight it left, `Esc` again closes: nothing applied', () => {
    const r = openMode('ask');
    r.press('', END);
    r.press('', ENTER);
    expect(stepIndex(r)).toBe(SCOPE_STEP);
    expect(shownForm(r).form).toEqual(modeScopeForm('auto'));
    r.press('', ESC);
    expect(stepIndex(r)).toBe(0);
    expect(r.rows().highlighted).toBe('auto');
    r.press('', ESC);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.mode.applied).toEqual([]);
    expect(r.mode.saved).toEqual([]);
    expect(r.announced).toEqual([]);
  });

  it('`Ctrl+C` on step 2 closes the whole popup and applies nothing', () => {
    const r = openMode('ask');
    r.press('', DOWN);
    r.press('', ENTER);
    r.press('\u0003', {});
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.mode.applied).toEqual([]);
    expect(r.mode.saved).toEqual([]);
  });

  it.each(CHAT_MODES)(
    'this chat: `Enter` applies %s through the setter, closes, and says what a typed `/mode` says: the setter’s word stands for a widening, the mode’s own line for a narrowing',
    (mode) => {
      const r = openMode(mode === 'ask' ? 'plan' : 'ask');
      const target = CHAT_MODES.indexOf(mode);
      for (let at = 0; at < target; at += 1) r.press('', DOWN);
      if (target === 0) r.press('', UP);
      expect(r.rows().highlighted).toBe(mode);
      r.press('', ENTER);
      r.settle(); // step 2's own frame is seen and settles
      r.press('', ENTER);
      expect(r.mode.applied).toEqual([mode]);
      expect(r.mode.saved).toEqual([]);
      expect(r.host.getSnapshot().open).toBe(false);
      // The fake setter says nothing (the real one announces a widening itself, `chat-mode-popup.test.ts`); a narrowing is the popup's word.
      expect(r.announced).toEqual(
        mode === 'ask' || mode === 'plan' ? [modeChangedNotice(mode)] : [],
      );
      expect(r.notifications.getSnapshot().current?.text).toBe(
        mode === 'ask' || mode === 'plan' ? modeChangedNotice(mode) : undefined,
      );
    },
  );

  it('a bare `Enter` chain applies the mode already in force to this chat: nothing changes', () => {
    const r = openMode('accept-edits');
    r.press('', ENTER);
    r.settle(); // step 2's own frame is seen and settles
    r.press('', ENTER);
    expect(r.mode.applied).toEqual(['accept-edits']);
    expect(r.mode.mode()).toBe('accept-edits');
    // The mode already in force is said, as a typed `/mode accept-edits` says it, rather than closing without a word.
    expect(r.announced).toEqual([modeChangedNotice('accept-edits')]);
  });

  it('a setter that refuses (an unrecorded widening): the popup still closes, says nothing, and the mode stays', () => {
    const r = openMode('ask', false);
    r.press('', END);
    r.press('', ENTER);
    r.settle(); // step 2's own frame is seen and settles
    r.press('', ENTER);
    expect(r.mode.applied).toEqual(['auto']);
    expect(r.mode.mode()).toBe('ask');
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.announced).toEqual([]);
  });

  it('new chats: `Enter` closes the popup, applies nothing to this chat, hands off once the key has been handled, and says the result on the host’s channel', async () => {
    const r = openMode('ask');
    r.press('', END);
    r.press('', ENTER);
    r.press('', DOWN);
    expect(shownForm(r).chosen).toBe(1);
    r.settle(); // step 2's own frame, as it is now, is seen and settles
    r.press('', ENTER);
    expect(r.host.getSnapshot().open).toBe(false);
    // Not inside the key's own handling: the flow's first card is a frame of its own.
    expect(r.mode.saved).toEqual([]);
    await macrotask();
    expect(r.mode.saved).toEqual(['auto']);
    expect(r.mode.applied).toEqual([]);
    // What the flow came to, in a few words, once it has ended (F2: none of its words goes into the transcript).
    await vi.waitFor(() =>
      expect(r.announced).toEqual(['Startup default: auto · applies to new chats']),
    );
  });

  it('the hand-off is entered on the work owner, and its fault goes to the owner, never to an unhandled rejection', async () => {
    const r = settingsRig();
    const failures: unknown[] = [];
    const entered: string[] = [];
    const owner: PopupWorkOwner = {
      enter: (operation) => {
        entered.push('entered');
        return operation();
      },
      failure: (cause) => failures.push(cause),
    };
    const fault = new Error('could not release the prompt');
    const member: ModeSettingsPort = {
      current: () => 'ask',
      apply: () => true,
      saveStartupDefault: () => Promise.reject(fault),
    };
    r.open({ mode: member, workOwner: owner }, 'mode');
    r.settle();
    r.press('', ENTER);
    r.press('', DOWN);
    r.settle(); // step 2's own frame, as it is now, is seen and settles
    r.press('', ENTER);
    expect(entered).toEqual(['entered']);
    await macrotask();
    await vi.waitFor(() => expect(failures).toEqual([fault]));
    // Nobody is left without word: nothing was saved, and the host's channel says so.
    expect(r.announced).toEqual(['The startup default could not be saved']);
  });

  it('step 2 entered again names the new mode and its effect, and opens on "This chat": a scope left on it for another mode is not carried over', () => {
    const r = openMode('ask');
    r.press('', END);
    r.press('', ENTER);
    r.press('', DOWN); // "New chats"
    expect(shownForm(r).chosen).toBe(1);
    r.press('', ESC);
    r.press('', UP); // auto → accept-edits
    r.press('', ENTER);
    const { form, chosen } = shownForm(r);
    expect(form.summary).toBe('Mode: accept-edits');
    expect(form.warning).toBe(MODE_EFFECT['accept-edits'].full);
    expect(chosen).toBe(0); // an `Enter` here changes this chat; it writes no startup default
  });

  it('an `Enter` before the popup was seen, or inside its settle, answers nothing (the opening guard)', () => {
    const r = settingsRig();
    const mode = fakeMode('ask');
    r.open({ mode: mode.member }, 'mode');
    r.press('', ENTER); // not seen yet
    expect(stepIndex(r)).toBe(0);
    r.host.shown(r.host.getSnapshot());
    r.clock.advance(100);
    r.press('', ENTER); // inside the settle
    expect(stepIndex(r)).toBe(0);
    r.clock.advance(500);
    r.press('', ENTER);
    expect(stepIndex(r)).toBe(SCOPE_STEP);
    r.settle(); // step 2's own frame is seen and settles (`popup-form-settle.test.ts` holds that rule)
    r.press('', ENTER);
    expect(mode.applied).toEqual(['ask']);
  });

  it('a step 2 that is not wholly on its page applies nothing and names no `Enter`; `Esc` still steps back', () => {
    const r = openMode('ask');
    r.press('', END);
    r.press('', ENTER);
    expect(stepIndex(r)).toBe(SCOPE_STEP);
    // Step 2 drawn whole, acknowledged, and its settle, quiet gap and lockout all passed: only the page can still withhold its `Enter`. The
    // page then shrinks under it (a resize the slot has not acknowledged yet), so the form is no longer wholly on it.
    r.settle();
    r.host.bindPageRows(() => 3);
    r.press('', ENTER);
    expect(r.mode.applied).toEqual([]);
    expect(r.host.getSnapshot().open).toBe(true);
    const frame = r.host.getSnapshot().frame;
    if (frame === undefined) throw new Error('no popup');
    expect(
      popupLegend(frame, 3, INNER).items.some((item) => 'keys' in item && item.keys === 'Enter'),
    ).toBe(false);
    r.press('', ESC);
    expect(stepIndex(r)).toBe(0);
  });

  it('the same `Enter` applies once the page holds step 2 whole again: the page was the only thing that withheld it', () => {
    const r = openMode('ask');
    r.press('', END);
    r.press('', ENTER);
    r.settle();
    r.host.bindPageRows(() => 3);
    r.press('', ENTER);
    expect(r.mode.applied).toEqual([]);
    r.host.bindPageRows(() => 17);
    r.settle(); // drawn whole again, and the lockout of the refused `Enter` passed
    r.press('', ENTER);
    expect(r.mode.applied).toEqual(['auto']);
  });
});

describe('what the popup draws', () => {
  /** Every string a step of the popup draws, for every mode in force and every chosen mode. */
  function drawnStrings(): string[] {
    const out: string[] = [];
    for (const current of CHAT_MODES) {
      const spec = modeSpec('chat', current);
      out.push(spec.title, ...spec.steps.map((step) => step.name));
      const list = modeContent(current);
      if (list.kind === 'list')
        for (const row of list.rows) out.push(row.label, row.detail ?? '', row.effect ?? '');
      const form = modeScopeForm(current);
      out.push(form.summary ?? '', form.warning ?? '', form.radio?.label ?? '');
      for (const option of form.radio?.options ?? []) out.push(option.label, option.detail ?? '');
    }
    return out.filter((text) => text.length > 0);
  }

  it('only the product’s own words: each string is what the scrub would leave, one line, no control character', () => {
    for (const text of drawnStrings()) {
      expect(popupText(text)).toBe(text);
      expect(CONTROL.test(text)).toBe(false);
    }
  });

  it('every row of both steps is drawn whole at the floor’s width, in both glyph forms', () => {
    for (const plain of [false, true])
      withGlyphForm(plain, () => {
        for (const current of CHAT_MODES) {
          const list = modeContent(current);
          for (let selected = 0; selected < 5; selected += 1)
            for (const line of popupBody(
              list,
              { selected, offset: 0 },
              {
                bodyRows: 17,
                listRows: 17,
                innerWidth: INNER,
              },
            ).lines) {
              expect(line.text.endsWith('…')).toBe(false);
              expect(displayWidth(line.text)).toBeLessThanOrEqual(INNER);
            }
        }
      });
  });
});

describe('what "New chats" says once the startup-default flow has ended (the host’s channel, at most 54 columns)', () => {
  /** Every result the hand-off can come to, with the words it says for `accept-edits` (the longest mode). */
  const RESULTS: readonly (readonly [string, StartupDefaultSaveResult, string])[] = [
    ['unchanged', { kind: 'unchanged' }, 'Startup default unchanged'],
    ['failed', { kind: 'refused', autoRevoked: false }, 'The startup default could not be saved'],
    [
      'failed after a confirmed narrowing',
      { kind: 'refused', autoRevoked: true },
      'Startup default not saved; startup auto stays revoked',
    ],
    ['saved', SAVED, 'Startup default: accept-edits · applies to new chats'],
    [
      'saved, unconfirmed',
      { ...SAVED, durability: 'unconfirmed' },
      'Startup default saved; durability unconfirmed',
    ],
    [
      'saved, a project overrides it',
      { ...SAVED, overriddenBy: 'project' },
      'Startup default saved; this project overrides it',
    ],
    [
      'saved, a workspace overrides it',
      { ...SAVED, overriddenBy: 'workspace' },
      'Startup default saved; this workspace overrides it',
    ],
    [
      'saved, stale auto refused',
      { ...SAVED, autoAfterRestart: true },
      'Startup default saved; auto applies after a restart',
    ],
    [
      'saved, unfinished',
      { kind: 'saved', durability: 'unknown', autoAfterRestart: false, unfinished: true },
      'Startup default saved; mode settings could not finish',
    ],
  ];

  it.each(RESULTS)('%s', (_name, result, words) => {
    expect(startupDefaultAnnouncement('accept-edits', result)).toBe(words);
  });

  it('every result, for every mode, is the product’s own words, whole within 54 columns (never cut)', () => {
    for (const mode of CHAT_MODES)
      for (const [, result] of RESULTS) {
        const text = startupDefaultAnnouncement(mode, result);
        expect(displayWidth(text)).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
        expect(text.endsWith('…')).toBe(false);
        expect(popupText(text)).toBe(text);
        expect(CONTROL.test(text)).toBe(false);
      }
  });

  it('the fact that matters most is said: an override before a refused auto, before an unconfirmed write', () => {
    expect(
      startupDefaultAnnouncement('auto', {
        kind: 'saved',
        durability: 'unconfirmed',
        overriddenBy: 'project',
        autoAfterRestart: true,
        unfinished: false,
      }),
    ).toBe('Startup default saved; this project overrides it');
    expect(
      startupDefaultAnnouncement('auto', {
        ...SAVED,
        durability: 'unconfirmed',
        autoAfterRestart: true,
      }),
    ).toBe('Startup default saved; auto applies after a restart');
  });
});
