/**
 * The popup's frame as rows of text ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §4, §5): four parts in order, every row exactly the frame's width (the padding is what makes the popup opaque), the table's glyphs in the
 * form colour asks for, the legend's way back kept last and never dropped, untrusted text sanitised and host-glyph blanked, and the four content
 * states.
 */
import { describe, expect, it } from 'vitest';

import { exitKey, type LegendItem } from '../render/tui/legend.js';
import { withGlyphForm } from '../render/tui/glyphs.js';
import { displayWidth } from '../render/tui/viewport.js';
import {
  loadingElapsedText,
  naturalBodyRows,
  popupBody,
  popupFrameLines,
  popupNoticeLegend,
  popupNoticeLines,
  type PopupContent,
  type PopupFrameParts,
  type PopupListRow,
} from './frame-model.js';
import {
  INLINE_LIST_MAX_ROWS,
  popupGeometry,
  popupInnerWidth,
  type PopupBoxGeometry,
} from './geometry.js';

function geometryFor(
  columns: number,
  rows: number,
  bodyRows: number,
  rail = false,
  placement: 'overlay' | 'replace' = 'overlay',
): PopupBoxGeometry {
  const geometry = popupGeometry({ columns, rows, kind: 'standard', placement, rail, bodyRows });
  if (!geometry.fits) throw new Error('refused');
  return geometry;
}

const LEGEND = {
  items: [
    { keys: '↑/↓', verb: 'select' },
    { keys: 'c', verb: 'copy' },
  ] as LegendItem[],
  exit: exitKey.close(),
};

const parts = (over: Partial<PopupFrameParts> = {}): PopupFrameParts => ({
  title: '/doctor',
  origin: 'home',
  steps: ['Report'],
  stepIndex: 0,
  legend: LEGEND,
  ...over,
});

const rows = (count: number): PopupListRow[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `r${String(index)}`,
    label: `row ${String(index)}`,
  }));

function frame(
  content: PopupContent,
  options: {
    readonly columns?: number;
    readonly rows?: number;
    readonly selected?: number;
    readonly offset?: number;
    readonly parts?: Partial<PopupFrameParts>;
    readonly ascii?: boolean;
    readonly elapsed?: string;
    readonly placement?: 'overlay' | 'replace';
  } = {},
) {
  const state = { selected: options.selected ?? 0, offset: options.offset ?? 0 };
  const steps = options.parts?.steps ?? ['Report'];
  const geometry = geometryFor(
    options.columns ?? 80,
    options.rows ?? 24,
    // As the slot asks for it: the rows its body wraps to at the inner width.
    naturalBodyRows(
      content,
      state,
      options.placement === 'replace' ? INLINE_LIST_MAX_ROWS : undefined,
      popupInnerWidth(options.columns ?? 80, 'standard'),
    ),
    steps.length > 1,
    options.placement,
  );
  const lines = withGlyphForm(options.ascii === true, () =>
    popupFrameLines(
      parts(options.parts),
      popupBody(content, state, geometry, options.elapsed),
      geometry,
    ),
  );
  return { geometry, lines, text: lines.map((line) => line.text) };
}

describe('every row of the frame is exactly the frame’s width (opacity is the safety property)', () => {
  const contents: readonly PopupContent[] = [
    { kind: 'loading', what: 'Checking' },
    { kind: 'empty', what: 'No workflows yet.', next: 'Use /init to create one.' },
    { kind: 'error', what: 'The catalogue could not be read.', next: 'Press r to try again.' },
    { kind: 'list', rows: rows(40) },
    { kind: 'report', lines: Array.from({ length: 40 }, (_, i) => `line ${String(i)}`) },
    { kind: 'list', rows: [{ id: 'w', label: '漢字の名前'.repeat(20), detail: '🙂 wide 💥' }] },
  ];
  it.each([
    [80, 24],
    [100, 30],
    [88, 40],
  ])('at %s × %s, in both glyph forms', (columns, terminalRows) => {
    for (const content of contents)
      for (const ascii of [false, true]) {
        const { geometry, text } = frame(content, { columns, rows: terminalRows, ascii });
        expect(text.length).toBe(geometry.height);
        for (const row of text) expect(displayWidth(row), JSON.stringify(row)).toBe(geometry.width);
      }
  });
});

describe('the four parts, in order', () => {
  it('the top edge carries the name on the left and the origin on the right', () => {
    const { text } = frame({ kind: 'list', rows: rows(2) });
    expect(text[0]).toMatch(/^ ─ \/doctor ─+ from Home ─ $/u);
    expect(frame({ kind: 'list', rows: rows(2) }, { parts: { origin: 'chat' } }).text[0]).toMatch(
      / from chat ─ $/u,
    );
  });

  it('a popup of more than one step says `step 2 of 3` on its top edge and draws the rail', () => {
    const { text } = frame(
      { kind: 'list', rows: rows(2) },
      { parts: { steps: ['Workflow', 'Inputs', 'Confirm'], stepIndex: 1 } },
    );
    expect(text[0]).toContain('from Home · step 2 of 3');
    expect(text[1]?.trim()).toBe('✓ Workflow ╌╌ ◉ Inputs ╌╌ ○ Confirm');
  });

  it('the rail is drawn in the plain forms when colour is off', () => {
    const { text } = frame(
      { kind: 'list', rows: rows(2) },
      { ascii: true, parts: { steps: ['Workflow', 'Inputs', 'Confirm'], stepIndex: 1 } },
    );
    expect(text[1]?.trim()).toBe('ok Workflow .. @ Inputs .. o Confirm');
    expect(text[0]).toMatch(/^ - \/doctor -+ from Home · step 2 of 3 - $/u);
  });

  it('a one-step popup has no rail', () => {
    const { text } = frame({ kind: 'list', rows: rows(2) });
    expect(text.some((row) => row.includes('╌'))).toBe(false);
  });

  it('the body, then the legend, then the bottom edge', () => {
    const { text } = frame({ kind: 'list', rows: rows(2) });
    expect(text[1]?.trimEnd()).toBe(' › row 0');
    expect(text[2]?.trimEnd()).toBe('   row 1');
    expect(text.at(-2)?.trim()).toBe('↑/↓ select · [c] copy · Esc close');
    expect(text.at(-1)).toBe(` ${'─'.repeat(66)} `);
  });
});

describe('the legend always ends with the way back, and the way back is the last thing truncated', () => {
  it('drops the other items from the end first and keeps the way back', () => {
    const many: LegendItem[] = Array.from({ length: 12 }, (_, i) => ({
      keys: String.fromCharCode(97 + i),
      verb: `action${String(i)}`,
    }));
    const { text } = frame(
      { kind: 'list', rows: rows(2) },
      { parts: { legend: { items: many, exit: exitKey.close() } } },
    );
    const legend = text.at(-2)?.trim() ?? '';
    expect(legend.endsWith('Esc close')).toBe(true);
    expect(legend.startsWith('[a] action0')).toBe(true);
    expect(legend).not.toContain('[l] action11');
  });

  it('a step after the first names Ctrl+C as the key that closes, and ends with Esc back', () => {
    const { text } = frame(
      { kind: 'list', rows: rows(2) },
      {
        parts: {
          steps: ['One', 'Two'],
          stepIndex: 1,
          legend: { items: [{ keys: 'Ctrl+C', verb: 'close' }], exit: exitKey.step() },
        },
      },
    );
    expect(text.at(-2)?.trim()).toBe('[Ctrl+C] close · Esc back');
  });
});

describe('untrusted text', () => {
  it('a title, a label and a detail are sanitised and cannot draw a host glyph', () => {
    const { text } = frame(
      {
        kind: 'list',
        rows: [{ id: 'x', label: '\u001b[31m✓ ok\u001b[0m', detail: '━━ Approval needed ━━' }],
      },
      { parts: { title: '/doctor\u001b]0;pwned\u0007 ›' } },
    );
    const all = text.join('\n');
    expect(all).not.toContain('\u001b');
    expect(all).not.toContain('━');
    expect(text[1]).not.toContain('✓');
    expect(text[0]).not.toContain('›');
  });

  it('a legend text item is made inert: a name cannot forge a key or a separator on the legend row', () => {
    const { text } = frame(
      { kind: 'list', rows: rows(1) },
      {
        parts: { legend: { items: [{ text: 'file [Ctrl+Y] Allow · x' }], exit: exitKey.close() } },
      },
    );
    expect(text.at(-2)).toContain('file (Ctrl+Y) Allow - x');
  });
});

describe('the content states (ADR-0148 §5)', () => {
  it('loading is a static `…`, and the elapsed seconds only once past five', () => {
    expect(frame({ kind: 'loading', what: 'Checking' }).text[1]?.trim()).toBe('Checking…');
    expect(frame({ kind: 'loading', what: 'Checking' }, { elapsed: '12 s' }).text[1]?.trim()).toBe(
      'Checking…  12 s',
    );
    expect(loadingElapsedText(4999)).toBeUndefined();
    expect(loadingElapsedText(5000)).toBe('5 s');
    expect(loadingElapsedText(12_999)).toBe('12 s');
    expect(loadingElapsedText(Number.NaN)).toBeUndefined();
  });

  it('empty says what is empty and what to do', () => {
    const { text } = frame({
      kind: 'empty',
      what: 'No workflows yet.',
      next: 'Use /init to create one.',
    });
    expect(text.slice(1, 3).map((row) => row.trim())).toEqual([
      'No workflows yet.',
      'Use /init to create one.',
    ]);
  });

  it('error says what failed, with the failed glyph, and the next action', () => {
    const { lines, text } = frame({
      kind: 'error',
      what: 'It failed.',
      next: 'Press r to try again.',
    });
    expect(text[1]?.trim()).toBe('✗ It failed.');
    expect(lines[1]?.kind).toBe('failed');
    expect(
      frame({ kind: 'error', what: 'It failed.', next: 'x' }, { ascii: true }).text[1]?.trim(),
    ).toBe('x It failed.');
  });

  it('overflow is a windowed list with `▲ N more` / `▼ N more`, and the highlighted row is always in the window', () => {
    for (const selected of [0, 7, 20, 39]) {
      const { text } = frame({ kind: 'list', rows: rows(40) }, { selected });
      const body = text.slice(1, -2);
      expect(body.length).toBe(18);
      expect(
        body.some((row) => row.includes(`› row ${String(selected)}`)),
        String(selected),
      ).toBe(true);
      // The window starts at the first row or says how many it hides above; it ends at the last or says how many it hides below.
      expect(body[0], String(selected)).toMatch(/^ [ ›] row 0 |▲ \d+ more/u);
      expect(body.at(-1), String(selected)).toMatch(/^ [ ›] row 39 |▼ \d+ more/u);
      // And the highlighted row is never a marker's row.
      for (const row of body) if (/[▲▼]/u.test(row)) expect(row).not.toContain('›');
    }
  });

  it('a report that does not fit is windowed the same way, from its offset', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`);
    const top = frame({ kind: 'report', lines }).text.slice(1, -2);
    expect(top[0]?.trim()).toBe('line 0');
    expect(top.at(-1)).toMatch(/▼ 23 more/u);
    const middle = frame({ kind: 'report', lines }, { offset: 10 }).text.slice(1, -2);
    expect(middle[0]).toMatch(/▲ 11 more/u);
    expect(middle[1]?.trim()).toBe('line 11');
  });

  it('inline (the accessible mode) windows a list to at most ten rows', () => {
    const { text } = frame({ kind: 'list', rows: rows(40) }, { placement: 'replace', rows: 40 });
    // ten list rows and the three rows of the frame: no padding the list cannot use
    expect(text.length).toBe(13);
    expect(text.slice(1, -2).filter((row) => row.trim() !== '').length).toBe(10);
  });

  it('a row that cannot act is drawn dim with its reason', () => {
    const { lines, text } = frame({
      kind: 'list',
      rows: [
        { id: 'a', label: 'alpha' },
        { id: 'b', label: 'bravo', enabled: false, reason: 'no key' },
      ],
    });
    expect(text[2]?.trim()).toBe('bravo  no key');
    expect(lines[2]?.kind).toBe('text');
  });
});

describe('the notice drawn in place of a popup the terminal cannot hold', () => {
  it('says why and what the way back does, each row filled to one width', () => {
    const lines = withGlyphForm(false, () =>
      popupNoticeLines('below-floor', { items: [], exit: exitKey.close() }, 60),
    );
    expect(lines.map((line) => line.text.trim())).toEqual([
      'Terminal too small for this popup — enlarge it to 80×24',
      'Esc close',
    ]);
    // a narrower terminal wraps the reason instead of losing its end
    const narrow = withGlyphForm(false, () =>
      popupNoticeLines('below-floor', { items: [], exit: exitKey.close() }, 30),
    );
    expect(narrow.map((line) => line.text.trim()).join(' ')).toContain('enlarge it to 80×24');
    expect(new Set(lines.map((line) => displayWidth(line.text))).size).toBe(1);
  });
});

describe('the keys that leave are the last to be dropped', () => {
  it('a narrow legend drops the other items and keeps [Ctrl+C] close and the way back', () => {
    const many: LegendItem[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        keys: String.fromCharCode(97 + i),
        verb: `action${String(i)}`,
      })),
      { keys: 'Ctrl+C', verb: 'close' },
    ];
    const { text } = frame(
      { kind: 'list', rows: rows(2) },
      {
        parts: {
          steps: ['One', 'Two'],
          stepIndex: 1,
          legend: { items: many, exit: exitKey.step() },
        },
      },
    );
    const legendRow = text.at(-2)?.trim() ?? '';
    expect(legendRow.endsWith('[Ctrl+C] close · Esc back')).toBe(true);
    expect(legendRow).not.toContain('action9');
  });
});

describe('the notice names the popup’s own leaving keys', () => {
  it('on the first step its Esc; on a later step [Ctrl+C] close and Esc back; nothing else', () => {
    const first = popupNoticeLegend({
      items: [
        { keys: '↑/↓', verb: 'select' },
        { keys: 'c', verb: 'copy' },
      ],
      exit: exitKey.close(),
    });
    expect(first.items).toEqual([]);
    const later = popupNoticeLegend({
      items: [
        { keys: '↑/↓', verb: 'select' },
        { keys: 'Ctrl+C', verb: 'close' },
      ],
      exit: exitKey.step(),
    });
    const lines = withGlyphForm(false, () => popupNoticeLines('below-floor', later, 60));
    expect(lines.at(-1)?.text.trim()).toBe('[Ctrl+C] close · Esc back');
  });
});

describe('the rule rows keep a blank cell at each end (MVP-11 step 4 review: a rule never touches the backdrop)', () => {
  it.each([
    [80, false],
    [80, true],
    [100, false],
  ])(
    'at %s columns (plain glyphs %s): the top and bottom rules span the inner width, inside one blank cell each side',
    (columns, ascii) => {
      const { geometry, lines, text } = frame({ kind: 'list', rows: rows(2) }, { columns, ascii });
      const rule = ascii ? '-' : '─';
      for (const row of [text[0] ?? '', text.at(-1) ?? '']) {
        expect(displayWidth(row)).toBe(geometry.width);
        expect(row.startsWith(` ${rule}`), row).toBe(true);
        expect(row.endsWith(`${rule} `), row).toBe(true);
      }
      // The text width is the geometry's: 66 at 80 columns, unchanged by the gutter.
      expect(geometry.innerWidth).toBe(columns === 80 ? 66 : 74);
      expect(text.at(-1)).toBe(` ${rule.repeat(geometry.innerWidth)} `);
      // The spans moved with the gutter: the title is still the strong stretch.
      const top = lines[0];
      const strong = top?.spans?.find((span) => span.role === 'strong');
      expect(top?.text.slice(strong?.from, strong?.to)).toBe('/doctor');
    },
  );
});

describe('a live notification is drawn in the legend row while the popup is open (MVP-11 step 4 review)', () => {
  it('in place of the legend, on one row, cut with the ellipsis at the inner width, in both placements', () => {
    for (const placement of ['overlay', 'replace'] as const) {
      const shown = frame(
        { kind: 'list', rows: rows(2) },
        {
          placement,
          parts: { notice: 'Doctor: sent 164 characters to the terminal clipboard.' },
        },
      );
      const plain = frame({ kind: 'list', rows: rows(2) }, { placement });
      expect(shown.text.length).toBe(plain.text.length);
      expect(shown.text.at(-2)?.trim()).toBe(
        'Doctor: sent 164 characters to the terminal clipboard.',
      );
      expect(shown.lines.at(-2)?.kind).toBe('notice');
      expect(shown.text.at(-2)).not.toContain('Esc close');
      expect(plain.text.at(-2)?.trim()).toBe('↑/↓ select · [c] copy · Esc close');
    }
    const long = frame(
      { kind: 'list', rows: rows(2) },
      { parts: { notice: `${'word '.repeat(30)}END` } },
    );
    const row = long.text.at(-2) ?? '';
    expect(displayWidth(row)).toBe(long.geometry.width);
    expect(row.trim().endsWith('…')).toBe(true);
    expect(row).not.toContain('END');
    expect(long.text.length).toBe(long.geometry.height);
  });
});

/** `count` columns of distinct words (`w01 w02 …`), whole words only. */
function sentence(count: number, tag: string): string {
  let out = '';
  for (let index = 1; out.length < count; index += 1)
    out += `${out === '' ? '' : ' '}${tag}${String(index).padStart(2, '0')}`;
  return out.slice(0, count).trimEnd();
}

describe('an empty or error state wraps what it says and what to do, and shows both whole (MVP-11 step 4 review)', () => {
  it.each([
    [80, 24],
    [100, 30],
  ])('at %s × %s, for every sentence of 70 to 110 columns', (columns, terminalRows) => {
    for (let width = 70; width <= 110; width += 1)
      for (const kind of ['empty', 'error'] as const) {
        const what = sentence(width, 'a');
        const next = sentence(width, 'b');
        const content: PopupContent =
          kind === 'empty' ? { kind, what, next } : { kind, what, next };
        const { geometry, text } = frame(content, { columns, rows: terminalRows });
        const body = text.slice(1, 1 + geometry.bodyRows).map((row) => row.trim());
        const drawn = body.join(' ').replace(/\s+/gu, ' ');
        const lead = kind === 'error' ? '✗ ' : '';
        expect(drawn, `${kind} ${String(width)}`).toBe(`${lead}${what} ${next}`);
        expect(drawn).not.toContain('…');
        for (const row of text) expect(displayWidth(row)).toBe(geometry.width);
      }
  });

  it('asks the geometry for the rows its sentences wrap to, and one row each without a width', () => {
    const content: PopupContent = {
      kind: 'empty',
      what: sentence(100, 'a'),
      next: sentence(70, 'b'),
    };
    expect(naturalBodyRows(content, { selected: 0, offset: 0 }, undefined, 66)).toBe(4);
    expect(naturalBodyRows(content, { selected: 0, offset: 0 }, undefined, 200)).toBe(2);
    expect(naturalBodyRows(content, { selected: 0, offset: 0, filter: '' }, undefined, 66)).toBe(5);
    expect(naturalBodyRows(content, { selected: 0, offset: 0 })).toBe(2);
  });

  it('cuts with the ellipsis only when the popup has no more rows', () => {
    const content: PopupContent = {
      kind: 'error',
      what: sentence(400, 'a'),
      next: sentence(400, 'b'),
    };
    const geometry = geometryFor(80, 24, 3);
    const body = withGlyphForm(false, () =>
      popupBody(content, { selected: 0, offset: 0 }, geometry),
    );
    expect(body.lines).toHaveLength(3);
    expect(body.lines[2]?.text.endsWith('…')).toBe(true);
    for (const line of body.lines) expect(displayWidth(line.text)).toBeLessThanOrEqual(66);
  });
});

describe('a line or paragraph separator never reaches a drawn row (MVP-11 step 4 review: the opacity of every row)', () => {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const hostile = (text: string): string => `${text}${LS}${PS}${LS}${LS}end`;

  it('in every row of every part, at several scroll offsets, with the width measure and the terminal agreeing', () => {
    const contents: readonly PopupContent[] = [
      {
        kind: 'list',
        heading: { status: 'warning', statusWord: 'warning', text: hostile('heading') },
        rows: Array.from({ length: 30 }, (_, index) => ({
          id: `r${String(index)}`,
          label: hostile(`label ${String(index)}`),
          detail: hostile('detail'),
          statusWord: hostile('ok'),
          status: 'completed' as const,
        })),
      },
      {
        kind: 'report',
        lines: Array.from({ length: 40 }, (_, index) => hostile(`line ${String(index)}`)),
      },
      { kind: 'empty', what: hostile('what'), next: hostile('next') },
      { kind: 'error', what: hostile('what'), next: hostile('next') },
      { kind: 'loading', what: hostile('loading') },
    ];
    for (const content of contents)
      for (const at of [0, 7, 25, 39])
        for (const notice of [undefined, hostile('a notice')]) {
          const { geometry, text } = frame(content, {
            selected: Math.min(at, 29),
            offset: at,
            parts: {
              title: hostile('/doctor'),
              steps: [hostile('One'), hostile('Two')],
              stepIndex: 1,
              notice,
              legend: { items: [{ text: hostile('a legend text') }], exit: exitKey.close() },
            },
          });
          for (const row of text) {
            expect(row.includes(LS) || row.includes(PS), JSON.stringify(row)).toBe(false);
            expect(displayWidth(row)).toBe(geometry.width);
          }
        }
  });

  it('in a filter line', () => {
    const geometry = geometryFor(80, 24, 4);
    const body = popupBody(
      { kind: 'list', rows: rows(3) },
      { selected: 0, offset: 0, filter: hostile('typed') },
      geometry,
    );
    expect(body.lines[0]?.text.includes(LS)).toBe(false);
    expect(body.lines[0]?.text.includes(PS)).toBe(false);
  });
});

describe('the notice in place of a popup covers its rows to the terminal’s edge (MVP-11 step 4 review)', () => {
  it.each([79, 60, 120])('at %s columns every row is exactly the terminal’s width', (columns) => {
    const lines = withGlyphForm(false, () =>
      popupNoticeLines('below-floor', { items: [], exit: exitKey.close() }, columns),
    );
    for (const line of lines) expect(displayWidth(line.text)).toBe(columns);
    expect(lines[0]?.text.trim()).toBe('Terminal too small for this popup — enlarge it to 80×24');
  });
});
