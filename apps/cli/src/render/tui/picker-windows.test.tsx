import './force-color.js';

import type { ModelCatalogEntry } from '@relavium/llm';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { withoutStyles } from './harness-util.js';
import { mentionWindow, MentionView } from './mention-view.js';
import type { MentionCandidate, MentionState } from './mention.js';
import { modelWindow, ModelPickerView } from './model-picker-view.js';
import type { ModelPickerState } from './model-picker.js';
import { markedWindow, windowMarkers } from './sheet-frame.js';
import { displayWidth } from './viewport.js';

/**
 * The two lists that draw a window of eight rows, the `/models` picker and the `@` file list, say how many rows the window hides, with the same
 * `▲ N more` / `▼ N more` rows as the palette and the native select ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §3):
 * a list of thirty models used to show `Model 08..15` with nothing to say that twenty-two more lay out of sight. The markers take the window's first and
 * last row, the highlighted row is never under one, the marker counts the row it stands on, and the list is as tall as it was.
 */
afterEach(cleanup);

const WINDOW = 8;

describe('markedWindow', () => {
  it('draws no marker for a list that fits', () => {
    expect(markedWindow(8, 7, WINDOW)).toEqual({ start: 0, end: 8 });
    expect(markedWindow(0, 0, WINDOW)).toEqual({ start: 0, end: 0 });
  });

  it('marks only the side that hides rows, counting the row the marker stands on', () => {
    expect(markedWindow(30, 0, WINDOW)).toEqual({ start: 0, end: 8, below: 23 });
    expect(markedWindow(30, 29, WINDOW)).toEqual({ start: 22, end: 30, above: 23 });
    const middle = markedWindow(30, 15, WINDOW);
    expect(middle.above).toBeGreaterThan(0);
    expect(middle.below).toBeGreaterThan(0);
    // The words of the markers, in the form in force.
    expect(windowMarkers(middle)).toEqual({
      above: `▲ ${String(middle.above)} more`,
      below: `▼ ${String(middle.below)} more`,
    });
    expect(windowMarkers({ start: 0, end: 8 })).toEqual({ above: undefined, below: undefined });
  });

  it('keeps the highlighted row off both marker rows, wherever it is, and the window as tall as it was', () => {
    for (let selected = 0; selected < 30; selected += 1) {
      const { start, end, above, below } = markedWindow(30, selected, WINDOW);
      expect(end - start, `selected ${String(selected)}`).toBe(WINDOW);
      expect(selected, 'inside the window').toBeGreaterThanOrEqual(start);
      expect(selected).toBeLessThan(end);
      if (above !== undefined) expect(selected, 'not under ▲').toBeGreaterThan(start);
      if (below !== undefined) expect(selected, 'not under ▼').toBeLessThan(end - 1);
      expect(above === undefined, `above at ${String(selected)}`).toBe(start === 0);
      if (above !== undefined) expect(above, 'counts the row it stands on').toBe(start + 1);
      if (below !== undefined) expect(below, 'counts the row it stands on').toBe(30 - end + 1);
      expect(below === undefined, `below at ${String(selected)}`).toBe(end === 30);
      // the hidden rows, counted with the row each marker stands on, add up to every row but the six that are drawn
      expect((above ?? 0) + (below ?? 0)).toBe(
        30 - (WINDOW - (above === undefined ? 0 : 1) - (below === undefined ? 0 : 1)),
      );
    }
  });

  it('draws no marker in a window too small to hold a marker, the highlighted row and the other marker', () => {
    expect(markedWindow(10, 5, 2)).toEqual({ start: 5, end: 7 });
    expect(markedWindow(10, 5, 1)).toEqual({ start: 5, end: 6 });
    // Three rows is the least that holds both: a marker, the highlighted row, a marker.
    expect(markedWindow(10, 5, 3)).toEqual({ start: 4, end: 7, above: 5, below: 4 });
  });

  it('puts a selection that is out of range at the end it is past, with that end’s marker only', () => {
    expect(markedWindow(30, 99, WINDOW)).toEqual({ start: 22, end: 30, above: 23 });
    expect(markedWindow(30, -4, WINDOW)).toEqual({ start: 0, end: 8, below: 23 });
  });

  it('names the same windows through the two lists', () => {
    expect(mentionWindow(30, 12)).toEqual(markedWindow(30, 12, WINDOW));
    expect(modelWindow(30, 12)).toEqual(markedWindow(30, 12, WINDOW));
  });
});

/** The marker row's pattern in the form the colour setting asks for (the plain forms are `^` and `v`). */
const markerRow = (up: boolean, color: boolean): RegExp =>
  new RegExp(`${color ? (up ? '▲' : '▼') : up ? '\\^' : 'v'} \\d+ more`, 'u');

const modelOf = (index: number): ModelCatalogEntry => ({
  modelId: `model-${String(index).padStart(2, '0')}`,
  displayName: `Model ${String(index).padStart(2, '0')}`,
  provider: 'anthropic',
  pricingSource: 'catalog',
  priceKnown: true,
  available: true,
  deprecated: false,
});

const PICKER: ModelPickerState = {
  entries: Array.from({ length: 30 }, (_, index) => modelOf(index)),
  filter: '',
  selected: 0,
  loading: false,
  currentDefault: undefined,
  refreshedAt: undefined,
  banner: undefined,
  hint: undefined,
  effortTiers: [],
  phase: 'model',
  effortStep: false,
  pending: undefined,
  effortSelected: 0,
  currentEffort: undefined,
};

function pickerLines(selected: number, color: boolean): string[] {
  const view = render(
    <ModelPickerView state={{ ...PICKER, selected }} color={color} nowMs={0} scope="this-chat" />,
  );
  const frame = withoutStyles(view.lastFrame() ?? '');
  view.unmount();
  return frame.split('\n');
}

describe('the /models picker with thirty models', () => {
  it.each([true, false])(
    'says how many it hides at each end of the window, as tall as before (colour %s)',
    (color) => {
      const top = pickerLines(0, color);
      const middle = pickerLines(15, color);
      const bottom = pickerLines(29, color);
      const rowsOf = (lines: readonly string[]): string[] =>
        lines.filter((line) => /Model \d\d|more$/u.test(line));
      // The same eight rows in every position (a marker takes a row, it does not add one), and the whole picker the same height.
      for (const lines of [top, middle, bottom]) expect(rowsOf(lines)).toHaveLength(WINDOW);
      expect(middle).toHaveLength(top.length);
      expect(bottom).toHaveLength(top.length);
      expect(top.join('\n')).not.toMatch(markerRow(true, color));
      expect(top.join('\n')).toMatch(markerRow(false, color));
      expect(top.join('\n')).toContain('23 more');
      expect(bottom.join('\n')).toMatch(markerRow(true, color));
      expect(bottom.join('\n')).not.toMatch(markerRow(false, color));
      const text = middle.join('\n');
      expect(text).toMatch(markerRow(true, color));
      expect(text).toMatch(markerRow(false, color));
      // The marker is the window's own first or last row, and the highlighted model is never under one.
      expect(rowsOf(top).at(-1), top.join('\n')).toMatch(markerRow(false, color));
      expect(rowsOf(top)[0]).toContain('Model 00');
      expect(rowsOf(bottom)[0], bottom.join('\n')).toMatch(markerRow(true, color));
      expect(rowsOf(bottom).at(-1)).toContain('Model 29');
      expect(rowsOf(middle)[0]).toMatch(markerRow(true, color));
      expect(rowsOf(middle).at(-1)).toMatch(markerRow(false, color));
      // The highlighted row is a model, never a marker.
      expect(
        middle.find((line) => line.includes('Model 15')),
        text,
      ).toBeDefined();
      for (const line of middle) expect(displayWidth(line), line).toBeLessThanOrEqual(80);
    },
  );
});

const candidateOf = (index: number): MentionCandidate => ({
  name: `file-${String(index).padStart(2, '0')}.ts`,
  type: 'file',
  path: `file-${String(index).padStart(2, '0')}.ts`,
});

const MENTION: MentionState = {
  dir: '',
  filter: '',
  candidates: Array.from({ length: 30 }, (_, index) => candidateOf(index)),
  selected: 0,
  loading: false,
};

function mentionLines(selected: number, color: boolean): string[] {
  const view = render(<MentionView state={{ ...MENTION, selected }} color={color} />);
  const frame = withoutStyles(view.lastFrame() ?? '');
  view.unmount();
  return frame.split('\n');
}

describe('the @ file list with thirty files', () => {
  it.each([true, false])(
    'says how many it hides at each end of the window, as tall as before (colour %s)',
    (color) => {
      const top = mentionLines(0, color);
      const middle = mentionLines(15, color);
      const bottom = mentionLines(29, color);
      const rowsOf = (lines: readonly string[]): string[] =>
        lines.filter((line) => /file-\d\d|more$/u.test(line));
      for (const lines of [top, middle, bottom]) expect(rowsOf(lines)).toHaveLength(WINDOW);
      expect(middle).toHaveLength(top.length);
      expect(top.join('\n')).not.toMatch(markerRow(true, color));
      expect(top.join('\n')).toMatch(markerRow(false, color));
      expect(bottom.join('\n')).toMatch(markerRow(true, color));
      expect(bottom.join('\n')).not.toMatch(markerRow(false, color));
      expect(middle.join('\n')).toMatch(markerRow(true, color));
      expect(middle.join('\n')).toMatch(markerRow(false, color));
      expect(middle.find((line) => line.includes('file-15.ts'))).toBeDefined();
      // The marker is the window's own first or last row, and the highlighted file is never under one.
      expect(rowsOf(top).at(-1), top.join('\n')).toMatch(markerRow(false, color));
      expect(rowsOf(top)[0]).toContain('file-00.ts');
      expect(rowsOf(bottom)[0], bottom.join('\n')).toMatch(markerRow(true, color));
      expect(rowsOf(bottom).at(-1)).toContain('file-29.ts');
      expect(rowsOf(middle)[0]).toMatch(markerRow(true, color));
      expect(rowsOf(middle).at(-1)).toMatch(markerRow(false, color));
    },
  );

  it('draws a list that fits without a marker', () => {
    const view = render(
      <MentionView state={{ ...MENTION, candidates: MENTION.candidates.slice(0, 8) }} color />,
    );
    const text = withoutStyles(view.lastFrame() ?? '');
    view.unmount();
    expect(text).not.toMatch(/more/u);
  });
});

describe('the marker rows', () => {
  const DIM = '\u001b[2m';

  it('are dim, like the palette’s and the native select’s, in both lists', () => {
    const models = render(
      <ModelPickerView state={{ ...PICKER, selected: 15 }} color nowMs={0} scope="this-chat" />,
    );
    const files = render(<MentionView state={{ ...MENTION, selected: 15 }} color />);
    for (const view of [models, files]) {
      const lines = (view.lastFrame() ?? '').split('\n').filter((line) => /more/u.test(line));
      view.unmount();
      expect(lines, 'a marker above and a marker below').toHaveLength(2);
      for (const line of lines) expect(line, JSON.stringify(line)).toContain(DIM);
    }
  });
});
