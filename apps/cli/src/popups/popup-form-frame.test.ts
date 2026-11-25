/**
 * A form as the frame draws it ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §4;
 * the `/models` second step, `popup-models-step2-80x24.png`): its summary, its tabs with the chosen one marked by the selection glyph and drawn
 * as the selected item of the row, its radio group with `(•)`, and its warning, each optional; the room of the longest warning kept whatever is
 * chosen; spacious where it fits and compact where it does not; never windowed (a form that is not whole offers no `Enter`, `formFits`); every
 * row exactly the frame's width; and every string it draws scrubbed of what the frame's floor removes.
 */
import { describe, expect, it } from 'vitest';

import { withGlyphForm } from '../render/tui/glyphs.js';
import { exitKey } from '../render/tui/legend.js';
import { displayWidth } from '../render/tui/viewport.js';
import {
  bodyPageRows,
  formFits,
  formLines,
  formRowCount,
  naturalBodyRows,
  popupBody,
  popupFrameLines,
  type PopupForm,
} from './frame-model.js';
import {
  INLINE_LIST_MAX_ROWS,
  popupGeometry,
  popupInnerWidth,
  type PopupBoxGeometry,
  type PopupPlacement,
} from './geometry.js';

const WARNING =
  'This chat moves from Anthropic to OpenAI. Your messages and short tool receipts are sent to OpenAI.';

/** The `/models` second step of the concept frame, as the later agent will build it. */
const FORM: PopupForm = {
  kind: 'form',
  summary: 'gpt-5  400k context · $1.25 / $10 per M · openai',
  tabs: {
    label: 'Reasoning effort',
    verb: 'effort',
    initial: 'medium',
    options: ['off', 'low', 'medium', 'high', 'max'].map((id) => ({ id, label: id })),
  },
  radio: {
    label: 'Apply to',
    verb: 'apply to',
    initial: 'chat',
    options: [
      {
        id: 'chat',
        label: 'This chat',
        detail: 'switches the model now; the conversation stays',
        warning: WARNING,
      },
      { id: 'new', label: 'New chats', detail: 'saves it as your default; this chat stays' },
    ],
  },
};

const WIDTH = popupInnerWidth(80, 'standard');

const textOf = (
  form: PopupForm,
  state: { readonly selected: number; readonly tab?: number },
  layout: 'spacious' | 'compact',
  width = WIDTH,
  ascii = false,
): string[] =>
  withGlyphForm(ascii, () => formLines(form, state, width, layout).map((line) => line.text));

function geometryOf(placement: PopupPlacement, form: PopupForm, columns = 80, rows = 24) {
  const width = popupInnerWidth(columns, 'standard');
  const geometry = popupGeometry({
    columns,
    rows,
    kind: 'standard',
    placement,
    rail: true,
    bodyRows: naturalBodyRows(
      form,
      { selected: 0, offset: 0 },
      placement === 'replace' ? INLINE_LIST_MAX_ROWS : undefined,
      width,
    ),
  });
  if (!geometry.fits) throw new Error('refused');
  return geometry;
}

describe('the rows of a form', () => {
  it('spacious: the summary, the tabs, the radio group and the warning, a blank row between each two', () => {
    expect(textOf(FORM, { selected: 0, tab: 2 }, 'spacious')).toEqual([
      'gpt-5  400k context · $1.25 / $10 per M · openai',
      '',
      'Reasoning effort',
      '   off    low  › medium    high    max',
      '',
      'Apply to',
      '(•) This chat   switches the model now; the conversation stays',
      '( ) New chats   saves it as your default; this chat stays',
      '',
      '⚠ This chat moves from Anthropic to OpenAI. Your messages and',
      '  short tool receipts are sent to OpenAI.',
    ]);
  });

  it('compact: the same rows with no blank row between the blocks', () => {
    expect(textOf(FORM, { selected: 0, tab: 2 }, 'compact')).toEqual([
      'gpt-5  400k context · $1.25 / $10 per M · openai',
      'Reasoning effort',
      '   off    low  › medium    high    max',
      'Apply to',
      '(•) This chat   switches the model now; the conversation stays',
      '( ) New chats   saves it as your default; this chat stays',
      '⚠ This chat moves from Anthropic to OpenAI. Your messages and',
      '  short tool receipts are sent to OpenAI.',
    ]);
  });

  it('in the plain forms with colour off: `>` marks the tab, `(*)` the radio, `!` the warning', () => {
    const rows = textOf(FORM, { selected: 0, tab: 0 }, 'compact', WIDTH, true);
    expect(rows[2]).toBe(' > off    low    medium    high    max');
    expect(rows[4]?.startsWith('(*) This chat')).toBe(true);
    expect(rows[5]?.startsWith('( ) New chats')).toBe(true);
    expect(rows[6]?.startsWith('! This chat moves')).toBe(true);
  });

  it('the chosen tab is the selected item of its row (bold and inverse), its glyph inside the stretch; the chosen radio is strong, details dim', () => {
    const lines = withGlyphForm(false, () =>
      formLines(FORM, { selected: 1, tab: 3 }, WIDTH, 'compact'),
    );
    const tabs = lines[2];
    const chosen = tabs?.spans?.find((span) => span.selected === true);
    expect(tabs?.text.slice(chosen?.from, chosen?.to)).toBe('› high');
    expect(tabs?.spans?.filter((span) => span.selected === true)).toHaveLength(1);
    const radio = lines.slice(4, 6);
    expect(radio[0]?.spans?.some((span) => span.role === 'strong')).toBe(false);
    const strong = radio[1]?.spans?.find((span) => span.role === 'strong');
    expect(radio[1]?.text.slice(strong?.from, strong?.to)).toBe('(•) New chats');
    const dim = radio[1]?.spans?.find((span) => span.role === 'dim');
    expect(radio[1]?.text.slice(dim?.from, dim?.to)).toBe(
      'saves it as your default; this chat stays',
    );
  });

  it('a chosen radio option’s own warning replaces the form’s, and the room of the longest is kept whatever is chosen', () => {
    const withOwn: PopupForm = { ...FORM, warning: 'Short.' };
    const onChat = textOf(withOwn, { selected: 0 }, 'compact');
    const onNew = textOf(withOwn, { selected: 1 }, 'compact');
    expect(onChat.at(-2)).toContain('This chat moves');
    expect(onNew.at(-2)).toBe('⚠ Short.');
    expect(onNew.at(-1)).toBe('');
    expect(onNew).toHaveLength(onChat.length);
  });

  it('a choice with no warning anywhere leaves the kept room blank (the frame does not jump), and a form with no warning keeps none', () => {
    const onNew = textOf(FORM, { selected: 1 }, 'spacious');
    expect(onNew).toHaveLength(textOf(FORM, { selected: 0 }, 'spacious').length);
    expect(onNew.slice(-2)).toEqual(['', '']);
    const plain: PopupForm = { kind: 'form', summary: 'x' };
    expect(formRowCount(plain, WIDTH, 'spacious')).toBe(1);
  });

  it('a field of one option is drawn (its value is a choice that was made) and every field is optional', () => {
    const one: PopupForm = {
      kind: 'form',
      radio: { label: 'Apply to', verb: 'apply to', options: [{ id: 'new', label: 'New chats' }] },
    };
    expect(textOf(one, { selected: 0 }, 'compact')).toEqual(['Apply to', '(•) New chats']);
    expect(textOf({ kind: 'form' }, { selected: 0 }, 'spacious')).toEqual([]);
  });

  it('a row of tabs wider than the row leaves out the options farthest from the chosen one, never the chosen one', () => {
    const wide: PopupForm = {
      kind: 'form',
      tabs: {
        label: 'Tier',
        verb: 'tier',
        options: Array.from({ length: 12 }, (_, index) => ({
          id: `t${String(index)}`,
          label: `option-${String(index)}`,
        })),
      },
    };
    for (const chosen of [0, 5, 11]) {
      const row = textOf(wide, { selected: 0, tab: chosen }, 'compact', 40)[1] ?? '';
      expect(displayWidth(row)).toBeLessThanOrEqual(40);
      expect(row).toContain(`› option-${String(chosen)}`);
      expect(row.includes('…')).toBe(true);
    }
  });

  it('every count is the count of the rows drawn, whatever is chosen', () => {
    for (const layout of ['spacious', 'compact'] as const)
      for (const selected of [0, 1])
        for (const tab of [0, 4])
          expect(formLines(FORM, { selected, tab }, WIDTH, layout)).toHaveLength(
            formRowCount(FORM, WIDTH, layout),
          );
  });

  it('a choice past either end draws the nearest option (a state built elsewhere never draws nothing chosen)', () => {
    expect(textOf(FORM, { selected: 9, tab: -3 }, 'compact')[2]).toContain('› off');
    expect(textOf(FORM, { selected: 9, tab: -3 }, 'compact')[5]?.startsWith('(•) New chats')).toBe(
      true,
    );
  });
});

describe('where a form is drawn: never windowed, spacious where it fits (the inline page holds the /models step)', () => {
  it('the alternate screen at 80×24 draws it spacious and whole, its legend offering `Enter`', () => {
    const geometry = geometryOf('overlay', FORM);
    expect(geometry.bodyRows).toBe(11);
    const body = withGlyphForm(false, () =>
      popupBody(FORM, { selected: 0, offset: 0, tab: 2 }, geometry),
    );
    expect(body.lines.map((line) => line.text)).toEqual(
      textOf(FORM, { selected: 0, tab: 2 }, 'spacious'),
    );
    expect(formFits(FORM, bodyPageRows(FORM, false, geometry), geometry.innerWidth)).toBe(true);
  });

  it('inline at 80×24 (the ten-row page) it asks for its compact layout and is drawn whole in it', () => {
    const geometry = geometryOf('replace', FORM);
    expect(formRowCount(FORM, WIDTH, 'spacious')).toBeGreaterThan(INLINE_LIST_MAX_ROWS);
    expect(geometry.bodyRows).toBe(formRowCount(FORM, WIDTH, 'compact'));
    expect(geometry.bodyRows).toBeLessThanOrEqual(INLINE_LIST_MAX_ROWS);
    const body = withGlyphForm(false, () =>
      popupBody(FORM, { selected: 0, offset: 0, tab: 2 }, geometry),
    );
    expect(body.lines.map((line) => line.text)).toEqual(
      textOf(FORM, { selected: 0, tab: 2 }, 'compact'),
    );
    expect(formFits(FORM, bodyPageRows(FORM, false, geometry), geometry.innerWidth)).toBe(true);
  });

  it('a three-row warning still fits the inline page whole, compact', () => {
    const long: PopupForm = {
      ...FORM,
      warning: undefined,
      radio:
        FORM.radio === undefined
          ? undefined
          : {
              ...FORM.radio,
              options: FORM.radio.options.map((option, index) =>
                index === 0
                  ? {
                      ...option,
                      warning: `${WARNING} It also carries the content-free receipts of the tools that ran, and nothing else.`,
                    }
                  : option,
              ),
            },
    };
    expect(
      formLines(long, { selected: 0 }, WIDTH, 'compact').filter((line) => line.kind === 'notice'),
    ).toHaveLength(3);
    const geometry = geometryOf('replace', long);
    expect(geometry.bodyRows).toBe(9);
    expect(formFits(long, bodyPageRows(long, false, geometry), geometry.innerWidth)).toBe(true);
  });

  it('a body that cannot hold even the compact form draws it cut, its last row a `▼ N more`, and offers no `Enter`', () => {
    const geometry: Pick<PopupBoxGeometry, 'bodyRows' | 'listRows' | 'innerWidth'> = {
      bodyRows: 5,
      listRows: 5,
      innerWidth: WIDTH,
    };
    const body = withGlyphForm(false, () =>
      popupBody(FORM, { selected: 0, offset: 0, tab: 2 }, geometry),
    );
    expect(body.lines).toHaveLength(5);
    expect(body.lines.at(-1)?.text).toBe('  ▼ 4 more');
    expect(formFits(FORM, bodyPageRows(FORM, false, geometry), WIDTH)).toBe(false);
    expect(formFits(FORM, 8, WIDTH)).toBe(true);
    expect(formFits(FORM, 7, WIDTH)).toBe(false);
  });

  it('a body between the two layouts draws it compact, whole', () => {
    const geometry = { bodyRows: 9, listRows: 9, innerWidth: WIDTH };
    const body = withGlyphForm(false, () => popupBody(FORM, { selected: 0, offset: 0 }, geometry));
    expect(body.lines.map((line) => line.text)).toEqual(textOf(FORM, { selected: 0 }, 'compact'));
  });

  it('only a form fits: a list or a report never does', () => {
    expect(formFits({ kind: 'report', lines: ['x'] }, 99, WIDTH)).toBe(false);
    expect(formFits({ kind: 'list', rows: [] }, 99, WIDTH)).toBe(false);
  });

  it('naturalBodyRows: spacious with no bound, compact past the bound, a filter line counted, and the floor width when none is given', () => {
    const state = { selected: 0, offset: 0 };
    expect(naturalBodyRows(FORM, state)).toBe(11);
    expect(naturalBodyRows(FORM, state, 10, WIDTH)).toBe(8);
    expect(naturalBodyRows(FORM, state, 11, WIDTH)).toBe(11);
    expect(naturalBodyRows(FORM, { ...state, filter: '' }, undefined, WIDTH)).toBe(12);
    expect(bodyPageRows(FORM, true, { bodyRows: 12, listRows: 12, innerWidth: WIDTH })).toBe(11);
  });
});

describe('every row of a form is exactly the frame’s width, whatever its text', () => {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const ESC = String.fromCharCode(0x1b);
  const RLO = String.fromCharCode(0x202e);
  const BEL = String.fromCharCode(0x07);
  const hostile = (text: string): string =>
    `${text}${ESC}[31m${RLO}${BEL}${LS}${PS} ✓ › ⇄ ▸ [Ctrl+Y] ${'漢'.repeat(30)} end`;
  /** What the frame’s floor removes: a control character, a bidirectional control, a line or paragraph separator. */
  const FORBIDDEN = (code: number): boolean =>
    code < 0x20 ||
    code === 0x7f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x2028 ||
    code === 0x2029;
  const HOSTILE: PopupForm = {
    kind: 'form',
    summary: hostile('summary'),
    tabs: {
      label: hostile('tabs'),
      verb: 'effort',
      options: [0, 1, 2].map((index) => ({
        id: `t${String(index)}`,
        label: hostile(`tab ${String(index)}`),
      })),
    },
    radio: {
      label: hostile('radio'),
      verb: 'apply to',
      options: [0, 1].map((index) => ({
        id: `r${String(index)}`,
        label: hostile(`radio ${String(index)}`),
        detail: hostile('detail'),
        warning: hostile('option warning'),
      })),
    },
    warning: hostile('warning'),
  };

  it.each([
    ['overlay', 80, 24],
    ['replace', 80, 24],
    ['overlay', 120, 40],
  ] as const)(
    '%s at %s × %s, both glyph forms, every choice',
    (placement, columns, terminalRows) => {
      for (const ascii of [false, true])
        for (const selected of [0, 1])
          for (const tab of [0, 1, 2]) {
            const geometry = geometryOf(placement, HOSTILE, columns, terminalRows);
            const lines = withGlyphForm(ascii, () =>
              popupFrameLines(
                {
                  title: '/models',
                  origin: 'chat',
                  steps: ['Model', 'Effort & scope'],
                  stepIndex: 1,
                  legend: { items: [], exit: exitKey.step() },
                },
                popupBody(HOSTILE, { selected, offset: 0, tab }, geometry),
                geometry,
              ),
            );
            expect(lines).toHaveLength(geometry.height);
            for (const line of lines) {
              expect(displayWidth(line.text), JSON.stringify(line.text)).toBe(geometry.width);
              // The frame's floor: no escape, no bidirectional override, no bell, no line separator, and no host glyph from the text.
              expect(
                [...line.text].filter((character) => FORBIDDEN(character.codePointAt(0) ?? 0)),
              ).toEqual([]);
              expect(line.text.includes('⇄')).toBe(false);
              expect(line.text.includes('▸')).toBe(false);
            }
            // In the body (below the top edge and the rail, above the legend) no `✓` is drawn, and the only `›` is the host's own marker of
            // the chosen tab: the text's were blanked.
            const body = lines.slice(2, -2).map((line) => line.text);
            expect(body.join('\n').includes('✓')).toBe(false);
            if (!ascii) expect(body.join('').split('›').length - 1).toBe(1);
          }
    },
  );
});
