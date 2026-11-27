/**
 * The `/workflows` detail is a PAGE of lines ([MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4; review round 1, P-3/O-3/O-13):
 * it opens at its title (never scrolled to its last runs), the arrows walk every line, inline it uses the body's whole height, and a page that
 * overflows says so and names its pages. Drawn through the one geometry function and the frame model exactly as the slot draws them, at 80×24 and
 * 100×30, on the alternate screen and in the flow, with colour off (what is asserted is the words and the rows).
 */
import { describe, expect, it } from 'vitest';

import type { WorkflowDetail } from '../home/workflow-detail.js';
import { popupBoxOf } from '../render/tui/surface-matrix/popup-fixture.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import {
  detailControls,
  homeWorkflowsSpec,
  workflowDetailContent,
} from './home-workflows-popup.js';
import {
  currentStep,
  foldPopupAction,
  highlightedRow,
  openFrame,
  withContent,
  type PopupFrame,
} from './popup-reducer.js';
import { bodyPageRows, naturalBodyRows } from './frame-model.js';
import { INLINE_LIST_MAX_ROWS, popupGeometry, popupInnerWidth } from './geometry.js';
import { definedRead, detailOf, workflowEntry } from './home-popups.test-support.js';
import type { HomeWorkflowRun } from './home-port.js';
import { POPUP_TEXT_COLUMNS } from './popup-text.js';
import { displayWidth } from '../render/tui/viewport.js';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const CELLS: readonly { readonly name: string; readonly variant: Variant }[] = [
  { name: 'alt 80×24', variant: { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } } },
  { name: 'alt 100×30', variant: { renderer: 'alt', color: false, size: { cols: 100, rows: 30 } } },
  {
    name: 'inline 80×24',
    variant: { renderer: 'inline', color: false, size: { cols: 80, rows: 24 } },
  },
  {
    name: 'inline 100×30',
    variant: { renderer: 'inline', color: false, size: { cols: 100, rows: 30 } },
  },
];

const THREE_RUNS: readonly HomeWorkflowRun[] = [
  { runId: '41ae651d-aaaa', status: 'paused', at: ago(5 * 60_000) },
  { runId: '092e6161-bbbb', status: 'completed', at: ago(48 * 3_600_000) },
  { runId: 'fa7f8a61-cccc', status: 'failed', at: ago(96 * 3_600_000) },
];

/** The detail step of the popup, landed with the page of `detail` and `runs`. */
function detailFrame(detail: WorkflowDetail, runs: readonly HomeWorkflowRun[]): PopupFrame {
  const read = definedRead([workflowEntry('release-notes', { name: 'Release notes' })]);
  const row = read.model.rows[0];
  if (row === undefined) throw new Error('no row');
  const content = workflowDetailContent({ row, detail, runs }, NOW);
  const opened = openFrame(homeWorkflowsSpec('home'), 1);
  const landed = withContent(opened, 1, content, detailControls(row), false);
  return { ...landed, stepIndex: 1 };
}

const FOURTEEN_NODES = Array.from({ length: 14 }, (_, at) => ({ id: `step-${String(at + 1)}` }));
const SEVEN_INPUTS = Array.from({ length: 7 }, (_, at) => ({
  name: `argument-${String(at + 1)}`,
  type: 'string',
  required: at % 2 === 0,
}));

/** The rows the frame draws in `variant`, and the page the legend was judged on. */
function drawn(frame: PopupFrame, variant: Variant) {
  const rows = popupBoxOf(frame, variant).rows;
  return { rows, text: rows.join('\n'), legend: rows.at(-2)?.trim() ?? '' };
}

/** The frame after `keys` (`down`, `pageDown`, `end`, `up`) pressed on the page, the page size read from the geometry like the slot does. */
function after(frame: PopupFrame, variant: Variant, keys: readonly string[]): PopupFrame {
  let current = frame;
  for (const key of keys) {
    const { state } = currentStep(current);
    const kind = current.spec.kind ?? 'standard';
    const geometry = popupGeometry({
      columns: variant.size.cols,
      rows: variant.size.rows,
      kind,
      placement: variant.renderer === 'alt' ? 'overlay' : 'replace',
      rail: true,
      bodyRows: naturalBodyRows(
        state.content,
        state,
        variant.renderer === 'alt' ? undefined : INLINE_LIST_MAX_ROWS,
        popupInnerWidth(variant.size.cols, kind),
      ),
    });
    if (!geometry.fits) throw new Error('the popup does not fit this cell');
    const pageRows = bodyPageRows(state.content, false, geometry);
    const action =
      key === 'down'
        ? { kind: 'move' as const, delta: 1 as const }
        : key === 'up'
          ? { kind: 'move' as const, delta: -1 as const }
          : key === 'pageDown'
            ? { kind: 'page' as const, delta: 1 as const }
            : key === 'home'
              ? { kind: 'jump' as const, to: 'first' as const }
              : { kind: 'jump' as const, to: 'last' as const };
    const folded = foldPopupAction(current, action, pageRows);
    if (folded.kind === 'frame') current = folded.frame;
  }
  return current;
}

const NO_MARKER = /(\^|v) \d+ more/u;

/** The lines the highlight stands on (`>`, the marker of the plain form), whatever kind of line they are. */
const caretRows = (text: string): string[] =>
  text.split('\n').filter((row) => /^ ?> /u.test(row.trimEnd()) || /^\s*> /u.test(row));

describe.each(CELLS)('the detail at $name', ({ variant }) => {
  it('with three runs and a short header: the whole page is on screen from its title, no run in front, no marker, and the legend of the page that fits', () => {
    const { rows, text, legend } = drawn(detailFrame(detailOf(), THREE_RUNS), variant);
    expect(text).toContain('release-notes · Release notes');
    expect(text).toContain('Drafts release notes for a version.');
    expect(text).toContain('Last runs');
    for (const id of ['41ae651d', '092e6161', 'fa7f8a61']) expect(text).toContain(id);
    expect(text, 'nothing is hidden above or below').not.toMatch(NO_MARKER);
    expect(
      caretRows(text),
      'no line is highlighted when it opens: a held Enter that opened it answers nothing',
    ).toEqual([]);
    // `↑/↓ select` names the key that lands on the first run; it is the only key that goes when the row is short, and `[Ctrl+C] close` goes before it.
    expect(legend).toMatch(
      /^↑\/↓ select · \[r\] run · \[x\] export · \[p\] pin( · \[Ctrl\+C\] close)? · Esc back$/u,
    );
    expect(rows.length).toBeLessThanOrEqual(variant.size.rows - 1);
  });

  it('with no run: the honest sentence, no marker, and no key that opens a run or pages', () => {
    const { text, legend } = drawn(detailFrame(detailOf(), []), variant);
    expect(text).toContain('No run of this workflow in this directory yet.');
    expect(text).not.toMatch(NO_MARKER);
    expect(legend).not.toContain('open run');
    expect(legend).not.toContain('PgUp/PgDn');
  });

  it('with 14 nodes and 7 inputs: it opens on its title (highlighted), says it goes on, names `↑/↓ scroll`, and reaches the last runs and back', () => {
    const frame = detailFrame(
      detailOf({ nodes: FOURTEEN_NODES, inputs: SEVEN_INPUTS }),
      THREE_RUNS,
    );
    const first = drawn(frame, variant);
    expect(
      first.text,
      'the title is on screen when it opens (it was scrolled off before)',
    ).toContain('release-notes · Release notes');
    expect(first.text).toContain('Drafts release notes for a version.');
    expect(first.text, 'and it says that more follows').toMatch(/v \d+ more/u);
    expect(
      caretRows(first.text),
      'the highlight is on the title: the page is walked line by line',
    ).toEqual([expect.stringContaining('release-notes · Release notes')]);
    expect(first.legend).toContain('↑/↓ scroll');
    expect(first.legend).toContain('Esc back');
    expect(first.legend, 'the letters that act are named').toMatch(
      /\[r\] run · \[x\] export · \[p\] pin/u,
    );
    const end = drawn(after(frame, variant, ['end']), variant);
    for (const id of ['41ae651d', '092e6161', 'fa7f8a61']) expect(end.text).toContain(id);
    expect(end.text, 'at the end the page above is hidden').toMatch(/\^ \d+ more/u);
    const back = drawn(after(frame, variant, ['end', ...Array<string>(60).fill('up')]), variant);
    expect(back.text, '↑ walks back up to the title').toContain('release-notes · Release notes');
    const paged = drawn(after(frame, variant, ['pageDown']), variant);
    expect(paged.text, 'a page on is not the first page').not.toBe(first.text);
  });
});

describe('the page uses the body’s whole height in the flow, not the ten rows of a list to choose from', () => {
  it('a long detail inline draws more than the 14 rows a ten-row list block has', () => {
    const frame = detailFrame(
      detailOf({ nodes: FOURTEEN_NODES, inputs: SEVEN_INPUTS }),
      THREE_RUNS,
    );
    const inline = CELLS.find((cell) => cell.name === 'inline 80×24')?.variant;
    if (inline === undefined) throw new Error('no inline cell');
    expect(drawn(frame, inline).rows.length).toBeGreaterThan(14);
  });
});

/** Frames of the detail with `runs` runs and the nodes and inputs it has, by what the page holds. */
const PAGES = {
  fits: (runs: readonly HomeWorkflowRun[]) => detailFrame(detailOf(), runs),
  long: (runs: readonly HomeWorkflowRun[]) =>
    detailFrame(detailOf({ nodes: FOURTEEN_NODES, inputs: SEVEN_INPUTS }), runs),
  /** 30 nodes with long ids and 12 inputs: overflows every page with or without a run. */
  thirty: (runs: readonly HomeWorkflowRun[]) =>
    detailFrame(
      detailOf({
        nodes: Array.from({ length: 30 }, (_, at) => ({
          id: `step-${String(at + 1).padStart(2, '0')}-of-the-long-chain`,
        })),
        inputs: Array.from({ length: 12 }, (_, at) => ({
          name: `argument-number-${String(at + 1).padStart(2, '0')}`,
          type: 'string',
          required: at % 2 === 0,
        })),
      }),
      runs,
    ),
};

describe.each(CELLS)('the detail’s keys at $name (review round 2, P2-1)', ({ variant }) => {
  const onScreen = (frame: PopupFrame): string => drawn(frame, variant).text;

  it('a page that fits, three runs: it opens with nothing highlighted, `↓` lands on the first run at once, then walks the runs and stops at the last', () => {
    const open = PAGES.fits(THREE_RUNS);
    expect(caretRows(onScreen(open))).toEqual([]);
    const one = after(open, variant, ['down']);
    expect(highlightedRow(one)?.id).toBe('run:0');
    expect(caretRows(onScreen(one)), 'the highlight is drawn on the first run').toEqual([
      expect.stringContaining('41ae651d'),
    ]);
    expect(onScreen(one), 'it says what Enter does there').toContain(
      'Opens it on the Runs screen.',
    );
    expect(drawn(one, variant).legend).toContain('Enter open run');
    const two = after(open, variant, ['down', 'down']);
    expect(highlightedRow(two)?.id).toBe('run:1');
    const three = after(open, variant, ['down', 'down', 'down']);
    expect(highlightedRow(three)?.id).toBe('run:2');
    expect(highlightedRow(after(three, variant, ['down']))?.id, 'it stops at the last run').toBe(
      'run:2',
    );
    expect(highlightedRow(after(three, variant, ['up']))?.id).toBe('run:1');
    expect(highlightedRow(after(open, variant, ['end']))?.id, 'End: the last run').toBe('run:2');
    expect(highlightedRow(after(open, variant, ['end', 'home']))?.id, 'Home: the first run').toBe(
      'run:0',
    );
  });

  it('a page that fits: Enter opens nothing before the first `↓` (a held or doubled Enter stops at the detail), and opens the run it is on after it', () => {
    const open = PAGES.fits(THREE_RUNS);
    expect(foldPopupAction(open, { kind: 'enter' }, 15).kind).toBe('unchanged');
    const fold = foldPopupAction(after(open, variant, ['down']), { kind: 'enter' }, 15);
    expect(fold.kind).toBe('enter');
    expect(fold.kind === 'enter' ? fold.row?.id : undefined).toBe('run:0');
  });

  it('a page that fits, ONE run: `↓` lands on it too, and the legend names `↑/↓ select` (the opening state has nothing highlighted)', () => {
    const open = PAGES.fits(THREE_RUNS.slice(0, 1));
    expect(drawn(open, variant).legend).toContain('↑/↓ select');
    expect(highlightedRow(after(open, variant, ['down']))?.id).toBe('run:0');
  });

  it('a page that fits, no run: nothing is blind: no key moves anything, and the legend names no `↑/↓` and no `Enter`', () => {
    const open = PAGES.fits([]);
    const before = onScreen(open);
    for (const keys of [['down'], ['up'], ['pageDown'], ['end'], ['home']])
      expect(onScreen(after(open, variant, keys)), keys.join(',')).toBe(before);
    const { legend } = drawn(open, variant);
    expect(legend).not.toContain('↑/↓');
    expect(legend).not.toContain('Enter');
    expect(legend).not.toContain('PgUp');
  });

  it.each([
    ['14 nodes, 7 inputs, 3 runs', () => PAGES.long(THREE_RUNS)],
    ['30 nodes, 7 inputs, 3 runs', () => PAGES.thirty(THREE_RUNS)],
    ['30 nodes, 7 inputs, no run', () => PAGES.thirty([])],
  ])(
    'a page that overflows (%s): every `↓` changes the screen, with the highlight drawn on exactly one line, down to the last line',
    (_name, make) => {
      let frame = make();
      const lines = currentStep(frame).state.content;
      const total = lines.kind === 'list' ? lines.rows.length : 0;
      // The blank gap rows between the groups are space, not lines: no press lands on one (review round 3, O3-8).
      const walked =
        lines.kind === 'list' ? lines.rows.filter((row) => row.label.trim() !== '') : [];
      const lastLine = lines.kind === 'list' ? lines.rows.indexOf(walked.at(-1) as never) : -1;
      expect(walked.length, 'the page has gap rows').toBeLessThan(total);
      expect(drawn(frame, variant).text, 'the page overflows').toMatch(/v \d+ more/u);
      let seen = onScreen(frame);
      expect(caretRows(seen)).toHaveLength(1);
      let moved = 0;
      for (let press = 0; press < total + 5; press += 1) {
        const next = after(frame, variant, ['down']);
        if (next === frame) break;
        const text = onScreen(next);
        expect(text, `press ${String(press + 1)} changed nothing`).not.toBe(seen);
        expect(caretRows(text), `press ${String(press + 1)}`).toHaveLength(1);
        expect(
          caretRows(text)[0]
            ?.replace(/^\s*>\s*/u, '')
            .trim(),
          `press ${String(press + 1)}: a caret never stands alone on an empty line`,
        ).not.toBe('');
        frame = next;
        seen = text;
        moved += 1;
      }
      expect(moved, 'it walked to the last line, which is on screen').toBe(walked.length - 1);
      expect(currentStep(frame).state.selected).toBe(lastLine);
      expect(caretRows(seen)).toHaveLength(1);
    },
  );

  it('a page that overflows: `↑/↓ scroll` is named, `PgUp/PgDn` where the width holds it, and the letters that act are always named', () => {
    for (const [make, runs] of [
      [PAGES.long, THREE_RUNS],
      [PAGES.thirty, THREE_RUNS],
      [PAGES.thirty, []],
    ] as const) {
      {
        const open = make(runs);
        for (const keys of [[], ['down', 'down', 'down'], ['end']]) {
          const { legend } = drawn(after(open, variant, keys), variant);
          // Where a run is highlighted its own `Enter open run` is kept before `↑/↓ scroll`, which the arrows do without being told.
          const onRun = highlightedRow(after(open, variant, keys))?.id?.startsWith('run:') === true;
          if (onRun) expect(legend, keys.join(',')).toContain('Enter open run');
          else expect(legend, keys.join(',')).toContain('↑/↓ scroll');
          expect(legend).toMatch(/\[r\] run · \[x\] export · \[p\] (un)?pin/u);
          expect(legend).toMatch(/Esc back$/u);
        }
      }
    }
  });

  it('a page that overflows: Enter does nothing on a line that is no run, and opens the run it has been walked onto', () => {
    const open = PAGES.long(THREE_RUNS);
    expect(foldPopupAction(open, { kind: 'enter' }, 15).kind, 'on the title').toBe('unchanged');
    expect(
      foldPopupAction(after(open, variant, ['down', 'down']), { kind: 'enter' }, 15).kind,
    ).toBe('unchanged');
    const ended = after(open, variant, ['end']);
    expect(highlightedRow(ended)?.id).toBe('run:2');
    const fold = foldPopupAction(ended, { kind: 'enter' }, 15);
    expect(fold.kind === 'enter' ? fold.row?.id : undefined).toBe('run:2');
    expect(drawn(ended, variant).legend).toContain('Enter open run');
  });

  it('whatever the page: the letters that act are named in the legend whenever it is drawn, and `[Ctrl+C] close` is the first key to go', () => {
    for (const make of [PAGES.fits, PAGES.long, PAGES.thirty])
      for (const runs of [[], THREE_RUNS]) {
        const open = make(runs);
        for (const keys of [[], ['down'], ['end'], ['pageDown']]) {
          const { legend } = drawn(after(open, variant, keys), variant);
          expect(legend, `${keys.join(',')} ${legend}`).toMatch(
            /\[r\] run · \[x\] export · \[p\] (un)?pin/u,
          );
          // `[Ctrl+C] close` is the first key to go: it is missing only where adding it would not fit the legend row (review round 3, M3-9).
          if (!legend.includes('[Ctrl+C]'))
            expect(
              displayWidth(legend) + displayWidth(' · [Ctrl+C] close'),
              `${keys.join(',')} ${legend}`,
            ).toBeGreaterThan(popupInnerWidth(variant.size.cols, 'standard'));
        }
      }
  });
});

/** The detail of one workflow of the catalogue, whose entry (and pin) the test chooses: what the title row is built from. */
function titleFrame(
  over: Partial<ReturnType<typeof workflowEntry>>,
  pinned: boolean,
  slug = 'nightly-billing-report',
): PopupFrame {
  const read = definedRead([workflowEntry(slug, over)], {
    pins: pinned ? [{ kind: 'workflow', ref: slug, rowid: 1, oversized: false }] : [],
  });
  const row = read.model.rows.find((candidate) => candidate.entryIndex !== undefined);
  if (row === undefined) throw new Error('no row');
  const content = workflowDetailContent({ row, detail: detailOf(), runs: [] }, NOW);
  const opened = openFrame(homeWorkflowsSpec('home'), 1);
  return { ...withContent(opened, 1, content, detailControls(row), false), stepIndex: 1 };
}

describe.each(CELLS)(
  'the detail’s title row at $name keeps its facts (review round 3, O3-3)',
  ({ variant }) => {
    /** The title row: the first row of the page that starts with the workflow's slug. */
    const titleOf = (frame: PopupFrame, slug = 'nightly-billing-report'): string => {
      const found = drawn(frame, variant).rows.find((line) => line.includes(slug));
      if (found === undefined) throw new Error('no title row');
      return found;
    };

    it('an ordinary long name is cut, with `…`, to leave the node count and `pinned` whole', () => {
      const frame = titleFrame(
        { name: 'Nightly report for the billing service of the whole company' },
        true,
      );
      const title = titleOf(frame);
      expect(title).toContain('nightly-billing-report · Nightly');
      expect(title, 'the name gives way').toContain('…');
      expect(title).toMatch(/ {2}· {2}3 nodes · pinned/u);
      expect(displayWidth(title.trim().replace(/^[›>]\s*/u, ''))).toBeLessThanOrEqual(
        POPUP_TEXT_COLUMNS - 2,
      );
    });

    it('a name that fits is drawn whole, with the facts after it', () => {
      const title = titleOf(titleFrame({ name: 'Billing report' }, true));
      expect(title).toContain('nightly-billing-report · Billing report  ·  3 nodes · pinned');
      expect(title).not.toContain('…');
    });

    it('a hostile name (key tokens, a glyph, a long run of text) is scrubbed and still leaves the facts whole', () => {
      const title = titleOf(
        titleFrame(
          { name: '[Ctrl+Y] Approve ▼ 9 more ' + 'x'.repeat(80) },
          true,
          'a-slug-of-twenty-two',
        ),
        'a-slug-of-twenty-two',
      );
      expect(title).toMatch(/ {2}· {2}3 nodes · pinned/u);
      expect(title).not.toContain('[Ctrl+Y]');
      expect(title).not.toContain('▼');
    });
  },
);

describe('a page that lands opens at its top', () => {
  it('whatever index the step was left on: a step that showed no list (a read in flight) hands its stale highlight to nobody', () => {
    const read = definedRead([workflowEntry('release-notes')]);
    const row = read.model.rows[0];
    if (row === undefined) throw new Error('no row');
    const opened = openFrame(homeWorkflowsSpec('home'), 1);
    const stale: PopupFrame = {
      ...opened,
      stepIndex: 1,
      steps: opened.steps.map((state, index) => (index === 1 ? { ...state, selected: 9 } : state)),
    };
    const content = workflowDetailContent({ row, detail: detailOf(), runs: THREE_RUNS }, NOW);
    const landed = withContent(stale, 1, content, detailControls(row), false);
    expect(highlightedRow(landed)?.id).toBe('title');
  });
});

describe('what the page flag of a detail and of an agent’s report decides, pinned', () => {
  const TWO_RUNS = THREE_RUNS.slice(0, 2);
  const ONE_RUN = THREE_RUNS.slice(0, 1);
  const WIDE: Variant = { renderer: 'alt', color: false, size: { cols: 100, rows: 30 } };

  it('a page that fits names `↑/↓ select` while it has a run to select, ONE as well as two (`↓` lands on it: nothing is highlighted when it opens), where the width holds it; none, none (review round 2: this was `names no select with ONE run`)', () => {
    expect(drawn(detailFrame(detailOf(), ONE_RUN), WIDE).legend).toContain('↑/↓ select');
    expect(drawn(detailFrame(detailOf(), TWO_RUNS), WIDE).legend).toContain('↑/↓ select');
    expect(drawn(detailFrame(detailOf(), []), WIDE).legend).not.toContain('↑/↓');
  });

  it('a report that is a page (an agent’s detail) uses the body’s whole height in the flow, where a plain report is windowed to the list bound', () => {
    const lines = Array.from({ length: 30 }, (_, at) => `line ${String(at + 1)}`);
    const spec = (page: boolean) => ({
      id: 'agents',
      title: '/agents',
      origin: 'home' as const,
      steps: [
        {
          name: 'Detail',
          content: { kind: 'report' as const, lines, ...(page ? { page: true as const } : {}) },
        },
      ],
    });
    const inline: Variant = { renderer: 'inline', color: false, size: { cols: 80, rows: 40 } };
    const shown = (page: boolean): number =>
      popupBoxOf(openFrame(spec(page), 1), inline).rows.filter((row) => /line \d+ *$/u.test(row))
        .length;
    expect(shown(false), 'a plain report keeps to the list bound').toBeLessThanOrEqual(
      INLINE_LIST_MAX_ROWS,
    );
    expect(shown(true), 'a page of lines takes the body’s whole height').toBeGreaterThan(
      INLINE_LIST_MAX_ROWS,
    );
  });
});

describe('the words of the detail’s fields (inputs, chain, title facts) are pinned', () => {
  const contentOf = (detail: WorkflowDetail, entryName?: string): string => {
    const read = definedRead([
      workflowEntry('release-notes', entryName === undefined ? {} : { name: entryName }),
    ]);
    const row = read.model.rows[0];
    if (row === undefined) throw new Error('no row');
    const content = workflowDetailContent({ row, detail, runs: [] }, NOW);
    if (content.kind !== 'list') throw new Error('a page of lines');
    return content.rows.map((entry) => entry.label).join('\n');
  };

  it('a workflow that declares no input says `none`', () => {
    expect(contentOf(detailOf({ inputs: [] }))).toMatch(/^Inputs +none$/mu);
  });

  it('inputs past the bound say how many more there are, and so does the chain', () => {
    const text = contentOf(detailOf({ inputsMore: 3, nodesMore: 5 }));
    expect(text).toContain('… and 3 more');
    expect(text).toContain('→ … 5 more');
  });

  it('the title says how many nodes the workflow has; a name that only repeats the slug is not said twice', () => {
    const title = contentOf(detailOf()).split('\n')[0] ?? '';
    expect(title).toBe('release-notes  ·  3 nodes');
    expect(contentOf(detailOf(), 'release-notes').split('\n')[0]).toBe(title);
    expect(contentOf(detailOf(), 'Release notes').split('\n')[0]).toBe(
      'release-notes · Release notes  ·  3 nodes',
    );
  });
});

describe('the chain draws `→` only along an edge (review round 2, O2-4)', () => {
  const chainOf = (nodes: { id: string; apart?: true }[], nodesMore = 0): string => {
    const read = definedRead([workflowEntry('release-notes')]);
    const row = read.model.rows[0];
    if (row === undefined) throw new Error('no row');
    const content = workflowDetailContent(
      { row, detail: detailOf({ nodes, nodesMore }), runs: [] },
      NOW,
    );
    if (content.kind !== 'list') throw new Error('a page of lines');
    return content.rows
      .map((entry) => entry.label)
      .filter((label) => /^Nodes|^ {9}\S/u.test(label))
      .join(' ')
      .replace(/^Nodes +/u, '')
      .replace(/ +/gu, ' ');
  };

  it('a diamond (`check` to `hi` and `lo`, both to `out`): the second sibling follows a `·`, the join an arrow', () => {
    expect(
      chainOf([
        { id: 'start' },
        { id: 'check' },
        { id: 'hi' },
        { id: 'lo', apart: true },
        { id: 'out' },
      ]),
    ).toBe('start → check → hi · lo → out');
  });

  it('a fan-out: every branch after the first follows a `·`', () => {
    expect(
      chainOf([{ id: 'start' }, { id: 'a' }, { id: 'b', apart: true }, { id: 'c', apart: true }]),
    ).toBe('start → a · b · c');
  });

  it('a straight chain keeps its arrows, and a chain cut at the bound says how many more follow', () => {
    expect(chainOf([{ id: 'start' }, { id: 'a' }, { id: 'out' }])).toBe('start → a → out');
    expect(chainOf([{ id: 'start' }, { id: 'a' }], 5)).toBe('start → a → … 5 more');
  });
});

describe('the lines of the detail keep to the room they are given', () => {
  const rowsOf = (
    detail: WorkflowDetail,
    runs: readonly HomeWorkflowRun[] = [],
    over: Parameters<typeof workflowEntry>[1] = {},
  ): readonly string[] => {
    const read = definedRead([workflowEntry('release-notes', over)]);
    const row = read.model.rows[0];
    if (row === undefined) throw new Error('no row');
    const content = workflowDetailContent({ row, detail, runs }, NOW);
    if (content.kind !== 'list') throw new Error('a page of lines');
    return content.rows.map((entry) => `${entry.label}${entry.detail ?? ''}`);
  };
  const MANY = Array.from({ length: 24 }, (_, at) => ({ id: `step-${String(at + 1)}` }));

  it('the fields’ values start in one column, and no line is wider than the popup’s text', () => {
    const lines = rowsOf(detailOf({ nodes: MANY, inputs: SEVEN_INPUTS }));
    const starts = ['Inputs', 'Nodes', 'File'].map((label) => {
      const line = lines.find((entry) => entry.startsWith(label)) ?? '';
      return line.length - line.slice(label.length).trimStart().length;
    });
    expect(new Set(starts).size, JSON.stringify(starts)).toBe(1);
    for (const line of lines)
      expect(displayWidth(line), line).toBeLessThanOrEqual(POPUP_TEXT_COLUMNS - 2);
  });

  it('a long file path is cut to what the File field has, not to the whole text width', () => {
    const lines = rowsOf(detailOf(), [], {
      path: `.relavium/workflows/${'a'.repeat(120)}.relavium.yaml`,
    });
    const file = lines.find((entry) => entry.startsWith('File')) ?? '';
    expect(displayWidth(file)).toBeLessThanOrEqual(POPUP_TEXT_COLUMNS - 2);
    expect(file).toContain('…');
  });

  it('a long description keeps to its rows and says it goes on', () => {
    const description = Array.from({ length: 80 }, (_, at) => `word${String(at)}`).join(' ');
    const lines = rowsOf(detailOf({ description }));
    const before = lines.indexOf('');
    const shown = lines.slice(1, before);
    expect(shown.length).toBeLessThanOrEqual(3);
    expect(shown.at(-1)).toMatch(/…$/u);
  });

  it('a paused run says how long it waits once, not twice', () => {
    const variant: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
    const paused =
      drawn(detailFrame(detailOf(), THREE_RUNS), variant).rows.find((row) =>
        row.includes('41ae651d'),
      ) ?? '';
    expect(paused).toMatch(/waiting +5m/u);
    expect(paused).not.toMatch(/waiting.*waiting/u);
  });
});

describe('the keys of a page of lines walk every line, not only the lines that can act', () => {
  // 80×24 is where the page overflows: at 100×30 it nearly fits and every key is a no-op.
  const variant: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
  const stepsOf = (count: number) =>
    Array.from({ length: count }, (_, at) => ({ id: `step-${String(at + 1)}` }));
  const inputsOf = (count: number) =>
    Array.from({ length: count }, (_, at) => ({
      name: `argument-${String(at + 1)}`,
      type: 'string',
      required: at % 2 === 0,
    }));
  const OVERFLOWING = { nodes: stepsOf(24), inputs: inputsOf(16) };
  const selectedOf = (frame: PopupFrame): { selected: number; last: number } => {
    const { state } = currentStep(frame);
    return {
      selected: state.selected,
      last: state.content.kind === 'list' ? state.content.rows.length - 1 : -1,
    };
  };

  it('End on a page that ends with a sentence (no run to act on) goes to its last line, and Home from there goes to its title', () => {
    const frame = detailFrame(detailOf(OVERFLOWING), []);
    expect(drawn(frame, variant).text, 'the page overflows').toMatch(/v \d+ more/u);
    const ended = after(frame, variant, ['end']);
    expect(selectedOf(ended).selected).toBe(selectedOf(ended).last);
    expect(drawn(ended, variant).text, 'the last line of the page is on screen').toContain(
      'No run of this workflow in this directory yet.',
    );
    const home = after(frame, variant, ['end', 'home']);
    expect(selectedOf(home).selected).toBe(0);
    expect(drawn(home, variant).text).toContain('release-notes · Release notes');
  });

  it('Home after End on a page with runs goes to the title, not to the first run that can act', () => {
    const frame = detailFrame(detailOf(OVERFLOWING), THREE_RUNS);
    const home = after(frame, variant, ['end', 'home']);
    expect(selectedOf(home).selected).toBe(0);
    expect(drawn(home, variant).text).toContain('release-notes · Release notes');
  });

  it('a page down moves a whole page of lines, whatever kind of line it lands on (the heading, a field, a run)', () => {
    const geometryOf = (frame: PopupFrame) => {
      const { state } = currentStep(frame);
      const geometry = popupGeometry({
        columns: variant.size.cols,
        rows: variant.size.rows,
        kind: 'standard',
        placement: 'overlay',
        rail: true,
        bodyRows: naturalBodyRows(
          state.content,
          state,
          undefined,
          popupInnerWidth(variant.size.cols, 'standard'),
        ),
      });
      if (!geometry.fits) throw new Error('the popup does not fit');
      return geometry;
    };
    let landedOnAHeading = 0;
    for (let nodes = 8; nodes <= 24; nodes += 1) {
      const frame = detailFrame(
        detailOf({ nodes: stepsOf(nodes), inputs: inputsOf(16) }),
        THREE_RUNS,
      );
      const page = bodyPageRows(currentStep(frame).state.content, false, geometryOf(frame));
      const after1 = selectedOf(after(frame, variant, ['pageDown']));
      const content = currentStep(frame).state.content;
      // A page lands on the line a page on: where that is a blank gap row between two groups (space, never a line), on the next line after it
      // (review round 3, O3-8).
      const target = Math.min(after1.last, page);
      const rows = content.kind === 'list' ? content.rows : [];
      const onward = rows.findIndex((row, at) => at >= target && row.label.trim() !== '');
      expect(after1.selected, `${String(nodes)} nodes`).toBe(onward < 0 ? target : onward);
      expect(rows[after1.selected]?.label.trim(), 'never a blank row').not.toBe('');
      if (content.kind === 'list' && content.rows[after1.selected]?.enabled === false)
        landedOnAHeading += 1;
    }
    expect(landedOnAHeading, 'the sweep reached lines that cannot act').toBeGreaterThan(3);
  });
});
