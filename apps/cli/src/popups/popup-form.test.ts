/**
 * A form's keys and its answer ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3):
 * `←/→` change its tabs and `↑/↓` its radio group, each stopping at the ends (no wrap-around, as a list's highlight); it opens on the current
 * values and keeps what was chosen, by id, when its content is replaced; `Enter` applies it as a whole with the ids chosen, through the host,
 * behind the opening guard like every answer, and only while it is wholly on its page; the legend names `←/→ <verb>` and `↑/↓ <verb>` through
 * the one builder, and no `Enter` for a form that is not whole. `←/→` change nothing on any other step and still disarm a confirmation line.
 */
import { describe, expect, it } from 'vitest';

import { createChordHistory } from '../render/tui/chord-guard.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
import type { PopupContent, PopupForm } from './frame-model.js';
import { createNotificationChannel, type Schedule } from './notifications.js';
import { createPopupHost } from './popup-host.js';
import {
  currentStep,
  foldPopupAction,
  formValues,
  openFrame,
  openingKeyOf,
  popupLegend,
  reducePopupKey,
  withContent,
  type PopupFormValues,
  type PopupFrame,
  type PopupKey,
  type PopupSpec,
  type PopupStep,
} from './popup-reducer.js';

const TIERS = ['off', 'low', 'medium', 'high', 'max'];
const FORM: PopupForm = {
  kind: 'form',
  summary: 'gpt-5  400k context',
  tabs: {
    label: 'Reasoning effort',
    verb: 'effort',
    initial: 'medium',
    options: TIERS.map((id) => ({ id, label: id })),
  },
  radio: {
    label: 'Apply to',
    verb: 'apply to',
    initial: 'new',
    options: [
      { id: 'chat', label: 'This chat', detail: 'switches the model now' },
      { id: 'new', label: 'New chats', detail: 'saves it as your default' },
    ],
  },
};

const FORM_STEP: PopupStep = { name: 'Effort & scope', content: FORM, enter: 'apply' };
const spec = (steps: readonly PopupStep[] = [FORM_STEP]): PopupSpec => ({
  id: 'form',
  title: '/models',
  origin: 'chat',
  steps,
});

const LEFT: PopupKey = { leftArrow: true };
const RIGHT: PopupKey = { rightArrow: true };
const UP: PopupKey = { upArrow: true };
const ENTER: PopupKey = { return: true };

/** Fold one key into the frame; a key the frame has no use for leaves it as it is. */
function press(frame: PopupFrame, key: PopupKey, input = ''): PopupFrame {
  const fold = foldPopupAction(frame, reducePopupKey(input, key, currentStep(frame).spec), 5);
  return fold.kind === 'frame' ? fold.frame : frame;
}

const chosen = (frame: PopupFrame) => formValues(currentStep(frame).state, FORM);

describe('the keys of a form', () => {
  it('←/→ are `adjust`, a navigation key for the opening guard (they decide nothing)', () => {
    expect(reducePopupKey('', LEFT, FORM_STEP)).toEqual({ kind: 'adjust', delta: -1 });
    expect(reducePopupKey('', RIGHT, FORM_STEP)).toEqual({ kind: 'adjust', delta: 1 });
    expect(openingKeyOf({ kind: 'adjust', delta: 1 })).toBe('navigate');
  });

  it('the form opens on the initial (current) options, and on the first where the initial is unknown or absent', () => {
    expect(chosen(openFrame(spec(), 1))).toEqual({ tab: 'medium', radio: 'new' });
    const unknown: PopupForm = {
      ...FORM,
      tabs: FORM.tabs === undefined ? undefined : { ...FORM.tabs, initial: 'ultra' },
      radio: FORM.radio === undefined ? undefined : { ...FORM.radio, initial: undefined },
    };
    expect(
      formValues(
        currentStep(openFrame(spec([{ ...FORM_STEP, content: unknown }]), 1)).state,
        unknown,
      ),
    ).toEqual({
      tab: 'off',
      radio: 'chat',
    });
  });

  it('←/→ move the tabs one option and stop at the ends (no wrap-around)', () => {
    let frame = openFrame(spec(), 1);
    frame = press(frame, RIGHT);
    expect(chosen(frame).tab).toBe('high');
    frame = press(press(press(frame, RIGHT), RIGHT), RIGHT);
    expect(chosen(frame).tab).toBe('max');
    expect(foldPopupAction(frame, { kind: 'adjust', delta: 1 }, 5)).toEqual({ kind: 'unchanged' });
    for (let index = 0; index < 9; index += 1) frame = press(frame, LEFT);
    expect(chosen(frame).tab).toBe('off');
    expect(foldPopupAction(frame, { kind: 'adjust', delta: -1 }, 5)).toEqual({ kind: 'unchanged' });
  });

  it('↑/↓ move the radio group’s choice and stop at the ends; a page or a jump goes to the end it points at', () => {
    let frame = openFrame(spec(), 1);
    expect(foldPopupAction(frame, { kind: 'move', delta: 1 }, 5)).toEqual({ kind: 'unchanged' });
    frame = press(frame, UP);
    expect(chosen(frame).radio).toBe('chat');
    expect(foldPopupAction(frame, { kind: 'move', delta: -1 }, 5)).toEqual({ kind: 'unchanged' });
    frame = press(frame, { pageDown: true });
    expect(chosen(frame).radio).toBe('new');
    frame = press(frame, { home: true });
    expect(chosen(frame).radio).toBe('chat');
    frame = press(frame, { end: true });
    expect(chosen(frame).radio).toBe('new');
    frame = press(frame, { pageUp: true });
    expect(chosen(frame).radio).toBe('chat');
    // The tabs did not move.
    expect(chosen(frame).tab).toBe('medium');
  });

  it('on a radio group of four, a page goes to the end it points at, not one option', () => {
    const four: PopupForm = {
      kind: 'form',
      radio: {
        label: 'Apply to',
        verb: 'scope',
        options: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id })),
      },
    };
    let frame = openFrame(spec([{ ...FORM_STEP, content: four }]), 1);
    frame = press(frame, { pageDown: true });
    expect(formValues(currentStep(frame).state, four).radio).toBe('d');
    frame = press(frame, { pageUp: true });
    expect(formValues(currentStep(frame).state, four).radio).toBe('a');
  });

  it('a form without tabs takes no ←/→, one without a radio group no ↑/↓, and ←/→ change nothing on a list or a report', () => {
    const noTabs: PopupForm = { kind: 'form', radio: FORM.radio };
    const noRadio: PopupForm = { kind: 'form', tabs: FORM.tabs };
    const frameOf = (content: PopupContent) =>
      openFrame(spec([{ name: 'x', content, enter: 'apply' }]), 1);
    expect(foldPopupAction(frameOf(noTabs), { kind: 'adjust', delta: 1 }, 5)).toEqual({
      kind: 'unchanged',
    });
    expect(foldPopupAction(frameOf(noRadio), { kind: 'move', delta: -1 }, 5)).toEqual({
      kind: 'unchanged',
    });
    expect(foldPopupAction(frameOf(noRadio), { kind: 'jump', to: 'last' }, 5)).toEqual({
      kind: 'unchanged',
    });
    const list = frameOf({
      kind: 'list',
      rows: [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
      ],
    });
    expect(foldPopupAction(list, { kind: 'adjust', delta: 1 }, 5)).toEqual({ kind: 'unchanged' });
    expect(
      foldPopupAction(frameOf({ kind: 'report', lines: ['x'] }), { kind: 'adjust', delta: -1 }, 5),
    ).toEqual({
      kind: 'unchanged',
    });
  });

  it('←/→ on a confirmation line disarm it as any key but a navigation key does (unchanged)', () => {
    const line: PopupStep = {
      name: 'Confirm',
      content: { kind: 'report', lines: ['x'] },
      chord: { verb: 'send' },
    };
    expect(reducePopupKey('', LEFT, line)).toEqual({ kind: 'disarm', cause: 'typed' });
    expect(reducePopupKey('', RIGHT, line)).toEqual({ kind: 'disarm', cause: 'typed' });
  });

  it('`Enter` applies the form as a whole with the ids chosen; with no `enter`, while loading, or on a `final` step it does not', () => {
    const frame = press(press(openFrame(spec(), 1), LEFT), UP);
    expect(foldPopupAction(frame, reducePopupKey('', ENTER, FORM_STEP), 5)).toEqual({
      kind: 'apply',
      values: { tab: 'low', radio: 'chat' },
    });
    const silent = openFrame(spec([{ ...FORM_STEP, enter: undefined }]), 1);
    expect(foldPopupAction(silent, { kind: 'enter' }, 5)).toEqual({ kind: 'unchanged' });
    const loading = openFrame(
      spec([{ ...FORM_STEP, content: { kind: 'loading', what: 'Reading' } }]),
      1,
    );
    expect(foldPopupAction(loading, { kind: 'enter' }, 5)).toEqual({ kind: 'unchanged' });
    const final = openFrame(spec([{ ...FORM_STEP, final: true }]), 1);
    expect(foldPopupAction(final, { kind: 'enter' }, 5)).toEqual({ kind: 'close' });
  });

  it('a field with no option, or a field the form does not have, is absent from the values', () => {
    const bare: PopupForm = {
      kind: 'form',
      summary: 'x',
      tabs: { label: 't', verb: 't', options: [] },
    };
    expect(
      formValues(currentStep(openFrame(spec([{ ...FORM_STEP, content: bare }]), 1)).state, bare),
    ).toEqual({});
  });

  it('a form whose content is replaced keeps the options chosen, by id; an id that is gone falls back on the new initial', () => {
    let frame = press(press(openFrame(spec(), 1), RIGHT), UP); // high, chat
    frame = withContent(frame, 0, { ...FORM, summary: 'rebuilt' });
    expect(chosen(frame)).toEqual({ tab: 'high', radio: 'chat' });
    const fewer: PopupForm = {
      ...FORM,
      tabs:
        FORM.tabs === undefined
          ? undefined
          : {
              ...FORM.tabs,
              initial: 'low',
              options: [
                { id: 'low', label: 'low' },
                { id: 'max', label: 'max' },
              ],
            },
    };
    frame = withContent(frame, 0, fewer);
    expect(formValues(currentStep(frame).state, fewer)).toEqual({ tab: 'low', radio: 'chat' });
  });

  it('a step that becomes a form opens on the form’s initial options', () => {
    const opening = openFrame(
      spec([{ ...FORM_STEP, content: { kind: 'loading', what: 'Reading' } }]),
      1,
    );
    expect(chosen(withContent(opening, 0, FORM))).toEqual({ tab: 'medium', radio: 'new' });
  });
});

describe('the legend of a form (through the one builder)', () => {
  const items = (frame: PopupFrame, page?: number) =>
    popupLegend(frame, page, 66).items.map((item) =>
      'keys' in item ? `${String(item.keys)} ${item.verb}` : item.text,
    );

  it('names ←/→ with the tabs’ verb, ↑/↓ with the radio’s, then `Enter apply`, and on a later step `Ctrl+C close` and `Esc back`', () => {
    const later = {
      ...openFrame(spec([{ name: 'Model', content: { kind: 'list', rows: [] } }, FORM_STEP]), 1),
      stepIndex: 1,
    };
    expect(items(later)).toEqual(['←/→ effort', '↑/↓ apply to', 'Enter apply', 'Ctrl+C close']);
    expect(popupLegend(later).exit).toEqual({ class: 'step', keys: 'Esc', verb: 'back' });
  });

  it('a field of one option names no key (there is nothing to change)', () => {
    const one: PopupForm = {
      kind: 'form',
      tabs: { label: 't', verb: 'effort', options: [{ id: 'a', label: 'a' }] },
      radio: { label: 'r', verb: 'apply to', options: [{ id: 'x', label: 'x' }] },
    };
    expect(items(openFrame(spec([{ ...FORM_STEP, content: one }]), 1))).toEqual(['Enter apply']);
  });

  it('a form that is not wholly on its page names no `Enter`', () => {
    const frame = openFrame(spec(), 1);
    expect(items(frame, 6)).toContain('Enter apply');
    expect(items(frame, 5)).not.toContain('Enter apply');
    expect(items(frame, 5)).toContain('←/→ effort');
  });
});

/** A manual clock and timer. */
function timers() {
  let now = 0;
  const schedule: Schedule = () => () => undefined;
  return { now: () => now, schedule, advance: (ms: number) => (now += ms) };
}

function rig(history = createChordHistory()) {
  const time = timers();
  const notifications = createNotificationChannel({ schedule: time.schedule });
  const host = createPopupHost({
    now: time.now,
    schedule: time.schedule,
    notifications,
    history,
    placement: 'overlay',
  });
  let page = 20;
  host.bindVisibility(() => true);
  host.bindOpenGate(() => undefined);
  host.bindPageRows(() => page);
  host.bindInnerWidth(() => 66);
  const applied: PopupFormValues[] = [];
  const opened = host.openForUser(spec(), {
    apply: (_context, values) => {
      applied.push(values);
    },
  });
  if (!opened.opened) throw new Error('refused');
  return {
    host,
    time,
    applied,
    show: () => host.shown(host.getSnapshot()),
    setPage: (rows: number) => {
      page = rows;
    },
  };
}

describe('the host answers a form', () => {
  it('`Enter` after the settle applies the ids chosen with ←/→ and ↑/↓', () => {
    const r = rig();
    r.show();
    r.time.advance(600);
    r.host.input('', RIGHT);
    r.host.input('', UP);
    // The form as it is now is a new frame: it is seen, and its own settle passes (`popup-form-settle.test.ts`).
    r.show();
    r.time.advance(500);
    r.host.input('', ENTER);
    expect(r.applied).toEqual([{ tab: 'high', radio: 'chat' }]);
  });

  it('holds the answer behind the opening guard: an `Enter` before the frame is seen, or inside its settle, applies nothing', () => {
    const r = rig();
    r.host.input('', ENTER); // no frame seen yet
    r.show();
    r.time.advance(100);
    r.host.input('', RIGHT); // a navigation key acts at once
    r.show(); // the slot acknowledges the frame the key made
    r.host.input('', ENTER); // inside the settle
    expect(r.applied).toEqual([]);
    r.time.advance(500);
    r.host.input('', ENTER);
    expect(r.applied).toEqual([{ tab: 'high', radio: 'new' }]);
  });

  it('applies nothing while the form is not wholly on the page its frame is drawn on', () => {
    const r = rig();
    r.show();
    r.time.advance(600);
    r.setPage(5);
    r.host.input('', ENTER);
    expect(r.applied).toEqual([]);
    r.setPage(6);
    // The first press resolved (it tried to answer), so a second one needs the lockout after it, not only the quiet gap: inside it, it is
    // taken for a held key's repeat and never applies a form.
    r.time.advance(300);
    r.host.input('', ENTER);
    expect(r.applied).toEqual([]);
    r.time.advance(APPROVAL_LOCKOUT_MS);
    r.host.input('', ENTER);
    expect(r.applied).toEqual([{ tab: 'medium', radio: 'new' }]);
  });

  it('an `Enter` on a form, applied or not, is a resolution on the key history (a held key cannot answer what opens next)', () => {
    const history = createChordHistory();
    const r = rig(history);
    r.show();
    r.time.advance(600);
    r.setPage(1);
    const before = history.lastResolvedAt;
    r.host.input('', ENTER);
    expect(r.applied).toEqual([]);
    expect(history.lastResolvedAt).toBeGreaterThan(before);
    r.time.advance(APPROVAL_LOCKOUT_MS); // a second press the lockout later (one inside it is taken for a held key's repeat)
    r.setPage(20);
    r.host.input('', ENTER);
    expect(r.applied).toHaveLength(1);
    expect(history.lastResolvedAt).toBe(r.time.now());
  });
});
