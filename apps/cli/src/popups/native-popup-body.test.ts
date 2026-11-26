/**
 * The native prompt channel as a popup body (`native-popup-body.ts`; ADR-0148 §1, §3, §4, §5): every framed kind's rows, the wrapped rows and
 * the window counted in them, the whole-prompt-or-no-answer rule at the budget's edge, the legend of each kind, and hostile text in every sink.
 * Pure: the layout is read directly, and the frame through the slot's own `nativePopupFrameLines`.
 */
import { describe, expect, it } from 'vitest';

import { withGlyphForm } from '../render/tui/glyphs.js';
import { legend } from '../render/tui/legend.js';
import type { NativePromptSnapshot } from '../render/tui/native-prompt-channel.js';
import { displayWidth } from '../render/tui/viewport.js';
import { selectLegend } from '../render/tui/native-select-window.js';
import { fittedLegendItems, popupNoticeText, wrapRows } from './frame-model.js';
import { INLINE_LIST_MAX_ROWS, popupInnerWidth } from './geometry.js';
import {
  livePin,
  NATIVE_LIST_MIN_ROWS,
  NATIVE_PICKER_EMPTY,
  NATIVE_PICKER_LOADING,
  NATIVE_PICKER_NONE_HERE,
  nativeFramed,
  nativeNaturalRows,
  nativeOptionWindow,
  nativePopupLayout,
  nativeLegendParts,
  nativePopupLegend,
  nativePopupNoticeKeys,
  nativeRailDone,
  nativeWindowPage,
  nextPin,
  pickerEmptyText,
  withLiveBullets,
  type NativeBodyGeometry,
  type NativePopupPin,
} from './native-popup-body.js';
import { createNativePicker, type NativePickerSnapshot } from '../render/tui/native-picker.js';
import {
  nativeNoticeReason,
  nativePopupFrameLines,
  nativePopupGeometry,
  nativePopupPinAfter,
} from './popup-slot.js';

/** The inner width of a standard popup at the floor (80 columns): 66. */
const WIDTH = popupInnerWidth(80, 'standard');
const PAGE: NativeBodyGeometry = { bodyRows: 17, listRows: 17, innerWidth: WIDTH };
const UNBOUNDED: NativeBodyGeometry = {
  bodyRows: Number.POSITIVE_INFINITY,
  listRows: Number.POSITIVE_INFINITY,
  innerWidth: WIDTH,
};

const BASE: NativePromptSnapshot = {
  active: true,
  kind: 'select',
  message: 'Which provider?',
  note: '',
  options: [
    {
      value: 'anthropic',
      label: 'Anthropic',
      hint: 'Official endpoint: https://api.anthropic.com',
    },
    { value: 'openai', label: 'OpenAI', hint: 'Official endpoint: https://api.openai.com' },
  ],
  selected: 0,
  display: '',
  error: '',
  escape: 'cancel',
  details: [],
  popup: {
    title: '/providers',
    origin: 'home',
    stepIndex: 0,
    stepCount: 3,
    stepNames: ['Provider', 'Key', 'Done'],
    exitLabel: 'close',
    depth: 1,
  },
};

const GEMINI = {
  value: 'gemini',
  label: 'Google Gemini',
  hint: 'Official endpoint: https://generativelanguage.googleapis.com',
} as const;

const KEY_STEP_NOTE =
  'Stored in your OS keychain, never on disk. Sent only to api.anthropic.com, once, to check it.';

/** The layout in the plain glyph form (colour off), as the slot draws it there. */
const plain = (snapshot: NativePromptSnapshot, page: NativeBodyGeometry = PAGE) =>
  withGlyphForm(true, () => nativePopupLayout(snapshot, page));
const texts = (snapshot: NativePromptSnapshot, page: NativeBodyGeometry = PAGE): string[] =>
  plain(snapshot, page).lines.map((line) => line.text);
const legendText = (snapshot: NativePromptSnapshot, windowed = false): string => {
  const parts = nativePopupLegend(snapshot, windowed);
  return legend(parts.items, parts.exit);
};

const options = (count: number): NativePromptSnapshot['options'] =>
  Array.from({ length: count }, (_, index) => ({
    value: `v${String(index)}`,
    label: `Option ${String(index)}`,
  }));

describe('which prompts a popup frame draws', () => {
  it.each(['select', 'text', 'password', 'busy', 'chord', 'picker'] as const)(
    'a %s with a descriptor is framed; without one, or with no flow open, it is not',
    (kind) => {
      expect(nativeFramed({ ...BASE, kind })).toBe(true);
      const { popup, ...card } = BASE;
      void popup;
      expect(nativeFramed({ ...card, kind })).toBe(false);
      expect(nativeFramed({ ...BASE, kind, active: false })).toBe(false);
    },
  );

  it('the idle snapshot is never framed', () => {
    expect(nativeFramed({ ...BASE, kind: 'idle' })).toBe(false);
  });
});

describe('a select', () => {
  it('draws its note dim, its message, its details, its options (the highlighted one selected) and its error, in that order', () => {
    const snapshot: NativePromptSnapshot = {
      ...BASE,
      note: 'First run',
      details: ['line one', 'line two'],
      selected: 1,
      error: 'Pick again.',
    };
    const lines = plain(snapshot).lines;
    expect(lines.map((line) => line.kind)).toEqual([
      'text',
      'message',
      'row',
      'row',
      'row',
      'selected',
      'failed',
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      'First run',
      'Which provider?',
      'line one',
      'line two',
      '  Anthropic  Official endpoint: https://api.anthropic.com',
      '> OpenAI  Official endpoint: https://api.openai.com',
      'Pick again.',
    ]);
  });

  it('wraps an option’s hint instead of cutting it: the Gemini endpoint (77 columns) is whole in a 66-column body, its later row under the label', () => {
    expect(displayWidth(`› ${GEMINI.label}  ${GEMINI.hint}`)).toBeGreaterThan(WIDTH);
    const snapshot: NativePromptSnapshot = { ...BASE, options: [GEMINI], selected: 0 };
    const rows = texts(snapshot).slice(1);
    expect(rows).toEqual([
      '> Google Gemini  Official endpoint:',
      '  https://generativelanguage.googleapis.com',
    ]);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(WIDTH);
    expect(
      plain(snapshot)
        .lines.slice(1)
        .every((line) => line.kind === 'selected'),
    ).toBe(true);
  });

  it('wraps the key step’s two sentences whole (the destination disclosure is never cut)', () => {
    const snapshot: NativePromptSnapshot = {
      ...BASE,
      kind: 'password',
      note: KEY_STEP_NOTE,
      message: 'Paste your Anthropic API key',
      options: [],
    };
    const rows = texts(snapshot);
    expect(rows.length).toBe(4);
    expect(rows.slice(0, 2).join(' ')).toBe(KEY_STEP_NOTE);
    expect(rows[3]).toBe('> ');
  });

  it('asks the geometry for every wrapped row it has (`nativeNaturalRows` is the wrapped count)', () => {
    const snapshot: NativePromptSnapshot = {
      ...BASE,
      note: KEY_STEP_NOTE,
      options: [GEMINI, ...BASE.options],
    };
    expect(nativeNaturalRows(snapshot, WIDTH)).toBe(2 + 1 + 2 + 1 + 1);
    expect(nativeNaturalRows(snapshot, WIDTH)).toBe(plain(snapshot, UNBOUNDED).lines.length);
  });

  it('a long list is drawn in a window with `▲/▼ N more`, the highlighted option always in it, and pages by the window', () => {
    const snapshot: NativePromptSnapshot = { ...BASE, options: options(30), selected: 15 };
    const page: NativeBodyGeometry = { bodyRows: 11, listRows: 10, innerWidth: WIDTH };
    const layout = plain(snapshot, page);
    expect(layout.fits).toBe(true);
    const list = layout.lines.slice(1).map((line) => line.text);
    expect(list.length).toBeLessThanOrEqual(10);
    expect(list[0]).toMatch(/^ {2}\^ \d+ more$/u);
    expect(list.at(-1)).toMatch(/^ {2}v \d+ more$/u);
    expect(list).toContain('> Option 15');
    const above = Number(/(\d+)/u.exec(list[0] ?? '')?.[1]);
    const below = Number(/(\d+)/u.exec(list.at(-1) ?? '')?.[1]);
    expect(above + below + (list.length - 2)).toBe(30);
    expect(layout.page).toBeGreaterThanOrEqual(1);
    expect(legendText(snapshot, layout.page !== undefined)).toBe(
      '↑/↓ select · PgUp/PgDn page · Enter choose · Esc close',
    );
  });

  it('a list drawn whole names no paging and has no page', () => {
    const layout = plain({ ...BASE, options: options(5) });
    expect(layout.page).toBeUndefined();
    expect(legendText(BASE)).toBe('↑/↓ select · Enter choose · Esc close');
  });

  it('inline a list is windowed to ten rows or fewer', () => {
    const page: NativeBodyGeometry = {
      bodyRows: 17,
      listRows: INLINE_LIST_MAX_ROWS,
      innerWidth: WIDTH,
    };
    const layout = plain({ ...BASE, options: options(12), selected: 11 }, page);
    expect(layout.lines.length - 1).toBeLessThanOrEqual(INLINE_LIST_MAX_ROWS);
    expect(layout.lines.map((line) => line.text)).toContain('> Option 11');
  });

  it('the budget edge: the rows above plus the least window fit exactly ⇒ on its page; one row fewer ⇒ not wholly on the page', () => {
    const snapshot: NativePromptSnapshot = {
      ...BASE,
      note: 'note',
      options: options(20),
      error: 'error',
    };
    const fixed = 3; // note, message, error
    const exact: NativeBodyGeometry = {
      bodyRows: fixed + NATIVE_LIST_MIN_ROWS,
      listRows: 17,
      innerWidth: WIDTH,
    };
    expect(plain(snapshot, exact).fits).toBe(true);
    expect(plain(snapshot, exact).lines.length).toBeLessThanOrEqual(exact.bodyRows);
    expect(plain(snapshot, { ...exact, bodyRows: exact.bodyRows - 1 }).fits).toBe(false);
    expect(plain(snapshot, { ...exact, bodyRows: exact.bodyRows - 1 }).lines).toEqual([]);
  });

  it('the least window holds the tallest option whole with both markers, wherever the highlight is', () => {
    const tall = { value: 't', label: 'x '.repeat(60).trim() }; // three rows at 64 columns
    const snapshot: NativePromptSnapshot = {
      ...BASE,
      message: '',
      options: [...options(8), tall, ...options(8)],
    };
    const rowsOfTall = plain({ ...snapshot }, UNBOUNDED).lines.filter((line) =>
      line.text.includes('x x'),
    ).length;
    expect(rowsOfTall).toBe(2);
    const least = Math.max(NATIVE_LIST_MIN_ROWS, rowsOfTall + 2);
    for (let selected = 0; selected < snapshot.options.length; selected += 1) {
      const page: NativeBodyGeometry = { bodyRows: least, listRows: 17, innerWidth: WIDTH };
      expect(plain({ ...snapshot, selected }, page).fits, String(selected)).toBe(true);
      expect(plain({ ...snapshot, selected }, { ...page, bodyRows: least - 1 }).fits).toBe(false);
    }
  });

  it('a flow’s persistent last step: its sentence led by its mark, its target and lines, its one option `Close`, and `Enter / Esc close`', () => {
    const done: NativePromptSnapshot = {
      ...BASE,
      message: 'Created the project directories.',
      details: ['.relavium', '.relavium/workflows', '.relavium/agents'],
      options: [{ value: 'done', label: 'Close' }],
      final: 'ok',
    };
    expect(texts(done)).toEqual([
      'ok Created the project directories.',
      '.relavium',
      '.relavium/workflows',
      '.relavium/agents',
      '> Close',
    ]);
    expect(legendText(done)).toBe('Enter / Esc close');
    expect(legendText({ ...done, popup: { ...BASE.popup!, exitLabel: 'skip for now' } })).toBe(
      'Enter / Esc close',
    );
  });
});

describe('the Done step is one shape: a mark AND a word in both tones (ADR-0148 §6, ADR-0145 §5)', () => {
  const done = (final: 'ok' | 'failed'): NativePromptSnapshot => ({
    ...BASE,
    message: final === 'ok' ? 'Exported workflow deploy' : 'Not exported.',
    details:
      final === 'ok'
        ? ['.relavium/workflows/deploy.relavium.yaml', 'Canonical YAML.']
        : ['The folder is read-only.'],
    options: [{ value: 'done', label: 'Close' }],
    escape: 'back',
    final,
  });
  const frame = (snapshot: NativePromptSnapshot, color: boolean): string[] => {
    const { geometry, layout } = nativePopupGeometry(
      snapshot,
      'overlay',
      { cols: 80, rows: 24 },
      color,
    );
    if (!geometry.fits || layout === undefined) throw new Error('refused');
    return nativePopupFrameLines(snapshot, geometry, layout, color).map((line) => line.text);
  };

  it.each([
    ['ok', true, '✓ Exported workflow deploy'],
    ['ok', false, 'ok Exported workflow deploy'],
    ['failed', true, '✗ Not exported.'],
    ['failed', false, 'x Not exported.'],
  ] as const)(
    'the %s tone, colour %s, at 80x24: the sentence leads with `%s`, its one option is `Close`, the legend says `Enter / Esc close`',
    (final, color, lead) => {
      const rows = frame(done(final), color).map((row) => row.trimEnd());
      expect(
        rows.some((row) => row.trim() === lead),
        rows.join('\n'),
      ).toBe(true);
      expect(rows.some((row) => row.trim() === `${color ? '›' : '>'} Close`)).toBe(true);
      expect(rows.some((row) => row.trim() === 'Enter / Esc close')).toBe(true);
      for (const row of rows) expect(displayWidth(row.padEnd(68))).toBe(68);
    },
  );

  it('R2-7 the sentence is a `done` line in the ok tone and a `failed` line in the failed tone (the colour roles), and a question stays a `message`', () => {
    const kindOf = (snapshot: NativePromptSnapshot): string | undefined =>
      withGlyphForm(true, () => nativePopupLayout(snapshot, PAGE).lines[0]?.kind);
    expect(kindOf(done('ok'))).toBe('done');
    expect(kindOf(done('failed'))).toBe('failed');
    const { final, ...question } = done('ok');
    void final;
    expect(kindOf(question)).toBe('message');
  });

  it('the target is drawn once under the sentence; the option carries no hint', () => {
    const rows = frame(done('ok'), false).map((row) => row.trim());
    expect(rows.filter((row) => row.includes('deploy.relavium.yaml'))).toHaveLength(1);
    expect(rows.indexOf('.relavium/workflows/deploy.relavium.yaml')).toBe(
      rows.indexOf('ok Exported workflow deploy') + 1,
    );
  });

  it('the mark is the product’s, never the text’s: a `✓`, a CSI and a forged mark in the sentence do not draw a second one', () => {
    const rows = withGlyphForm(true, () =>
      nativePopupLayout(
        { ...done('ok'), message: '\u001b[31m✓ Done\u001b[0m ✗ forged' },
        PAGE,
      ).lines.map((line) => line.text),
    );
    // The text's own `✓` and `✗` are blanked (host glyphs); the one mark is the step's.
    expect(rows[0]?.replace(/\s+/gu, ' ')).toBe('ok Done forged');
    expect(rows[0]?.match(/ok/gu)).toHaveLength(1);
  });

  it('a prompt that is not a flow’s last step carries no mark: its question is drawn as it is', () => {
    expect(texts({ ...BASE, message: 'Which provider?' })[0]).toBe('Which provider?');
  });
});

describe('the option window (pure)', () => {
  /** A small deterministic generator, so the property runs the same cases every time. */
  function* cases(): Generator<{ heights: number[]; selected: number; budget: number }> {
    let seed = 7;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    for (let run = 0; run < 4000; run += 1) {
      const count = 1 + next(14);
      const heights = Array.from({ length: count }, () => 1 + next(3));
      yield { heights, selected: next(count), budget: 1 + next(18) };
    }
  }

  it('holds the highlighted option, never more rows than the budget, every option when they all fit, and refuses only when its option and markers cannot fit', () => {
    for (const { heights, selected, budget } of cases()) {
      const window = nativeOptionWindow(heights, selected, budget);
      const sum = heights.reduce((total, height) => total + height, 0);
      if (sum <= budget) {
        expect(window).toEqual({ start: 0, end: heights.length });
        continue;
      }
      const own =
        (heights[selected] ?? 0) + (selected > 0 ? 1 : 0) + (selected < heights.length - 1 ? 1 : 0);
      if (window === undefined) {
        expect(own).toBeGreaterThan(budget);
        continue;
      }
      expect(window.start).toBeLessThanOrEqual(selected);
      expect(window.end).toBeGreaterThan(selected);
      let rows = (window.start > 0 ? 1 : 0) + (window.end < heights.length ? 1 : 0);
      for (let index = window.start; index < window.end; index += 1) rows += heights[index] ?? 0;
      expect(rows).toBeLessThanOrEqual(budget);
    }
  });

  it('a page never moves the cursor past an option that was not drawn, either way', () => {
    for (const { heights, selected, budget } of cases()) {
      const window = nativeOptionWindow(heights, selected, budget);
      if (window === undefined) continue;
      const page = nativeWindowPage(window, selected, heights.length);
      if (page === undefined) {
        expect(window).toEqual({ start: 0, end: heights.length });
        continue;
      }
      expect(page).toBeGreaterThanOrEqual(1);
      for (const to of [
        Math.max(0, selected - page),
        Math.min(heights.length - 1, selected + page),
      ]) {
        // every option strictly between the old cursor and the new one was drawn, and the new one is drawn or the next after the window
        const low = Math.min(selected, to);
        const high = Math.max(selected, to);
        for (let passed = low + 1; passed < high; passed += 1) {
          expect(
            passed >= window.start && passed < window.end,
            `${String(passed)} of ${JSON.stringify(window)}`,
          ).toBe(true);
        }
        expect(
          to >= window.start - 1 && to <= window.end,
          `${String(to)} of ${JSON.stringify(window)}`,
        ).toBe(true);
      }
    }
  });
});

describe('a field, a wait and the picker', () => {
  it('a masked field draws the channel’s display (bullets), never more; a long text field shows its end', () => {
    expect(
      texts({ ...BASE, kind: 'password', message: 'Key', options: [], display: '••••' }),
    ).toEqual(['Key', '> ••••']);
    const long = 'p'.repeat(40) + 'END';
    const rows = texts({
      ...BASE,
      kind: 'text',
      message: 'Path',
      options: [],
      display: 'x'.repeat(100) + long,
    });
    expect(rows[1]?.endsWith('END')).toBe(true);
    expect(rows[1]?.startsWith('> …')).toBe(true);
    expect(displayWidth(rows[1] ?? '')).toBeLessThanOrEqual(WIDTH);
  });

  it('a field whose rows do not all fit is not on its page', () => {
    const snapshot: NativePromptSnapshot = {
      ...BASE,
      kind: 'password',
      note: KEY_STEP_NOTE,
      message: 'Key',
      options: [],
      error: 'Resized · key cleared, paste it again',
    };
    const rows = plain(snapshot, UNBOUNDED).lines.length;
    expect(plain(snapshot, { ...PAGE, bodyRows: rows }).fits).toBe(true);
    expect(plain(snapshot, { ...PAGE, bodyRows: rows - 1 }).fits).toBe(false);
  });

  it('a wait draws its note and its message, static', () => {
    expect(
      texts({
        ...BASE,
        kind: 'busy',
        options: [],
        message: 'Checking your Anthropic key · one request to api.anthropic.com',
      }),
    ).toEqual(['Checking your Anthropic key · one request to api.anthropic.com']);
    expect(legendText({ ...BASE, kind: 'busy' })).toBe('Esc cancels it');
  });

  const PICKER: NativePromptSnapshot = {
    ...BASE,
    kind: 'picker',
    message: 'Resume a session',
    options: [
      { value: 's1', label: 'Fix the flaky test', hint: '2 days ago · 14 messages' },
      { value: 's2', label: 'Plan the release' },
    ],
    display: 'fix',
    picker: {
      allDirectories: false,
      page: 1,
      cursor: 3,
      loading: false,
      hasNext: false,
      hasPrevious: false,
      retryable: false,
    },
  };

  it('the picker: its question, scope and page, filter line with the caret where the cursor is, rows with hints dim under them', () => {
    const lines = plain(PICKER).lines;
    expect(lines.map((line) => line.text)).toEqual([
      'Resume a session',
      'This directory · Page 1',
      'Filter: fix_',
      '> Fix the flaky test',
      '  2 days ago · 14 messages',
      '  Plan the release',
    ]);
    expect(lines.map((line) => line.kind)).toEqual([
      'message',
      'text',
      'row',
      'selected',
      'text',
      'row',
    ]);
    expect(texts({ ...PICKER, picker: { ...PICKER.picker!, cursor: 1 } })[2]).toBe('Filter: f_ix');
    expect(legendText(PICKER)).toBe(
      '↑/↓ select · Enter resume · Tab all directories · PgUp/PgDn page · Esc close',
    );
  });

  it('the picker’s loading, empty and failed states', () => {
    expect(
      texts({ ...PICKER, options: [], picker: { ...PICKER.picker!, loading: true } }),
    ).toContain(NATIVE_PICKER_LOADING);
    expect(texts({ ...PICKER, options: [] })).toContain(NATIVE_PICKER_EMPTY);
    const failed = texts({
      ...PICKER,
      options: [],
      error: 'Session history could not be read · Enter retry · Esc close',
    });
    expect(failed).toContain('Session history could not be read · Enter retry · Esc close');
    expect(failed).not.toContain(NATIVE_PICKER_EMPTY);
    expect(
      legendText({
        ...PICKER,
        options: [],
        error: 'x',
        picker: { ...PICKER.picker!, retryable: true },
      }),
    ).toBe('Enter retry · Esc close');
  });

  it('OB-7: a picker with no row, through the real picker: this directory says where the others are, a filter or all directories says nothing matches, and no `Enter resume` is named where nothing can be resumed', async () => {
    const abort = new AbortController();
    let rows: NativePromptSnapshot['options'] = [];
    let state: NativePickerSnapshot | undefined;
    const controller = createNativePicker({
      message: 'Resume a session',
      load: () => Promise.resolve({ options: rows }),
      signal: abort.signal,
      onChoose: () => undefined,
      onFailure: () => undefined,
      onChange: (next) => {
        state = next;
      },
    });
    /** The real picker's state, framed as the `/resume` flow frames it. */
    const framed = (): NativePromptSnapshot => {
      if (state === undefined) throw new Error('no picker state');
      return {
        ...PICKER,
        picker: state,
        options: state.options,
        selected: state.selected,
        display: state.display,
        error: state.error,
      };
    };
    /** The legend row as the frame fits it at 80 columns. */
    const row = (): string => {
      const parts = nativePopupLegend(framed());
      return legend(fittedLegendItems(parts, WIDTH), parts.exit);
    };
    try {
      controller.start();
      await controller.whenSettled();
      // This directory, nothing typed, no session: where the others are, and no `Enter resume`.
      expect(state?.allDirectories).toBe(false);
      expect(texts(framed())).toContain(NATIVE_PICKER_NONE_HERE);
      expect(NATIVE_PICKER_NONE_HERE).toBe('No sessions in this directory · Tab shows all');
      expect(texts(framed())).not.toContain(NATIVE_PICKER_EMPTY);
      expect(row()).toBe('↑/↓ select · Tab all directories · PgUp/PgDn page · Esc close');
      // A filter typed: nothing matches it.
      controller.input('z', {});
      await controller.whenSettled();
      expect(state?.display).toBe('z');
      expect(texts(framed())).toContain(NATIVE_PICKER_EMPTY);
      expect(texts(framed())).not.toContain(NATIVE_PICKER_NONE_HERE);
      expect(row()).not.toContain('Enter resume');
      // The filter cleared, and `Tab` to all directories: nothing anywhere matches, and it says so.
      controller.input('', { backspace: true });
      controller.input('', { tab: true });
      await controller.whenSettled();
      expect(state?.display).toBe('');
      expect(state?.allDirectories).toBe(true);
      expect(texts(framed())).toContain(NATIVE_PICKER_EMPTY);
      expect(texts(framed())).not.toContain(NATIVE_PICKER_NONE_HERE);
      expect(row()).toBe('↑/↓ select · Tab this directory · PgUp/PgDn page · Esc close');
      // With a session to resume, `Enter resume` is named again (and the 66 columns drop `PgUp/PgDn page` first, as they always did).
      rows = [{ value: 's1', label: 'Fix the flaky test' }];
      controller.input('', { tab: true });
      await controller.whenSettled();
      expect(state?.options).toHaveLength(1);
      expect(row()).toBe('↑/↓ select · Enter resume · Tab all directories · Esc close');
    } finally {
      controller.dispose();
      abort.abort();
    }
  });

  it('OB-7: the card draws the same words with the same rule (one legend for both surfaces)', () => {
    const empty: NativePromptSnapshot = { ...PICKER, options: [], display: '' };
    expect(pickerEmptyText(empty)).toBe(NATIVE_PICKER_NONE_HERE);
    expect(pickerEmptyText({ ...empty, display: 'fix' })).toBe(NATIVE_PICKER_EMPTY);
    expect(pickerEmptyText({ ...empty, picker: { ...empty.picker!, allDirectories: true } })).toBe(
      NATIVE_PICKER_EMPTY,
    );
    const card = nativeLegendParts(empty, false, 'card');
    expect(legend(card.items, card.exit)).toBe(
      '↑/↓ select · Tab all directories · PgUp/PgDn page · Esc close',
    );
    // While a page loads the picker ignores `Enter`, so the key is not named, with or without the rows of the page it replaces.
    const loading = { ...empty, picker: { ...empty.picker!, loading: true } };
    expect(legendText(loading)).not.toContain('Enter resume');
    expect(legendText({ ...PICKER, picker: { ...PICKER.picker!, loading: true } })).not.toContain(
      'Enter resume',
    );
    expect(PICKER.options.length, 'the fixture has a row').toBeGreaterThan(0);
    expect(legendText(PICKER), 'a loaded page with a row names it').toContain('Enter resume');
  });

  it('the picker inline: its rows in a window of ten rows or fewer, the highlighted one in it', () => {
    const many: NativePromptSnapshot = {
      ...PICKER,
      options: Array.from({ length: 6 }, (_, index) => ({
        value: `s${String(index)}`,
        label: `Session ${String(index)}`,
        hint: `${String(index)} days ago`,
      })),
      selected: 5,
    };
    const page: NativeBodyGeometry = {
      bodyRows: 17,
      listRows: INLINE_LIST_MAX_ROWS,
      innerWidth: WIDTH,
    };
    const layout = plain(many, page);
    expect(layout.fits).toBe(true);
    expect(layout.lines.length - 3).toBeLessThanOrEqual(INLINE_LIST_MAX_ROWS);
    expect(layout.lines.map((line) => line.text)).toContain('> Session 5');
    expect(layout.lines.map((line) => line.text)).toContain('  ^ 2 more');
    // the picker pages by loading pages, never by its window
    expect(layout.page).toBeUndefined();
  });
});

describe('a chord step', () => {
  const CHORD: NativePromptSnapshot = {
    ...BASE,
    kind: 'chord',
    message: "Import workflow 'deploy' into this project?",
    options: [
      { value: 'allow', label: 'Write the file' },
      { value: 'deny', label: 'Write nothing' },
    ],
    details: [
      'from        ~/Downloads/deploy.relavium.yaml',
      'to          .relavium/workflows/deploy.relavium.yaml',
      'Canonical YAML: comments are dropped and values are kept as written. The file you named is not changed.',
    ],
  };

  it('draws its question and its facts wrapped, and names its answers on the legend row', () => {
    const rows = texts(CHORD);
    expect(rows[0]).toBe("Import workflow 'deploy' into this project?");
    expect(rows.length).toBe(5);
    expect(rows.slice(3).join(' ')).toBe(CHORD.details[2]);
    expect(legendText(CHORD)).toBe('[Ctrl+Y] Write the file · [Ctrl+N] Write nothing · Esc denies');
    expect(legendText({ ...CHORD, escape: 'back' })).toBe(
      '[Ctrl+Y] Write the file · [Ctrl+N] Write nothing · Esc back · [Ctrl+C] denies',
    );
  });

  it('the answer roles: the affirmative in `ok`, the refusal in `danger`; the way back keeps its consequence (never renamed by the descriptor)', () => {
    const parts = nativePopupLegend({
      ...CHORD,
      popup: { ...BASE.popup!, exitLabel: 'skip for now' },
    });
    expect(parts.items.slice(0, 2)).toEqual([
      { keys: 'Ctrl+Y', verb: 'Write the file', role: 'ok' },
      { keys: 'Ctrl+N', verb: 'Write nothing', role: 'danger' },
    ]);
    expect(parts.exit).toEqual({ class: 'decide', keys: 'Esc', verb: 'denies', role: 'warn' });
  });

  it('is on its page only while its legend row keeps `[Ctrl+Y]`: a refusal dropped for room is fine, an affirmative is not', () => {
    const back = { ...CHORD, escape: 'back' as const };
    expect(
      fittedLegendItems(nativePopupLegend(back), WIDTH).some(
        (item) => 'keys' in item && item.keys === 'Ctrl+N',
      ),
    ).toBe(false);
    expect(plain(back).fits).toBe(true);
    const long: NativePromptSnapshot = {
      ...CHORD,
      options: [
        {
          value: 'allow',
          label: 'Write the file and overwrite every earlier copy of it in this project',
        },
        { value: 'deny', label: 'Write nothing' },
      ],
    };
    expect(plain(long).fits).toBe(false);
  });

  it('its facts and its question have their key tokens and separators made inert (the full scrub of a chord surface)', () => {
    const forged: NativePromptSnapshot = {
      ...CHORD,
      message: 'Import [Ctrl+Y] Allow · Esc close?',
      details: ['from ［Ctrl＋Y］ Write the file', 'to x · [d] withdraw'],
    };
    const rows = texts(forged).join('\n');
    expect(rows).not.toMatch(/\[Ctrl\+Y\]|［Ctrl＋Y］|\[d\]/u);
    expect(rows).not.toContain(' · ');
    expect(rows).toContain('(Ctrl+Y)');
  });

  it('a chord step whose facts do not all fit is not on its page', () => {
    const rows = plain(CHORD, UNBOUNDED).lines.length;
    expect(plain(CHORD, { ...PAGE, bodyRows: rows }).fits).toBe(true);
    expect(plain(CHORD, { ...PAGE, bodyRows: rows - 1 }).fits).toBe(false);
  });
});

describe('the legend of each kind, and the descriptor’s words for the way back', () => {
  it.each([
    ['select', 'cancel', '↑/↓ select · Enter choose · Esc skip for now'],
    ['select', 'back', '↑/↓ select · Enter choose · Esc back · [Ctrl+C] skip for now'],
    ['text', 'cancel', 'Enter continue · Esc skip for now'],
    ['password', 'back', 'Enter continue · Esc back · [Ctrl+C] skip for now'],
    ['busy', 'cancel', 'Esc cancels it'],
  ] as const)('%s, escape %s: %s', (kind, escape, expected) => {
    expect(
      legendText({ ...BASE, kind, escape, popup: { ...BASE.popup!, exitLabel: 'skip for now' } }),
    ).toBe(expected);
  });
});

describe('what `Enter` says on a text or a masked field (`enterVerb`, a product constant)', () => {
  const field = (kind: 'text' | 'password', enterVerb?: string): NativePromptSnapshot => ({
    ...BASE,
    kind,
    escape: 'back',
    popup: {
      ...BASE.popup!,
      exitLabel: 'back',
      ...(enterVerb === undefined ? {} : { enterVerb }),
    },
  });

  it.each(['text', 'password'] as const)(
    'a %s says `Enter check` where its step asked for it, and `Enter continue` where it did not',
    (kind) => {
      expect(legendText(field(kind, 'check'))).toBe('Enter check · Esc back · [Ctrl+C] back');
      expect(legendText(field(kind))).toBe('Enter continue · Esc back · [Ctrl+C] back');
      expect(legendText(field(kind, ''))).toBe('Enter continue · Esc back · [Ctrl+C] back');
    },
  );

  it('is read for text and masked fields only: a select, a chord, a wait and the picker keep their own words', () => {
    for (const kind of ['select', 'busy', 'chord', 'picker'] as const) {
      const snapshot: NativePromptSnapshot = {
        ...BASE,
        kind,
        popup: { ...BASE.popup!, enterVerb: 'check' },
      };
      expect(legendText(snapshot), kind).not.toContain('check');
    }
  });

  it('the card never has it (no descriptor): `Enter continue`', () => {
    const { popup, ...card } = field('password', 'check');
    void popup;
    const parts = nativeLegendParts(card, false, 'card');
    expect(legend(parts.items, parts.exit)).toContain('Enter continue');
  });

  it('a verb that carries a forged legend token is drawn as given: nothing at run time can tell product text from data, so only the TYPE keeps it a constant', () => {
    // Documented, not prevented: `enterVerb` is a product constant by contract (see `NativePopupDescriptor.enterVerb`).
    expect(legendText(field('text', 'check · [Ctrl+Y] allow'))).toContain('check · [Ctrl+Y] allow');
  });
});

describe('W7: what `Esc` says where it steps back (`escapeVerb`, a product constant) and the rail’s skipped steps', () => {
  const stepping = (
    escapeVerb?: string,
    escape: 'back' | 'cancel' = 'back',
  ): NativePromptSnapshot => ({
    ...BASE,
    escape,
    popup: { ...BASE.popup!, ...(escapeVerb === undefined ? {} : { escapeVerb }) },
  });

  it('the first run’s first step reads `Esc skip for now · [Ctrl+C] close`; with none it reads `Esc back`; an empty verb is none', () => {
    expect(legendText(stepping('skip for now'))).toBe(
      '↑/↓ select · Enter choose · Esc skip for now · [Ctrl+C] close',
    );
    expect(legendText(stepping())).toBe('↑/↓ select · Enter choose · Esc back · [Ctrl+C] close');
    expect(legendText(stepping(''))).toBe('↑/↓ select · Enter choose · Esc back · [Ctrl+C] close');
  });

  it('names only the `Esc` that steps back: where `Esc` closes the popup the way back keeps the descriptor’s exit label', () => {
    expect(legendText(stepping('skip for now', 'cancel'))).toBe(
      '↑/↓ select · Enter choose · Esc close',
    );
  });

  it('a text or a masked field and a wait name it the same way; the card never has it', () => {
    const field: NativePromptSnapshot = { ...stepping('skip for now'), kind: 'password' };
    expect(legendText(field)).toBe('Enter continue · Esc skip for now · [Ctrl+C] close');
    const { popup, ...card } = field;
    void popup;
    const parts = nativeLegendParts(card, false, 'card');
    expect(legend(parts.items, parts.exit)).toContain('Esc back');
  });

  it('the rail’s `done` marks: a skipped step is not done; none skipped (or none in the list) is no marks at all', () => {
    expect(nativeRailDone(BASE)).toBeUndefined();
    expect(nativeRailDone({ ...BASE, popup: { ...BASE.popup!, skipped: [] } })).toBeUndefined();
    expect(
      nativeRailDone({ ...BASE, popup: { ...BASE.popup!, stepIndex: 2, skipped: [1] } }),
    ).toEqual([true, false, true]);
    const { popup, ...card } = BASE;
    void popup;
    expect(nativeRailDone(card)).toBeUndefined();
  });

  it('the drawn rail of a Done step that skipped the key step, at 80×24, colour and plain', () => {
    const done: NativePromptSnapshot = {
      ...BASE,
      message: 'Using OPENAI_API_KEY · OpenAI',
      options: [{ value: 'done', label: 'Close' }],
      escape: 'back',
      final: 'ok',
      popup: { ...BASE.popup!, stepIndex: 2, skipped: [1] },
    };
    const rail = (color: boolean): string | undefined => {
      const { geometry, layout } = nativePopupGeometry(
        done,
        'overlay',
        { cols: 80, rows: 24 },
        color,
      );
      if (layout === undefined || !geometry.fits) throw new Error('no frame');
      return nativePopupFrameLines(done, geometry, layout, color)
        .map((line) => line.text.trim())
        .find((row) => row.includes('Provider'));
    };
    expect(rail(true)).toBe('✓ Provider ╌╌ ○ Key ╌╌ ◉ Done');
    expect(rail(false)).toBe('ok Provider .. o Key .. @ Done');
  });
});

describe('a short legend row keeps the choice over paging (the select window)', () => {
  const windowed: NativePromptSnapshot = {
    ...BASE,
    escape: 'back',
    popup: { ...BASE.popup!, exitLabel: 'close' },
  };
  const fitted = (width: number): string => {
    const parts = nativePopupLegend(windowed, true);
    return legend(fittedLegendItems(parts, width), parts.exit);
  };

  it('at the width of an 80-column popup the full row is 70 columns: `PgUp/PgDn page` goes, `Enter choose` stays', () => {
    const parts = nativePopupLegend(windowed, true);
    expect(legend(parts.items, parts.exit)).toBe(
      '↑/↓ select · PgUp/PgDn page · Enter choose · Esc back · [Ctrl+C] close',
    );
    expect(displayWidth(legend(parts.items, parts.exit))).toBeGreaterThan(WIDTH);
    expect(fitted(WIDTH)).toBe('↑/↓ select · Enter choose · Esc back · [Ctrl+C] close');
  });

  it('where the whole row fits it is whole, and where nothing but the way back fits it is the way back', () => {
    expect(fitted(WIDTH + 10)).toContain('PgUp/PgDn page');
    expect(fitted('Esc back · [Ctrl+C] close'.length)).toBe('Esc back · [Ctrl+C] close');
  });

  it('only paging has a lower rank: a list drawn whole has no priority at all (the frame’s own order by position)', () => {
    expect(nativePopupLegend(windowed, false).priority).toBeUndefined();
    expect(nativePopupLegend({ ...windowed, kind: 'text' }).priority).toBeUndefined();
  });

  it('the picker’s paging gives way first too', () => {
    const picker: NativePromptSnapshot = {
      ...BASE,
      kind: 'picker',
      escape: 'back',
      popup: { ...BASE.popup!, exitLabel: 'close' },
    };
    const parts = nativePopupLegend(picker);
    const row = legend(fittedLegendItems(parts, 56), parts.exit);
    expect(row).toContain('Enter resume');
    expect(row).not.toContain('PgUp/PgDn');
  });
});

describe('the notice drawn in place of a popup names only the keys that act on a frame nobody sees', () => {
  const noticeOf = (snapshot: NativePromptSnapshot): string => {
    const keys = withGlyphForm(true, () => nativePopupNoticeKeys(snapshot));
    return legend(keys.items, keys.exit);
  };

  it.each([
    ['select', 'cancel', 'Esc close'],
    ['select', 'back', 'Esc back · [Ctrl+C] close'],
    ['text', 'back', 'Esc back · [Ctrl+C] close'],
    ['password', 'cancel', 'Esc close'],
    ['busy', 'cancel', 'Esc cancels it'],
    ['chord', 'cancel', 'Esc denies'],
    ['chord', 'back', 'Esc back · [Ctrl+C] denies'],
    ['picker', 'back', 'Esc back · [Ctrl+C] close'],
  ] as const)('%s, escape %s: `%s` (what Esc really does there)', (kind, escape, expected) => {
    expect(noticeOf({ ...BASE, kind, escape })).toBe(expected);
  });

  it('the Done step: `Esc close` (its `Enter` is not delivered to a frame nobody sees)', () => {
    const done: NativePromptSnapshot = {
      ...BASE,
      options: [{ value: 'done', label: 'Close' }],
      escape: 'back',
      final: 'ok',
    };
    expect(legendText(done)).toBe('Enter / Esc close');
    expect(noticeOf(done)).toBe('Esc close');
    expect(noticeOf({ ...done, final: 'failed' })).toBe('Esc close');
  });

  it.each(['select', 'text', 'password', 'busy', 'chord', 'picker'] as const)(
    '%s: never `Enter`, `Ctrl+Y` or `Ctrl+N` (nothing on an unseen frame answers)',
    (kind) => {
      for (const escape of ['cancel', 'back'] as const) {
        const text = noticeOf({ ...BASE, kind, escape });
        expect(text).not.toMatch(/Enter|Ctrl\+Y|Ctrl\+N/u);
      }
    },
  );
});

describe('the popup of one flow does not jump between its steps (the pin, the overlay only)', () => {
  const SIZE = { cols: 80, rows: 24 };
  const prompt = (
    details: number,
    extra: Partial<NativePromptSnapshot> = {},
  ): NativePromptSnapshot => ({
    ...BASE,
    details: Array.from({ length: details }, (_, index) => `row ${String(index)}`),
    ...extra,
  });
  const draw = (snapshot: NativePromptSnapshot, pin?: NativePopupPin) => {
    const { geometry } = nativePopupGeometry(snapshot, 'overlay', SIZE, false, pin);
    if (!geometry.fits) throw new Error('refused');
    return geometry;
  };

  it('the first prompt takes its own place (centred); a taller step grows DOWN from that row and a shorter one never shrinks it', () => {
    const first = draw(prompt(1));
    const pin = nextPin(undefined, prompt(1), 'overlay', SIZE, first);
    expect(pin).toMatchObject({ cols: 80, rows: 24, bodyRows: first.bodyRows, top: first.top });
    expect(typeof pin?.flow).toBe('string');
    const taller = draw(prompt(6), pin);
    expect(taller.top).toBe(first.top);
    expect(taller.height).toBeGreaterThan(first.height);
    const pin2 = nextPin(pin, prompt(6), 'overlay', SIZE, taller);
    const shorter = draw(prompt(0, { kind: 'busy' }), pin2);
    expect(shorter.top).toBe(first.top);
    expect(shorter.height).toBe(taller.height);
  });

  it('a step that would not fit below the pinned row is centred by the geometry, and that row is the one kept from then on', () => {
    const first = draw(prompt(1));
    const pin = nextPin(undefined, prompt(1), 'overlay', SIZE, first);
    const tall = draw(prompt(15), pin);
    expect(tall.top).toBe(draw(prompt(15)).top);
    expect(tall.top + tall.height).toBeLessThanOrEqual(SIZE.rows);
    const pin2 = nextPin(pin, prompt(15), 'overlay', SIZE, tall);
    expect(draw(prompt(1), pin2).top).toBe(tall.top);
  });

  it('a wait before the first prompt (the frame right after `begin`) takes no pin: the first prompt does, and sits where it would have alone', () => {
    const waiting = prompt(0, { kind: 'busy', message: '' });
    expect(nextPin(undefined, waiting, 'overlay', SIZE, draw(waiting))).toBeUndefined();
    const alone = draw(prompt(5));
    const pin = nextPin(undefined, prompt(5), 'overlay', SIZE, alone);
    expect(pin?.top).toBe(alone.top);
  });

  it('a list drawn in a window sets neither the height nor the row the flow keeps (a price field after the 21-row model list stays short)', () => {
    const first = draw(prompt(3));
    const pin = nextPin(undefined, prompt(3), 'overlay', SIZE, first);
    const list = draw(prompt(15), pin);
    // The windowed frame leaves the pin exactly as it was; a later short step is drawn where and as tall as the flow's own steps are.
    expect(nextPin(pin, prompt(15), 'overlay', SIZE, list, true)).toBe(pin);
    expect(nextPin(undefined, prompt(15), 'overlay', SIZE, list, true)).toBeUndefined();
    // Not windowed, the same frame would have raised the pin (the flag is what keeps it out).
    expect(nextPin(pin, prompt(15), 'overlay', SIZE, list, false)?.bodyRows).toBe(list.bodyRows);
    expect(draw(prompt(3), nextPin(pin, prompt(15), 'overlay', SIZE, list, true)).height).toBe(
      first.height,
    );
  });

  it('a wait between two prompts keeps the height of the step it follows', () => {
    const first = draw(prompt(6));
    const pin = nextPin(undefined, prompt(6), 'overlay', SIZE, first);
    const wait = draw(prompt(0, { kind: 'busy', message: 'Checking' }), pin);
    expect(wait.height).toBe(first.height);
    expect(wait.top).toBe(first.top);
  });

  it('an inline popup is a block in the flow: no pin is taken and none is read (not even one of this very flow taken in the overlay)', () => {
    const inline = nativePopupGeometry(prompt(1), 'replace', SIZE, false).geometry;
    if (!inline.fits) throw new Error('refused');
    expect(nextPin(undefined, prompt(1), 'replace', SIZE, inline)).toBeUndefined();
    const overlay = draw(prompt(6));
    const pin = nextPin(undefined, prompt(6), 'overlay', SIZE, overlay);
    expect(livePin(pin, prompt(6), 'overlay', SIZE)).toBe(pin);
    expect(livePin(pin, prompt(6), 'replace', SIZE)).toBeUndefined();
    expect(nextPin(pin, prompt(6), 'replace', SIZE, inline)).toBeUndefined();
  });

  it('any resize drops the pin (it can never hold a box a smaller terminal cannot), and so does another flow', () => {
    const first = draw(prompt(6));
    const pin = nextPin(undefined, prompt(6), 'overlay', SIZE, first);
    expect(livePin(pin, prompt(6), 'overlay', SIZE)).toBe(pin);
    expect(livePin(pin, prompt(6), 'overlay', { cols: 80, rows: 30 })).toBeUndefined();
    expect(livePin(pin, prompt(6), 'overlay', { cols: 100, rows: 24 })).toBeUndefined();
    const other = prompt(6, { popup: { ...BASE.popup!, title: '/import' } });
    expect(livePin(pin, other, 'overlay', SIZE)).toBeUndefined();
    const longer = prompt(6, { popup: { ...BASE.popup!, stepCount: 4 } });
    expect(livePin(pin, longer, 'overlay', SIZE)).toBeUndefined();
  });

  it('the fold the matrix expects boxes with (`nativePopupPinAfter`) is the slot’s own: a frame that is not framed is the popup unmounted, so the next flow starts fresh', () => {
    const idle: NativePromptSnapshot = { ...BASE, kind: 'idle', active: false };
    const tall = prompt(6);
    const both = nativePopupPinAfter([tall, idle, prompt(1)], 'overlay', SIZE, false);
    const alone = nativePopupPinAfter([prompt(1)], 'overlay', SIZE, false);
    expect(both).toEqual(alone);
    const held = nativePopupPinAfter([prompt(1), tall], 'overlay', SIZE, false);
    expect(held?.bodyRows).toBeGreaterThan(alone?.bodyRows ?? 0);
    expect(held?.top).toBe(alone?.top);
    expect(nativePopupPinAfter([prompt(1), tall], 'replace', SIZE, false)).toBeUndefined();
  });

  it('a step that cannot fit below the first row moves the pin: the row it was centred on is the one kept afterwards', () => {
    const first = draw(prompt(1));
    const pin = nextPin(undefined, prompt(1), 'overlay', SIZE, first);
    const tall = draw(prompt(15), pin);
    const moved = nextPin(pin, prompt(15), 'overlay', SIZE, tall);
    expect(moved?.top).toBe(tall.top);
    expect(moved?.top).not.toBe(first.top);
  });

  it('R2-8 a box that ends exactly on the terminal’s last row keeps the pinned row (the edge is inclusive); one row lower, the geometry centres it', () => {
    const natural = draw(prompt(6));
    const flush: NativePopupPin = {
      flow: 'x',
      cols: 80,
      rows: 24,
      bodyRows: 0,
      top: SIZE.rows - natural.height,
    };
    expect(flush.top).not.toBe(natural.top);
    expect(draw(prompt(6), flush).top).toBe(flush.top);
    expect(draw(prompt(6), { ...flush, top: flush.top + 1 }).top).toBe(natural.top);
  });

  it('the pinned height is clamped by the terminal like any body: it can never exceed what the floor gives (21 rows at 80x24)', () => {
    const pin: NativePopupPin = { flow: 'x', cols: 80, rows: 24, bodyRows: 999, top: 0 };
    const box = draw(prompt(1), pin);
    expect(box.height).toBe(21);
    expect(box.top + box.height).toBeLessThanOrEqual(SIZE.rows);
  });
});

describe('the frame the slot draws (the rail’s step names, ADR-0148 §1)', () => {
  const frame = (snapshot: NativePromptSnapshot, color = false): string[] => {
    const { geometry, layout } = nativePopupGeometry(
      snapshot,
      'overlay',
      { cols: 80, rows: 24 },
      color,
    );
    if (!geometry.fits || layout === undefined) throw new Error('refused');
    return nativePopupFrameLines(snapshot, geometry, layout, color).map((line) => line.text);
  };

  it('names the rail’s nodes, marks the current one, and says `step N of M` on the top edge', () => {
    const rows = frame({ ...BASE, popup: { ...BASE.popup!, stepIndex: 1 } });
    expect(rows[0]).toContain('/providers');
    expect(rows[0]).toContain('from Home · step 2 of 3');
    expect(rows[1]).toMatch(/Provider .* Key .* Done/u);
    for (const row of rows) expect(displayWidth(row)).toBe(68);
  });

  it('a descriptor with no names draws bare nodes (the rail as it was)', () => {
    const { stepNames, ...bare } = BASE.popup!;
    void stepNames;
    const rows = frame({ ...BASE, popup: bare });
    expect(rows[1]).not.toMatch(/Provider|Key|Done/u);
  });

  it('a one-step flow has no rail', () => {
    const rows = frame({ ...BASE, popup: { ...BASE.popup!, stepCount: 1, stepNames: ['Only'] } });
    expect(rows.join('\n')).not.toContain('Only');
    expect(rows[0]).not.toContain('step');
  });
});

describe('hostile text in every sink', () => {
  const CORPUS = [
    '\u001b[31mred\u001b[0m',
    '\u001b]52;c;Zm9v\u0007clip',
    '\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007',
    'c1\u0085\u009b[2Jx',
    'bidi\u202eevil\u2066x\u2069',
    'zero​width‍﻿',
    'line\u2028sep\u2029para',
    '✓ ok › ◉ ━━ Approval needed ━━',
    '[Ctrl+Y] Allow · Esc close',
    '［Ｃｔｒｌ＋Ｙ］ fullwidth',
    'sk-ant-api03-' + 'A'.repeat(40),
    'long '.repeat(60).trim(),
  ];
  /** Whether a drawn row carries a character it must not: a C0 control but the tab, DEL or a C1 control, a bidirectional control, a line separator. */
  const carriesEscape = (row: string): boolean =>
    Array.from(row).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        (code < 0x20 && code !== 0x09) ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069) ||
        code === 0x2028 ||
        code === 0x2029
      );
    });

  /** Every row of every kind, with `text` in every sink of it. */
  function framesWith(text: string): Map<string, readonly string[]> {
    const sinks: Record<string, NativePromptSnapshot> = {
      note: { ...BASE, note: text },
      message: { ...BASE, message: text },
      label: { ...BASE, options: [{ value: 'x', label: text }] },
      hint: { ...BASE, options: [{ value: 'x', label: 'x', hint: text }] },
      details: { ...BASE, details: [text] },
      error: { ...BASE, error: text },
      display: { ...BASE, kind: 'text', options: [], display: text },
      chordMessage: {
        ...BASE,
        kind: 'chord',
        message: text,
        options: [
          { value: 'allow', label: 'Yes' },
          { value: 'deny', label: 'No' },
        ],
      },
      chordDetails: {
        ...BASE,
        kind: 'chord',
        details: [text],
        options: [
          { value: 'allow', label: 'Yes' },
          { value: 'deny', label: 'No' },
        ],
      },
      pickerLabel: { ...BASE, kind: 'picker', options: [{ value: 'x', label: text, hint: text }] },
      // The Done step: its sentence (led by the step's own mark) and the target and lines under it, in both tones.
      doneOkMessage: {
        ...BASE,
        message: text,
        options: [{ value: 'done', label: 'Close' }],
        escape: 'back',
        final: 'ok',
      },
      doneOkTarget: {
        ...BASE,
        message: 'Created',
        details: [text, text],
        options: [{ value: 'done', label: 'Close' }],
        escape: 'back',
        final: 'ok',
      },
      doneFailedMessage: {
        ...BASE,
        message: text,
        details: [text],
        options: [{ value: 'done', label: 'Close' }],
        escape: 'back',
        final: 'failed',
      },
      title: { ...BASE, popup: { ...BASE.popup!, title: text, stepNames: [text, text, text] } },
    };
    const out = new Map<string, readonly string[]>();
    for (const [name, snapshot] of Object.entries(sinks)) {
      const { geometry, layout } = nativePopupGeometry(
        snapshot,
        'overlay',
        { cols: 80, rows: 24 },
        false,
      );
      if (!geometry.fits || layout === undefined) throw new Error('refused');
      out.set(
        name,
        layout.fits
          ? nativePopupFrameLines(snapshot, geometry, layout, false).map((line) => line.text)
          : [],
      );
    }
    return out;
  }

  it.each(CORPUS)(
    '%j: no control, bidi or separator character reaches a row, and every row is the frame’s width',
    (text) => {
      for (const [sink, rows] of framesWith(text)) {
        for (const row of rows) {
          expect(carriesEscape(row), `${sink}: ${JSON.stringify(row)}`).toBe(false);
          expect(displayWidth(row), sink).toBe(68);
        }
      }
    },
  );

  it('host glyphs in untrusted text are blanked in every sink but a field (a row cannot draw `✓`, `›` or a rule); a field shows what was typed', () => {
    for (const [sink, rows] of framesWith('✓ ok › ◉ ━━ Approval needed ━━')) {
      const body = rows.slice(2, -2).join('\n');
      if (sink === 'display') expect(body).toContain('> ✓ ok');
      else expect(body, sink).not.toMatch(/[✓›◉━]/u);
    }
  });

  it('a forged chord or legend token in a chord step’s body is inert; the legend row is the step’s own', () => {
    const rows = framesWith('[Ctrl+Y] Allow · Esc close').get('chordDetails') ?? [];
    expect(rows.slice(0, -2).join('\n')).not.toContain('[Ctrl+Y]');
    expect(rows.at(-2)?.trim()).toBe('[Ctrl+Y] Yes · [Ctrl+N] No · Esc denies');
  });

  it('a forged legend in a select’s hint stays in the body, behind the margin: the legend row is the step’s own', () => {
    const rows = framesWith('↑/↓ select · Enter choose · Esc close').get('hint') ?? [];
    expect(rows.at(-2)?.trim()).toBe('↑/↓ select · Enter choose · Esc close');
    const forged = rows.findIndex((row) => row.includes('↑/↓ select') && row !== rows.at(-2));
    expect(forged).toBeGreaterThan(1);
    expect(rows[forged]?.startsWith(' ')).toBe(true);
  });

  it('a very long text is wrapped whole, never cut: every word of it is drawn', () => {
    const words = Array.from({ length: 40 }, (_, index) => `w${String(index)}`);
    const rows = texts({ ...BASE, note: words.join(' ') });
    expect(
      rows
        .join(' ')
        .split(/\s+/u)
        .filter((word) => word.startsWith('w')),
    ).toEqual(words);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(WIDTH);
  });

  it('a key-shaped string pasted into a masked field is drawn only as bullets', () => {
    const rows = texts({ ...BASE, kind: 'password', options: [], display: '•'.repeat(32) });
    expect(rows.join('\n')).not.toMatch(/sk-|api03/u);
  });
});

describe('the reviews’ killing tests (6.1 architecture round)', () => {
  /** A snapshot of every framed kind, each with text long enough to wrap. */
  const LONG = 'L'.repeat(150);
  const KINDS: readonly NativePromptSnapshot[] = [
    { ...BASE, options: [GEMINI, { value: 'x', label: LONG, hint: 'H'.repeat(150) }] },
    { ...BASE, kind: 'text', options: [], message: LONG, display: 'x'.repeat(300) },
    {
      ...BASE,
      kind: 'password',
      options: [],
      note: KEY_STEP_NOTE,
      message: LONG,
      display: '•'.repeat(32),
    },
    { ...BASE, kind: 'busy', options: [], message: LONG, note: LONG },
    {
      ...BASE,
      kind: 'chord',
      message: LONG,
      details: [LONG, 'short'],
      options: [
        { value: 'allow', label: 'Write' },
        { value: 'deny', label: 'Skip' },
      ],
    },
    {
      ...BASE,
      kind: 'picker',
      message: LONG,
      display: LONG,
      options: [{ value: 's', label: LONG, hint: 'H'.repeat(150) }],
      picker: {
        allDirectories: false,
        page: 1,
        cursor: 0,
        loading: false,
        hasNext: false,
        hasPrevious: false,
        retryable: false,
      },
    },
    {
      ...BASE,
      message: LONG,
      details: [LONG],
      options: [{ value: 'done', label: 'Done', hint: LONG }],
      final: 'failed',
    },
  ];

  it.each([80, 100, 140])(
    'at %i columns no body row of any framed kind is wider than the inner width',
    (columns) => {
      const width = popupInnerWidth(columns, 'standard');
      for (const snapshot of KINDS)
        for (const color of [true, false])
          for (const row of withGlyphForm(!color, () =>
            nativePopupLayout(snapshot, {
              bodyRows: Number.POSITIVE_INFINITY,
              listRows: Number.POSITIVE_INFINITY,
              innerWidth: width,
            }),
          ).lines)
            expect(displayWidth(row.text), `${snapshot.kind}: ${row.text}`).toBeLessThanOrEqual(
              width,
            );
    },
  );

  it('a chord with `escape: back` whose affirmative cannot fit the legend row is not on its page (the `[Ctrl+Y]` item itself is asked for, not any key)', () => {
    const chord: NativePromptSnapshot = {
      ...BASE,
      kind: 'chord',
      escape: 'back',
      message: 'Import?',
      details: ['from x'],
      options: [
        { value: 'allow', label: 'W'.repeat(100) },
        { value: 'deny', label: 'No' },
      ],
    };
    // the legend row still names keys (`Esc back`, `[Ctrl+C] denies`): only `[Ctrl+Y]` is gone
    expect(fittedLegendItems(nativePopupLegend(chord), WIDTH).some((item) => 'keys' in item)).toBe(
      true,
    );
    expect(plain(chord).fits).toBe(false);
  });

  it('a typed field that exactly fills the row is drawn whole, with no ellipsis; one column more shows its end', () => {
    const exact = 'x'.repeat(WIDTH - 2);
    const row = (display: string): string =>
      plain({ ...BASE, kind: 'text', options: [], display, message: 'Name' }).lines[1]?.text ?? '';
    expect(row(exact)).toBe(`> ${exact}`);
    expect(row(`${exact}y`)).toBe(`> …${'x'.repeat(WIDTH - 4)}y`);
  });

  it('`wrapRows`: a row after a break at exactly the width starts at its first word', () => {
    expect(wrapRows(`${'a'.repeat(66)} bbb`, 66)).toEqual(['a'.repeat(66), 'bbb']);
  });
});

describe('one legend for the card and the popup', () => {
  it.each([
    ['select', 'cancel', false],
    ['select', 'back', false],
    ['select', 'cancel', true],
    ['select', 'back', true],
  ] as const)(
    'the card’s %s legend (escape %s, windowed %s) is the select window’s own estimate',
    (kind, escape, windowed) => {
      const snapshot: NativePromptSnapshot = { ...BASE, kind, escape };
      const parts = nativeLegendParts(snapshot, windowed, 'card');
      expect(legend(parts.items, parts.exit)).toBe(selectLegend(escape === 'back', windowed));
    },
  );

  it.each(['select', 'text', 'password', 'busy', 'picker'] as const)(
    '%s: the card and the popup draw the same items (the popup names the way back in the descriptor’s words)',
    (kind) => {
      for (const escape of ['cancel', 'back'] as const) {
        const snapshot: NativePromptSnapshot = {
          ...BASE,
          kind,
          escape,
          popup: { ...BASE.popup!, exitLabel: 'close' },
        };
        const card = nativeLegendParts(snapshot, false, 'card');
        const popup = nativePopupLegend(snapshot);
        expect(popup.items).toEqual(card.items);
        expect(legend(popup.items, popup.exit)).toBe(legend(card.items, card.exit));
      }
    },
  );

  it('a chord card’s legend is its way back alone (its answers are rows); the popup names the answers before it', () => {
    const chord: NativePromptSnapshot = {
      ...BASE,
      kind: 'chord',
      options: [
        { value: 'allow', label: 'Write' },
        { value: 'deny', label: 'Skip' },
      ],
    };
    const card = nativeLegendParts(chord, false, 'card');
    expect(legend(card.items, card.exit)).toBe('Esc denies');
    const popup = nativePopupLegend(chord);
    expect(legend(popup.items, popup.exit)).toBe('[Ctrl+Y] Write · [Ctrl+N] Skip · Esc denies');
    expect(popup.items.slice(2)).toEqual(card.items);
  });
});

describe('a masked field drawn with what it holds NOW (`withLiveBullets`)', () => {
  const live = (
    display: string,
    kind: NativePromptSnapshot['kind'] = 'password',
  ): NativePromptSnapshot => ({
    ...BASE,
    kind,
    options: [],
    display,
  });

  it('a field the resize emptied is drawn with no bullet, its row as wide as before', () => {
    const row = ` > ${'•'.repeat(12)}      `;
    expect(withLiveBullets(row, live(''))).toBe(` > ${' '.repeat(12)}      `);
    expect(displayWidth(withLiveBullets(row, live('')))).toBe(displayWidth(row));
  });

  it('a field that holds fewer than were drawn keeps that many; one that holds as many or more is left as it is', () => {
    const row = ` > ${'•'.repeat(12)}`;
    expect(withLiveBullets(row, live('•'.repeat(5)))).toBe(` > ${'•'.repeat(5)}${' '.repeat(7)}`);
    expect(withLiveBullets(row, live('•'.repeat(12)))).toBe(row);
    expect(withLiveBullets(row, live('•'.repeat(20)))).toBe(row);
  });

  it('once the prompt is no longer a masked field, no bullet of it is drawn', () => {
    expect(withLiveBullets(' > ••••', live('', 'busy'))).toBe(' >     ');
  });
});

describe('why a framed prompt that is not on its page is a notice', () => {
  const tooLong: NativePromptSnapshot = {
    ...BASE,
    kind: 'chord',
    message: 'Write?',
    details: Array.from({ length: 30 }, (_, index) => `fact ${String(index)}`),
    options: [
      { value: 'allow', label: 'Write' },
      { value: 'deny', label: 'Skip' },
    ],
  };
  const wide: NativePromptSnapshot = {
    ...tooLong,
    details: Array.from({ length: 9 }, (_, index) => `fact ${String(index)} ${'w'.repeat(62)}`),
  };
  const reason = (snapshot: NativePromptSnapshot, cols: number, rows: number) => {
    const { geometry } = nativePopupGeometry(snapshot, 'overlay', { cols, rows }, false);
    return nativeNoticeReason(snapshot, 'overlay', geometry, false);
  };

  it('below the floor: `below-floor`', () => {
    expect(reason(BASE, 60, 20)).toBe('below-floor');
  });

  it('too long for the largest popup any terminal gives: `too-long` (enlarging cannot help), and it says so', () => {
    expect(reason(tooLong, 80, 24)).toBe('too-long');
    expect(reason(tooLong, 200, 60)).toBe('too-long');
    expect(popupNoticeText('too-long')).toBe('This is too long for a popup');
  });

  it('too wide for this terminal but not for a wider one: `no-room` (enlarging helps)', () => {
    expect(reason(wide, 80, 24)).toBe('no-room');
    const { layout } = nativePopupGeometry(wide, 'overlay', { cols: 100, rows: 30 }, false);
    expect(layout?.fits).toBe(true);
  });
});
