/**
 * The popup's reducer driver ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3): the
 * keys, the steps, `Esc` that clears a filter, steps back and closes, `Ctrl+C` that closes the stack, typed text that goes only into a text
 * field, the opening on the CURRENT value, and the legend that names exactly the keys the fold reads (each key it lists is pressed here).
 */
import { describe, expect, it } from 'vitest';

import { legend } from '../render/tui/legend.js';
import type { PopupContent, PopupListRow } from './frame-model.js';
import {
  backOf,
  currentStep,
  foldPopupAction,
  openFrame,
  openingKeyOf,
  popupLegend,
  railOf,
  reducePopupKey,
  visibleRows,
  withContent,
  type PopupFrame,
  type PopupKey,
  type PopupSpec,
  type PopupStep,
} from './popup-reducer.js';

const row = (id: string, enabled = true): PopupListRow => ({ id, label: id, enabled });
const LIST: PopupContent = {
  kind: 'list',
  rows: [row('alpha'), row('bravo', false), row('charlie'), row('delta')],
};
const step = (over: Partial<PopupStep> = {}): PopupStep => ({
  name: 'Pick',
  content: LIST,
  ...over,
});
const spec = (steps: readonly PopupStep[]): PopupSpec => ({
  id: 'test',
  title: '/test',
  origin: 'chat',
  steps,
});

/** Press one key on the frame: the fold's step, with a page of 2 rows. */
function press(frame: PopupFrame, input: string, key: PopupKey = {}) {
  const { spec: current } = currentStep(frame);
  return foldPopupAction(frame, reducePopupKey(input, key, current), 2);
}

function stateOf(fold: ReturnType<typeof press>): PopupFrame {
  if (fold.kind !== 'frame') throw new Error(`expected a frame, got ${fold.kind}`);
  return fold.frame;
}

describe('opening', () => {
  it('opens on the first step, on the CURRENT value a step names, so a bare Enter changes nothing', () => {
    const frame = openFrame(spec([step({ initialRow: 'charlie', enter: 'apply' })]), 7);
    expect(frame.runId).toBe(7);
    expect(frame.stepIndex).toBe(0);
    expect(currentStep(frame).state.selected).toBe(2);
    expect(press(frame, '', { return: true })).toEqual({ kind: 'enter', row: row('charlie') });
  });

  it('opens on the first row that can act when the step names none, or names one that cannot act', () => {
    expect(
      currentStep(
        openFrame(
          spec([step({ content: { kind: 'list', rows: [row('x', false), row('y')] } })]),
          1,
        ),
      ).state.selected,
    ).toBe(1);
    expect(currentStep(openFrame(spec([step({ initialRow: 'bravo' })]), 1)).state.selected).toBe(0);
  });
});

describe('the arrows and the pages', () => {
  const frame = openFrame(spec([step()]), 1);

  it('↓ skips a row that cannot act, and stops at the end (no wrap-around)', () => {
    const down = stateOf(press(frame, '', { downArrow: true }));
    expect(currentStep(down).state.selected).toBe(2);
    const last = stateOf(press(down, '', { downArrow: true }));
    expect(currentStep(last).state.selected).toBe(3);
    expect(press(last, '', { downArrow: true })).toEqual({ kind: 'unchanged' });
  });

  it('↑ stops at the first row', () => {
    expect(press(frame, '', { upArrow: true })).toEqual({ kind: 'unchanged' });
  });

  it('a page moves by the window and lands on a row that can act; Home and End jump', () => {
    expect(currentStep(stateOf(press(frame, '', { pageDown: true }))).state.selected).toBe(2);
    const end = stateOf(press(frame, '', { end: true }));
    expect(currentStep(end).state.selected).toBe(3);
    expect(currentStep(stateOf(press(end, '', { home: true }))).state.selected).toBe(0);
  });

  it('a report scrolls by its offset, and stops at its last page', () => {
    const report = openFrame(
      spec([step({ content: { kind: 'report', lines: ['a', 'b', 'c', 'd', 'e'] } })]),
      1,
    );
    const scrolled = stateOf(press(report, '', { downArrow: true }));
    expect(currentStep(scrolled).state.offset).toBe(1);
    const bottom = stateOf(press(report, '', { end: true }));
    expect(currentStep(bottom).state.offset).toBe(3);
    expect(press(bottom, '', { downArrow: true })).toEqual({ kind: 'unchanged' });
  });
});

describe('Enter, Esc and Ctrl+C (ADR-0148 §3)', () => {
  it('Enter answers a step that says what it does, with the highlighted row; nothing on a step that does not', () => {
    expect(press(openFrame(spec([step({ enter: 'apply' })]), 1), '', { return: true })).toEqual({
      kind: 'enter',
      row: row('alpha'),
    });
    expect(press(openFrame(spec([step()]), 1), '', { return: true })).toEqual({
      kind: 'unchanged',
    });
  });

  it('Enter on a row that cannot act answers nothing', () => {
    const frame: PopupFrame = {
      ...openFrame(spec([step({ enter: 'apply' })]), 1),
      steps: [{ content: LIST, selected: 1, offset: 0, filter: '' }],
    };
    expect(press(frame, '', { return: true })).toEqual({ kind: 'unchanged' });
  });

  it('Esc closes on the first step, and goes back one step later, keeping the earlier step as it was', () => {
    const two = openFrame(spec([step(), step({ name: 'Confirm' })]), 1);
    expect(press(two, '', { escape: true })).toEqual({ kind: 'close' });
    const first = stateOf(press(two, '', { end: true }));
    const onSecond: PopupFrame = { ...first, stepIndex: 1 };
    const back = stateOf(press(onSecond, '', { escape: true }));
    expect(back.stepIndex).toBe(0);
    expect(currentStep(back).state.selected).toBe(3);
  });

  it('Esc clears a filter first, and closes on the next press', () => {
    const filtered = openFrame(spec([step({ filter: true })]), 1);
    const typed = stateOf(press(filtered, 'ch'));
    expect(currentStep(typed).state.filter).toBe('ch');
    expect(visibleRows(currentStep(typed).state).map((r) => r.id)).toEqual(['charlie']);
    const cleared = stateOf(press(typed, '', { escape: true }));
    expect(currentStep(cleared).state.filter).toBe('');
    expect(press(cleared, '', { escape: true })).toEqual({ kind: 'close' });
  });

  it('Ctrl+C closes the whole popup on any step, and arms nothing', () => {
    const two = { ...openFrame(spec([step(), step()]), 1), stepIndex: 1 };
    expect(press(two, 'c', { ctrl: true })).toEqual({ kind: 'close-all' });
    expect(press(two, '\u0003')).toEqual({ kind: 'close-all' });
  });

  it('neither Esc nor Ctrl+C ever answers a step', () => {
    for (const key of [{ escape: true }, { ctrl: true }] as const) {
      const fold = press(
        openFrame(spec([step({ enter: 'apply' })]), 1),
        key.escape === true ? '' : 'c',
        key,
      );
      expect(fold.kind).not.toBe('enter');
      expect(fold.kind).not.toBe('control');
    }
  });
});

describe('typed text goes only into a text field', () => {
  it('a letter the step lists is its control; any other letter on a step with no filter is nothing', () => {
    const frame = openFrame(spec([step({ controls: [{ key: 'r', verb: 'again' }] })]), 1);
    expect(press(frame, 'r')).toEqual({ kind: 'control', key: 'r' });
    expect(press(frame, 'x')).toEqual({ kind: 'unchanged' });
    expect(press(frame, 'r', { ctrl: true })).toEqual({ kind: 'unchanged' });
  });

  it('a step with a filter takes typing and Backspace; the highlight follows the first row that can act', () => {
    const frame = openFrame(spec([step({ filter: true })]), 1);
    const typed = stateOf(press(frame, 'd'));
    expect(currentStep(typed).state.selected).toBe(0);
    expect(visibleRows(currentStep(typed).state).map((r) => r.id)).toEqual(['delta']);
    const back = stateOf(press(typed, '', { backspace: true }));
    expect(currentStep(back).state.filter).toBe('');
  });
});

describe('a result that lands', () => {
  it('replaces a step’s content and keeps the highlight on a row that can act', () => {
    const frame = stateOf(press(openFrame(spec([step()]), 1), '', { end: true }));
    const next = withContent(frame, 0, { kind: 'list', rows: [row('only')] });
    expect(currentStep(next).state.selected).toBe(0);
    expect(currentStep(next).state.content.kind).toBe('list');
  });
});

describe('what each key is to the opening guard', () => {
  it('leaving is leave, the arrows navigate, Enter and a control answer, typing types', () => {
    const current = step({ controls: [{ key: 'r', verb: 'again' }], filter: true });
    const kind = (input: string, key: PopupKey = {}) =>
      openingKeyOf(reducePopupKey(input, key, current));
    expect(kind('', { escape: true })).toBe('leave');
    expect(kind('c', { ctrl: true })).toBe('leave');
    expect(kind('', { upArrow: true })).toBe('navigate');
    expect(kind('', { pageDown: true })).toBe('navigate');
    expect(kind('', { return: true })).toBe('answer');
    expect(kind('r')).toBe('answer');
    expect(kind('x')).toBe('type');
  });
});

describe('the legend names exactly the keys the fold reads', () => {
  it('on a list step: select, the Enter verb, each control, and Esc close last', () => {
    const frame = openFrame(
      spec([step({ enter: 'apply', controls: [{ key: 'c', verb: 'copy' }] })]),
      1,
    );
    const parts = popupLegend(frame);
    expect(legend(parts.items, parts.exit)).toBe('↑/↓ select · Enter apply · [c] copy · Esc close');
    // every key the legend lists is a key the fold answers on this step
    expect(press(frame, '', { downArrow: true }).kind).toBe('frame');
    expect(press(frame, '', { return: true }).kind).toBe('enter');
    expect(press(frame, 'c').kind).toBe('control');
    expect(press(frame, '', { escape: true }).kind).toBe('close');
  });

  it('on a later step: Ctrl+C is the key that closes, and the legend ends with Esc back (a step)', () => {
    const frame = { ...openFrame(spec([step(), step({ name: 'Two' })]), 1), stepIndex: 1 };
    const parts = popupLegend(frame);
    expect(legend(parts.items, parts.exit)).toBe('↑/↓ select · [Ctrl+C] close · Esc back');
    expect(parts.exit.class).toBe('step');
    expect(press(frame, '', { escape: true }).kind).toBe('frame');
    expect(press(frame, 'c', { ctrl: true }).kind).toBe('close-all');
  });

  it('with a filter typed: Esc clears it, and Ctrl+C closes', () => {
    const typed = stateOf(press(openFrame(spec([step({ filter: true })]), 1), 'a'));
    const parts = popupLegend(typed);
    expect(legend(parts.items, parts.exit)).toContain('[Ctrl+C] close · Esc clear the filter');
    expect(parts.exit.class).toBe('step');
  });

  it('a loading step says its Esc cancels; a report says it scrolls; a one-row list does not offer select', () => {
    const loading = openFrame(spec([step({ content: { kind: 'loading', what: 'Checking' } })]), 1);
    expect(legend(popupLegend(loading).items, popupLegend(loading).exit)).toBe('Esc cancel');
    const report = openFrame(spec([step({ content: { kind: 'report', lines: ['x'] } })]), 1);
    expect(legend(popupLegend(report).items, popupLegend(report).exit)).toBe(
      '↑/↓ scroll · Esc close',
    );
    const single = openFrame(spec([step({ content: { kind: 'list', rows: [row('one')] } })]), 1);
    expect(legend(popupLegend(single).items, popupLegend(single).exit)).toBe('Esc close');
  });
});

describe('the letters a step answers to can arrive with its content (ADR-0148 §3, MVP-11 step 4b)', () => {
  const REPORT: PopupContent = { kind: 'report', lines: ['one line'] };
  const two = (): PopupFrame => openFrame(spec([step({ content: REPORT })]), 1);
  const R = [{ key: 'r', verb: 'release' }] as const;

  it('a step with no control answers no letter, and one the content brought answers it, in the fold and in the legend', () => {
    const bare = two();
    expect(press(bare, 'r').kind).toBe('unchanged');
    expect(legend(popupLegend(bare).items, popupLegend(bare).exit)).toBe('↑/↓ scroll · Esc close');
    const offered = withContent(bare, 0, REPORT, R);
    expect(currentStep(offered).spec.controls).toEqual(R);
    expect(press(offered, 'r')).toEqual({ kind: 'control', key: 'r' });
    expect(legend(popupLegend(offered).items, popupLegend(offered).exit)).toBe(
      '↑/↓ scroll · r release · Esc close'.replace('r release', '[r] release'),
    );
  });

  it('an empty list takes the control away, and a content that names none keeps the ones it has', () => {
    const offered = withContent(two(), 0, REPORT, R);
    expect(press(withContent(offered, 0, REPORT, []), 'r').kind).toBe('unchanged');
    expect(press(withContent(offered, 0, { kind: 'report', lines: ['again'] }), 'r')).toEqual({
      kind: 'control',
      key: 'r',
    });
  });

  it('is per step: another step keeps its own controls, and the spec’s are the default', () => {
    const frame = openFrame(
      spec([
        step({ content: REPORT, controls: [{ key: 'a', verb: 'first' }] }),
        step({ name: 'Two', content: REPORT }),
      ]),
      1,
    );
    const changed = withContent(frame, 1, REPORT, R);
    expect(currentStep(changed).spec.controls).toEqual([{ key: 'a', verb: 'first' }]);
    expect(currentStep({ ...changed, stepIndex: 1 }).spec.controls).toEqual(R);
  });
});

describe('a final step: the end of a flow (MVP-11 step 4b)', () => {
  const REPORT: PopupContent = { kind: 'report', lines: ['Released.'] };
  const flow = (): PopupFrame => ({
    ...openFrame(
      spec([
        step({ content: REPORT }),
        step({ name: 'Release', content: REPORT, back: 0 }),
        step({ name: 'Done', content: REPORT, back: 1, final: true, enter: 'close' }),
      ]),
      1,
    ),
    stepIndex: 2,
  });

  it('Esc closes the popup from it: there is no way back to what the flow just did', () => {
    expect(backOf(flow().spec, 2)).toBe(-1);
    expect(backOf(flow().spec, 1)).toBe(0);
    expect(press(flow(), '', { escape: true }).kind).toBe('close');
    // The same step without `final` steps back along `back`.
    const plain = {
      ...flow(),
      spec: spec([step(), step({ name: 'B', back: 0 }), step({ name: 'C', back: 1 })]),
    };
    expect(press(plain, '', { escape: true }).kind).toBe('frame');
  });

  it('Enter answers it and Ctrl+C closes everything, as on any step', () => {
    expect(press(flow(), '', { return: true })).toEqual({ kind: 'enter', row: undefined });
    expect(press(flow(), 'c', { ctrl: true }).kind).toBe('close-all');
  });

  it('its legend names Enter and Esc as the keys that close it, and nothing else', () => {
    const parts = popupLegend(flow());
    expect(parts.items).toEqual([]);
    expect(legend(parts.items, parts.exit)).toBe('Enter / Esc close');
    expect(parts.exit.class).toBe('close');
  });

  it('the rail still counts the steps that led to it', () => {
    const rail = railOf({ ...flow(), spec: { ...flow().spec, rail: 'path' } });
    expect(rail.names).toEqual(['Pick', 'Release', 'Done']);
    expect(rail.index).toBe(2);
  });
});
