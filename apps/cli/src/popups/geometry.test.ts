/**
 * The one geometry of a popup, pinned on the numbers ADR-0148 §4 and §7 give ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)).
 */
import { describe, expect, it } from 'vitest';

import {
  INLINE_LIST_MAX_ROWS,
  POPUP_FRAME_ROWS,
  POPUP_MAX_WIDTH,
  POPUP_STANDARD_MAX_ROWS,
  popupGeometry,
  popupMargin,
  type PopupBoxGeometry,
  type PopupGeometryInput,
} from './geometry.js';

const standard = (columns: number, rows: number, extra: Partial<PopupGeometryInput> = {}) =>
  popupGeometry({ columns, rows, kind: 'standard', placement: 'overlay', rail: false, ...extra });

function box(geometry: ReturnType<typeof popupGeometry>): PopupBoxGeometry {
  if (!geometry.fits) throw new Error(`refused: ${geometry.reason}`);
  return geometry;
}

describe('the width of a standard popup', () => {
  it('is min(columns − 2 × margin, 76): 68 at 80 columns, 76 from 88 up, never wider', () => {
    expect(box(standard(80, 24)).width).toBe(68);
    expect(box(standard(87, 24)).width).toBe(75);
    expect(box(standard(88, 24)).width).toBe(76);
    expect(box(standard(99, 24)).width).toBe(76);
    expect(box(standard(100, 30)).width).toBe(76);
    expect(box(standard(240, 60)).width).toBe(POPUP_MAX_WIDTH);
  });

  it('takes a margin of 6 from 80 to 99 columns and 8 from 100', () => {
    expect(popupMargin(80)).toBe(6);
    expect(popupMargin(99)).toBe(6);
    expect(popupMargin(100)).toBe(8);
  });

  it('is centred, and its inner width is the width less a column of margin on each side', () => {
    const at80 = box(standard(80, 24));
    expect(at80.left).toBe(6);
    expect(at80.innerWidth).toBe(66);
    const at100 = box(standard(100, 30));
    expect(at100.left).toBe(12);
    expect(at100.left * 2 + at100.width).toBe(100);
  });
});

describe('the height of a standard popup', () => {
  it('is at most 21 rows: the frame (top edge, legend, bottom edge) and up to 18 body rows', () => {
    const tallest = box(standard(80, 24));
    expect(tallest.height).toBe(POPUP_STANDARD_MAX_ROWS);
    expect(tallest.maxBodyRows).toBe(POPUP_STANDARD_MAX_ROWS - POPUP_FRAME_ROWS);
    expect(box(standard(200, 60)).height).toBe(POPUP_STANDARD_MAX_ROWS);
  });

  it('is as tall as its body asks, clamped to one row and to what it may have, and centred on its own height', () => {
    const short = box(standard(80, 24, { bodyRows: 3 }));
    expect(short.height).toBe(6);
    expect(short.top).toBe(9);
    expect(box(standard(80, 24, { bodyRows: 0 })).bodyRows).toBe(1);
    expect(box(standard(80, 24, { bodyRows: 500 })).bodyRows).toBe(18);
  });

  it('gives the rail a row only for more than one step', () => {
    expect(box(standard(80, 24, { rail: true })).maxBodyRows).toBe(17);
    expect(box(standard(80, 24, { rail: true })).railRows).toBe(1);
    expect(box(standard(80, 24)).railRows).toBe(0);
  });
});

describe('the inspection popup', () => {
  it('is rows − 1 by columns − 2: 78 × 23 at 80×24, at the top, one column in', () => {
    const inspection = box(
      popupGeometry({
        columns: 80,
        rows: 24,
        kind: 'inspection',
        placement: 'overlay',
        rail: false,
      }),
    );
    expect([inspection.width, inspection.height, inspection.left, inspection.top]).toEqual([
      78, 23, 1, 0,
    ]);
  });

  it('always takes its whole height, whatever its body asks', () => {
    const inspection = box(
      popupGeometry({
        columns: 100,
        rows: 30,
        kind: 'inspection',
        placement: 'overlay',
        rail: false,
        bodyRows: 2,
      }),
    );
    expect(inspection.height).toBe(29);
    expect(inspection.width).toBe(98);
  });
});

describe('below the floor', () => {
  it.each([
    [79, 24],
    [80, 23],
    [60, 20],
    [Number.NaN, 24],
    [80.5, 24],
  ])('%s × %s is refused, so the host draws the notice', (columns, rows) => {
    expect(standard(columns, rows)).toEqual({ fits: false, reason: 'below-floor' });
  });
});

describe('a block in the flow (the inline renderer)', () => {
  const inline = (rows: number, extra: Partial<PopupGeometryInput> = {}) =>
    popupGeometry({
      columns: 80,
      rows,
      kind: 'standard',
      placement: 'replace',
      rail: false,
      ...extra,
    });

  it('keeps the whole live region at most rows − 1 lines, with what else the region draws', () => {
    expect(box(inline(24)).height).toBe(21);
    const shared = box(inline(24, { otherRows: 10 }));
    expect(shared.height + 10).toBeLessThanOrEqual(23);
    expect(shared.height).toBe(13);
  });

  it('is placed by the flow, not at a position of its own', () => {
    expect(box(inline(24, { bodyRows: 2 }))).toMatchObject({ left: 0, top: 0 });
  });

  it('windows a list to at most ten rows (the accessible mode)', () => {
    expect(box(inline(30)).listRows).toBe(INLINE_LIST_MAX_ROWS);
    expect(box(standard(80, 30)).listRows).toBe(18);
  });

  it('refuses when there is no room for its frame and one body row, and the host falls back to the notice', () => {
    expect(inline(24, { otherRows: 20 })).toEqual({ fits: false, reason: 'no-room' });
    expect(box(inline(24, { otherRows: 19 })).height).toBe(4);
  });

  it('the inspection kind inline is as tall as the region allows: rows − 1', () => {
    expect(
      box(
        popupGeometry({
          columns: 80,
          rows: 24,
          kind: 'inspection',
          placement: 'replace',
          rail: false,
        }),
      ).height,
    ).toBe(23);
  });
});
