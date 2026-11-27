/**
 * The popup's frame as rows of text ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §4, §5): four parts in order, every row exactly the frame's width (the padding is what makes the popup opaque), the table's glyphs in the
 * form colour asks for, the legend's way back kept last and never dropped, untrusted text sanitised and host-glyph blanked, and the four content
 * states.
 */
import { describe, expect, it } from 'vitest';

import { exitKey, legend, LEGEND_SEPARATOR, type LegendItem } from '../render/tui/legend.js';
import { withGlyphForm } from '../render/tui/glyphs.js';
import { displayWidth } from '../render/tui/viewport.js';
import {
  loadingElapsedText,
  naturalBodyRows,
  originLabel,
  popupBody,
  popupFrameLines,
  popupNoticeLegend,
  popupNoticeLines,
  reportLinesFit,
  reportPageStep,
  type PopupContent,
  type PopupFrameParts,
  type PopupListRow,
} from './frame-model.js';
import {
  INLINE_LIST_MAX_ROWS,
  POPUP_NOTICE_MAX_COLUMNS,
  POPUP_NOTICE_WAY_BACK_COLUMNS,
  popupGeometry,
  popupInnerWidth,
  type PopupBoxGeometry,
} from './geometry.js';
import { NOTHING_HELD } from './cost-popup.js';

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

  it('each origin has its own words on the top edge: `from Home`, `from chat`, and `first run` for the setup the Home opens by itself (OB-5a)', () => {
    expect(originLabel('home')).toBe('from Home');
    expect(originLabel('chat')).toBe('from chat');
    expect(originLabel('first-run')).toBe('first run');
    const { text } = frame(
      { kind: 'list', rows: rows(2) },
      { parts: { origin: 'first-run', steps: ['Provider', 'Key', 'Done'], stepIndex: 0 } },
    );
    expect(text[0]).toContain(' first run · step 1 of 3 ');
    expect(text[0]).not.toContain('from');
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

  it('the markers count entries, not rows: a heading above 32 entries is no entry, for every highlight, and a marker that would stand for no entry is not drawn (review round 1, O-9)', () => {
    const heading = (id: string): PopupListRow => ({
      id,
      label: id,
      section: true,
      enabled: false,
    });
    const entries = Array.from(
      { length: 32 },
      (_, index): PopupListRow => ({ id: `e${String(index)}`, label: `entry ${String(index)}` }),
    );
    const counted = (list: readonly PopupListRow[], selected: number): number => {
      const body = frame({ kind: 'list', rows: list }, { selected }).text.slice(1, -2);
      const marker = (glyph: string): number =>
        Number(
          body.map((row) => new RegExp(`${glyph} (\\d+) more`, 'u').exec(row)?.[1]).find(Boolean) ??
            0,
        );
      const shown = body.filter((row) => /entry \d+/u.test(row)).length;
      return marker('▲') + shown + marker('▼');
    };
    // One heading: the 32 entries are rows 1 to 32.
    for (let selected = 1; selected <= 32; selected += 1)
      expect(
        counted([heading('head'), ...entries], selected),
        `highlight ${String(selected)}`,
      ).toBe(32);
    // Three rows that are no entry above them: the window can start past all three, and says nothing above (it hides no entry).
    const padded = [heading('head'), heading('note'), heading('blank'), ...entries];
    for (let selected = 3; selected <= 34; selected += 1)
      expect(counted(padded, selected), `padded, highlight ${String(selected)}`).toBe(32);
    const lowered = frame({ kind: 'list', rows: padded }, { selected: 10 }).text.slice(1, -2);
    expect(
      lowered.some((row) => row.includes('▲')),
      'nothing above is an entry',
    ).toBe(false);
    expect(lowered[0]?.trim(), 'the first row stays what it is').toBe('blank');
    // A page the arrows walk line by line has no entries to count: every hidden line is what its marker stands for, sections included.
    const lines: PopupListRow[] = Array.from({ length: 40 }, (_, index) => ({
      id: `l${String(index)}`,
      label: `line ${String(index)}`,
      section: true,
      enabled: false,
    }));
    const page = frame({ kind: 'list', rows: lines, page: true }, { selected: 39 }).text.slice(
      1,
      -2,
    );
    expect(
      page.some((row) => /▲ \d+ more/u.test(row)),
      'the lines above are said',
    ).toBe(true);
    // The numbers (review round 2, P2-5): 40 lines in a body of 18 rows. At the end the window starts at line 22: 23 lines are above (the one under
    // the marker counted), none below. Highlighted on line 20 it starts at line 12 and ends at line 30: 13 above, 11 below (line 29 under the marker).
    expect(page[0]).toMatch(/▲ 23 more/u);
    expect(page.at(-1)).not.toMatch(/▼/u);
    const middle = frame({ kind: 'list', rows: lines, page: true }, { selected: 20 }).text.slice(
      1,
      -2,
    );
    expect(middle[0]).toMatch(/▲ 13 more/u);
    expect(middle.at(-1)).toMatch(/▼ 11 more/u);
    expect(middle.length).toBe(18);
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

describe('a live notification is drawn in the legend row while the popup is open, and the row still ends with the way back (MVP-11 step 4 round 2; ADR-0148 §1.4)', () => {
  const COPIED = 'Doctor: sent 164 characters to the terminal clipboard.';

  it('in place of the legend’s keys, on one row, then ` · ` and the way back whole, in both placements', () => {
    for (const placement of ['overlay', 'replace'] as const) {
      const shown = frame(
        { kind: 'list', rows: rows(2) },
        { placement, parts: { notice: COPIED } },
      );
      const plain = frame({ kind: 'list', rows: rows(2) }, { placement });
      expect(shown.text.length).toBe(plain.text.length);
      expect(shown.text.at(-2)?.trim()).toBe(`${COPIED} · Esc close`);
      expect(shown.lines.at(-2)?.kind).toBe('notice');
      expect(shown.text.at(-2)).not.toContain('[c] copy');
      expect(plain.text.at(-2)?.trim()).toBe('↑/↓ select · [c] copy · Esc close');
      // The way back is drawn as a key, as in the legend: `Esc` strong, the separator and the verb dim.
      const row = shown.lines.at(-2);
      const roleAt = (word: string): string | undefined => {
        const at = row?.text.lastIndexOf(word) ?? -1;
        return row?.spans?.find((span) => span.from <= at && at < span.to)?.role;
      };
      expect(roleAt('Esc')).toBe('strong');
      expect(roleAt('close')).toBe('dim');
      expect(roleAt('·')).toBe('dim');
      expect(roleAt('Doctor')).toBeUndefined();
    }
  });

  it('a notification too long for the row is cut with the ellipsis; the way back never is, whatever it says', () => {
    for (const [exit, words] of [
      [exitKey.close(), 'Esc close'],
      [exitKey.step(), 'Esc back'],
      [exitKey.close(['Enter', 'Esc']), 'Enter / Esc close'],
      [exitKey.step('Esc', 'clear the filter'), 'Esc clear the filter'],
    ] as const) {
      const long = frame(
        { kind: 'list', rows: rows(2) },
        { parts: { notice: `${'word '.repeat(30)}END`, legend: { items: [], exit } } },
      );
      const row = long.text.at(-2) ?? '';
      expect(displayWidth(row)).toBe(long.geometry.width);
      expect(row.trim().endsWith(`… · ${words}`), row).toBe(true);
      expect(row).not.toContain('END');
      expect(long.text.length).toBe(long.geometry.height);
    }
  });

  it('the budget a popup’s texts are written to (POPUP_NOTICE_MAX_COLUMNS, 54) is exactly what fits beside `Esc close` at the floor: a text of 54 columns is whole, one of 55 is cut', () => {
    expect(POPUP_NOTICE_MAX_COLUMNS).toBe(54);
    // The way back the geometry reserves is the one the legend builder draws: the separator and `Esc close`.
    const way = `${LEGEND_SEPARATOR}${legend([], exitKey.close())}`;
    expect(displayWidth(way)).toBe(POPUP_NOTICE_WAY_BACK_COLUMNS);
    expect(popupInnerWidth(80, 'standard') - displayWidth(way)).toBe(POPUP_NOTICE_MAX_COLUMNS);
    const whole = 'x'.repeat(POPUP_NOTICE_MAX_COLUMNS - 3) + 'END';
    for (const placement of ['overlay', 'replace'] as const) {
      const fits = frame({ kind: 'list', rows: rows(2) }, { placement, parts: { notice: whole } });
      expect(fits.text.at(-2)?.trim()).toBe(`${whole} · Esc close`);
      const over = frame(
        { kind: 'list', rows: rows(2) },
        { placement, parts: { notice: `${whole}!` } },
      );
      expect(over.text.at(-2)?.trim().endsWith('… · Esc close')).toBe(true);
      expect(over.text.at(-2)).not.toContain('END!');
    }
  });

  it('a line or paragraph separator in it is folded before it is measured (the row is still exactly the frame’s width)', () => {
    const notice = `a${String.fromCharCode(0x2028)}b`;
    const shown = frame({ kind: 'list', rows: rows(2) }, { parts: { notice } });
    expect(shown.text.at(-2)?.trim()).toBe('a b · Esc close');
    expect(displayWidth(shown.text.at(-2) ?? '')).toBe(shown.geometry.width);
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

describe('what the body draws, row for row (MVP-11 step 4, review round 2, mutation sweep B15–B50)', () => {
  const GEOMETRY = { bodyRows: 8, listRows: 8, innerWidth: 60 } as const;
  const at = (over: { readonly selected?: number; readonly offset?: number } = {}) => ({
    selected: over.selected ?? 0,
    offset: over.offset ?? 0,
  });
  const textOf = (
    content: PopupContent,
    state = at(),
    geometry: {
      readonly bodyRows: number;
      readonly listRows: number;
      readonly innerWidth: number;
    } = GEOMETRY,
  ): string[] => popupBody(content, state, geometry).lines.map((line) => line.text);
  const longReport = (): PopupContent => ({
    kind: 'report',
    lines: Array.from({ length: 30 }, (_, index) => `line ${String(index)}`),
  });

  it('B41: scrolled to the end, a report draws its last line, and no marker where nothing is below', () => {
    const drawn = textOf(longReport(), at({ offset: 22 }));
    expect(drawn.at(-1)).toContain('line 29');
    expect(drawn.join('\n')).not.toContain('▼');
  });

  it('B36: an offset past the end draws the last page, never rows past the report', () => {
    const drawn = textOf(longReport(), at({ offset: 100 }));
    expect(drawn.at(-1)).toContain('line 29');
    expect(drawn).toHaveLength(8);
  });

  it('B34/B31: an empty report and a list with no rows (a filter that matches nothing) say there is nothing to show', () => {
    expect(textOf({ kind: 'report', lines: [] })).toEqual(['Nothing to show.']);
    expect(textOf({ kind: 'list', rows: [] })).toEqual(['Nothing to show.']);
  });

  it('B50: with a heading, a list whose selection is at the bottom of its window still draws the selected row, within the body', () => {
    const many = Array.from({ length: 14 }, (_, index) => ({
      id: `r${String(index)}`,
      label: `row${String(index)}`,
    }));
    for (const geometry of [
      { bodyRows: 10, listRows: 10, innerWidth: 60 },
      // Inline at 80×24: a heading and a window of ten under it, the body one row taller.
      { bodyRows: 11, listRows: 10, innerWidth: 66 },
    ]) {
      const body = popupBody(
        {
          kind: 'list',
          rows: many,
          heading: { status: 'completed', statusWord: 'ok', text: 'doctor: all checks passed' },
        },
        at({ selected: 13 }),
        geometry,
      );
      const drawn = body.lines.map((line) => line.text);
      expect(drawn.join('\n')).toContain('row13');
      expect(drawn.length).toBeLessThanOrEqual(geometry.bodyRows);
    }
  });

  it('B15/B16: an error’s and an empty state’s two sentences pass the floor: no control sequence reaches a row', () => {
    for (const kind of ['error', 'empty'] as const) {
      const drawn = textOf({ kind, what: 'bad\u001b[31m thing', next: 'then\u001b[2J this' }).join(
        '\n',
      );
      expect(drawn).not.toContain('\u001b');
      expect(drawn).toContain('bad');
      expect(drawn).toContain('this');
    }
  });

  it('B24/B25/B27: a section label, a reason and a status word pass the floor too', () => {
    const drawn = textOf({
      kind: 'list',
      rows: [
        { id: 's', label: 'sec\u001b[31mtion', section: true, enabled: false },
        { id: 'd', label: 'disabled', enabled: false, reason: 'why\u001b[2J' },
        { id: 'w', label: 'word', status: 'warning', statusWord: 'wa\u001b[31mrn' },
      ],
    }).join('\n');
    expect(drawn).not.toContain('\u001b');
    expect(drawn).toContain('sec');
    expect(drawn).toContain('why');
    expect(drawn).toContain('wa');
  });
});

describe('a wrapped row of an empty or error state starts at its word (round 3, observation #3)', () => {
  it('the real `/cost --release` nothing-held sentence at 80×24: its second row starts with `release.`, at the column of the first', () => {
    const content: PopupContent = { kind: 'empty', ...NOTHING_HELD };
    const { geometry, text } = frame(content, { columns: 80, rows: 24 });
    const body = text.slice(1, 1 + geometry.bodyRows);
    const at = body.findIndex((row) => row.includes('release.'));
    expect(at).toBeGreaterThan(0);
    // The margin, then the word: never the space the wrap broke at.
    expect(body[at]?.startsWith(' release.')).toBe(true);
    expect(body[at]?.startsWith('  ')).toBe(false);
    for (const row of text) expect(displayWidth(row)).toBe(geometry.width);
  });

  it('a sentence whose first row fills the width exactly: no row after it starts with a space, in both states', () => {
    // 66 columns, then a space and the rest: the wrap breaks after the 66th column and leaves the space at the next row's start.
    const what = `${'a'.repeat(30)} ${'b'.repeat(35)} rest of it`;
    const next = `${'c'.repeat(66)} then this`;
    for (const kind of ['empty', 'error'] as const) {
      const content: PopupContent = kind === 'empty' ? { kind, what, next } : { kind, what, next };
      const body = withGlyphForm(false, () =>
        popupBody(content, { selected: 0, offset: 0 }, geometryFor(80, 24, 6)),
      );
      const texts = body.lines.map((line) => line.text);
      expect(texts).toContain(kind === 'empty' ? 'rest of it' : `${'b'.repeat(35)} rest of it`);
      expect(texts).toContain('then this');
      for (const row of texts.slice(1)) expect(row.startsWith(' ')).toBe(false);
    }
  });
});

describe('the frame model’s edges (round 3 mutation sweep)', () => {
  it('FM08/FM12/FM13: the rows a body asks for: a loading step with a filter line two, an empty report one, an empty list one', () => {
    expect(
      naturalBodyRows({ kind: 'loading', what: 'x' }, { selected: 0, offset: 0, filter: '' }),
    ).toBe(2);
    expect(naturalBodyRows({ kind: 'loading', what: 'x' }, { selected: 0, offset: 0 })).toBe(1);
    expect(naturalBodyRows({ kind: 'report', lines: [] }, { selected: 0, offset: 0 })).toBe(1);
    expect(naturalBodyRows({ kind: 'list', rows: [] }, { selected: 0, offset: 0 })).toBe(1);
  });

  it('FM15: a row that cannot act and names no reason says `unavailable`', () => {
    const { text } = frame({
      kind: 'list',
      rows: [
        { id: 'a', label: 'alpha' },
        { id: 'b', label: 'bravo', enabled: false },
      ],
    });
    expect(text[2]?.trim()).toBe('bravo  unavailable');
  });

  it('a page moves by the rows between its marker rows, at least one line; a page too short for markers moves whole', () => {
    expect([18, 17, 10, 4, 3, 2, 1, 0].map(reportPageStep)).toEqual([16, 15, 8, 2, 1, 2, 1, 1]);
  });

  it('a report fits its row only when every line, as drawn, is no wider than it', () => {
    expect(reportLinesFit(['a'.repeat(66), 'b'], 66)).toBe(true);
    expect(reportLinesFit(['b', 'a'.repeat(67)], 66)).toBe(false);
    expect(reportLinesFit([], 1)).toBe(true);
    // A host glyph is blanked to a space of the same width; a line separator is folded to one.
    expect(reportLinesFit([`${'a'.repeat(64)}●${String.fromCharCode(0x2028)}`], 66)).toBe(true);
  });
});
