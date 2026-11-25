/**
 * The popup's reducer driver ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3): the
 * keys, the steps, `Esc` that clears a filter, steps back and closes, `Ctrl+C` that closes the stack, typed text that goes only into a text
 * field, the opening on the CURRENT value, and the legend that names exactly the keys the fold reads (each key it lists is pressed here).
 */
import { describe, expect, it } from 'vitest';

import { legend } from '../render/tui/legend.js';
import { popupBody, type PopupContent, type PopupListRow } from './frame-model.js';
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

describe('an `Enter` that is not a plain first press answers nothing, on any step (MVP-11 step 5, security round 1)', () => {
  const FORM: PopupContent = {
    kind: 'form',
    radio: {
      label: 'Apply to',
      verb: 'apply to',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    },
  };
  const steps = [
    ['a list that says what Enter does', step({ enter: 'apply' })],
    ['a form', step({ enter: 'apply', content: FORM })],
    ['a list that says nothing', step()],
  ] as const;
  // What a terminal sends for a key that is held (a repeat a terminal that reports key events labels), let go, or pressed with a modifier
  // (`Esc` then `Enter` inside the escape window arrives as `Meta+Enter`).
  const notPlain: readonly (readonly [string, PopupKey])[] = [
    ['a repeat', { return: true, eventType: 'repeat' }],
    ['a release', { return: true, eventType: 'release' }],
    ['Shift+Enter', { return: true, shift: true }],
    ['Meta+Enter', { return: true, meta: true }],
    ['Ctrl+Enter', { return: true, ctrl: true }],
  ];

  it.each(
    steps.flatMap(([name, one]) => notPlain.map(([kind, key]) => [name, one, kind, key] as const)),
  )('on %s, %s answers nothing', (_name, one, _kind, key) => {
    expect(reducePopupKey('', key, one)).toEqual({ kind: 'none' });
    // It answers nothing: the fold leaves the frame as it was, so no handler hears of it.
    expect(foldPopupAction(openFrame(spec([one]), 1), reducePopupKey('', key, one), 2)).toEqual({
      kind: 'unchanged',
    });
  });

  it.each(steps)(
    'on %s, a plain press and a press a terminal labels as one are the answer',
    (_name, one) => {
      expect(reducePopupKey('', { return: true }, one)).toEqual({ kind: 'enter' });
      expect(reducePopupKey('', { return: true, eventType: 'press' }, one)).toEqual({
        kind: 'enter',
      });
    },
  );
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

  it('keeps the highlight on the same row by id when rows land before it (a refreshed catalog sorts a new model first)', () => {
    const frame = stateOf(press(openFrame(spec([step()]), 1), '', { end: true })); // delta, the last row
    expect(visibleRows(currentStep(frame).state)[currentStep(frame).state.selected]?.id).toBe(
      'delta',
    );
    const landed = withContent(frame, 0, {
      kind: 'list',
      rows: [row('aaa-new'), row('alpha'), row('bravo', false), row('charlie'), row('delta')],
    });
    const state = currentStep(landed).state;
    expect(visibleRows(state)[state.selected]?.id).toBe('delta'); // by index it would be 'charlie'
  });

  it('a highlighted row that is gone leaves the highlight at its index, or on the first row that can act', () => {
    const frame = stateOf(press(openFrame(spec([step()]), 1), '', { end: true })); // delta
    const gone = withContent(frame, 0, {
      kind: 'list',
      rows: [row('alpha'), row('bravo'), row('charlie'), row('echo')],
    });
    expect(currentStep(gone).state.selected).toBe(3); // the same index, a row that can act
    const short = withContent(frame, 0, {
      kind: 'list',
      rows: [row('alpha'), row('bravo', false)],
    });
    expect(currentStep(short).state.selected).toBe(0);
  });

  it('a highlighted row that is still there but cannot act any more is left for one that can', () => {
    const frame = stateOf(press(openFrame(spec([step()]), 1), '', { end: true })); // delta
    const disabled = withContent(frame, 0, {
      kind: 'list',
      rows: [row('alpha'), row('bravo'), row('charlie'), row('delta', false)],
    });
    expect(currentStep(disabled).state.selected).toBe(0);
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

describe('PgUp and PgDn show every line of a long report (round 3: the marker rows replace a line each)', () => {
  /**
   * The lines a person reads by pressing only `key` from the first page (`pageDown`) or the last (`pageUp`): for each page, the indexes of the
   * report lines the frame model draws between its marker rows, on a page of `page` rows.
   */
  function pagesRead(total: number, page: number, key: 'pageDown' | 'pageUp'): number[][] {
    const lines = Array.from({ length: total }, (_, index) => `report line ${String(index)}`);
    const content: PopupContent = { kind: 'report', lines };
    let frame = openFrame(spec([step({ content })]), 1);
    if (key === 'pageUp')
      frame = stateOf(foldPopupAction(frame, { kind: 'jump', to: 'last' }, page));
    const read: number[][] = [];
    for (let turn = 0; turn <= total; turn += 1) {
      const body = popupBody(
        content,
        { ...currentStep(frame).state, filter: undefined },
        {
          bodyRows: page,
          listRows: page,
          innerWidth: 66,
        },
      );
      read.push(
        body.lines
          .filter((line) => line.kind === 'row')
          .map((line) => Number(/report line (\d+)/u.exec(line.text)?.[1])),
      );
      const fold = foldPopupAction(
        frame,
        { kind: 'page', delta: key === 'pageDown' ? 1 : -1 },
        page,
      );
      if (fold.kind !== 'frame') return read;
      frame = fold.frame;
    }
    throw new Error('the pages never ended');
  }

  const cases = [20, 40, 46, 92, 100].flatMap((total) =>
    [18, 17, 10, 4, 3, 2, 1].map((page) => [total, page] as const),
  );

  it.each(cases)(
    '%i lines on a page of %i: PgDn alone shows every line, each once before the last page',
    (total, page) => {
      const pages = pagesRead(total, page, 'pageDown');
      expect(new Set(pages.flat())).toEqual(new Set(Array.from({ length: total }, (_, i) => i)));
      for (let at = 1; at < pages.length; at += 1) {
        const before = pages[at - 1] ?? [];
        const next = pages[at] ?? [];
        const lastBefore = Math.max(...before);
        // No line is skipped between two pages, and none is read twice except where the last page is held at the end.
        if (at < pages.length - 1) expect(Math.min(...next)).toBe(lastBefore + 1);
        else expect(Math.min(...next)).toBeLessThanOrEqual(lastBefore + 1);
      }
    },
  );

  it.each(cases)(
    '%i lines on a page of %i: PgUp alone, from the end, is the mirror',
    (total, page) => {
      const pages = pagesRead(total, page, 'pageUp');
      expect(new Set(pages.flat())).toEqual(new Set(Array.from({ length: total }, (_, i) => i)));
      for (let at = 1; at < pages.length; at += 1) {
        const before = pages[at - 1] ?? [];
        const next = pages[at] ?? [];
        const firstBefore = Math.min(...before);
        if (at < pages.length - 1) expect(Math.max(...next)).toBe(firstBefore - 1);
        else expect(Math.max(...next)).toBeGreaterThanOrEqual(firstBefore - 1);
      }
    },
  );

  it('a page of the alternate screen (18 rows) moves 16 lines, one inline (10 rows) moves 8; a page too short for markers moves whole', () => {
    const report = openFrame(
      spec([step({ content: { kind: 'report', lines: Array.from({ length: 100 }, String) } })]),
      1,
    );
    const offset = (fold: ReturnType<typeof foldPopupAction>): number =>
      currentStep(stateOf(fold)).state.offset;
    expect(offset(foldPopupAction(report, { kind: 'page', delta: 1 }, 18))).toBe(16);
    expect(offset(foldPopupAction(report, { kind: 'page', delta: 1 }, 10))).toBe(8);
    expect(offset(foldPopupAction(report, { kind: 'page', delta: 1 }, 2))).toBe(2);
  });
});

describe('the reducer’s edges (round 3 mutation sweep)', () => {
  const rows = (count: number, detail?: (index: number) => string | undefined): PopupListRow[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `r${String(index)}`,
      label: `row ${String(index)}`,
      detail: detail?.(index),
    }));
  const longList = step({ content: { kind: 'list', rows: rows(20) }, enter: 'go', filter: true });
  const report = (count: number): PopupStep =>
    step({
      content: { kind: 'report', lines: Array.from({ length: count }, (_, i) => `l${String(i)}`) },
    });
  const line: PopupStep = {
    name: 'Confirm',
    content: { kind: 'report', lines: ['a'] },
    chord: { verb: 'send' },
    holds: 'chord',
    back: 0,
  };

  it('R20: PgUp is a page up and PgDn a page down, on a list and on a line', () => {
    expect(reducePopupKey('', { pageUp: true }, longList)).toEqual({ kind: 'page', delta: -1 });
    expect(reducePopupKey('', { pageDown: true }, longList)).toEqual({ kind: 'page', delta: 1 });
    expect(reducePopupKey('', { pageUp: true }, line)).toEqual({ kind: 'page', delta: -1 });
  });

  it('R20: PgUp on a list moves the highlight up a page', () => {
    const frame = openFrame(spec([longList]), 1);
    const down = stateOf(foldPopupAction(frame, { kind: 'jump', to: 'last' }, 5));
    const up = stateOf(foldPopupAction(down, { kind: 'page', delta: -1 }, 5));
    expect(currentStep(up).state.selected).toBe(14);
  });

  it('R38: ↑ and PgUp at the first line of a report change nothing (the offset is never below zero)', () => {
    const frame = openFrame(spec([report(12)]), 1);
    expect(foldPopupAction(frame, { kind: 'move', delta: -1 }, 5)).toEqual({ kind: 'unchanged' });
    expect(foldPopupAction(frame, { kind: 'page', delta: -1 }, 5)).toEqual({ kind: 'unchanged' });
  });

  it('R43: PgDn on a list moves the highlight by the page', () => {
    const fold = foldPopupAction(openFrame(spec([longList]), 1), { kind: 'page', delta: 1 }, 5);
    expect(currentStep(stateOf(fold)).state.selected).toBe(5);
  });

  it('R37: Backspace takes a whole astral character off the filter, never half of it', () => {
    const typed = stateOf(
      foldPopupAction(openFrame(spec([longList]), 1), { kind: 'append', text: 'a😀' }, 5),
    );
    const back = stateOf(foldPopupAction(typed, { kind: 'backspace' }, 5));
    expect(currentStep(back).state.filter).toBe('a');
  });

  it('R59/R60: a result that lands keeps the highlighted row where it still can act, and scrolls a report back to its first line', () => {
    const list = openFrame(spec([step({ content: { kind: 'list', rows: rows(8) } })]), 1);
    const second = stateOf(foldPopupAction(list, { kind: 'move', delta: 1 }, 5));
    const third = stateOf(foldPopupAction(second, { kind: 'move', delta: 1 }, 5));
    expect(currentStep(withContent(third, 0, { kind: 'list', rows: rows(8) })).state.selected).toBe(
      2,
    );
    const scrolled = stateOf(
      foldPopupAction(openFrame(spec([report(12)]), 1), { kind: 'move', delta: 1 }, 5),
    );
    expect(currentStep(scrolled).state.offset).toBe(1);
    expect(
      currentStep(withContent(scrolled, 0, { kind: 'report', lines: ['a', 'b'] })).state.offset,
    ).toBe(0);
  });

  it('R64: the filter finds a row by its detail too', () => {
    const detailed = step({
      content: { kind: 'list', rows: rows(8, (index) => (index === 3 ? 'needle' : undefined)) },
      filter: true,
    });
    const typed = stateOf(
      foldPopupAction(openFrame(spec([detailed]), 1), { kind: 'append', text: 'needle' }, 5),
    );
    expect(visibleRows(currentStep(typed).state).map((found) => found.id)).toEqual(['r3']);
  });

  it('R05: an initial step past the last opens on the first', () => {
    expect(openFrame({ ...spec([longList, report(3)]), initialStep: 2 }, 1).stepIndex).toBe(0);
    expect(openFrame({ ...spec([longList, report(3)]), initialStep: 1 }, 1).stepIndex).toBe(1);
  });

  it('R06: a step whose `back` names itself goes back to the step before it', () => {
    expect(backOf(spec([longList, { ...report(3), back: 1 }]), 1)).toBe(0);
  });

  it('R12: Ctrl+Esc on a line is a key typed over it, not its way back', () => {
    expect(reducePopupKey('', { escape: true, ctrl: true }, line)).toEqual({
      kind: 'disarm',
      cause: 'typed',
    });
    expect(reducePopupKey('', { escape: true }, line)).toEqual({ kind: 'leave' });
  });

  it('R18: Alt and a letter is not that letter’s control, nor typing', () => {
    const controlled = step({ controls: [{ key: 'd', verb: 'deep' }], filter: true });
    expect(reducePopupKey('d', { meta: true }, controlled)).toEqual({ kind: 'none' });
    expect(reducePopupKey('d', {}, controlled)).toEqual({ kind: 'control', key: 'd' });
  });
});
