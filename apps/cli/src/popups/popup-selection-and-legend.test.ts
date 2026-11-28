/**
 * Review round 3: the reducer rules of fix wave 2 that no test pinned. A highlight whose row is gone from replaced content goes to the
 * nearest row that can act (`nearestEnabled`, M2-12) and a page keeps its place on a line that cannot act (`holdable`); a page walks every line
 * only while it overflows its page (`walkable`, the boundary being a page of exactly the rows it has); a step that gives `[Ctrl+C] close` way
 * does so only where the row cannot hold it, to the column (`closeGivesWay`), and every other step keeps it.
 */
import { describe, expect, it } from 'vitest';

import { legend } from '../render/tui/legend.js';
import { displayWidth } from '../render/tui/viewport.js';
import type { PopupContent, PopupListRow } from './frame-model.js';
import {
  foldPopupAction,
  highlightedRow,
  openFrame,
  popupLegend,
  withContent,
  type PopupFrame,
  type PopupSpec,
  type PopupStep,
} from './popup-reducer.js';

const row = (id: string, extra: Partial<PopupListRow> = {}): PopupListRow => ({
  id,
  label: id,
  ...extra,
});
const disabled = (id: string): PopupListRow => row(id, { enabled: false, reason: 'not now' });
const list = (...rows: PopupListRow[]): PopupContent => ({ kind: 'list', rows });
const specOf = (content: PopupContent, extra: Partial<PopupStep> = {}): PopupSpec => ({
  id: 't',
  title: '/t',
  origin: 'chat',
  steps: [{ name: 'A', content, enter: 'choose', ...extra }],
});

/** The frame on `content` with the highlight on the row `onId`, then `next` landed in the step (what a refresh or a withdrawal does). */
function landed(content: PopupContent, onId: string, next: PopupContent): PopupFrame {
  const opened = openFrame(specOf(content), 1);
  let frame = opened;
  for (let press = 0; press < 20 && highlightedRow(frame)?.id !== onId; press += 1) {
    const fold = foldPopupAction(frame, { kind: 'move', delta: 1 }, 10);
    if (fold.kind !== 'frame') break;
    frame = fold.frame;
  }
  expect(highlightedRow(frame)?.id, 'the rig reached the row').toBe(onId);
  return withContent(frame, 0, next);
}

describe('the highlight after the row it stood on is gone: the nearest row that can act (M2-12)', () => {
  const abcd = list(row('a'), row('b'), row('c'), row('d'));

  it('a row in the middle gone: the highlight stays on that place, which is the next row now', () => {
    expect(highlightedRow(landed(abcd, 'b', list(row('a'), row('c'), row('d'))))?.id).toBe('c');
  });

  it('the FIRST row gone: the highlight stays on the top, which is the next row now (not the one after it)', () => {
    expect(highlightedRow(landed(abcd, 'a', list(row('b'), row('c'), row('d'))))?.id).toBe('b');
  });

  it('the LAST row gone: the highlight goes to the new last row, not to the top', () => {
    expect(highlightedRow(landed(abcd, 'd', list(row('a'), row('b'), row('c'))))?.id).toBe('c');
  });

  it('a row that cannot act is passed over: forward first, and backward when nothing forward can act', () => {
    expect(highlightedRow(landed(abcd, 'b', list(row('a'), disabled('x'), row('d'))))?.id).toBe(
      'd',
    );
    expect(highlightedRow(landed(abcd, 'c', list(row('a'), row('b'), disabled('x'))))?.id).toBe(
      'b',
    );
    expect(
      highlightedRow(landed(abcd, 'd', list(row('a'), disabled('x'), disabled('y'))))?.id,
    ).toBe('a');
  });

  it('no row can act at all: the highlight is on the top row, never on the last', () => {
    const frame = landed(list(row('a')), 'a', list(disabled('x'), disabled('y'), disabled('z')));
    expect(frame.steps[0]?.selected).toBe(0);
  });
});

describe('a page keeps its place on a line that cannot act when its content is replaced (`holdable`)', () => {
  const heading = (id: string): PopupListRow => ({ id, label: id, section: true, enabled: false });
  const page = (...rows: PopupListRow[]): PopupContent => ({ kind: 'list', page: true, rows });

  /** A step showing `rows` as a page, the highlight put on the row `at` (a page walks every line only when it overflows: set directly). */
  function onLine(content: PopupContent, at: number): PopupFrame {
    const opened = openFrame(specOf(content), 1);
    return { ...opened, steps: opened.steps.map((state) => ({ ...state, selected: at })) };
  }

  const rows = [heading('head'), heading('inputs'), heading('files'), row('run:0'), row('run:1')];

  it('the same page landing again (a pin changes a fact, not the lines): the highlight stays on the line it was on, by id', () => {
    const frame = withContent(onLine(page(...rows), 2), 0, page(...rows));
    expect(highlightedRow(frame)?.id).toBe('files');
  });

  it('the line it stood on moved: it follows the line, whether the line can act or not', () => {
    const frame = withContent(
      onLine(page(...rows), 2),
      0,
      page(heading('head'), heading('new'), heading('inputs'), heading('files'), row('run:0')),
    );
    expect(highlightedRow(frame)?.id).toBe('files');
  });

  it('the line it stood on is gone: the line now at its place (any line), not the first run', () => {
    const frame = withContent(
      onLine(page(...rows), 2),
      0,
      page(heading('head'), heading('inputs'), heading('other'), row('run:0'), row('run:1')),
    );
    expect(highlightedRow(frame)?.id).toBe('other');
  });
});

describe('a page walks every line only while it OVERFLOWS its page (`walkable`), the boundary included', () => {
  const lines = (count: number): PopupListRow[] => [
    { id: 'head', label: 'head', section: true, enabled: false },
    ...Array.from({ length: count - 3 }, (_, at) => ({
      id: `line:${String(at)}`,
      label: `line ${String(at)}`,
      section: true as const,
      enabled: false as const,
    })),
    row('run:0'),
    row('run:1'),
  ];
  const page = (count: number): PopupFrame => {
    const opened = openFrame(specOf({ kind: 'list', page: true, rows: lines(count) }), 1);
    // A page lands at its title (what `withContent` does from a step that showed no list).
    return { ...opened, steps: opened.steps.map((state) => ({ ...state, selected: 0 })) };
  };
  /** A page whose lines all cannot act (no last run), landing at its title. */
  const noRuns = (count: number): PopupFrame => {
    const rows = Array.from({ length: count }, (_, at) => ({
      id: `line:${String(at)}`,
      label: `line ${String(at)}`,
      section: true as const,
      enabled: false as const,
    }));
    const opened = openFrame(specOf({ kind: 'list', page: true, rows }), 1);
    return { ...opened, steps: opened.steps.map((state) => ({ ...state, selected: 0 })) };
  };
  const down = (frame: PopupFrame, pageRows: number): string | undefined => {
    const fold = foldPopupAction(frame, { kind: 'move', delta: 1 }, pageRows);
    return fold.kind === 'frame' ? highlightedRow(fold.frame)?.id : undefined;
  };

  it('a page of exactly the rows it is drawn in FITS: `↓` lands on the first run, not on the next line', () => {
    expect(down(page(8), 8)).toBe('run:0');
  });

  it('a page of one more row than its page overflows: `↓` walks to the next line', () => {
    expect(down(page(9), 8)).toBe('line:0');
  });

  it('a page of fewer rows fits too', () => {
    expect(down(page(8), 9)).toBe('run:0');
  });

  it('a page with no row that can act: an arrow, a page or a jump moves nothing, and the highlight never stands past the rows', () => {
    const open = page(7);
    const none = open.steps[0]?.content.kind === 'list' ? open.steps[0].content.rows.length : 0;
    expect(none).toBe(7);
    for (const action of [
      { kind: 'move', delta: 1 },
      { kind: 'move', delta: -1 },
      { kind: 'page', delta: 1 },
      { kind: 'page', delta: -1 },
      { kind: 'jump', to: 'last' },
      { kind: 'jump', to: 'first' },
    ] as const) {
      const fold = foldPopupAction(noRuns(7), action, 10);
      expect(fold.kind, JSON.stringify(action)).toBe('unchanged');
    }
  });

  it('the legend judges the same boundary: a page of exactly its rows says `↑/↓ select`, one more says `↑/↓ scroll`', () => {
    const wide = 120;
    const text = (count: number, pageRows: number): string => {
      const parts = popupLegend(page(count), pageRows, wide);
      return legend(parts.items, parts.exit);
    };
    expect(text(8, 8)).toContain('↑/↓ select');
    expect(text(8, 8)).not.toContain('scroll');
    expect(text(9, 8)).toContain('↑/↓ scroll');
    expect(text(9, 8)).not.toContain('select');
  });
});

describe('a list to choose from is never scrolled line by line: only a page of lines says `↑/↓ scroll`', () => {
  it('a plain list longer than its page says `↑/↓ select` and names no pages', () => {
    const frame = openFrame(
      specOf(list(...Array.from({ length: 12 }, (_, at) => row(`r${String(at)}`)))),
      1,
    );
    const parts = popupLegend(frame, 5, 120);
    const text = legend(parts.items, parts.exit);
    expect(text).toContain('↑/↓ select');
    expect(text).not.toContain('scroll');
    expect(text).not.toContain('PgUp');
  });
});

describe('`[Ctrl+C] close` gives way only on a step that says so, and only where the row cannot hold it, to the column', () => {
  const CONTROLS = [
    { key: 'r', verb: 'run' },
    { key: 'x', verb: 'export' },
    { key: 'p', verb: 'pin' },
  ];
  /** A second step (so `Esc` goes back and `Ctrl+C` is named), with `extra` set on it. */
  const stepped = (extra: Partial<PopupStep>): PopupFrame => ({
    ...openFrame(
      {
        id: 't',
        title: '/t',
        origin: 'chat',
        steps: [
          { name: 'List', content: list(row('a'), row('b')), enter: 'open' },
          {
            name: 'Detail',
            content: list(row('a'), row('b')),
            enter: 'open',
            back: 0,
            controls: CONTROLS,
            ...extra,
          },
        ],
      },
      1,
    ),
    stepIndex: 1,
  });
  const keys = (frame: PopupFrame, width: number): readonly string[] =>
    popupLegend(frame, 17, width).items.flatMap((item) =>
      'keys' in item ? [item.keys].flat() : [],
    );
  const wholeWidth = (frame: PopupFrame): number => {
    const parts = popupLegend(frame, 17, 200);
    return displayWidth(legend(parts.items, parts.exit));
  };

  it('a step that does not give way keeps it to the last, however narrow the row', () => {
    const frame = stepped({});
    expect(keys(frame, 200)).toContain('Ctrl+C');
    expect(keys(frame, 20)).toContain('Ctrl+C');
    expect(keys(frame, 5)).toContain('Ctrl+C');
  });

  it('a step that gives way keeps it where the whole legend fits the row exactly, and drops it one column short', () => {
    const frame = stepped({ closeGivesWay: true });
    const whole = wholeWidth(frame);
    expect(keys(frame, 200)).toContain('Ctrl+C');
    expect(keys(frame, whole), 'exactly the width').toContain('Ctrl+C');
    expect(keys(frame, whole - 1), 'one column short').not.toContain('Ctrl+C');
    // The letters that act are never what goes for it.
    expect(keys(frame, whole - 1)).toEqual(expect.arrayContaining(['r', 'x', 'p']));
  });
});
