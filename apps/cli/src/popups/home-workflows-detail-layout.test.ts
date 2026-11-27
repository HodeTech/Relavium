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
            : { kind: 'jump' as const, to: 'last' as const };
    const folded = foldPopupAction(current, action, pageRows);
    if (folded.kind === 'frame') current = folded.frame;
  }
  return current;
}

const NO_MARKER = /(\^|v) \d+ more/u;

describe.each(CELLS)('the detail at $name', ({ variant }) => {
  it('with three runs and a short header: the whole page is on screen from its title, no run in front, no marker, and the legend of the page that fits', () => {
    const { rows, text, legend } = drawn(detailFrame(detailOf(), THREE_RUNS), variant);
    expect(text).toContain('release-notes · Release notes');
    expect(text).toContain('Drafts release notes for a version.');
    expect(text).toContain('Last runs');
    for (const id of ['41ae651d', '092e6161', 'fa7f8a61']) expect(text).toContain(id);
    expect(text, 'nothing is hidden above or below').not.toMatch(NO_MARKER);
    expect(text, 'the highlight is on the title, not on a run').not.toMatch(/^ ?> .*[0-9a-f]{8}/mu);
    // `↑/↓ select` (the last runs are rows to choose) is named where the width holds it (100 columns), and is the first item to go at 80.
    expect(legend).toMatch(
      /^(↑\/↓ select · )?\[r\] run · \[x\] export · \[p\] pin · \[Ctrl\+C\] close · Esc back$/u,
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

  it('with 14 nodes and 7 inputs: it opens on its title, says it goes on, names its pages, and scrolls to the last runs and back', () => {
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
    expect(first.legend).toContain('PgUp/PgDn page');
    expect(first.legend).toContain('Esc back');
    const end = drawn(after(frame, variant, ['end']), variant);
    for (const id of ['41ae651d', '092e6161', 'fa7f8a61']) expect(end.text).toContain(id);
    expect(end.text, 'at the end the page above is hidden').toMatch(/\^ \d+ more/u);
    const back = drawn(after(frame, variant, ['end', ...Array<string>(40).fill('up')]), variant);
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

describe('Enter on the page', () => {
  it('opens nothing on the title (a held or doubled Enter stops at the detail), and opens the run it is walked onto', () => {
    const variant = CELLS[0]?.variant;
    if (variant === undefined) throw new Error('no cell');
    const frame = detailFrame(detailOf(), THREE_RUNS);
    expect(foldPopupAction(frame, { kind: 'enter' }, 15).kind).toBe('unchanged');
    let walked = frame;
    for (let step = 0; step < 30 && highlightedRow(walked)?.id !== 'run:0'; step += 1)
      walked = after(walked, variant, ['down']);
    expect(highlightedRow(walked)?.id).toBe('run:0');
    const fold = foldPopupAction(walked, { kind: 'enter' }, 15);
    expect(fold.kind).toBe('enter');
    expect(fold.kind === 'enter' ? fold.row?.id : undefined).toBe('run:0');
  });
});

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
