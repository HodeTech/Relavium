/**
 * The `/mode` popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3, §6, dated
 * note of 2026-11-27; MVP-11 unit 8 §6, OD-25 / D84): ONE list, no rail, no decision that changes nothing.
 *
 * - the rows: the four modes with their effect in a few words and, right-aligned and never cut, `this chat` (the mode in force) and `startup` (the
 *   saved default); the highlighted mode's whole effect under the list (amber for the two that approve without a card);
 * - the keys follow the row: in a chat `Enter` uses the mode in this chat now, or keeps on the one in force; `[s]` saves it as the startup default
 *   and is absent on the mode that already is the default; on the Home `Enter` sets the startup default or, on the saved value, keeps;
 * - what is DRAWN: the grid at 80×24 and 100×30, in the alternate screen and inline, with colour and without, the legend fitted (`[s] startup` where
 *   the whole legend does not fit), the state words never cut;
 * - the answers: through the real popup host on a manual clock (the opening guard's real timings), every no-op path closes with its one line and
 *   changes nothing, and the hand-off to the startup-default writer's confirmation (`mode-confirm.ts`) says what it came to.
 */
import { CHAT_MODES, type ChatMode } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { MODE_EFFECT, modeChangedNotice } from '../chat/mode-effects.js';
import { withGlyphForm } from '../render/tui/glyphs.js';
import { popupBoxOf } from '../render/tui/surface-matrix/popup-fixture.js';
import { displayWidth } from '../render/tui/viewport.js';
import { fittedLegendItems, popupBody, popupText } from './frame-model.js';
import { POPUP_FLOOR, POPUP_NOTICE_MAX_COLUMNS, popupInnerWidth } from './geometry.js';
import {
  MODE_INTRO,
  MODE_INTRO_HOME,
  MODE_NOT_COMPLETED,
  modeContent,
  modeEnterVerb,
  modeOfRow,
  modeSpec,
  modeStateWords,
  startupAlreadyAnnouncement,
  startupDefaultAnnouncement,
  type ModeListFacts,
} from './mode-popup.js';
import { type PopupWorkOwner } from './popup-work.js';
import {
  currentStep,
  openFrame,
  popupLegend,
  type PopupFrame,
  type PopupKey,
} from './popup-reducer.js';
import type { StartupDefaultSaveResult } from '../chat/mode-settings.js';
import type { StartupDefaultOutcome } from './settings-port.js';
import { DOWN, ENTER, ESC, fakeModeMember, settingsRig, UP } from './settings.test-support.js';

const END: PopupKey = { end: true };
/** A control character, or a line or paragraph separator (built from their code points: a source file cannot carry them as escapes here). */
const CONTROL = new RegExp(
  `[\\u0000-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  'u',
);
const INNER = popupInnerWidth(POPUP_FLOOR.columns, 'standard');
const INNER_100 = popupInnerWidth(100, 'standard');

/** What the startup-default writer's flow comes to in the announcement tests unless a case says otherwise: saved, and it applies to new chats. */
const SAVED: StartupDefaultSaveResult = {
  kind: 'saved',
  durability: 'confirmed',
  autoAfterRestart: false,
  unfinished: false,
};

/** A chat's facts: the mode in force and the saved startup default (`'unknown'`: it could not be read). */
const chat = (current: ChatMode, startup: ChatMode | 'unknown' = 'ask'): ModeListFacts => ({
  surface: 'chat',
  current,
  startup: startup === 'unknown' ? undefined : startup,
});
const home = (startup: ChatMode): ModeListFacts => ({ surface: 'home', startup });

/** The popup of `facts` as a frame with row `at` highlighted (the intro is row 0). */
function frameOn(facts: ModeListFacts, at: number): PopupFrame {
  const opened = openFrame(modeSpec(facts.surface === 'chat' ? 'chat' : 'home', facts), 1);
  return { ...opened, steps: opened.steps.map((step) => ({ ...step, selected: at })) };
}

/** The mode's row in the list: the intro is row 0, so `ask` is 1. */
const rowOf = (mode: ChatMode): number => CHAT_MODES.indexOf(mode) + 1;

/** The drawn rows of the popup on a screen of `cols`×`rows`, in the renderer and the colour form given. */
function drawn(
  facts: ModeListFacts,
  highlighted: ChatMode,
  cols = 80,
  rows = 24,
  renderer: 'alt' | 'inline' = 'alt',
  color = true,
): readonly string[] {
  return popupBoxOf(frameOn(facts, rowOf(highlighted)), {
    renderer,
    color,
    size: { cols, rows },
  }).rows;
}

/** One row of the list as the frame draws it: a one-column margin, then `left` and `right` (the state words) flush at the end of 66 columns. */
const rowWith = (left: string, right = '', width = INNER): string =>
  ` ${left.padEnd(width - right.length)}${right}`.trimEnd();

/** The rows with the trailing spaces trimmed (the frame pads to its width; the text is what is compared). */
const trimmed = (rows: readonly string[]): string[] => rows.map((row) => row.trimEnd());

/** The legend of `facts` with `highlighted`, as the fit leaves it at `width`. */
function legendAt(facts: ModeListFacts, highlighted: ChatMode, width: number): string {
  const frame = frameOn(facts, rowOf(highlighted));
  const legend = withGlyphForm(false, () => popupLegend(frame, 17, width));
  const kept = fittedLegendItems(legend, width);
  const keysOf = (keys: string | readonly string[]): string =>
    typeof keys === 'string' ? keys : keys.join(' / ');
  const parts = kept.map((item) =>
    'keys' in item ? `${keysOf(item.keys)} ${item.verb}` : item.text,
  );
  return [...parts, `${keysOf(legend.exit.keys)} ${legend.exit.verb}`].join(' | ');
}

describe('the list: one step, no rail', () => {
  it('is ONE step (so no rail and no `step N of M`), opened on the mode in force in a chat and on the saved default on the Home', () => {
    for (const mode of CHAT_MODES) {
      const spec = modeSpec('chat', chat(mode, 'ask'));
      expect(spec.steps).toHaveLength(1);
      expect(spec.steps[0]?.initialRow).toBe(mode);
      expect(modeSpec('home', home(mode)).steps[0]?.initialRow).toBe(mode);
    }
    expect(modeSpec('chat', chat('plan', 'ask'), 'auto').steps[0]?.initialRow).toBe('auto');
    expect(modeSpec('chat', chat('plan')).title).toBe('/mode');
    // no rail and no step count on the top edge, in either surface
    for (const rows of [drawn(chat('ask'), 'ask'), drawn(home('ask'), 'ask')]) {
      expect(rows.some((row) => /step \d of \d/u.test(row))).toBe(false);
      expect(rows.some((row) => /Mode\s+╌╌|Confirm/u.test(row))).toBe(false);
    }
  });

  it('the intro, then each mode: its name in one column, its effect in a few words, its whole effect, and the Enter and letters of its row', () => {
    const content = modeContent(chat('accept-edits', 'plan'));
    if (content.kind !== 'list') throw new Error('a list');
    const [intro, ...modes] = content.rows;
    expect(intro).toMatchObject({ label: MODE_INTRO, section: true, enabled: false });
    expect(modes.map((row) => row.id)).toEqual([...CHAT_MODES]);
    for (const row of modes) {
      const mode = modeOfRow(row.id);
      if (mode === undefined) throw new Error('a mode');
      // the effect text starts in one column (the label is padded to the longest name)
      expect(row.label.length).toBe('accept-edits'.length);
      expect(row.label.trimEnd()).toBe(mode);
      expect(row.detail).toBe(MODE_EFFECT[mode].short);
      expect(row.effect).toBe(MODE_EFFECT[mode].full);
      // amber exactly where the mode approves something without a card
      expect(row.effectTone).toBe(mode === 'accept-edits' || mode === 'auto' ? 'warn' : undefined);
    }
    expect(modes.map((row) => row.tag)).toEqual([undefined, 'startup', 'this chat', undefined]);
  });

  it('the Home’s intro names the startup default, and no row says `this chat`', () => {
    const content = modeContent(home('plan'));
    if (content.kind !== 'list') throw new Error('a list');
    expect(content.rows[0]?.label).toBe(MODE_INTRO_HOME);
    expect(content.rows.map((row) => row.tag).filter((tag) => tag !== undefined)).toEqual([
      'startup',
    ]);
  });

  it('state words: `this chat`, `startup`, or both with the legend’s separator; none for a mode that is neither', () => {
    expect(modeStateWords(chat('ask', 'ask'), 'ask')).toBe('this chat · startup');
    expect(modeStateWords(chat('plan', 'ask'), 'plan')).toBe('this chat');
    expect(modeStateWords(chat('plan', 'ask'), 'ask')).toBe('startup');
    expect(modeStateWords(chat('plan', 'ask'), 'auto')).toBeUndefined();
    expect(modeStateWords(chat('plan', 'unknown'), 'ask')).toBeUndefined();
    expect(modeStateWords(home('plan'), 'plan')).toBe('startup');
  });

  it('`Enter` says what it does to the row it is on: use / keep in a chat, set / keep on the Home', () => {
    expect(modeEnterVerb(chat('ask'), 'plan')).toBe('use in this chat');
    expect(modeEnterVerb(chat('ask'), 'ask')).toBe('keep');
    expect(modeEnterVerb(home('ask'), 'plan')).toBe('set as startup default');
    expect(modeEnterVerb(home('ask'), 'ask')).toBe('keep');
  });
});

describe('what is drawn: the grid', () => {
  it('a chat at 80×24, the mode in force highlighted and also the startup default: `Enter keep`, no `[s]`, the state words whole at the row’s end', () => {
    expect(trimmed(drawn(chat('ask', 'ask'), 'ask'))).toEqual([
      ' ─ /mode ────────────────────────────────────────────── from chat ─',
      '   Choose how the agent treats an effect.',
      ' › ask           every action asks first        this chat · startup',
      '   plan          read-only, nothing is changed',
      '   accept-edits  files are edited without asking',
      '   auto          commands ask; granted actions run unasked',
      '',
      ' Every write, command and network call asks first.',
      '',
      '',
      ' ↑/↓ select · Enter keep · Esc close',
      ' ──────────────────────────────────────────────────────────────────',
    ]);
  });

  it('another mode highlighted at 80×24: `Enter use in this chat`, and `[s] startup` (the whole legend is 69 columns against a row of 66)', () => {
    expect(trimmed(drawn(chat('ask', 'ask'), 'plan')).slice(2, 12)).toEqual([
      '   ask           every action asks first        this chat · startup',
      ' › plan          read-only, nothing is changed',
      '   accept-edits  files are edited without asking',
      '   auto          commands ask; granted actions run unasked',
      '',
      ' Read-only: nothing is changed, and the agent drafts a plan first.',
      '',
      '',
      ' ↑/↓ select · Enter use in this chat · [s] startup · Esc close',
      ' ──────────────────────────────────────────────────────────────────',
    ]);
  });

  it('at 100×30 the popup is wider (74 columns of row) and the legend says `[s] startup default` whole', () => {
    const rows = trimmed(drawn(chat('ask', 'ask'), 'plan', 100, 30));
    expect(rows.at(-2)).toBe(
      ' ↑/↓ select · Enter use in this chat · [s] startup default · Esc close',
    );
    expect(displayWidth(rows.at(-2) ?? '')).toBeLessThanOrEqual(INNER_100 + 2);
  });

  it('the highlighted mode’s whole effect is under the list: `auto` takes three rows at 80 columns, and the frame is as tall for every highlight', () => {
    const heights = new Set(CHAT_MODES.map((mode) => drawn(chat('ask', 'ask'), mode).length));
    expect(heights.size).toBe(1);
    expect(trimmed(drawn(chat('ask', 'ask'), 'auto')).slice(7, 10)).toEqual([
      ' File edits, network calls and other granted actions are approved',
      ' without asking; a command still asks unless you remembered or',
      ' approved it, and scope and protected-path rules still apply.',
    ]);
  });

  it('the Home at 80×24: the same list without `this chat`, `Enter set as startup default` on another mode and `Enter keep` on the saved one', () => {
    expect(trimmed(drawn(home('ask'), 'plan'))).toEqual([
      ' ─ /mode ────────────────────────────────────────────── from Home ─',
      '   Choose the startup default for new chats.',
      rowWith('  ask           every action asks first', 'startup'),
      ' › plan          read-only, nothing is changed',
      '   accept-edits  files are edited without asking',
      '   auto          commands ask; granted actions run unasked',
      '',
      ' Read-only: nothing is changed, and the agent drafts a plan first.',
      '',
      '',
      ' ↑/↓ select · Enter set as startup default · Esc close',
      ' ──────────────────────────────────────────────────────────────────',
    ]);
    expect(trimmed(drawn(home('ask'), 'ask')).at(-2)).toBe(' ↑/↓ select · Enter keep · Esc close');
  });

  it('inline: the same rows in a block in the flow, and with colour off the ASCII glyphs (`>` for the marker, `-` for the rules)', () => {
    const inline = trimmed(drawn(chat('plan', 'ask'), 'plan', 80, 24, 'inline'));
    expect(inline[0]).toBe(' ─ /mode ────────────────────────────────────────────── from chat ─');
    expect(inline).toContain(rowWith('› plan          read-only, nothing is changed', 'this chat'));
    expect(inline).toContain(rowWith('  ask           every action asks first', 'startup'));
    expect(inline.at(-2)).toBe(' ↑/↓ select · Enter keep · [s] startup default · Esc close');
    expect(inline.length).toBeLessThanOrEqual(23);
    const plain = trimmed(drawn(chat('plan', 'ask'), 'plan', 80, 24, 'alt', false));
    expect(plain[0]).toBe(' - /mode ---------------------------------------------- from chat -');
    expect(plain).toContain(rowWith('> plan          read-only, nothing is changed', 'this chat'));
    expect(plain.at(-1)).toBe(` ${'-'.repeat(66)}`);
  });

  it('every row is exactly the frame’s width, whole, in every cell: the state words are never cut, whatever is cut with the ellipsis is the effect', () => {
    for (const [cols, rows] of [
      [80, 24],
      [100, 30],
    ] as const)
      for (const renderer of ['alt', 'inline'] as const)
        for (const color of [true, false])
          for (const facts of [
            chat('ask', 'ask'),
            chat('accept-edits', 'accept-edits'),
            chat('auto', 'auto'),
            chat('plan', 'accept-edits'),
            chat('ask', 'unknown'),
            home('auto'),
          ])
            for (const mode of CHAT_MODES) {
              const box = drawn(facts, mode, cols, rows, renderer, color);
              const width = Math.max(...box.map((row) => displayWidth(row)));
              for (const row of box) expect(displayWidth(row)).toBe(width);
              const words = modeStateWords(facts, mode);
              if (words !== undefined)
                expect(
                  box.some((row) => row.trimEnd().endsWith(words)),
                  `${mode} in ${facts.surface}: ${words}`,
                ).toBe(true);
            }
  });

  it('the two states that need the most room: `accept-edits` and `auto` each both `this chat` and `startup` (68 and 78 columns against 66): the effect is cut with `…`, the state words stay', () => {
    const edits = trimmed(drawn(chat('accept-edits', 'accept-edits'), 'plan')).find((row) =>
      row.includes('accept-edits  '),
    );
    expect(edits).toBe('   accept-edits  files are edited without ask…  this chat · startup');
    const auto = trimmed(drawn(chat('auto', 'auto'), 'plan')).find((row) =>
      row.startsWith('   auto'),
    );
    expect(auto).toBe('   auto          commands ask; granted action…  this chat · startup');
    // at 100 columns accept-edits fits whole
    expect(
      trimmed(drawn(chat('accept-edits', 'accept-edits'), 'plan', 100, 30)).find((row) =>
        row.includes('accept-edits  '),
      ),
    ).toBe(
      rowWith('  accept-edits  files are edited without asking', 'this chat · startup', INNER_100),
    );
  });

  it('every string the list draws is the product’s own: what the scrub would leave, on one line, no control character', () => {
    const strings: string[] = [];
    for (const facts of [chat('ask'), chat('auto', 'plan'), home('plan')]) {
      const spec = modeSpec('chat', facts);
      strings.push(spec.title, ...spec.steps.map((step) => step.name));
      const list = modeContent(facts);
      if (list.kind === 'list')
        for (const row of list.rows)
          strings.push(row.label.trimEnd(), row.detail ?? '', row.effect ?? '', row.tag ?? '');
    }
    for (const text of strings.filter((entry) => entry.length > 0)) {
      expect(popupText(text)).toBe(text);
      expect(CONTROL.test(text)).toBe(false);
    }
  });
});

describe('the effect under the list: amber where the mode approves without a card', () => {
  /** The kinds of the rows the effect paragraph is drawn in (the rows under the list), for `mode` highlighted. */
  function effectKinds(mode: ChatMode): string[] {
    const frame = frameOn(chat('ask', 'ask'), rowOf(mode));
    const { state } = currentStep(frame);
    const body = popupBody(state.content, state, { bodyRows: 17, listRows: 17, innerWidth: INNER });
    // the five list rows (the intro and the four modes) are the first lines; the blank row follows; what is left is the effect
    return body.lines
      .slice(6)
      .filter((line) => line.text.trim() !== '')
      .map((line) => line.kind);
  }

  it('`accept-edits` and `auto` are drawn as a notice (amber), every other effect as the plain message', () => {
    expect(new Set(effectKinds('accept-edits'))).toEqual(new Set(['notice']));
    expect(new Set(effectKinds('auto'))).toEqual(new Set(['notice']));
    expect(new Set(effectKinds('ask'))).toEqual(new Set(['message']));
    expect(new Set(effectKinds('plan'))).toEqual(new Set(['message']));
  });
});

describe('the legend follows the row', () => {
  it('another mode: `Enter use in this chat` and `[s] startup`; the mode in force: `Enter keep`; the startup default: no `[s]`', () => {
    expect(legendAt(chat('ask', 'plan'), 'auto', INNER)).toBe(
      '↑/↓ select | Enter use in this chat | s startup | Esc close',
    );
    expect(legendAt(chat('ask', 'plan'), 'ask', INNER)).toBe(
      '↑/↓ select | Enter keep | s startup default | Esc close',
    );
    // the mode that already is the startup default: `[s]` leaves the legend (it would save nothing)
    expect(legendAt(chat('ask', 'plan'), 'plan', INNER)).toBe(
      '↑/↓ select | Enter use in this chat | Esc close',
    );
    expect(legendAt(chat('plan', 'plan'), 'plan', INNER)).toBe(
      '↑/↓ select | Enter keep | Esc close',
    );
  });

  it('`[s] startup default` where the whole legend fits (74 columns), `[s] startup` where it does not (66): the fit is judged on the whole row', () => {
    expect(legendAt(chat('ask', 'ask'), 'plan', INNER_100)).toBe(
      '↑/↓ select | Enter use in this chat | s startup default | Esc close',
    );
    expect(legendAt(chat('ask', 'ask'), 'plan', INNER)).toBe(
      '↑/↓ select | Enter use in this chat | s startup | Esc close',
    );
  });

  it('the drop order on a short row: `↑/↓ select` first, then `[s]`; the `Enter` verb and `Esc close` never drop', () => {
    const facts = chat('ask', 'ask');
    // 50 columns: the whole legend (61 with the short verb) does not fit, select goes first
    expect(legendAt(facts, 'plan', 50)).toBe('Enter use in this chat | s startup | Esc close');
    // 40 columns: `[s]` goes before the `Enter` verb
    expect(legendAt(facts, 'plan', 40)).toBe('Enter use in this chat | Esc close');
    // far too short: the Enter verb and the way back stay (the frame cuts the row, it never drops them)
    for (const width of [34, 36]) {
      const text = legendAt(facts, 'plan', width);
      expect(text).toContain('Enter use in this chat');
      expect(text.endsWith('Esc close')).toBe(true);
    }
  });

  it('the Home: `Enter set as startup default` or `Enter keep`, never `[s]` (its `Enter` IS the write)', () => {
    expect(legendAt(home('ask'), 'plan', INNER)).toBe(
      '↑/↓ select | Enter set as startup default | Esc close',
    );
    expect(legendAt(home('ask'), 'ask', INNER)).toBe('↑/↓ select | Enter keep | Esc close');
  });

  it('`[s]` is offered on every row when the startup default could not be read (nothing is known to be the default)', () => {
    for (const mode of CHAT_MODES)
      expect(legendAt(chat('ask', 'unknown'), mode, INNER)).toContain('s startup');
  });
});

/** The rig with `/mode` open over a fake member, its frame seen and settled. */
function openMode(options: Parameters<typeof fakeModeMember>[0] = {}) {
  const r = settingsRig();
  const fake = fakeModeMember(options);
  const owner: PopupWorkOwner = { enter: (operation) => operation(), failure: vi.fn() };
  const opened = r.open(
    { mode: fake.member, workOwner: owner },
    'mode',
    fake.member.scope === 'home' ? 'home' : 'standalone-chat',
  );
  expect(opened.opened).toBe(true);
  r.settle();
  return { ...r, fake, owner };
}

const popupOpen = (r: Pick<ReturnType<typeof settingsRig>, 'host'>): boolean =>
  r.host.getSnapshot().open;
const stepCount = (r: Pick<ReturnType<typeof settingsRig>, 'host'>): number | undefined =>
  r.host.getSnapshot().frame?.spec.steps.length;

describe('in a chat: Enter applies at once or keeps; [s] is the startup default', () => {
  it('`Enter` on the mode in force KEEPS: the popup closes with the one line it always said, and nothing is applied, written or asked (no second screen)', () => {
    const r = openMode({ current: 'plan', startup: 'ask' });
    expect(r.rows().highlighted).toBe('plan'); // opened on the mode in force
    r.press('', ENTER);
    expect(popupOpen(r)).toBe(false);
    expect(r.announced).toEqual([modeChangedNotice('plan')]);
    expect(r.fake.applied).toEqual([]);
    expect(r.fake.saved).toEqual([]);
    expect(r.fake.mode()).toBe('plan');
  });

  it('there is ONE step: the list is the only screen the popup ever has in a chat', () => {
    const r = openMode({ current: 'ask', startup: 'ask' });
    expect(stepCount(r)).toBe(1);
    r.press('', DOWN);
    r.press('', ENTER);
    expect(popupOpen(r)).toBe(false);
  });

  it.each(CHAT_MODES.filter((mode) => mode !== 'ask'))(
    '`Enter` on %s uses it in this chat at once, through the session’s one setter; a narrowing says the mode’s own line, a widening is the setter’s word (the popup adds none)',
    (mode) => {
      const r = openMode({ current: 'ask', startup: 'ask' });
      for (let at = 0; at < CHAT_MODES.indexOf(mode); at += 1) r.press('', DOWN);
      expect(r.rows().highlighted).toBe(mode);
      r.press('', ENTER);
      expect(popupOpen(r)).toBe(false);
      expect(r.fake.applied).toEqual([mode]);
      expect(r.fake.saved).toEqual([]);
      expect(r.announced).toEqual(mode === 'plan' ? [modeChangedNotice('plan')] : []);
    },
  );

  it('a widening the setter refuses (its record could not be written) closes the popup and the popup adds no word; the mode stays', () => {
    const r = openMode({ current: 'ask', startup: 'ask', accepts: false });
    r.press('', END);
    r.press('', ENTER);
    expect(popupOpen(r)).toBe(false);
    expect(r.fake.applied).toEqual(['auto']);
    expect(r.fake.mode()).toBe('ask');
    expect(r.announced).toEqual([]);
  });

  it('`Esc` and `Ctrl+C` close it, applying nothing, saying nothing and writing nothing', () => {
    for (const close of [ESC, { ctrl: true } as PopupKey]) {
      const r = openMode({ current: 'ask', startup: 'ask' });
      r.press('', DOWN);
      r.press(close === ESC ? '' : 'c', close);
      expect(popupOpen(r)).toBe(false);
      expect(r.fake.applied).toEqual([]);
      expect(r.fake.saved).toEqual([]);
      expect(r.announced).toEqual([]);
    }
  });

  it('`[s]` closes the list and hands the highlighted mode to the startup-default flow; the chat’s own mode does not change', async () => {
    const r = openMode({ current: 'ask', startup: 'ask' });
    r.press('', DOWN); // plan
    r.press('s', {});
    expect(popupOpen(r)).toBe(false);
    await vi.waitFor(() => expect(r.fake.saved).toEqual(['plan']));
    expect(r.fake.applied).toEqual([]);
    expect(r.fake.mode()).toBe('ask');
  });

  it('`[s]` on the mode in force saves THAT mode (not the one the list opened on, not the startup default)', async () => {
    const r = openMode({ current: 'plan', startup: 'ask' });
    r.press('s', {});
    await vi.waitFor(() => expect(r.fake.saved).toEqual(['plan']));
  });

  it('`[s]` on the mode that already is the startup default does nothing: the popup stays, nothing is handed off (it would save nothing)', async () => {
    const r = openMode({ current: 'plan', startup: 'ask' });
    r.press('', UP); // ask, the startup default
    expect(r.rows().highlighted).toBe('ask');
    r.press('s', {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(popupOpen(r)).toBe(true);
    expect(r.fake.saved).toEqual([]);
  });

  it('with the startup default unknown (unreadable) `[s]` works on every row, `startup` marks none, and the list still opens', async () => {
    const r = openMode({ current: 'ask', startup: undefined });
    r.press('', DOWN);
    r.press('s', {});
    await vi.waitFor(() => expect(r.fake.saved).toEqual(['plan']));
  });

  it('any other letter, `Tab`, a space and a digit do nothing on the list (typing goes nowhere)', () => {
    const r = openMode({ current: 'ask', startup: 'plan' });
    for (const key of ['a', 'y', 'n', '1', ' ', 'S', 'q']) r.press(key, {});
    r.press('', { tab: true } as PopupKey);
    expect(popupOpen(r)).toBe(true);
    expect(r.fake.applied).toEqual([]);
    expect(r.fake.saved).toEqual([]);
  });
});

describe('what the hand-off came to (the startup-default flow’s outcome)', () => {
  it.each<[string, StartupDefaultOutcome]>([
    ['said (the Done step said it)', { kind: 'said' }],
    ['closed (nothing was asked)', { kind: 'closed' }],
  ])('%s: nothing more is announced, the list does not open again', async (_name, outcome) => {
    const r = openMode({ current: 'ask', startup: 'ask', outcome });
    r.press('', DOWN);
    r.press('s', {});
    await vi.waitFor(() => expect(r.fake.saved).toEqual(['plan']));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(r.announced).toEqual([]);
    expect(popupOpen(r)).toBe(false);
  });

  it('a notice (a declined confirmation, the flow’s refusal) is the ONE notification on the host’s channel', async () => {
    const r = openMode({
      current: 'ask',
      startup: 'ask',
      outcome: { kind: 'notice', text: 'Startup default unchanged' },
    });
    r.press('', DOWN);
    r.press('s', {});
    await vi.waitFor(() => expect(r.announced).toEqual(['Startup default unchanged']));
  });

  it('a step back (`Esc` on the confirmation) opens the list AGAIN on the mode chosen; there it can be changed or closed', async () => {
    let answers = 0;
    const r = openMode({
      current: 'ask',
      startup: 'ask',
      outcome: () => (answers++ === 0 ? { kind: 'back' } : { kind: 'said' }),
    });
    r.press('', DOWN);
    r.press('', DOWN); // accept-edits
    r.press('s', {});
    await vi.waitFor(() => expect(popupOpen(r)).toBe(true));
    expect(r.rows().highlighted).toBe('accept-edits');
    expect(r.fake.saved).toEqual(['accept-edits']);
    r.settle();
    r.press('', ESC);
    expect(popupOpen(r)).toBe(false);
    expect(r.announced).toEqual([]);
    expect(r.fake.applied).toEqual([]);
  });

  it('a fault of the hand-off itself (the owner no longer admits work) is the owner’s and says the startup default could not be saved', async () => {
    const r = openMode({
      current: 'ask',
      startup: 'ask',
      outcome: () => Promise.reject(new Error('the prompt could not be released')),
    });
    r.press('', DOWN);
    r.press('s', {});
    await vi.waitFor(() => expect(r.announced).toEqual(['The startup default could not be saved']));
    expect(r.owner.failure).toHaveBeenCalledOnce();
  });
});

describe('the keys the opening guard and the host hold back: nothing applies on a frame nobody has seen, inside its settle, or on a held key', () => {
  /** A rig that has NOT acknowledged its first frame: the popup is open, the slot has not drawn it. */
  function unseen(options: Parameters<typeof fakeModeMember>[0] = {}) {
    const r = settingsRig();
    const fake = fakeModeMember({ current: 'ask', startup: 'ask', ...options });
    const opened = r.open({ mode: fake.member }, 'mode');
    expect(opened.opened).toBe(true);
    return { ...r, fake };
  }

  it('`↓↓↓ Enter` typed before the frame was seen applies NOTHING and moves nothing: every key that arrived before it appeared is dropped', () => {
    const r = unseen();
    for (const key of [DOWN, DOWN, DOWN, ENTER]) r.press('', key);
    r.host.shown(r.host.getSnapshot());
    expect(r.rows().highlighted).toBe('ask');
    r.clock.advance(1000);
    r.press('', ENTER); // the mode in force: keep
    expect(r.fake.applied).toEqual([]);
    expect(popupOpen(r)).toBe(false);
  });

  it('`↓↓↓ Enter` typed right after the frame appeared: the arrows move at once, the `Enter` waits out the popup’s settle (500 ms), and only then answers', () => {
    const r = unseen();
    r.host.shown(r.host.getSnapshot());
    r.clock.advance(16);
    for (const key of [DOWN, DOWN, DOWN, ENTER]) r.press('', key);
    expect(r.rows().highlighted).toBe('auto');
    expect(r.fake.applied).toEqual([]);
    expect(popupOpen(r)).toBe(true);
    r.clock.advance(482);
    r.press('', ENTER); // 498 ms after it appeared
    expect(r.fake.applied).toEqual([]);
    r.clock.advance(2);
    r.press('', ENTER); // 500 ms: a deliberate answer
    expect(r.fake.applied).toEqual(['auto']);
  });

  it('`[s]` is held back the same way: a letter that arrived before the frame was seen, or inside its settle, saves nothing', async () => {
    const r = unseen();
    r.press('', DOWN);
    r.press('s', {});
    r.host.shown(r.host.getSnapshot());
    r.clock.advance(100);
    r.press('s', {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(r.fake.saved).toEqual([]);
    expect(popupOpen(r)).toBe(true);
  });

  it('a held `Enter` never applies: a repeat or a release event, `Meta+Enter` and `Shift+Enter` answer nothing, even long after the frame', () => {
    const r = openMode({ current: 'ask', startup: 'ask' });
    r.press('', END);
    for (const key of [
      { return: true, eventType: 'repeat' },
      { return: true, eventType: 'release' },
      { return: true, meta: true },
      { return: true, shift: true },
      { return: true, ctrl: true },
    ] as PopupKey[]) {
      r.clock.advance(1000);
      r.press('', key);
    }
    expect(r.fake.applied).toEqual([]);
    expect(popupOpen(r)).toBe(true);
    r.clock.advance(1000);
    r.press('', ENTER);
    expect(r.fake.applied).toEqual(['auto']);
  });

  it('the popup is the key owner: a `Ctrl+Y`, `Ctrl+N` or `Ctrl+G` answers nothing and does not close the list', () => {
    const r = openMode({ current: 'ask', startup: 'ask' });
    for (const input of ['y', 'n', 'g', 'o', 'r']) r.press(input, { ctrl: true });
    expect(popupOpen(r)).toBe(true);
    expect(r.fake.applied).toEqual([]);
    expect(r.fake.saved).toEqual([]);
  });
});

describe('on the bare Home: Enter sets the startup default, or keeps the saved one', () => {
  it('opens on the saved startup default, with the Home’s intro and no `this chat`', () => {
    const r = openMode({ scope: 'home', startup: 'plan' });
    expect(r.rows().highlighted).toBe('plan');
    expect(r.rows().all[0]).toContain(MODE_INTRO_HOME);
    expect(stepCount(r)).toBe(1);
  });

  it('`Enter` on the saved value closes with ONE notification ("Startup default is already plan"): nothing is handed off, nothing written', async () => {
    const r = openMode({ scope: 'home', startup: 'plan' });
    r.press('', ENTER);
    expect(popupOpen(r)).toBe(false);
    expect(r.announced).toEqual([startupAlreadyAnnouncement('plan')]);
    expect(r.announced).toEqual(['Startup default is already plan']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(r.fake.saved).toEqual([]);
  });

  it('`Enter` on another mode hands it to the confirmation (nothing is applied: the Home has no conversation); `[s]` is no key there', async () => {
    const r = openMode({ scope: 'home', startup: 'plan' });
    r.press('s', {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(r.fake.saved).toEqual([]);
    expect(popupOpen(r)).toBe(true);
    r.press('', DOWN);
    r.press('', ENTER);
    expect(popupOpen(r)).toBe(false);
    await vi.waitFor(() => expect(r.fake.saved).toEqual(['accept-edits']));
    expect(r.fake.applied).toEqual([]);
  });

  it('a startup default that cannot be read is not guessed: the list does not open, and the writer’s own sentence is the one notification', () => {
    const r = settingsRig();
    const fake = fakeModeMember({ scope: 'home', startup: undefined });
    const opened = r.open({ mode: fake.member }, 'mode', 'home');
    expect(opened.opened).toBe(false);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.announced).toEqual([MODE_NOT_COMPLETED]);
  });

  it('a step back from the confirmation opens the Home’s list again on the mode chosen, and `Esc` there closes without a word', async () => {
    let answers = 0;
    const r = openMode({
      scope: 'home',
      startup: 'ask',
      outcome: () => (answers++ === 0 ? { kind: 'back' } : { kind: 'said' }),
    });
    r.press('', DOWN);
    r.press('', ENTER);
    await vi.waitFor(() => expect(popupOpen(r)).toBe(true));
    expect(r.rows().highlighted).toBe('plan');
    r.settle();
    r.press('', ESC);
    expect(popupOpen(r)).toBe(false);
    expect(r.announced).toEqual([]);
  });
});

describe('the settings table offers the popup only where its member fits the surface', () => {
  it('a chat’s member opens in a chat, the Home’s on the bare Home; neither crosses over', async () => {
    const { settingsAvailable } = await import('./settings-port.js');
    const chatMember = fakeModeMember({ scope: 'chat' }).member;
    const homeMember = fakeModeMember({ scope: 'home', startup: 'ask' }).member;
    const port = (surface: 'home' | 'home-chat' | 'standalone-chat', mode: typeof chatMember) => ({
      surface,
      announce: () => {},
      mode,
    });
    expect(settingsAvailable(port('standalone-chat', chatMember), 'mode')).toBe(true);
    expect(settingsAvailable(port('home-chat', chatMember), 'mode')).toBe(true);
    expect(settingsAvailable(port('home', homeMember), 'mode')).toBe(true);
    expect(settingsAvailable(port('home', chatMember), 'mode')).toBe(false);
    expect(settingsAvailable(port('home-chat', homeMember), 'mode')).toBe(false);
    expect(settingsAvailable({ surface: 'home', announce: () => {} }, 'mode')).toBe(false);
  });
});

describe('the popup never builds its own words from stored text', () => {
  it('the facts pick rows and tags and are never drawn: a frame built for every fact draws only the closed set of words', () => {
    const allowed = new Set<string>([...CHAT_MODES, 'this chat', 'startup', 'this chat · startup']);
    for (const facts of [chat('ask', 'ask'), chat('auto', 'plan'), home('accept-edits')]) {
      const content = modeContent(facts);
      if (content.kind !== 'list') throw new Error('a list');
      for (const row of content.rows)
        if (row.tag !== undefined) expect(allowed.has(row.tag)).toBe(true);
    }
  });
});

describe('what the startup default says on the host’s channel once the flow has ended without a step of its own that said it (at most 54 columns)', () => {
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
    for (const mode of CHAT_MODES) {
      for (const [, result] of RESULTS) {
        const text = startupDefaultAnnouncement(mode, result);
        expect(displayWidth(text)).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
        expect(text.endsWith('…')).toBe(false);
        expect(popupText(text)).toBe(text);
        expect(CONTROL.test(text)).toBe(false);
      }
      const already = startupAlreadyAnnouncement(mode);
      expect(displayWidth(already)).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
      expect(already).toBe(`Startup default is already ${mode}`);
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
