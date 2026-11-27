import { describe, expect, it } from 'vitest';

import { modelSwitchNotice } from '../../chat/repl-info.js';
import { commandResultPreview } from './attachments.js';
import {
  entryLines,
  formatBusyLine,
  formatReasoningPanel,
  formatToolCall,
  toolCallText,
  transcriptDocument,
  wrapTranscript,
} from './chat-projection.js';
import { GLYPHS, MARKER_GLYPHS, withGlyphForm } from './glyphs.js';
import type { TranscriptEntry } from './session-view-model.js';
import { noticeLines, TEXT_FORM_YOUR_TURN } from './transcript-guard.js';
import { startsWithMarginWord } from './chat-grid.js';
import { displayWidth, wrapText, type DisplayLine } from './viewport.js';

/**
 * The speaker marker on the transcript's grid (MVP-11 unit 9, [ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §6; this file held step 7a's interim guard, and every assertion that moved says so).
 *
 * THE UNTRUSTED-TEXT SINK. The marker (`›`) is the host's mark of who spoke, the `▸` leads a tool call and the `⇄` a model switch. On the grid the
 * guard is STRUCTURAL: a row's mark is its `margin`, a role the host sets where it builds the row (`wrapEntry`) and that `marginCell` draws from
 * product constants, and every word of the row is CONTENT, laid out in the content column. So the first requirement these tests hold is "no row of
 * a reply, a command's output, a pasted line or a name carries a mark the host did not set". The structure is exact in the layout, not on a
 * terminal that measures a character wider than the layout does, so (review round 1 of unit 9, S-1, OQ4 as revised) every drawn row also goes
 * through the screen's filter and has the three glyphs BLANKED again, as step 7a did, in the text and the spans alike: the second requirement.
 * The documents keep every glyph. Each test names the requirement it holds and was proved against a mutant of the production code.
 */

/** A stand-in for a glyph: one column and no space, so a text written with it lays out exactly as the same text written with the glyph. */
const STAND_IN = 'Ж';
const SWAP = /[›▸⇄]/gu;

const ZWSP = String.fromCharCode(0x200b);
const LRM = String.fromCharCode(0x200e);
const RLO = String.fromCharCode(0x202e);
const COMBINING_ACUTE = String.fromCharCode(0x0301);
const ESC = String.fromCharCode(0x1b);
/** U+115F: the layout measures it 0 columns, a terminal may draw it two (review round 1, S-1). */
const HANGUL_FILLER = String.fromCodePoint(0x115f);

const assistant = (text: string): TranscriptEntry => ({ role: 'assistant', text });
const user = (text: string): TranscriptEntry => ({ role: 'user', text });
const notice = (text: string): TranscriptEntry => ({ role: 'notice', text });

/**
 * The margin roles of a reply's rows must be exactly: `agent` on its first row and on a row that starts with a margin word (the inline renderer's
 * word for the reply, review round 1, S-2), nothing on any other: no row of a reply carries a mark of the host.
 */
function expectReplyMargins(rows: readonly DisplayLine[], label: string): void {
  expect(
    rows.map((row) => row.margin),
    label,
  ).toEqual(
    rows.map((row, index) => (index === 0 || startsWithMarginWord(row.text) ? 'agent' : undefined)),
  );
}

/** No drawn text of `rows`, nor of any span, holds one of the host's three marker glyphs (they are blanked on the screen). */
function expectNoMarkerGlyph(rows: readonly DisplayLine[], label: string): void {
  for (const row of rows)
    for (const text of [row.text, ...(row.spans ?? []).map((span) => span.text)])
      expect(text, `${label}: ${JSON.stringify(text)}`).not.toMatch(SWAP);
}

/** The margin roles of rows that carry no host mark at all (a notice that names no lead, the hanging rows of a turn). */
function expectNoMargin(rows: readonly DisplayLine[], label: string): void {
  expect(
    rows.filter((row) => row.margin !== undefined),
    label,
  ).toEqual([]);
}

describe('the person’s turn carries the host’s mark as its first row’s margin role', () => {
  // Moved from step 7a: the first row's `marker` field and its text's leading glyph are now the row's `margin` role and a text without the prefix.
  it.each([true, false])(
    'the first row is the `yourTurn` role and the person’s words; the rest of the turn hangs with no role (colour %s)',
    (color) => {
      const rows = wrapTranscript(
        [user('hello world, a long message that wraps around')],
        20,
        color,
      );
      expect(rows.length).toBeGreaterThan(2);
      expect(rows[0]).toMatchObject({ margin: 'yourTurn', style: 'user' });
      expect(rows[0]?.text.startsWith('hello')).toBe(true);
      for (const row of rows.slice(1)) {
        expect(row.margin, JSON.stringify(row.text)).toBeUndefined();
        expect(row.style).toBe('user');
      }
    },
  );

  it('a turn typed on several lines marks only its first row: the later lines are rows of the turn, not turns', () => {
    const rows = wrapTranscript([user('first\nsecond\nthird')], 80, true);
    expect(rows.map((row) => row.text)).toEqual(['first', 'second', 'third']);
    expect(rows.map((row) => row.margin)).toEqual(['yourTurn', undefined, undefined]);
  });

  // Moved from "the marker costs no column and moves no row": the mark is not in the text at all now, so the turn's rows ARE the person's words
  // wrapped at the content width, the same in both forms (the form is the margin's, drawn by `marginCell`).
  it('the rows are the person’s words wrapped at the width, identical with colour on and off', () => {
    const bodies = [
      'short',
      'hello world, a long message that wraps around the width',
      'a\n\nb\n\n\nc',
      '中文 wide glyphs 中文 beside the marker 中文 and a 😀 emoji',
      `${'x'.repeat(70)} then a word`,
      '',
    ];
    for (const body of bodies) {
      for (const cols of [1, 2, 3, 7, 20, 80]) {
        const label = `${JSON.stringify(body)} @ ${cols}`;
        const plain = wrapTranscript([user(body)], cols, false);
        const marked = wrapTranscript([user(body)], cols, true);
        expect(marked, label).toEqual(plain);
        // the hanging wrap: a row the wrap starts begins at its text (review round 1, D-2)
        expect(
          marked.map((row) => row.text),
          label,
        ).toEqual(wrapText(body, cols, true));
      }
    }
  });

  it('an empty turn is a row with the mark and no words, and a one-column terminal still carries the role', () => {
    expect(wrapTranscript([user('')], 80, true)).toEqual([
      { text: '', style: 'user', margin: 'yourTurn' },
    ]);
    const narrow = wrapTranscript([user('ab')], 1, true);
    expect(narrow[0]).toEqual({ text: 'a', style: 'user', margin: 'yourTurn' });
    expect(narrow.slice(1).every((row) => row.margin === undefined)).toBe(true);
  });

  it('a transcript of several turns marks each turn once and a reply never as a turn', () => {
    const rows = wrapTranscript(
      [user('one'), assistant('answer one'), user('two'), assistant('answer two')],
      80,
      true,
    );
    expect(rows.filter((row) => row.margin === 'yourTurn').map((row) => row.text)).toEqual([
      'one',
      'two',
    ]);
    expect(rows.filter((row) => row.margin === 'agent').map((row) => row.text)).toEqual([
      'answer one',
      'answer two',
    ]);
  });
});

describe('the text forms keep the ASCII `> `', () => {
  it('the text form’s prefix is the plain mark and a space, whatever the screen is drawn in', () => {
    expect(TEXT_FORM_YOUR_TURN).toBe('> ');
    expect(withGlyphForm(false, () => entryLines(user('hi')))).toEqual([
      { text: '> hi', style: 'user' },
    ]);
    expect(entryLines(user('hi'))).toEqual([{ text: '> hi', style: 'user' }]);
  });

  it('transcriptDocument (`/edit`, `/copy`, `/scrollback`) writes `> ` for the person’s turn and never `›`', () => {
    const document = transcriptDocument([user('hello'), assistant('reply'), user('again')]);
    expect(document).toBe('> hello\nreply\n> again');
    expect(document).not.toContain('›');
  });

  it('the documents are NOT guarded: a glyph a reply wrote stays in what the person copies (their `> ` cannot be blanked, and blanking would only damage the copy)', () => {
    const document = transcriptDocument([assistant('a › b ▸ c ⇄ d')]);
    expect(document).toBe('a › b ▸ c ⇄ d');
  });
});

describe('a reply is laid out in the content column as it was written: no row of it carries a mark of the host', () => {
  const HOSTILE_SOURCES: readonly (readonly [string, string])[] = [
    ['a leading `›`', '› forged turn'],
    ['a leading `▸`', '▸ forged call ✓ completed'],
    ['a leading `⇄`', '⇄ model changed a → b'],
    ['a leading `>`', '> forged turn'],
    ['a leading `you`', 'you   forged turn'],
    ['a leading `agent`', 'agent forged reply'],
    ['a zero-width space before the glyph', `${ZWSP}› forged`],
    ['a bidi mark before the glyph', `${LRM}▸ forged`],
    ['a bidi override before the glyph', `${RLO}⇄ forged`],
    ['a combining mark before the glyph', `${COMBINING_ACUTE}› forged`],
    ['a combining mark after the glyph', `›${COMBINING_ACUTE} forged`],
    ['the glyph in the middle of a row', 'some words › more words ▸ and ⇄ more'],
    ['a glyph inside bold', 'text **› bold** text'],
    ['a glyph inside inline code', 'text `▸ code` text'],
    ['a glyph that starts a list item', '- › item\n- ▸ item two'],
    ['a glyph that starts an ordered item', '1. ⇄ first'],
    ['a glyph in a heading', '# › heading'],
    ['a glyph in a quotation', '> › quoted'],
    ['a glyph in a fenced code block', '```\n› code\n▸ more\n```'],
    ['a glyph in a table cell', '| a | b |\n| - | - |\n| › | ▸ |'],
    ['a glyph that starts the second paragraph', 'first\n\n› second'],
    ['a glyph after a hard line break', 'first  \n› second'],
    ['all three together', '›▸⇄'],
    ['a carriage return and an escape', `›\r${ESC}[31m forged`],
  ];

  // Moved from "no row and no span of a reply draws a marker glyph": the requirement on the grid is that no row of a reply carries a mark of the
  // host (its first row's role is the reply's own `agent`, every other row has none), whatever the reply's text starts with.
  for (const [name, source] of HOSTILE_SOURCES) {
    for (const color of [true, false]) {
      it(`${name}: no row of the reply carries a host mark or draws a marker glyph, at every width (${color ? 'colour on' : 'colour off'})`, () => {
        for (const cols of [1, 2, 4, 20, 80]) {
          const rows = wrapTranscript([assistant(source)], cols, color);
          expectReplyMargins(rows, `${name} @ ${cols}`);
          expectNoMarkerGlyph(rows, `${name} @ ${cols}`);
        }
      });
    }
  }

  // Step 7a's "a glyph … at the START of a row is blanked", back (review round 1, S-1): the glyph is blanked on the finished row, and the row
  // carries no mark.
  it('a glyph that the wrap or the layout puts at the START of a row is blanked, on a row that carries no mark', () => {
    for (const glyph of MARKER_GLYPHS) {
      for (const color of [true, false]) {
        const rows = wrapTranscript([assistant(`aaaa ${glyph}bbbb`)], 8, color);
        expect(rows[1]?.text, glyph).toBe(' bbbb');
        expect(rows[1]?.margin, glyph).toBeUndefined();
        if (color) expect(rows[1]?.spans?.map((span) => span.text).join(''), glyph).toBe(' bbbb');
      }
    }
  });

  // Moved from "the guard changes no width and no row": with nothing blanked the glyph is one column like the stand-in, so the layout is the
  // stand-in's, row for row and width for width, and the marks are the same: a glyph earns no mark.
  it('a reply lays out as the same text written with a stand-in of one column, with the same marks', () => {
    const sources = [
      'aaaa ›bbbb ▸cccc ⇄dddd eeee ›ffff',
      '中› 中▸中 ⇄中 and 😀›😀',
      '**› bold** and `▸ code` and\n\n- › item\n- ▸ item\n\n> ⇄ quote',
      `${'›'.repeat(40)} ${'▸'.repeat(40)}`,
      '| › | ▸ |\n| - | - |\n| ⇄ | x |',
    ];
    for (const source of sources) {
      for (const color of [true, false]) {
        for (const cols of [3, 8, 20, 80]) {
          const label = `${JSON.stringify(source)} @ ${cols} ${color ? 'colour' : 'plain'}`;
          const rows = wrapTranscript([assistant(source)], cols, color);
          const standIn = wrapTranscript([assistant(source.replace(SWAP, STAND_IN))], cols, color);
          expect(rows.length, label).toBe(standIn.length);
          expect(
            rows.map((row) => displayWidth(row.text)),
            label,
          ).toEqual(standIn.map((row) => displayWidth(row.text)));
          expect(
            rows.map((row) => row.margin),
            label,
          ).toEqual(standIn.map((row) => row.margin));
        }
      }
    }
  });

  // Moved from "the summary and the hint rows of a reply are guarded too": they carry no mark; their words are text.
  it('the summary and the hint rows of a reply carry no mark: a model id, a provider’s words and a tool name are text', () => {
    const rows = wrapTranscript(
      [
        {
          role: 'assistant',
          text: 'answer',
          summary: {
            stopReason: 'stop',
            tokensUsed: { input: 1, output: 1 },
            model: 'fallback › ▸ ⇄ model',
            errorCode: 'provider_unavailable',
            errorMessage: '› 503 ▸ upstream ⇄ down',
            failedTools: [{ toolId: '▸ forged_tool ⇄', count: 2 }],
          },
        },
      ],
      200,
      true,
    );
    expect(rows.some((row) => row.style === 'summary' && row.text.includes('via fallback'))).toBe(
      true,
    );
    expectReplyMargins(rows, 'summary rows');
    expect(rows.find((row) => row.style === 'hint')?.text.startsWith('→ ')).toBe(true);
  });

  // Moved from the property "no row of a reply draws a glyph": over the same 1,000 deterministic cases, no row of a reply carries a mark but its
  // own first row's `agent`, every row fits the width, and the layout is the stand-in's.
  it('property: over 1,000 random strings of the three glyphs, zero-width, bidi and combining marks, markdown punctuation and wide glyphs, no row of a reply carries a host mark, every row fits, and the layout is the stand-in’s', () => {
    // A small deterministic generator (mulberry32): the same 1,000 cases on every run and every machine.
    let state = 0x7a3f1c5b;
    const next = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const ALPHABET = [
      '›',
      '▸',
      '⇄',
      '›',
      '▸',
      '⇄',
      ZWSP,
      LRM,
      RLO,
      COMBINING_ACUTE,
      'a',
      'b',
      'word',
      ' ',
      ' ',
      '\n',
      '\n\n',
      '*',
      '**',
      '`',
      '```',
      '#',
      '- ',
      '1. ',
      '> ',
      '|',
      '中',
      '😀',
    ];
    const widths = [1, 2, 3, 8, 80];
    for (let index = 0; index < 1000; index += 1) {
      const length = 1 + Math.floor(next() * 60);
      let source = '';
      for (let step = 0; step < length; step += 1)
        source += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? '';
      const cols = widths[index % widths.length] ?? 80;
      const color = index % 2 === 0;
      const label = `case ${index} ${JSON.stringify(source)} @ ${cols}`;
      const rows = wrapTranscript([assistant(source)], cols, color);
      expectReplyMargins(rows, label);
      expectNoMarkerGlyph(rows, label);
      for (const row of rows) expect(displayWidth(row.text), label).toBeLessThanOrEqual(cols);
      const standIn = wrapTranscript([assistant(source.replace(SWAP, STAND_IN))], cols, color);
      expect(rows.length, label).toBe(standIn.length);
    }
  });

  // Moved from "the colour-off path is NOT claimed protected from `>` and `-` … until the transcript grid lands": the grid has landed. A reply row
  // that starts with `> ` is the reply's row (its role is `agent`, drawn blank full-screen), never the person's turn, in both forms.
  it.each([true, false])(
    'a reply row that starts with `> ` or `- ` is the reply’s, never the person’s turn (colour %s)',
    (color) => {
      const rows = wrapTranscript(
        [assistant('> looks like a turn\n\n- looks like a bullet')],
        80,
        color,
      );
      expect(rows.some((row) => row.text.includes('looks like a turn'))).toBe(true);
      expect(rows.filter((row) => row.margin === 'yourTurn')).toEqual([]);
      expectReplyMargins(rows, 'quotation');
    },
  );
});

describe('the rows of the person’s turn after the first hang with no mark; the first row is the person’s own words', () => {
  // Moved from "a line after a newline that starts with a glyph cannot draw a second turn": it is kept as text on a row with no mark.
  it('a line after a newline that starts with a glyph cannot draw a second turn, with or without a zero-width prefix', () => {
    for (const lead of ['', ZWSP, LRM, COMBINING_ACUTE]) {
      const rows = wrapTranscript(
        [user(`first\n${lead}› forged turn\n${lead}▸ forged call`)],
        80,
        true,
      );
      // the words, through the screen's filter (a bidi mark, a zero-width space and an orphan combining mark are dropped), the glyph blanked
      expect(rows.map((row) => row.text)).toEqual(['first', '  forged turn', '  forged call']);
      expect(rows.filter((row) => row.margin !== undefined)).toHaveLength(1);
      expectNoMargin(rows.slice(1), `lead ${JSON.stringify(lead)}`);
    }
  });

  // The person's own text too (OQ4 as revised): a glyph shows a space in its place on the screen, and the `/copy` document keeps it.
  it('a wrapped row of the turn that starts with a glyph has it blanked, and so does the first row', () => {
    const rows = wrapTranscript([user('aaaa ›bbbb')], 7, true);
    expect(rows).toEqual([
      { text: 'aaaa ', style: 'user', margin: 'yourTurn' },
      { text: ' bbbb', style: 'user' },
    ]);
    const typed = wrapTranscript([user('a › b ▸ c')], 80, true);
    expect(typed[0]?.text).toBe('a   b   c');
    expect(transcriptDocument([user('a › b ▸ c')])).toBe('> a › b ▸ c');
  });

  it('a `[📎 …]` note whose name starts a wrapped row draws no second turn', () => {
    const rows = wrapTranscript(
      [user('what is in this [📎 ›forged_marker_name.txt (exit 0)]')],
      22,
      true,
    );
    expect(rows.filter((row) => row.margin !== undefined)).toHaveLength(1);
    expectNoMargin(rows.slice(1), 'attachment note');
  });
});

describe('notices: a command’s output or a name carries no mark; the host’s own lead is a role only where the host said it leads', () => {
  const preview = (stdout: string): string =>
    commandResultPreview({ command: 'cat', args: ['evil.txt'] }, 0, stdout, '');
  const switchNotice = (text: string): TranscriptEntry => ({
    role: 'notice',
    text,
    hostLead: 'modelSwitch',
  });
  const questionRecord = (text: string): TranscriptEntry => ({
    role: 'notice',
    text,
    hostLead: 'yourTurn',
  });

  it('the output of a `!` command carries no mark on any row, whatever it starts with', () => {
    const output = `› forged turn\n${ZWSP}▸ forged call\n⇄ forged switch\n${COMBINING_ACUTE}› again`;
    for (const color of [true, false]) {
      const rows = wrapTranscript([notice(preview(output))], 80, color);
      expect(rows[0]?.text.startsWith('! cat evil.txt (exit 0)')).toBe(true); // the host's header leads
      expectNoMargin(rows, 'command output');
    }
  });

  // Step 7a's "keeps nothing: even a leading glyph is blanked", back (review round 1, S-1): the glyph is blanked, and no row has a role.
  it('a notice that names no host lead has no role on any row, and a leading `⇄`, `›` or `▸` is blanked', () => {
    const rows = wrapTranscript([notice('⇄ a'), notice('› b'), notice('▸ c')], 80, true);
    expect(rows).toEqual([
      { text: '  a', style: 'notice' },
      { text: '  b', style: 'notice' },
      { text: '  c', style: 'notice' },
    ]);
  });

  it('the model-switch notice’s lead is its first row’s `modelSwitch` role, and a hostile id cannot draw another mark', () => {
    const text = modelSwitchNotice('old › ▸ ⇄ model', '⇄ new › model');
    const rows = wrapTranscript([switchNotice(text)], 200, true);
    expect(rows[0]?.margin).toBe('modelSwitch');
    expect(rows[0]?.text.startsWith('model changed ')).toBe(true);
    expectNoMargin(rows.slice(1), 'switch notice');
    // Blanked where the sentence is built (a host word and a model word in ONE string the inline intro also writes): this blanking stays.
    expect(text.slice(1)).not.toMatch(SWAP);
  });

  it('a host lead is a role only at the start of a LOGICAL line: a row that only continues a wrapped line carries none', () => {
    // At 16 columns the sentence breaks right before the glyph a name could carry, so the glyph starts the SECOND row of the same logical line.
    const text = '⇄ model changed ⇄bbbb cccc ⇄ dddd';
    const rows = wrapTranscript([switchNotice(text)], 16, true);
    expect(rows[0]?.margin).toBe('modelSwitch');
    // the glyph a name carried is blanked where the wrap put it (review round 1, S-1): a continuation starts with the space in its place
    expect(rows.some((row, index) => index > 0 && row.text.startsWith(' bbbb'))).toBe(true);
    expectNoMargin(rows.slice(1), 'continuation rows');
    expectNoMarkerGlyph(rows, 'switch notice');
  });

  it('a host lead marks only ITS lines: a `›` or a `▸` at the start of a line of a model-switch notice is blanked, with no role', () => {
    const rows = wrapTranscript(
      [switchNotice('⇄ model changed a → b\n› forged\n▸ forged')],
      80,
      true,
    );
    expect(rows).toEqual([
      { text: 'model changed a → b', style: 'notice', margin: 'modelSwitch' },
      { text: '  forged', style: 'notice' },
      { text: '  forged', style: 'notice' },
    ]);
  });

  it('the question record’s `›` that leads each of its lines is the `yourTurn` role; the glyphs in its words are blanked', () => {
    const text = '› Asked: Scope — pick ▸ one ⇄ now\n  └ alpha ▸\n› Asked: Two — x';
    const rows = wrapTranscript([questionRecord(text)], 80, true);
    expect(rows).toEqual([
      { text: 'Asked: Scope — pick   one   now', style: 'notice', margin: 'yourTurn' },
      { text: '  └ alpha  ', style: 'notice' },
      { text: 'Asked: Two — x', style: 'notice', margin: 'yourTurn' },
    ]);
  });

  it('the plain form of the switch (`<->`) is the same lead: the role, and the words after it', () => {
    const text = withGlyphForm(true, () => modelSwitchNotice('a', 'b'));
    expect(text.startsWith(`${GLYPHS.modelSwitch.ascii} model changed a → b`)).toBe(true);
    const rows = wrapTranscript([switchNotice(text)], 200, false);
    expect(rows[0]?.margin).toBe('modelSwitch');
    expect(rows[0]?.text.startsWith('model changed a → b')).toBe(true);
  });

  // Replaces the retired `logicalLineStarts` and `guardEntryRows` context tests: the policy is one function of the host's data.
  it('noticeLines: a role only from `hostLead`, only for a line that begins with the lead and a space, in either form', () => {
    expect(noticeLines('⇄ a\n› b', undefined)).toEqual([{ text: '⇄ a' }, { text: '› b' }]);
    expect(noticeLines('⇄ a\n⇄b\n x ⇄ y', 'modelSwitch')).toEqual([
      { text: 'a', margin: 'modelSwitch' },
      { text: '⇄b' },
      { text: ' x ⇄ y' },
    ]);
    expect(noticeLines('> a\n› b\n▸ c', 'yourTurn')).toEqual([
      { text: 'a', margin: 'yourTurn' },
      { text: 'b', margin: 'yourTurn' },
      { text: '▸ c' },
    ]);
    expect(noticeLines('<-> a', 'modelSwitch')).toEqual([{ text: 'a', margin: 'modelSwitch' }]);
    expect(noticeLines('', 'yourTurn')).toEqual([{ text: '' }]);
  });
});

describe('tool rows: the host’s `▸` is the margin’s, and the words that are not the host’s are blanked where they share its string', () => {
  // Unchanged: the plain driver and the documents keep `formatToolCall`'s string byte for byte, and the id and target are blanked inside it.
  it('formatToolCall keeps its leading `▸` and blanks a glyph in the tool’s id and in its target', () => {
    const line = formatToolCall(
      { id: 'c1', toolId: 'weird▸tool›name⇄', resolved: true, success: true, outcome: 'success' },
      { callId: 'c1', toolId: 'weird▸tool›name⇄', outcome: 'success', target: '› a ▸ path ⇄ here' },
    );
    expect(line.startsWith('▸ ')).toBe(true);
    expect(line.slice(1)).not.toMatch(SWAP);
    expect(line).toContain('weird tool name');
    expect(line).toContain('→   a   path   here');
  });

  // Moved from "each row keeps the host's `▸` once per call": one call per row (OQ2), the `▸` is the row's `toolCall` role, the text is the call's
  // words (`toolCallText`) with no glyph of the set.
  it('a tool entry is one call per row, each the `toolCall` role and the call’s words, with no glyph in them', () => {
    const calls = Array.from({ length: 6 }, (_, index) => ({
      id: `c${index}`,
      toolId: `t${index}▸x`,
      resolved: true,
      success: true,
      outcome: 'success' as const,
    }));
    const rows = wrapTranscript([{ role: 'tools', text: '', calls, omitted: 3 }], 400, true);
    expect(rows.map((row) => row.margin)).toEqual([...calls.map(() => 'toolCall'), undefined]);
    expect(rows.slice(0, 6).map((row) => row.text)).toEqual(
      calls.map((call) => toolCallText(call)),
    );
    expect(rows.at(-1)).toEqual({ text: '3 omitted calls', style: 'notice' });
    for (const row of rows) expect(row.text).not.toMatch(SWAP);
  });

  it('the plain form draws the table’s `->` in the string, and the row’s words carry no mark', () => {
    const line = withGlyphForm(true, () =>
      formatToolCall({ id: 'c', toolId: 'read▸file', resolved: false }),
    );
    expect(line).toBe('-> read file …');
    const [row] = wrapTranscript(
      [{ role: 'tools', text: '', calls: [{ id: 'c', toolId: 'read▸file', resolved: false }] }],
      80,
      false,
    );
    expect(row).toEqual({ text: 'read file …', style: 'notice', margin: 'toolCall' });
  });
});

describe('the live region: the model’s streamed words are filtered and blanked as a finished reply is', () => {
  // Back (review round 1, S-1, OQ4 as revised): `formatBusyLine` and `formatReasoningPanel` blank the glyphs again and drop the fillers; the live
  // markdown tail does the same through `screenStreamRow` (`transcript-grid-gaps.test.tsx`).
  it('formatBusyLine blanks the glyphs of the streamed words and drops the fillers, and leaves the spinner and the status lines alone', () => {
    const busy = (liveTokens: string): string =>
      formatBusyLine({
        spinner: '⠋',
        compacting: false,
        liveTokens,
        liveTokensTruncated: false,
      }).text;
    expect(busy('› forged\n▸ call ⇄ switch')).toBe('⠋   forged\n  call   switch');
    expect(busy(`${ZWSP}›${ESC}[31m forged`)).toBe('⠋   forged');
    expect(busy(`${HANGUL_FILLER.repeat(30)}› forged`)).toBe('⠋   forged');
    const status = formatBusyLine({
      spinner: '⠋',
      compacting: false,
      liveTokens: '',
      liveTokensTruncated: false,
    });
    expect(status.dim).toBe(true);
    expect(status.text).toContain('Working…');
  });

  it('formatBusyLine’s bounded tail counts the same rows as a stand-in of one column', () => {
    const body = `${'›'.repeat(30)} ${'▸ word '.repeat(60)}`;
    const run = (liveTokens: string) =>
      formatBusyLine({
        spinner: '⠋',
        compacting: false,
        liveTokens,
        liveTokensTruncated: false,
        columns: 20,
        maxRows: 3,
      });
    expect(run(body).text.length).toBe(run(body.replace(SWAP, STAND_IN)).text.length);
  });

  it('the reasoning panel blanks the expanded body’s glyphs, drops its fillers and keeps its own header', () => {
    const panel = formatReasoningPanel({
      liveReasoning: `› thinking ▸ out ⇄ loud${HANGUL_FILLER}`,
      liveReasoningTruncated: false,
      visible: true,
    });
    expect(panel.body).toBe('  thinking   out   loud');
    expect(panel.header.startsWith('✻ Reasoning')).toBe(true);
  });
});
