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

  it('a loading first step says its Esc cancels; a report that overflows its page says it scrolls; a one-row list does not offer select', () => {
    const loading = openFrame(spec([step({ content: { kind: 'loading', what: 'Checking' } })]), 1);
    expect(legend(popupLegend(loading).items, popupLegend(loading).exit)).toBe('Esc cancel');
    const single = openFrame(spec([step({ content: { kind: 'list', rows: [row('one')] } })]), 1);
    expect(legend(popupLegend(single).items, popupLegend(single).exit)).toBe('Esc close');
  });
});

describe('`↑/↓ scroll` is named only for a report that does not fit its page (MVP-11 step 4 review)', () => {
  const report = (count: number): PopupFrame =>
    openFrame(
      spec([
        step({
          content: {
            kind: 'report',
            lines: Array.from({ length: count }, (_, i) => `l${String(i)}`),
          },
        }),
      ]),
      1,
    );
  const said = (frame: PopupFrame, rows?: number): string => {
    const parts = popupLegend(frame, rows);
    return legend(parts.items, parts.exit);
  };

  it('on the page the frame draws: one line more than the page scrolls, a page of lines does not', () => {
    expect(said(report(5), 5)).toBe('Esc close');
    expect(said(report(6), 5)).toBe('↑/↓ scroll · Esc close');
    expect(said(report(1), 1)).toBe('Esc close');
    expect(said(report(2), 1)).toBe('↑/↓ scroll · Esc close');
  });

  it('without a page, on the page of a standard popup at the floor (18 body rows for one step, 17 with a rail)', () => {
    expect(said(report(1))).toBe('Esc close');
    expect(said(report(18))).toBe('Esc close');
    expect(said(report(19))).toBe('↑/↓ scroll · Esc close');
    const railed = (count: number): PopupFrame => ({
      ...openFrame(
        spec([
          step(),
          step({
            name: 'Two',
            content: {
              kind: 'report',
              lines: Array.from({ length: count }, (_, i) => `l${String(i)}`),
            },
          }),
        ]),
        1,
      ),
      stepIndex: 1,
    });
    expect(said(railed(17))).toBe('[Ctrl+C] close · Esc back');
    expect(said(railed(18))).toBe('↑/↓ scroll · [Ctrl+C] close · Esc back');
  });

  it('every legend the fold scrolls is a legend that says so: the key moves the report exactly when it is named', () => {
    for (const [count, page] of [
      [5, 5],
      [6, 5],
      [1, 1],
      [2, 1],
    ] as const) {
      const frame = report(count);
      const moved = foldPopupAction(frame, { kind: 'move', delta: 1 }, page).kind === 'frame';
      expect(said(frame, page).includes('scroll'), `${String(count)} in ${String(page)}`).toBe(
        moved,
      );
    }
  });
});

describe('the way back says what Esc does there (MVP-11 step 4 review)', () => {
  const LINE: PopupStep = {
    name: 'Line',
    content: { kind: 'report', lines: ['Sends one small request'] },
    back: 0,
    holds: 'chord',
    chord: { verb: 'send' },
  };
  const said = (frame: PopupFrame): string => {
    const parts = popupLegend(frame);
    return legend(parts.items, parts.exit);
  };
  const on = (line: PopupStep, content?: PopupContent): PopupFrame => {
    const frame = { ...openFrame(spec([step(), line]), 1), stepIndex: 1 };
    return content === undefined ? frame : withContent(frame, 1, content);
  };

  it('a confirmation line steps back, whatever it shows: answer drawn, being prepared, nothing to confirm, failed', () => {
    expect(said(on(LINE))).toBe('[Ctrl+Y] send · Esc back');
    expect(said(on(LINE, { kind: 'loading', what: 'Reading' }))).toBe('Esc back');
    expect(
      said(on(LINE, { kind: 'empty', what: 'No provider has a key.', next: 'Add one.' })),
    ).toBe('Esc back');
    expect(said(on(LINE, { kind: 'error', what: 'It failed.', next: 'Esc goes back.' }))).toBe(
      'Esc back',
    );
    expect(popupLegend(on(LINE)).exit.class).toBe('step');
  });

  it('a confirmation line that is the first step closes, and cancels only while it is being prepared', () => {
    const first = (content: PopupContent): PopupFrame =>
      openFrame(spec([{ ...LINE, back: undefined, content }]), 1);
    expect(said(first({ kind: 'report', lines: ['x'] }))).toBe('[Ctrl+Y] send · Esc close');
    expect(said(first({ kind: 'empty', what: 'none', next: 'go' }))).toBe('Esc close');
    expect(said(first({ kind: 'loading', what: 'Reading' }))).toBe('Esc cancel');
    expect(popupLegend(first({ kind: 'loading', what: 'Reading' })).exit.class).toBe('close');
  });

  it('a later step that is loading goes back (Esc does not stop its work there); a first step that is loading cancels', () => {
    const later = {
      ...openFrame(
        spec([step(), step({ name: 'Two', content: { kind: 'loading', what: 'x' } })]),
        1,
      ),
      stepIndex: 1,
    };
    expect(said(later)).toBe('[Ctrl+C] close · Esc back');
    expect(press(later, '', { escape: true }).kind).toBe('frame');
    const first = openFrame(spec([step({ content: { kind: 'loading', what: 'x' } })]), 1);
    expect(said(first)).toBe('Esc cancel');
    expect(press(first, '', { escape: true }).kind).toBe('close');
  });
});

describe('the letters a step answers to can arrive with its content (ADR-0148 §3, MVP-11 step 4b)', () => {
  const REPORT: PopupContent = { kind: 'report', lines: ['one line'] };
  const two = (): PopupFrame => openFrame(spec([step({ content: REPORT })]), 1);
  const R = [{ key: 'r', verb: 'release' }] as const;

  it('a step with no control answers no letter, and one the content brought answers it, in the fold and in the legend', () => {
    const bare = two();
    expect(press(bare, 'r').kind).toBe('unchanged');
    // A one-line report fits its page: it names no scroll.
    expect(legend(popupLegend(bare).items, popupLegend(bare).exit)).toBe('Esc close');
    const offered = withContent(bare, 0, REPORT, R);
    expect(currentStep(offered).spec.controls).toEqual(R);
    expect(press(offered, 'r')).toEqual({ kind: 'control', key: 'r' });
    expect(legend(popupLegend(offered).items, popupLegend(offered).exit)).toBe(
      '[r] release · Esc close',
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

  it('Enter closes it as Esc does, whatever it shows (a failed result, nothing, a load), and Ctrl+C closes everything', () => {
    expect(press(flow(), '', { return: true })).toEqual({ kind: 'close' });
    for (const content of [
      { kind: 'error', what: 'The release could not be completed.', next: 'Esc closes.' },
      { kind: 'empty', what: 'Nothing.', next: 'Esc closes.' },
      { kind: 'loading', what: 'Reading' },
      { kind: 'list', rows: [] },
    ] as const satisfies readonly PopupContent[])
      expect(press(withContent(flow(), 2, content), '', { return: true }), content.kind).toEqual({
        kind: 'close',
      });
    // The same step without `final` refuses Enter on a failed result (it has nothing to answer).
    const plain = withContent(
      {
        ...flow(),
        spec: spec([
          step(),
          step({ name: 'B', back: 0 }),
          step({ name: 'C', back: 1, enter: 'close' }),
        ]),
      },
      2,
      { kind: 'error', what: 'x', next: 'y' },
    );
    expect(press(plain, '', { return: true }).kind).toBe('unchanged');
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
