import { describe, expect, it } from 'vitest';

import { parseMouseEvent, type MouseEvent } from './mouse.js';
import {
  cellAt,
  isCollapsed,
  lineSpan,
  normalizeSelection,
  reduceSelection,
  selectionText,
  splitRow,
  type SelectionRange,
  type SelectionViewport,
  routeMouseSelection,
  type SelectionRouterPorts,
  type SelectionState,
} from './selection.js';
import { sliceDisplayColumns } from './viewport.js';

/**
 * The pure selection state machine (2.6.F Step 6). Columns are DISPLAY CELLS, not character indices — the terminal
 * reports the cell a click landed on, and a CJK glyph or emoji occupies two of them. Getting that wrong silently
 * copies the wrong text, which is worse than copying nothing.
 */

const cell = (line: number, column: number): { line: number; column: number } => ({ line, column });
const range = (a: [number, number], b: [number, number]): SelectionRange =>
  normalizeSelection({ anchor: cell(...a), focus: cell(...b) });

describe('normalizeSelection + isCollapsed', () => {
  it('a plain CLICK is collapsed — it selects nothing and copies nothing (but still clears a prior selection)', () => {
    expect(isCollapsed({ anchor: cell(3, 5), focus: cell(3, 5) })).toBe(true);
    expect(isCollapsed({ anchor: cell(3, 5), focus: cell(3, 6) })).toBe(false);
  });

  it('puts a BACKWARD drag (up, or leftward on one line) into document order', () => {
    expect(normalizeSelection({ anchor: cell(5, 2), focus: cell(1, 9) })).toEqual({
      start: cell(1, 9),
      end: cell(5, 2),
    });
    expect(normalizeSelection({ anchor: cell(2, 9), focus: cell(2, 3) })).toEqual({
      start: cell(2, 3),
      end: cell(2, 9),
    });
  });

  it('leaves a forward drag alone', () => {
    expect(normalizeSelection({ anchor: cell(1, 0), focus: cell(4, 7) })).toEqual({
      start: cell(1, 0),
      end: cell(4, 7),
    });
  });
});

describe('lineSpan — what is highlighted on each row', () => {
  it('a line outside the selection has no span', () => {
    const r = range([2, 1], [4, 3]);
    expect(lineSpan(1, r)).toBeUndefined();
    expect(lineSpan(5, r)).toBeUndefined();
  });

  it('a single-line selection is [from, end+1) — the end cell is INCLUSIVE, as in every terminal', () => {
    expect(lineSpan(2, range([2, 3], [2, 6]))).toEqual({ from: 3, to: 7 });
  });

  it('the FIRST line runs to the end of the row (open-ended), the LAST from column 0', () => {
    const r = range([2, 4], [4, 2]);
    expect(lineSpan(2, r)).toEqual({ from: 4, to: undefined }); // to end of row
    expect(lineSpan(3, r)).toEqual({ from: 0, to: undefined }); // whole row
    expect(lineSpan(4, r)).toEqual({ from: 0, to: 3 });
  });
});

describe('sliceDisplayColumns — width-aware, the reason columns are cells', () => {
  it('slices ASCII like String.slice', () => {
    expect(sliceDisplayColumns('hello world', 0, 5)).toBe('hello');
    expect(sliceDisplayColumns('hello world', 6, 11)).toBe('world');
    expect(sliceDisplayColumns('hello', 3, 3)).toBe('');
  });

  it('takes the WHOLE wide character when either of its two cells is selected', () => {
    // 日 and 本 are 2 cells each: columns 0-1 and 2-3.
    expect(sliceDisplayColumns('日本語', 0, 1)).toBe('日'); // clicked its left half
    expect(sliceDisplayColumns('日本語', 1, 2)).toBe('日'); // clicked its right half
    expect(sliceDisplayColumns('日本語', 0, 4)).toBe('日本');
    expect(sliceDisplayColumns('日本語', 2, 6)).toBe('本語');
  });

  it('an emoji cluster (ZWJ / flag / keycap) is atomic — never split down the middle', () => {
    expect(sliceDisplayColumns('a👍b', 1, 2)).toBe('👍');
    expect(sliceDisplayColumns('a👍b', 0, 3)).toBe('a👍');
    expect(sliceDisplayColumns('👩‍👩‍👧b', 0, 1)).toBe('👩‍👩‍👧'); // one grapheme, 2 cells
  });

  it('a zero-width combining mark rides its base — it is never orphaned onto a base it does not modify', () => {
    const eAcute = 'é'; // e + COMBINING ACUTE
    expect(sliceDisplayColumns(`x${eAcute}y`, 1, 2)).toBe(eAcute); // the mark comes with its `e`
    expect(sliceDisplayColumns(`x${eAcute}y`, 0, 1)).toBe('x'); // …and never with the `x` before it
  });

  it('truncates past the end of the row rather than throwing (a drag beyond a short line)', () => {
    expect(sliceDisplayColumns('hi', 0, 999)).toBe('hi');
    expect(sliceDisplayColumns('hi', 5, 999)).toBe('');
  });
});

describe('selectionText — what lands on the clipboard', () => {
  const lines = ['first line', 'second line', 'third line', '日本語です'];

  it('a single-line selection copies exactly the highlighted cells', () => {
    expect(selectionText(lines, range([0, 0], [0, 4]))).toBe('first');
    expect(selectionText(lines, range([1, 7], [1, 10]))).toBe('line');
  });

  it('a multi-line selection copies first-partial, whole-middle, last-partial — `\\n`-joined', () => {
    expect(selectionText(lines, range([0, 6], [2, 4]))).toBe('line\nsecond line\nthird');
  });

  it('a backward drag copies the same text as the forward one', () => {
    expect(selectionText(lines, range([2, 4], [0, 6]))).toBe('line\nsecond line\nthird');
  });

  it('copies wide characters whole, by CELL', () => {
    expect(selectionText(lines, range([3, 0], [3, 3]))).toBe('日本'); // cells 0..3 ⇒ two glyphs
  });

  it('a selection that outruns the transcript copies what still exists (never throws)', () => {
    expect(selectionText(lines, range([2, 0], [9, 0]))).toBe('third line\n日本語です');
    expect(selectionText([], range([0, 0], [3, 3]))).toBe('');
  });

  it('a collapsed selection copies a single cell — the caller decides not to copy at all', () => {
    // `isCollapsed` is the guard; `selectionText` is total, so it must still behave on the degenerate range.
    expect(selectionText(lines, range([0, 0], [0, 0]))).toBe('f');
  });
});

/**
 * `splitRow` — what the viewport actually draws. The highlight is an ANSI `inverse` attribute, which a frame snapshot
 * cannot see, so the SPLIT is where correctness has to be pinned: get it wrong and the user sees the wrong characters
 * highlighted, then copies exactly what was highlighted, and never learns why.
 */
describe('splitRow — the three pieces the viewport renders', () => {
  it('an open-ended span highlights to the end of the row (an inner row of a multi-line selection)', () => {
    expect(splitRow('hello world', { from: 6, to: undefined })).toEqual({
      before: 'hello ',
      selected: 'world',
      after: '',
    });
    expect(splitRow('hello', { from: 0, to: undefined })).toEqual({
      before: '',
      selected: 'hello',
      after: '',
    });
  });

  it('a bounded span leaves a tail (a single-line selection, or the last row)', () => {
    expect(splitRow('hello world', { from: 0, to: 5 })).toEqual({
      before: '',
      selected: 'hello',
      after: ' world',
    });
    expect(splitRow('hello world', { from: 2, to: 4 })).toEqual({
      before: 'he',
      selected: 'll',
      after: 'o world',
    });
  });

  it('a span that starts PAST the row selects nothing and leaves the row whole (a drag over a short line)', () => {
    expect(splitRow('hi', { from: 40, to: undefined })).toEqual({
      before: 'hi',
      selected: '',
      after: '',
    });
  });

  it('reassembles losslessly — before + selected + after is always the original row', () => {
    // The degenerate rows are the point. A LEADING zero-width cluster (a combining mark, a ZWJ, a lone variation
    // selector) has no cell of its own and no cluster before it to ride. Until the Step-6 review it matched neither
    // membership test and fell into `after`, physically moving it PAST its base — `'\u0301ab'` came back as
    // `'ab\u0301'` — and dropping it from the copy. A row that is ENTIRELY zero-width has no cell at all.
    const rows = [
      'hello world',
      '日本語です',
      'a👍b',
      'x',
      '\u0301ab',
      '\u200dab',
      '\ufe0fab',
      'aéb',
      '\u0301',
      'a\u0001b',
    ];
    const spans = [
      { from: 0, to: undefined },
      { from: 1, to: 3 },
      { from: 2, to: undefined },
      { from: 0, to: 1 },
      { from: 99, to: undefined },
      { from: 1, to: 1 }, // degenerate: selects nothing, and must still not lose or move a cluster
    ];
    for (const row of rows) {
      for (const span of spans) {
        const { before, selected, after } = splitRow(row, span);
        expect(before + selected + after, `${row} @ ${span.from}..${String(span.to)}`).toBe(row);
      }
    }
  });

  it('a MID-ROW zero-width cluster rides the cluster before it (the defensive control-character path)', () => {
    // UAX#29 (GB9) absorbs every combining mark / ZWJ into the preceding cluster, so the only way to get a width-0
    // cluster that is NOT the first one is a C0/C1 control — which `sanitizeInline` strips upstream, making this the
    // walker's DEFENSIVE branch. Pinned anyway: without it the control is emitted into the tail and the row no longer
    // reassembles (`'a\u0001b'` comes back as `'ab\u0001'`), which a break-verify proved nothing else catches.
    expect(splitRow('a\u0001b', { from: 1, to: 2 })).toEqual({
      before: 'a\u0001',
      selected: 'b',
      after: '',
    });
  });

  it('a DEGENERATE span selects nothing — and the wide glyph it straddles is not silently highlighted', () => {
    // `sliceDisplayColumns` guards `endColumn <= startColumn` and copies ''. `partitionDisplayColumns` did not, so the
    // intersect rule highlighted `日` (cells 0-1 straddle column 1) while the clipboard got '' — the one thing
    // copy-on-select must never do (Step-6 Opus review). Unreachable through `lineSpan` today; structural now.
    expect(splitRow('日本語です', { from: 1, to: 1 })).toEqual({
      before: '日',
      selected: '',
      after: '本語です',
    });
  });

  it('a LEADING zero-width cluster stays with the base it precedes, in both the highlight and the copy', () => {
    expect(splitRow('\u0301ab', { from: 0, to: 1 })).toEqual({
      before: '',
      selected: '\u0301a', // the mark has no cell; it rides the first cluster that does
      after: 'b',
    });
    expect(splitRow('\u0301ab', { from: 1, to: 2 })).toEqual({
      before: '\u0301a',
      selected: 'b',
      after: '',
    });
  });

  it('never splits a wide character or an emoji cluster down the middle', () => {
    expect(splitRow('日本語', { from: 1, to: 3 })).toEqual({
      before: '',
      selected: '日本', // both glyphs — cells 0-1 and 2-3 each intersect [1,3)
      after: '語',
    });
    expect(splitRow('a👍b', { from: 1, to: 2 })).toEqual({
      before: 'a',
      selected: '👍',
      after: 'b',
    });
  });
});

/**
 * THE invariant of copy-on-select: what the user sees highlighted is EXACTLY what lands on their clipboard. The
 * highlight comes from `splitRow` (a partition), the clipboard from `selectionText` (`sliceDisplayColumns`). They are
 * different functions and could drift; a user would never discover it, because both look right in isolation.
 */
describe('the highlight and the clipboard agree, character for character', () => {
  const rows = [
    'hello world',
    '日本語です',
    'a👍b',
    '',
    'x',
    'aéb',
    '\u0301ab',
    '\u200dab',
    '\u0301',
  ];

  it('splitRow().selected === the text selectionText would copy for that row', () => {
    for (const row of rows) {
      for (const from of [0, 1, 2, 3]) {
        for (const to of [undefined, 1, 2, 4, 99]) {
          if (to !== undefined && to <= from) continue;
          const highlighted = splitRow(row, { from, to }).selected;
          // `selectionText` indexes by ABSOLUTE line, so hand it a one-row transcript. `end` is inclusive.
          const copied = selectionText([row], {
            start: cell(0, from),
            end: cell(0, (to ?? Number.MAX_SAFE_INTEGER) - 1),
          });
          expect(copied, `"${row}" @ ${from}..${String(to)}`).toBe(highlighted);
        }
      }
    }
  });
});

/** A viewport starting at frame row 3 (a Home-style header above it), 10 rows tall, scrolled to line 100. */
const VP: SelectionViewport = { top: 3, left: 0, height: 10, totalLines: 500, offset: 100 };

/** Parse a real SGR report, so the reducer is exercised through the same bytes a terminal sends. Throws rather than
 *  asserting non-null: a typo in a test's escape would otherwise silently reduce `undefined` and pass. */
const ev = (sgr: string): MouseEvent => {
  const parsed = parseMouseEvent(sgr);
  if (parsed === undefined) throw new Error(`not a mouse report: ${JSON.stringify(sgr)}`);
  return parsed;
};

describe('cellAt — terminal cell → wrapped-transcript cell', () => {
  it('frame row 0 is TERMINAL row 1: the viewport’s first row maps to the scroll offset', () => {
    expect(cellAt(4, 1, VP)).toEqual(cell(100, 0)); // row 4 = frame row 3 = the viewport's first
    expect(cellAt(5, 7, VP)).toEqual(cell(101, 6));
  });

  it('CLAMPS a drag above the viewport to its first line — not to a negative index', () => {
    expect(cellAt(1, 1, VP)).toEqual(cell(100, 0)); // the header rows
    expect(cellAt(-5, 1, VP)).toEqual(cell(100, 0));
  });

  it('CLAMPS a drag below the viewport to its last visible line', () => {
    expect(cellAt(13, 1, VP)).toEqual(cell(109, 0)); // top 3 + height 10 ⇒ last visible frame row 12
    expect(cellAt(99, 1, VP)).toEqual(cell(109, 0));
  });

  it('CLAMPS a drag left of the viewport to column 0', () => {
    expect(cellAt(4, 0, { ...VP, left: 2 })).toEqual(cell(100, 0));
  });

  it('never indexes past the transcript (a short transcript in a tall viewport)', () => {
    const short: SelectionViewport = { top: 0, left: 0, height: 10, totalLines: 3, offset: 0 };
    expect(cellAt(9, 1, short)).toEqual(cell(2, 0)); // row 9 ⇒ visible row 8, but only 3 lines exist
  });

  it('an EMPTY transcript maps everything to line 0 (never -1)', () => {
    const empty: SelectionViewport = { top: 0, left: 0, height: 10, totalLines: 0, offset: 0 };
    expect(cellAt(5, 5, empty)).toEqual(cell(0, 4));
  });
});

describe('reduceSelection — the shared gesture, so the two surfaces cannot drift', () => {
  it('a LEFT press starts a collapsed selection (a click alone highlights nothing)', () => {
    const action = reduceSelection(undefined, ev('[<0;5;5M'), VP);
    expect(action).toEqual({ kind: 'set', state: { anchor: cell(101, 4), focus: cell(101, 4) } });
    expect(isCollapsed({ anchor: cell(101, 4), focus: cell(101, 4) })).toBe(true);
  });

  it('MIDDLE and RIGHT presses leave a live selection alone (they paste / open a menu in emulators)', () => {
    const live = { anchor: cell(100, 0), focus: cell(102, 3) };
    expect(reduceSelection(live, ev('[<1;5;5M'), VP)).toEqual({ kind: 'none' });
    expect(reduceSelection(live, ev('[<2;5;5M'), VP)).toEqual({ kind: 'none' });
  });

  it('a DRAG moves the focus and keeps the anchor', () => {
    const started = { anchor: cell(100, 0), focus: cell(100, 0) };
    expect(reduceSelection(started, ev('[<32;9;7M'), VP)).toEqual({
      kind: 'set',
      state: { anchor: cell(100, 0), focus: cell(103, 8) },
    });
  });

  it('a drag with NO press before it does nothing (a stray report after a re-render)', () => {
    expect(reduceSelection(undefined, ev('[<32;9;7M'), VP)).toEqual({ kind: 'none' });
  });

  it('RELEASE after a real drag COPIES, and keeps the highlight (as every terminal does)', () => {
    const dragged = { anchor: cell(100, 0), focus: cell(102, 5) };
    expect(reduceSelection(dragged, ev('[<0;6;8m'), VP)).toEqual({ kind: 'copy', state: dragged });
  });

  it('RELEASE after a plain click CLEARS — it must not copy a single character', () => {
    const clicked = { anchor: cell(101, 4), focus: cell(101, 4) };
    expect(reduceSelection(clicked, ev('[<0;5;5m'), VP)).toEqual({ kind: 'clear' });
  });

  it('a MIDDLE or RIGHT release leaves a live selection alone — it must NOT re-copy it', () => {
    // SGR encodes the released button (xterm ctlseqs: the `m` byte exists "to resolve the X10 ambiguity regarding
    // which button was released"). Without reading it, every right-click while a selection was live re-emitted the
    // whole selection over OSC 52 (Step-6 Opus review).
    const dragged = { anchor: cell(2, 3), focus: cell(2, 8) };
    expect(reduceSelection(dragged, ev('[<2;9;7m'), VP)).toEqual({ kind: 'none' }); // right
    expect(reduceSelection(dragged, ev('[<1;9;7m'), VP)).toEqual({ kind: 'none' }); // middle
  });

  it('a release from a terminal reporting the X10 "no button" code 3 still ENDS the gesture', () => {
    // Honour the legacy meaning: "some button came up". Treating it as `none` would strand the drag — the selection
    // would neither copy nor clear, and the next press would look like a drag continuation.
    const dragged = { anchor: cell(2, 3), focus: cell(2, 8) };
    expect(reduceSelection(dragged, ev('[<3;9;7m'), VP)).toEqual({ kind: 'copy', state: dragged });
    const clicked = { anchor: cell(2, 3), focus: cell(2, 3) };
    expect(reduceSelection(clicked, ev('[<3;4;5m'), VP)).toEqual({ kind: 'clear' });
  });

  it('the WHEEL never touches the selection — it belongs to reduceScroll', () => {
    const live = { anchor: cell(100, 0), focus: cell(102, 3) };
    expect(reduceSelection(live, ev('[<64;5;5M'), VP)).toEqual({ kind: 'none' });
    expect(reduceSelection(live, ev('[<65;5;5M'), VP)).toEqual({ kind: 'none' });
  });

  it('a horizontal wheel / exotic button is inert (still CONSUMED by the caller)', () => {
    expect(reduceSelection(undefined, ev('[<66;1;1M'), VP)).toEqual({ kind: 'none' });
  });

  it('a BACKWARD drag (up-left) produces a selection that copies the same text', () => {
    const started = { anchor: cell(105, 5), focus: cell(105, 5) };
    const dragged = reduceSelection(started, ev('[<32;2;5M'), VP); // up and to the left
    expect(dragged).toEqual({ kind: 'set', state: { anchor: cell(105, 5), focus: cell(101, 1) } });
    if (dragged.kind !== 'set') throw new Error('unreachable');
    expect(normalizeSelection(dragged.state)).toEqual({ start: cell(101, 1), end: cell(105, 5) });
  });
});

/**
 * The three things the pure reducer cannot own, because they touch SCROLL state (2.6.F Step 6f, Opus review). Pinned
 * against a fake port set rather than a mounted ink tree, so each rule is readable on its own; `chat-app.test.tsx`
 * and `home-app.test.tsx` then pin the assembly.
 */
describe('routeMouseSelection — the scroll-aware half of a gesture', () => {
  const VIEWPORT: SelectionViewport = { top: 2, left: 0, height: 5, totalLines: 100, offset: 40 };

  /**
   * The fake ports MODEL the scroll: `scrollBy` moves `offset`, and `geometry()` reads it. Without that a break that
   * maps the focus BEFORE the scroll instead of after stays green — the whole point of the ordering is that the
   * second `geometry()` call sees a different offset. `pauseFollow` likewise records the follow flag exactly as the
   * surfaces do, so a double-`pauseFollow` loses the memory here too.
   */
  const ports = (
    overrides: Partial<SelectionRouterPorts> = {},
  ): SelectionRouterPorts & {
    log: string[];
    selection: () => SelectionState | undefined;
    following: () => boolean;
  } => {
    const log: string[] = [];
    let selection: SelectionState | undefined;
    let offset = VIEWPORT.offset;
    let following = true;
    let followedBefore = false;
    let gesture = false;
    const base: SelectionRouterPorts = {
      geometry: () => ({ ...VIEWPORT, offset }),
      current: () => selection,
      setSelection: (s_) => {
        selection = s_;
        log.push(s_ === undefined ? 'clear' : `set ${s_.anchor.line}->${s_.focus.line}`);
      },
      copy: () => log.push('copy'),
      scrollBy: (m) => {
        offset += m === 'line-down' ? 1 : -1;
        log.push(`scroll ${m}`);
      },
      pauseFollow: () => {
        followedBefore = following;
        following = false;
        log.push('pauseFollow');
      },
      restoreFollow: () => {
        if (followedBefore) following = true;
        log.push('restoreFollow');
      },
      gestureActive: () => gesture,
      setGestureActive: (active) => {
        gesture = active;
      },
      ...overrides,
    };
    return { ...base, log, selection: () => selection, following: () => following };
  };

  it('a PRESS below the viewport (the prompt) starts nothing — it must not anchor on the last visible line', () => {
    // `cellAt` clamps by design, for drags. Clamping a PRESS anchors it to the viewport's last line, so the user drags
    // across, and copies, text they never pressed on (Step-6 completeness critic).
    const p = ports();
    routeMouseSelection(ev('[<0;5;9M'), p); // terminal row 9 = frame row 8; the viewport ends at frame row 6
    expect(p.log).toEqual([]);
    expect(p.selection()).toBeUndefined();
  });

  it('a PRESS above the viewport (the Home’s management strip) starts nothing', () => {
    const p = ports();
    routeMouseSelection(ev('[<0;5;1M'), p); // terminal row 1 = frame row 0; the viewport starts at frame row 2
    expect(p.log).toEqual([]);
  });

  it('a PRESS on the viewport’s first and last rows DOES start a selection (they are inside it)', () => {
    const first = ports();
    routeMouseSelection(ev('[<0;5;3M'), first); // frame row 2 === top
    expect(first.selection()).toBeDefined();
    const last = ports();
    routeMouseSelection(ev('[<0;5;7M'), last); // frame row 6 === top + height - 1
    expect(last.selection()).toBeDefined();
  });

  it('a DRAG on the viewport’s LAST row scrolls down BEFORE the focus is mapped', () => {
    // Without this a selection can never exceed one screenful: `cellAt` clamps the focus to the last visible line, so
    // dragging further down just re-selects the same row. And the ORDER is load-bearing: the focus must be mapped
    // against the offset the scroll just produced, or the selection lags a line behind the pointer forever.
    const p = ports();
    routeMouseSelection(ev('[<0;5;5M'), p); // press, inner row (frame row 4 ⇒ line 40 + 2 = 42)
    p.log.length = 0;
    routeMouseSelection(ev('[<32;5;7M'), p); // drag to the last row (frame row 6)
    expect(p.log).toEqual(['scroll line-down', 'set 42->45']);
    // offset 41 + visibleRow 4 = 45. Mapping before the scroll would give 44 — a line the pointer has left behind.
  });

  it('a sustained DRAG down the edge extends the selection one line per report', () => {
    const p = ports();
    routeMouseSelection(ev('[<0;5;5M'), p);
    for (let i = 0; i < 3; i += 1) routeMouseSelection(ev('[<32;5;7M'), p);
    expect(p.selection()?.focus.line).toBe(47); // 45, 46, 47 — it really keeps growing
    expect(p.selection()?.anchor.line).toBe(42); // …and the anchor never moves
  });

  it('a DRAG on the viewport’s FIRST row scrolls up — the only signal there is, since nothing is above it', () => {
    const p = ports();
    routeMouseSelection(ev('[<0;5;5M'), p);
    p.log.length = 0;
    routeMouseSelection(ev('[<32;5;3M'), p); // drag to the first row
    expect(p.log[0]).toBe('scroll line-up');
  });

  it('a DRAG on an INNER row never scrolls', () => {
    const p = ports();
    routeMouseSelection(ev('[<0;5;4M'), p);
    p.log.length = 0;
    routeMouseSelection(ev('[<32;9;5M'), p);
    expect(p.log.filter((l) => l.startsWith('scroll'))).toEqual([]);
  });

  it('a DRAG with no press before it neither scrolls nor selects', () => {
    const p = ports();
    routeMouseSelection(ev('[<32;5;7M'), p); // last row, but no gesture in flight
    expect(p.log).toEqual([]);
  });

  it('a PRESS freezes auto-follow, so a completing turn cannot slide the transcript under the pointer', () => {
    const p = ports();
    routeMouseSelection(ev('[<0;5;5M'), p);
    expect(p.log).toContain('pauseFollow');
  });

  it('a plain CLICK restores auto-follow — pausing it for a click would silently stop the stream', () => {
    const p = ports();
    routeMouseSelection(ev('[<0;5;5M'), p); // press
    routeMouseSelection(ev('[<0;5;5m'), p); // release at the same cell ⇒ collapsed ⇒ clear
    expect(p.log).toEqual(['set 42->42', 'pauseFollow', 'clear', 'restoreFollow']);
  });

  it('a drag that RETURNS to its anchor still restores auto-follow — pauseFollow must run once, on the press', () => {
    // A second `pauseFollow` overwrites the remembered flag with the already-false `following`, so the `clear` that
    // follows silently fails to restore it. The user presses, wiggles, lets go on the same cell — and the transcript
    // has quietly stopped following the stream, with nothing on screen to say why.
    const p = ports();
    routeMouseSelection(ev('[<0;5;5M'), p); // press
    routeMouseSelection(ev('[<32;9;5M'), p); // drag away
    routeMouseSelection(ev('[<32;5;5M'), p); // …and back to the anchor cell
    routeMouseSelection(ev('[<0;5;5m'), p); // release ⇒ collapsed ⇒ clear
    expect(p.log.filter((l) => l === 'pauseFollow')).toHaveLength(1);
    expect(p.following()).toBe(true);
  });

  it('a real DRAG keeps auto-follow frozen after the copy', () => {
    const p = ports();
    routeMouseSelection(ev('[<0;5;5M'), p);
    routeMouseSelection(ev('[<32;9;5M'), p);
    routeMouseSelection(ev('[<0;9;5m'), p);
    expect(p.log).toContain('copy');
    expect(p.log).not.toContain('restoreFollow');
  });

  it('a MIDDLE/RIGHT press neither freezes follow nor disturbs the selection', () => {
    const p = ports();
    routeMouseSelection(ev('[<0;5;5M'), p);
    p.log.length = 0;
    routeMouseSelection(ev('[<2;9;5M'), p);
    expect(p.log).toEqual([]);
  });

  it('a stray click OUTSIDE the viewport after a copy does not re-copy the retained highlight', () => {
    // The gesture-gating bug (Step-6h review): after a drag-copy the highlight is RETAINED, so `current` is a real
    // non-collapsed selection. A left press on the prompt returns `none` (outside the viewport), leaving that
    // selection — and the following release used to see a non-collapsed `current` and re-emit it over OSC 52.
    const p = ports();
    routeMouseSelection(ev('[<0;5;5M'), p); // press inside…
    routeMouseSelection(ev('[<32;9;5M'), p); // …drag…
    routeMouseSelection(ev('[<0;9;5m'), p); // …release ⇒ copy
    expect(p.log.filter((l) => l === 'copy')).toHaveLength(1);
    const held = p.selection();
    p.log.length = 0;

    // The prompt is at terminal row 9 = frame row 8; the viewport spans frame rows 2..6. Both press and release miss.
    routeMouseSelection(ev('[<0;5;9M'), p); // press on the prompt ⇒ no gesture
    routeMouseSelection(ev('[<0;5;9m'), p); // release ⇒ must NOT copy
    expect(p.log).toEqual([]); // no copy, no clear, no mutation
    expect(p.selection()).toBe(held); // the highlight is preserved, byte-for-byte
  });

  it('a DRAG whose press missed the viewport cannot resurrect a retained selection', () => {
    const p = ports();
    routeMouseSelection(ev('[<0;5;5M'), p); // a real gesture…
    routeMouseSelection(ev('[<32;9;5M'), p);
    routeMouseSelection(ev('[<0;9;5m'), p); // …copied, gesture closed
    const held = p.selection();
    p.log.length = 0;

    routeMouseSelection(ev('[<0;5;9M'), p); // press on the prompt ⇒ no gesture
    routeMouseSelection(ev('[<32;9;5M'), p); // a drag with the button held, back into the viewport
    expect(p.log).toEqual([]); // no scroll, no set
    expect(p.selection()).toBe(held);
  });
});
