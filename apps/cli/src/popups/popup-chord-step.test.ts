/**
 * The reducer driver's confirmation line and branching steps ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3, §8): what each key means on a step answered by `Ctrl+Y`, where `Esc` goes from a step reached from the first, what the rail counts, a
 * loading step that answers nothing, and the legend a step keeps longest when it does not fit.
 */
import { describe, expect, it } from 'vitest';

import { legend } from '../render/tui/legend.js';
import { displayWidth } from '../render/tui/viewport.js';
import { consentContent, doctorSpec } from './doctor-popup.js';
import { POPUP_TEXT_COLUMNS } from './popup-text.js';
import { popupFrameLines } from './frame-model.js';
import { POPUP_NOTICE_MAX_COLUMNS, popupGeometry, type PopupBoxGeometry } from './geometry.js';
import {
  backOf,
  foldPopupAction,
  openFrame,
  openingKeyOf,
  popupLegend,
  railOf,
  reducePopupKey,
  withContent,
  type PopupFrame,
  type PopupKey,
  type PopupSpec,
  type PopupStep,
} from './popup-reducer.js';

const LINE: PopupStep = {
  name: 'Deep check',
  content: { kind: 'report', lines: ['Sends one small request with your key to:'] },
  back: 0,
  holds: 'chord',
  chord: { verb: 'send' },
};

const keyOn = (input: string, key: PopupKey = {}) => reducePopupKey(input, key, LINE);

describe('a key on a confirmation line', () => {
  it('Ctrl+Y is the answer and nothing else is', () => {
    expect(keyOn('y', { ctrl: true })).toEqual({ kind: 'chord' });
    expect(keyOn('y', { ctrl: true, meta: true })).toEqual({ kind: 'disarm', cause: 'typed' });
    expect(keyOn('y')).toEqual({ kind: 'disarm', cause: 'typed' });
  });

  it('Esc steps back; Ctrl+C (a cancel), a letter, Enter, Backspace and any other chord (typed) disarm; the navigation keys only move', () => {
    expect(keyOn('', { escape: true })).toEqual({ kind: 'leave' });
    expect(keyOn('c', { ctrl: true })).toEqual({ kind: 'disarm', cause: 'interrupt' });
    expect(keyOn('C', { ctrl: true })).toEqual({ kind: 'disarm', cause: 'interrupt' });
    expect(keyOn('\u0003')).toEqual({ kind: 'disarm', cause: 'interrupt' });
    expect(keyOn('c', { ctrl: true, meta: true })).toEqual({ kind: 'disarm', cause: 'typed' });
    expect(keyOn('c')).toEqual({ kind: 'disarm', cause: 'typed' });
    expect(keyOn('x')).toEqual({ kind: 'disarm', cause: 'typed' });
    expect(keyOn('', { return: true })).toEqual({ kind: 'disarm', cause: 'typed' });
    expect(keyOn('', { backspace: true })).toEqual({ kind: 'disarm', cause: 'typed' });
    expect(keyOn('n', { ctrl: true })).toEqual({ kind: 'disarm', cause: 'typed' });
    expect(keyOn('', { upArrow: true })).toEqual({ kind: 'move', delta: -1 });
    expect(keyOn('', { downArrow: true })).toEqual({ kind: 'move', delta: 1 });
    expect(keyOn('', { pageDown: true })).toEqual({ kind: 'page', delta: 1 });
    expect(keyOn('', { home: true })).toEqual({ kind: 'jump', to: 'first' });
  });

  it('for the opening guard the answer is an answer and disarming is leaving (admitted on a frame nobody has seen)', () => {
    expect(openingKeyOf({ kind: 'chord' })).toBe('answer');
    expect(openingKeyOf({ kind: 'disarm', cause: 'typed' })).toBe('leave');
    expect(openingKeyOf({ kind: 'disarm', cause: 'interrupt' })).toBe('leave');
  });
});

describe('folding on a confirmation line', () => {
  const frame = { ...openFrame(doctorSpec('home', true), 1) };
  const ready: PopupFrame = withContent(frame, 2, LINE.content);

  it('takes the chord only on a line that is drawn: never while it is prepared or when there is nothing to confirm', () => {
    expect(foldPopupAction(ready, { kind: 'chord' }, 18)).toEqual({ kind: 'chord' });
    expect(foldPopupAction(frame, { kind: 'chord' }, 18)).toEqual({ kind: 'unchanged' });
    const empty = withContent(frame, 2, { kind: 'empty', what: 'none', next: 'go' });
    expect(foldPopupAction(empty, { kind: 'chord' }, 18)).toEqual({ kind: 'unchanged' });
  });

  it('disarming and Esc go back to the step the line names (the checks), not the step before it', () => {
    for (const action of [{ kind: 'disarm', cause: 'typed' }, { kind: 'leave' }] as const) {
      const fold = foldPopupAction(ready, action, 18);
      expect(fold.kind).toBe('frame');
      if (fold.kind === 'frame') expect(fold.frame.stepIndex).toBe(0);
    }
  });

  it('a line on the first step closes when it is disarmed', () => {
    const only = openFrame({ id: 'one', title: '/one', origin: 'home', steps: [LINE] }, 1);
    expect(foldPopupAction(only, { kind: 'disarm', cause: 'typed' }, 18)).toEqual({
      kind: 'close',
    });
  });
});

describe('branching steps and their rail', () => {
  const spec = doctorSpec('home', false);

  it('`back` names where Esc goes; with none it is the step before, and the first has none', () => {
    expect(backOf(spec, 0)).toBe(-1);
    expect(backOf(spec, 1)).toBe(0);
    expect(backOf(spec, 2)).toBe(0);
    const linear = { ...spec, steps: spec.steps.map((step) => ({ ...step, back: undefined })) };
    expect(backOf(linear, 2)).toBe(1);
  });

  it('the rail of a popup of alternatives counts the path to the step, never a step that is not to come', () => {
    expect(railOf({ ...openFrame(spec, 1), stepIndex: 0 })).toEqual({
      names: ['Checks'],
      index: 0,
    });
    expect(railOf({ ...openFrame(spec, 1), stepIndex: 2 })).toEqual({
      names: ['Checks', 'Deep check'],
      index: 1,
    });
    // A popup that is a sequence keeps its rail: every step, the ones to come included.
    const sequence = { ...spec, rail: undefined };
    expect(railOf({ ...openFrame(sequence, 1), stepIndex: 1 }).names).toHaveLength(3);
  });

  it('a popup opens on the step its spec names', () => {
    expect(openFrame(doctorSpec('home', true), 1).stepIndex).toBe(2);
    expect(openFrame(doctorSpec('home', false), 1).stepIndex).toBe(0);
  });
});

describe('a loading step answers nothing and names nothing that answers', () => {
  const frame = openFrame(checksSpec(), 1);

  it('its Enter and its controls do nothing; Esc still cancels', () => {
    expect(foldPopupAction(frame, { kind: 'enter' }, 18)).toEqual({ kind: 'unchanged' });
    expect(foldPopupAction(frame, { kind: 'control', key: 'd' }, 18)).toEqual({
      kind: 'unchanged',
    });
    expect(foldPopupAction(frame, { kind: 'leave' }, 18)).toEqual({ kind: 'close' });
    const parts = popupLegend(frame);
    expect(legend(parts.items, parts.exit)).toBe('Esc cancel');
  });
});

/**
 * A popup of the doctor's shape (a checks list with three controls and an `Enter`, a detail and a confirmation line reached from it), written
 * here so the reducer's rules are pinned whatever the doctor's own spec does next (its tests pin the spec).
 */
function checksSpec(): PopupSpec {
  return {
    id: 'checks',
    title: '/checks',
    origin: 'home',
    rail: 'path',
    steps: [
      {
        name: 'Checks',
        content: { kind: 'loading', what: 'Checking' },
        enter: 'details',
        controls: [
          { key: 'r', verb: 'quick check' },
          { key: 'd', verb: 'deep check' },
          { key: 'c', verb: 'copy' },
        ],
        legendKeep: ['d', 'r', 'Enter', 'c'],
      },
      { name: 'Detail', content: { kind: 'report', lines: [] }, back: 0 },
      { ...LINE, content: { kind: 'loading', what: 'Reading' } },
    ],
  };
}

describe('a step that says there is nothing, or that it failed, has nothing for Enter', () => {
  it.each([
    { kind: 'empty', what: 'Nothing here.', next: 'Try later.' },
    { kind: 'error', what: 'It failed.', next: 'Try again.' },
  ] as const)('%o: Enter does nothing and is not named; the controls still are', (content) => {
    const frame = withContent(openFrame(checksSpec(), 1), 0, content);
    expect(foldPopupAction(frame, { kind: 'enter' }, 18)).toEqual({ kind: 'unchanged' });
    const parts = popupLegend(frame);
    expect(legend(parts.items, parts.exit)).toBe(
      '[r] quick check · [d] deep check · [c] copy · Esc close',
    );
  });
});

describe('the legend a step keeps longest', () => {
  const rows = withContent(openFrame(checksSpec(), 1), 0, {
    kind: 'list',
    rows: [
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b' },
    ],
  });

  /** The legend row of the frame, as the frame model fits it to `columns`. */
  function legendRow(columns: number): string {
    const geometry = popupGeometry({
      columns,
      rows: 24,
      kind: 'standard',
      placement: 'overlay',
      rail: false,
      bodyRows: 3,
    });
    if (!geometry.fits) throw new Error('fits');
    const box: PopupBoxGeometry = geometry;
    const lines = popupFrameLines(
      {
        title: '/doctor',
        origin: 'home',
        steps: ['Checks'],
        stepIndex: 0,
        legend: popupLegend(rows),
      },
      { lines: [] },
      box,
    );
    return (lines.at(-2)?.text ?? '').trim();
  }

  it('at 80 columns the arrows and the copy go first, and the deep check, the quick check and Enter stay', () => {
    expect(legendRow(80)).toBe('Enter details · [r] quick check · [d] deep check · Esc close');
  });

  it('with room every key is drawn, in the order a person reaches for them', () => {
    expect(legendRow(200)).toBe(
      'Enter details · [r] quick check · [d] deep check · [c] copy · Esc close',
    );
    const parts = popupLegend(rows);
    expect(legend(parts.items, parts.exit)).toBe(
      '↑/↓ select · Enter details · [r] quick check · [d] deep check · [c] copy · Esc close',
    );
  });

  it('the text a popup writes fits the narrowest popup whole: its column is the geometry’s inner width at the floor, and a real line fits it', () => {
    const floor = popupGeometry({
      columns: 80,
      rows: 24,
      kind: 'standard',
      placement: 'overlay',
      rail: true,
      bodyRows: 1,
    });
    if (!floor.fits) throw new Error('fits');
    // The number the geometry itself computes, not a fixture measured against itself.
    expect(floor.innerWidth).toBe(66);
    expect(POPUP_TEXT_COLUMNS).toBe(floor.innerWidth);
    expect(POPUP_NOTICE_MAX_COLUMNS).toBe(floor.innerWidth);
    // A real line the doctor draws, with four origins and an unnamed provider, at its longest: every row of it fits whole.
    const line = consentContent(
      [
        { providerId: 'anthropic', origin: 'https://api.anthropic.com' },
        { providerId: 'openai', origin: 'https://api.openai.com' },
        { providerId: 'gemini', origin: 'https://generativelanguage.googleapis.com' },
        { providerId: 'deepseek', origin: 'https://api.deepseek.com' },
      ],
      ['openai'],
      'home-chat',
    );
    if (line.kind !== 'report') throw new Error('a drawn line is a report');
    expect(line.lines.length).toBeGreaterThan(3);
    for (const text of line.lines)
      expect(displayWidth(text), text).toBeLessThanOrEqual(floor.innerWidth);
  });
});
