/**
 * A list row's effect ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3: a setting
 * states its effect before it applies; the `/mode` frame, `popup-mode-chat-80x24.png`): the highlighted row's effect is a paragraph wrapped
 * under the list, with the room of the longest effect kept whichever row is highlighted, so the frame never jumps; a list none of whose rows
 * has one is drawn exactly as before. And the one filter of a list: what the body draws is what the key fold selects in.
 */
import { describe, expect, it } from 'vitest';

import { withGlyphForm } from '../render/tui/glyphs.js';
import { displayWidth } from '../render/tui/viewport.js';
import {
  bodyPageRows,
  filterListRows,
  naturalBodyRows,
  popupBody,
  type PopupContent,
  type PopupListRow,
} from './frame-model.js';
import { INLINE_LIST_MAX_ROWS, popupInnerWidth } from './geometry.js';
import {
  currentStep,
  foldPopupAction,
  openFrame,
  popupLegend,
  reducePopupKey,
  type PopupFrame,
  type PopupSpec,
} from './popup-reducer.js';

const WIDTH = popupInnerWidth(80, 'standard');
const AUTO_EFFECT =
  'auto approves granted actions without asking; a command still asks unless you remembered or approved it; scope and protected-path rules still apply.';

const MODES: readonly PopupListRow[] = [
  { id: 'ask', label: 'ask', detail: 'asks before every effect' },
  { id: 'plan', label: 'plan', detail: 'only reads' },
  {
    id: 'accept-edits',
    label: 'accept-edits',
    detail: 'applies file edits without a card',
    effect: 'Files are edited without asking; commands and network still ask.',
  },
  {
    id: 'auto',
    label: 'auto',
    detail: 'runs governed actions without asking',
    effect: AUTO_EFFECT,
  },
];
const LIST: PopupContent = { kind: 'list', rows: MODES };

const body = (
  content: PopupContent,
  selected: number,
  geometry = { bodyRows: 20, listRows: 20, innerWidth: WIDTH },
  filter?: string,
): string[] =>
  withGlyphForm(false, () =>
    popupBody(content, { selected, offset: 0, filter }, geometry).lines.map((line) => line.text),
  );

describe('the effect of the highlighted row', () => {
  it('is drawn under the list after a blank row, wrapped to the row', () => {
    expect(body(LIST, 3)).toEqual([
      '  ask  asks before every effect',
      '  plan  only reads',
      '  accept-edits  applies file edits without a card',
      '› auto  runs governed actions without asking',
      '',
      'auto approves granted actions without asking; a command still asks',
      'unless you remembered or approved it; scope and protected-path',
      'rules still apply.',
    ]);
  });

  it('a row with no effect leaves the room blank, and the room is the longest effect’s whichever row is highlighted', () => {
    const counts = [0, 1, 2, 3].map((selected) => body(LIST, selected).length);
    expect(new Set(counts)).toEqual(new Set([8]));
    expect(body(LIST, 0).slice(4)).toEqual(['', '', '', '']);
    expect(body(LIST, 2).slice(4)).toEqual([
      '',
      'Files are edited without asking; commands and network still ask.',
      '',
      '',
    ]);
  });

  it('naturalBodyRows asks for the list, a blank row and the longest effect’s rows, inline too', () => {
    const state = { selected: 0, offset: 0 };
    expect(naturalBodyRows(LIST, state, undefined, WIDTH)).toBe(4 + 1 + 3);
    expect(naturalBodyRows(LIST, state, INLINE_LIST_MAX_ROWS, WIDTH)).toBe(4 + 1 + 3);
    // Counted at the floor's width when no width is given (a caller with no geometry).
    expect(naturalBodyRows(LIST, state)).toBe(8);
  });

  it('the list window gives way to the effect: a short body keeps the whole paragraph and windows the rows', () => {
    const geometry = { bodyRows: 6, listRows: 6, innerWidth: WIDTH };
    expect(bodyPageRows(LIST, false, geometry)).toBe(2);
    const drawn = body(LIST, 3, geometry);
    expect(drawn).toHaveLength(6);
    expect(drawn.slice(0, 2).join('\n')).toContain('› auto');
    expect(drawn.slice(2).join(' ')).toContain('protected-path rules');
  });

  it('a list with no effect is drawn as before, asks for no room, and its page is its window', () => {
    const plain: PopupContent = {
      kind: 'list',
      rows: MODES.map((row) => ({ id: row.id, label: row.label, detail: row.detail })),
    };
    expect(body(plain, 0)).toEqual([
      '› ask  asks before every effect',
      '  plan  only reads',
      '  accept-edits  applies file edits without a card',
      '  auto  runs governed actions without asking',
    ]);
    expect(naturalBodyRows(plain, { selected: 0, offset: 0 }, undefined, WIDTH)).toBe(4);
    expect(bodyPageRows(plain, false, { bodyRows: 4, listRows: 17, innerWidth: WIDTH })).toBe(4);
  });

  it('a list’s page leaves out its heading and its filter line', () => {
    const headed: PopupContent = {
      kind: 'list',
      heading: { status: 'warning', statusWord: 'warning', text: 'one' },
      rows: MODES,
    };
    expect(bodyPageRows(headed, true, { bodyRows: 20, listRows: 20, innerWidth: WIDTH })).toBe(
      20 - 2 - 4,
    );
    expect(bodyPageRows(headed, false, { bodyRows: 20, listRows: 10, innerWidth: WIDTH })).toBe(10);
  });

  it('a section row (a heading inside the list) carries no effect even if it names one', () => {
    const sectioned: PopupContent = {
      kind: 'list',
      rows: [
        { id: 's', label: 'Section', section: true, effect: 'never drawn' },
        ...MODES.slice(0, 1),
      ],
    };
    expect(body(sectioned, 1).join('\n')).not.toContain('never drawn');
  });

  it('hostile text in an effect is scrubbed by the frame’s floor and never widens a row', () => {
    const LS = String.fromCharCode(0x2028);
    const ESC = String.fromCharCode(0x1b);
    const hostile: PopupContent = {
      kind: 'list',
      rows: [
        { id: 'a', label: 'a', effect: `${ESC}[31m red ✓ › ⇄${LS}${'漢'.repeat(80)}` },
        { id: 'b', label: 'b' },
      ],
    };
    const drawn = body(hostile, 0);
    for (const row of drawn) {
      expect(displayWidth(row)).toBeLessThanOrEqual(WIDTH);
      expect(row.includes(ESC)).toBe(false);
      expect(row.includes(LS)).toBe(false);
      expect(row.includes('✓')).toBe(false);
      expect(row.includes('⇄')).toBe(false);
    }
    expect(drawn.slice(2).join('').split('›')).toHaveLength(1);
  });
});

describe('the one filter of a list (the body draws what the key fold selects in)', () => {
  const NAMES: PopupContent = {
    kind: 'list',
    rows: [
      { id: 'a', label: 'alpha' },
      { id: 'b', label: 'bravo', detail: 'second' },
      { id: 'c', label: 'charlie' },
      { id: 'd', label: 'delta', detail: 'ALPHA-like' },
    ],
  };

  it('matches the label or the detail, case folded, and leaves every row for an empty or blank filter', () => {
    if (NAMES.kind !== 'list') throw new Error('a list');
    expect(filterListRows(NAMES.rows, 'alp').map((row) => row.id)).toEqual(['a', 'd']);
    expect(filterListRows(NAMES.rows, '  ').map((row) => row.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterListRows(NAMES.rows, undefined)).toBe(NAMES.rows);
  });

  it('the body draws the rows the filter leaves, the highlight on the row the fold selected', () => {
    const spec: PopupSpec = {
      id: 'f',
      title: '/f',
      origin: 'chat',
      steps: [{ name: 'One', content: NAMES, filter: true, enter: 'apply' }],
    };
    let frame: PopupFrame = openFrame(spec, 1);
    for (const key of ['a', 'l', 'p']) {
      const fold = foldPopupAction(frame, reducePopupKey(key, {}, currentStep(frame).spec), 5);
      if (fold.kind !== 'frame') throw new Error('a frame');
      frame = fold.frame;
    }
    const down = foldPopupAction(frame, { kind: 'move', delta: 1 }, 5);
    if (down.kind !== 'frame') throw new Error('a frame');
    const { state } = currentStep(down.frame);
    expect(body(NAMES, state.selected, undefined, state.filter)).toEqual([
      'Filter: alp█',
      '  alpha',
      '› delta  ALPHA-like',
    ]);
    // `Enter` answers with the row drawn as highlighted.
    const enter = foldPopupAction(down.frame, { kind: 'enter' }, 5);
    expect(enter).toEqual({
      kind: 'enter',
      row: { id: 'd', label: 'delta', detail: 'ALPHA-like' },
    });
    expect(popupLegend(down.frame).items).toContainEqual({ keys: '↑/↓', verb: 'select' });
  });

  it('a filter that leaves nothing says there is nothing to show', () => {
    expect(body(NAMES, 0, undefined, 'zzz')).toEqual(['Filter: zzz█', 'Nothing to show.']);
  });
});
