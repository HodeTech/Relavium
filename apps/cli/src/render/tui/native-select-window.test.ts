import { describe, expect, it } from 'vitest';
import type { NativePromptSnapshot } from './native-prompt-channel.js';
import {
  selectLayout,
  selectLegend,
  selectPageRows,
  selectRowText,
  type SelectLine,
} from './native-select-window.js';

/** A select card as the channel publishes it: `count` workflows the way the run picker lists them (a slug, and its file as the hint). */
function card(
  count: number,
  over: Partial<NativePromptSnapshot> & { readonly hint?: (index: number) => string } = {},
): NativePromptSnapshot {
  const { hint, ...rest } = over;
  return {
    active: true,
    kind: 'select',
    message: 'Run which workflow?',
    note: '',
    options: Array.from({ length: count }, (_, index) => ({
      value: String(index),
      label: `wf-${String(index).padStart(2, '0')}`,
      hint: hint?.(index) ?? `.relavium/workflows/wf-${String(index).padStart(2, '0')}.yaml`,
    })),
    selected: 0,
    display: '',
    error: '',
    escape: 'cancel',
    details: [],
    ...rest,
  };
}

const SIZE_80x24 = { cols: 80, rows: 24 };
const optionsOf = (lines: readonly SelectLine[]): number[] =>
  lines.flatMap((line) => (line.kind === 'option' ? [line.index] : []));
const markersOf = (lines: readonly SelectLine[]): string[] =>
  lines.flatMap((line) => (line.kind === 'marker' ? [line.text] : []));

describe('selectLayout: a select card the terminal cannot hold whole', () => {
  it('draws a short list whole: no layout at all, so the card is what it always was', () => {
    for (const count of [1, 3, 10]) {
      expect(selectLayout(card(count), SIZE_80x24), `${String(count)} workflows`).toBeUndefined();
    }
    expect(selectPageRows(card(3), SIZE_80x24)).toBeUndefined();
  });

  it('draws only the window of a 60-workflow list that fits 80x24: the question, the rows and the legend are 23 rows', () => {
    const layout = selectLayout(card(60), SIZE_80x24);
    expect(layout).toBeDefined();
    // 24 rows, one the card never uses, the question and the legend: 21 lines for the list, one of them the `▼` marker.
    expect(layout?.lines).toHaveLength(21);
    expect(optionsOf(layout?.lines ?? [])).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(markersOf(layout?.lines ?? [])).toEqual(['▼ 40 more']);
    expect(layout?.lines.at(-1)).toMatchObject({ kind: 'marker', position: 'below' });
    expect(layout?.lines[0]).toEqual({ kind: 'option', index: 0 });
  });

  it('puts the `▲` marker above the last row when the cursor is on it, and no `▼` marker', () => {
    const layout = selectLayout(card(60, { selected: 59 }), SIZE_80x24);
    expect(layout?.lines[0]).toMatchObject({ kind: 'marker', position: 'above' });
    expect(markersOf(layout?.lines ?? [])).toEqual(['▲ 40 more']);
    expect(optionsOf(layout?.lines ?? []).at(-1)).toBe(59);
  });

  it('keeps the cursor on a drawn option row, and every row counted exactly once, wherever the cursor is', () => {
    for (const size of [SIZE_80x24, { cols: 100, rows: 30 }, { cols: 120, rows: 50 }]) {
      for (let selected = 0; selected < 60; selected += 1) {
        const layout = selectLayout(card(60, { selected }), size);
        const lines = layout?.lines ?? [];
        expect(
          optionsOf(lines),
          `cursor ${String(selected)} at ${String(size.rows)} rows`,
        ).toContain(selected);
        // One line per terminal row, never more than the room the card leaves.
        expect(lines.length).toBeLessThanOrEqual(size.rows - 3);
        // Rows are drawn once, in order, and the markers count what is not drawn.
        const shown = optionsOf(lines);
        expect(shown).toEqual([...shown].sort((a, b) => a - b));
        const hidden = markersOf(lines).reduce(
          (sum, text) => sum + Number(/\d+/.exec(text)?.[0]),
          0,
        );
        expect(shown.length + hidden).toBe(60);
        // A marker stands only where rows are hidden, and the first and last drawn lines are the only places for one.
        const first = lines[0];
        const last = lines.at(-1);
        expect(first?.kind === 'marker').toBe((shown[0] ?? 0) > 0);
        expect(last?.kind === 'marker').toBe((shown.at(-1) ?? 59) < 59);
      }
    }
  });

  it('counts a wrapped row as the rows it takes, and cuts the windowed rows to one terminal row each', () => {
    // 80 columns: `❯ wf-00 — ` and a 104-character file name (words, so it wraps at a space) is two rows an option: 10 options are 20 rows
    // and the question and the legend 2 more, and 11 do not fit.
    const long = (): string => 'ab '.repeat(35).trimEnd();
    expect(selectLayout(card(10, { hint: long }), SIZE_80x24)).toBeUndefined();
    const layout = selectLayout(card(11, { hint: long }), SIZE_80x24);
    // Windowed, and the whole list is then 11 single rows: they all fit, so there is no marker.
    expect(layout).toBeDefined();
    expect(optionsOf(layout?.lines ?? [])).toHaveLength(11);
    expect(markersOf(layout?.lines ?? [])).toEqual([]);
  });

  it('gives the window the rows a longer question and a note leave, and no more', () => {
    const plain = selectLayout(card(60), SIZE_80x24);
    const noted = selectLayout(card(60, { note: 'n'.repeat(160) }), SIZE_80x24);
    // The note is two rows at 80 columns.
    expect(noted?.lines.length).toBe((plain?.lines.length ?? 0) - 2);
  });

  it('shows the cursor row alone, with no marker, when the question leaves room for one or two rows', () => {
    // 23 rows to use: 1 legend, so a 21-row question leaves 1 and a 20-row one leaves 2.
    const one = selectLayout(card(60, { selected: 7, message: 'q'.repeat(80 * 21) }), SIZE_80x24);
    expect(one?.lines).toEqual([{ kind: 'option', index: 7 }]);
    const two = selectLayout(card(60, { selected: 7, message: 'q'.repeat(80 * 20) }), SIZE_80x24);
    expect(two?.lines).toHaveLength(2);
    expect(optionsOf(two?.lines ?? [])).toContain(7);
    expect(markersOf(two?.lines ?? [])).toEqual([]);
    expect(one?.page).toBe(1);
  });

  it('is undefined (the card is drawn whole, and refused) only when not even one row fits the question and the legend', () => {
    expect(
      selectLayout(card(60, { message: 'q'.repeat(80 * 22) }), SIZE_80x24),
      'a question of 22 rows leaves no row',
    ).toBeUndefined();
    expect(
      selectLayout(card(60, { message: 'Disclosure ' + 's'.repeat(4000) }), SIZE_80x24),
    ).toBeUndefined();
  });

  it('leaves a terminal below the minimum to the view: its own message says what to do', () => {
    expect(selectLayout(card(60), { cols: 80, rows: 10 })).toBeUndefined();
    expect(selectLayout(card(60), { cols: 79, rows: 24 })).toBeUndefined();
    expect(selectLayout(card(60), { cols: Number.NaN, rows: 24 })).toBeUndefined();
  });

  it('is a select-only layout', () => {
    for (const kind of ['text', 'password', 'busy', 'picker', 'chord', 'idle'] as const) {
      expect(selectLayout(card(60, { kind }), SIZE_80x24), kind).toBeUndefined();
    }
    expect(selectLayout(card(0), SIZE_80x24)).toBeUndefined();
  });

  it('pages by the rows a window that hides both sides draws, and a page then back lands on the row it left', () => {
    expect(selectPageRows(card(60), SIZE_80x24)).toBe(19);
    expect(selectPageRows(card(60), { cols: 120, rows: 50 })).toBe(45);
    const down = 19;
    const from = selectLayout(card(60, { selected: 0 }), SIZE_80x24);
    const to = selectLayout(card(60, { selected: down }), SIZE_80x24);
    // The window after the page still draws every row between the two cursors that the first one drew.
    const kept = optionsOf(from?.lines ?? []).filter((index) =>
      optionsOf(to?.lines ?? []).includes(index),
    );
    expect(kept.length).toBeGreaterThan(0);
    expect(optionsOf(to?.lines ?? [])).toContain(down);
  });
});

describe('the rows and the legend of a select card', () => {
  it('draws the cursor, or the gutter under it, then the label and its hint', () => {
    const snapshot = card(3, { selected: 1 });
    expect(selectRowText(snapshot, 0)).toBe('  wf-00 — .relavium/workflows/wf-00.yaml');
    expect(selectRowText(snapshot, 1)).toBe('› wf-01 — .relavium/workflows/wf-01.yaml');
    expect(selectRowText(snapshot, 9)).toBe('');
    const bare = card(1, { options: [{ value: 'yes', label: 'Yes' }] });
    expect(selectRowText(bare, 0)).toBe('› Yes');
  });

  it('says what the keys do, and adds the page keys only to a windowed list', () => {
    expect(selectLegend(false, false)).toBe('↑/↓ select · Enter choose · Esc close');
    expect(selectLegend(true, false)).toBe('↑/↓ select · Enter choose · Esc back · [Ctrl+C] close');
    expect(selectLegend(false, true)).toBe(
      '↑/↓ select · PgUp/PgDn page · Enter choose · Esc close',
    );
    expect(selectLegend(true, true)).toBe(
      '↑/↓ select · PgUp/PgDn page · Enter choose · Esc back · [Ctrl+C] close',
    );
  });
});
