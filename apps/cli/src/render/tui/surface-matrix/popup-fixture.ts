import {
  naturalBodyRows,
  popupBody,
  popupFrameLines,
  reportPageRows,
  type PopupOrigin,
} from '../../../popups/frame-model.js';
import { INLINE_LIST_MAX_ROWS, popupGeometry, popupInnerWidth } from '../../../popups/geometry.js';
import {
  currentStep,
  openFrame,
  popupLegend,
  railOf,
  type PopupFrame,
  type PopupSpec,
} from '../../../popups/popup-reducer.js';
import { withGlyphForm } from '../glyphs.js';
import type { PopupBox } from './properties.js';
import type { ScreenCell } from './terminal.js';
import type { Variant } from './variants.js';

/**
 * The popup the TEST layer opens ([ADR-0148](../../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1): a minimal report popup with a selected row, a control and the way back, so the surface matrix and the host tests exercise the popup
 * frame in every host and cell before any product command becomes a popup. It is NOT a product command (its title is no command's name).
 */
export const TEST_POPUP_TITLE = 'Test report';

/** What the popup's legend row says, written out here and not built by the legend builder (the builder is part of what is checked). */
export const TEST_POPUP_LEGEND_ROW = '↑/↓ select · [c] copy · Esc close';

export function testReportPopup(origin: PopupOrigin): PopupSpec {
  return {
    id: 'test-report',
    title: TEST_POPUP_TITLE,
    origin,
    steps: [
      {
        name: 'Report',
        content: {
          kind: 'list',
          rows: [
            { id: 'alpha', label: 'alpha check', status: 'completed', detail: 'ok' },
            { id: 'bravo', label: 'bravo check', status: 'warning', detail: 'warn' },
            { id: 'charlie', label: 'charlie check', status: 'failed', detail: 'failed' },
          ],
        },
        controls: [{ key: 'c', verb: 'copy' }],
        initialRow: 'alpha',
      },
    ],
  };
}

/** What each mount showed just before the test opened its popup: its rows (the popup-box property) and its cells with their styles (the backdrop-dim property). */
interface Baseline {
  readonly lines: readonly string[];
  readonly cells: readonly (readonly ScreenCell[])[] | undefined;
}
const BASELINES = new WeakMap<object, Baseline>();

/** Record what `mount` shows now, before a popup is opened over it. */
export function recordBaseline(mount: {
  readonly frame: () => string[];
  readonly cells?: () => ScreenCell[][];
}): void {
  BASELINES.set(mount, { lines: mount.frame(), cells: mount.cells?.() });
}

/** The frame `mount` showed before its popup opened, or `undefined` when none was recorded. */
export function baselineOf(mount: object): readonly string[] | undefined {
  return BASELINES.get(mount)?.lines;
}

/** The cells (with their styles) `mount` showed before its popup opened, or `undefined` when none were recorded. */
export function baselineCellsOf(mount: object): readonly (readonly ScreenCell[])[] | undefined {
  return BASELINES.get(mount)?.cells;
}

/** Where the test popup is drawn in a cell, and its rows: the one geometry function and the frame model, in the cell's glyph form. */
export function testPopupBox(origin: PopupOrigin): (variant: Variant) => PopupBox {
  return (variant) => popupBoxOf(openFrame(testReportPopup(origin), 1), variant);
}

/**
 * Where a popup's frame is drawn in a cell, and its rows, from the one geometry function and the frame model exactly as the slot draws them
 * (its rail, its legend judged on the page it draws, its body in the cell's glyph form, and the live notification in its legend row when
 * `notice` is given). A product popup's surface passes the frame its host has open.
 */
export function popupBoxOf(
  frame: PopupFrame | undefined,
  variant: Variant,
  notice?: string,
): PopupBox {
  if (frame === undefined) throw new Error('no popup is open in this cell');
  const placement = variant.renderer === 'alt' ? 'overlay' : 'replace';
  const { spec: step, state: opened } = currentStep(frame);
  const state = { ...opened, filter: step.filter === true ? opened.filter : undefined };
  const rail = railOf(frame);
  const kind = frame.spec.kind ?? 'standard';
  const geometry = popupGeometry({
    columns: variant.size.cols,
    rows: variant.size.rows,
    kind,
    placement,
    rail: rail.names.length > 1,
    bodyRows: naturalBodyRows(
      state.content,
      state,
      placement === 'replace' ? INLINE_LIST_MAX_ROWS : undefined,
      popupInnerWidth(variant.size.cols, kind),
    ),
  });
  if (!geometry.fits) throw new Error('the popup does not fit this cell');
  const rows = withGlyphForm(!variant.color, () =>
    popupFrameLines(
      {
        title: frame.spec.title,
        origin: frame.spec.origin,
        steps: rail.names,
        stepIndex: rail.index,
        done: rail.done,
        legend: popupLegend(frame, reportPageRows(geometry, state.filter !== undefined)),
        notice,
      },
      popupBody(state.content, state, geometry),
      geometry,
    ),
  ).map((line) => line.text);
  return {
    placement,
    top: geometry.top,
    left: geometry.left,
    width: geometry.width,
    height: geometry.height,
    rows,
  };
}
