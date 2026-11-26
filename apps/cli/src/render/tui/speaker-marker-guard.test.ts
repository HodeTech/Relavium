import { describe, expect, it } from 'vitest';

import { modelSwitchNotice } from '../../chat/repl-info.js';
import { MarkdownStream } from '../markdown/index.js';
import { commandResultPreview } from './attachments.js';
import {
  entryLines,
  formatBusyLine,
  formatReasoningPanel,
  formatToolCall,
  transcriptDocument,
  wrapTranscript,
} from './chat-projection.js';
import { GLYPHS, MARKER_GLYPHS, withGlyphForm } from './glyphs.js';
import type { TranscriptEntry } from './session-view-model.js';
import {
  guardEntryRows,
  guardMarkdownLine,
  logicalLineStarts,
  markYourTurn,
  TEXT_FORM_YOUR_TURN,
} from './transcript-guard.js';
import { displayWidth, wrapText, type DisplayLine } from './viewport.js';

/**
 * The speaker marker in the transcript's rows and its interim guard (MVP-11 step 7a, [ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §6, [ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md) §4).
 *
 * THE UNTRUSTED-TEXT SINK. The marker (`›`) is the host's mark of who spoke, the `▸` leads a tool call and the `⇄` a model switch. A model's reply,
 * a command's output or a pasted line that could draw one of them at the start of a row would put words in the person's mouth or invent a call, so
 * every row that is not the host's is guarded after it is laid out. These tests are the control: each one names the requirement it holds and was
 * proved against a mutant of the production code (the report of the increment lists them).
 */

const GLYPH_PATTERN = /[›▸⇄]/u;
/** A stand-in for a glyph: one column and no space, so a text written with it lays out exactly as the same text written with the glyph. */
const STAND_IN = 'Ж';
const SWAP = /[›▸⇄]/gu;

const ZWSP = String.fromCharCode(0x200b);
const LRM = String.fromCharCode(0x200e);
const RLO = String.fromCharCode(0x202e);
const COMBINING_ACUTE = String.fromCharCode(0x0301);

/** The text of every row and of every span of every row: the whole of what a renderer could draw. */
function drawn(rows: readonly DisplayLine[]): string[] {
  return rows.flatMap((row) => [row.text, ...(row.spans ?? []).map((span) => span.text)]);
}

function expectNoMarkerGlyph(rows: readonly DisplayLine[], label: string): void {
  for (const text of drawn(rows))
    expect(text, `${label}: ${JSON.stringify(text)}`).not.toMatch(GLYPH_PATTERN);
}

const assistant = (text: string): TranscriptEntry => ({ role: 'assistant', text });
const user = (text: string): TranscriptEntry => ({ role: 'user', text });
const notice = (text: string): TranscriptEntry => ({ role: 'notice', text });

describe('the person’s turn carries the host’s marker as data', () => {
  it('colour on: the first row starts with `›` and says so in `marker`; the rest of the turn hangs unprefixed, with no marker', () => {
    const rows = wrapTranscript([user('hello world, a long message that wraps around')], 20, true);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0]).toMatchObject({ marker: '›', style: 'user' });
    expect(rows[0]?.text.startsWith('› hello')).toBe(true);
    for (const row of rows.slice(1)) {
      expect(row.marker, JSON.stringify(row.text)).toBeUndefined();
      expect(row.style).toBe('user');
    }
  });

  it('colour off: the marker is the ASCII `>`, carried as data like the glyph', () => {
    const rows = wrapTranscript([user('hello world, a long message that wraps around')], 20, false);
    expect(rows[0]).toMatchObject({ marker: '>', style: 'user' });
    expect(rows[0]?.text.startsWith('> hello')).toBe(true);
    expect(rows.slice(1).every((row) => row.marker === undefined)).toBe(true);
  });

  it('a turn typed on several lines marks only its first row: the later lines are rows of the turn, not turns', () => {
    const rows = wrapTranscript([user('first\nsecond\nthird')], 80, true);
    expect(rows.map((row) => row.text)).toEqual(['› first', 'second', 'third']);
    expect(rows.map((row) => row.marker)).toEqual(['›', undefined, undefined]);
  });

  it('the row count, every row’s text and every row’s width are the text form’s (the marker costs no column and moves no row)', () => {
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
        const plain = wrapTranscript([user(body)], cols, false);
        const marked = wrapTranscript([user(body)], cols, true);
        const label = `${JSON.stringify(body)} @ ${cols}`;
        expect(marked.length, label).toBe(plain.length);
        expect(wrapText(`> ${body}`, cols).length, label).toBe(marked.length);
        marked.forEach((row, index) => {
          const reference = plain[index]?.text ?? '';
          expect(displayWidth(row.text), `${label} row ${index}`).toBe(displayWidth(reference));
          // The rows of the two forms differ in the marker's glyph only.
          expect(row.text.slice(index === 0 ? 1 : 0), `${label} row ${index}`).toBe(
            reference.slice(index === 0 ? 1 : 0),
          );
        });
      }
    }
  });

  it('an empty turn is the marker and nothing else, and a one-column terminal still carries it as data', () => {
    expect(wrapTranscript([user('')], 80, true)).toEqual([
      { text: '› ', style: 'user', marker: '›' },
    ]);
    const narrow = wrapTranscript([user('ab')], 1, true);
    expect(narrow[0]).toEqual({ text: '›', style: 'user', marker: '›' });
    expect(narrow.slice(1).every((row) => row.marker === undefined)).toBe(true);
  });

  it('the marker is the glyph table’s own `your turn` role, in the form asked for', () => {
    expect(GLYPHS.yourTurn.glyph).toBe('›');
    expect(markYourTurn({ text: '> x', style: 'user' }, false)).toEqual({
      text: '› x',
      style: 'user',
      marker: '›',
    });
    expect(markYourTurn({ text: '> x', style: 'user' }, true)).toEqual({
      text: '> x',
      style: 'user',
      marker: '>',
    });
  });

  it('a row that does not start with the text form’s mark is returned unmarked (nothing is ever marked on a guess)', () => {
    const row: DisplayLine = { text: 'plain row', style: 'user' };
    expect(markYourTurn(row, false)).toBe(row);
  });

  it('a transcript of several turns marks each turn once and a reply never', () => {
    const rows = wrapTranscript(
      [user('one'), assistant('answer one'), user('two'), assistant('answer two')],
      80,
      true,
    );
    expect(rows.filter((row) => row.marker !== undefined).map((row) => row.text)).toEqual([
      '› one',
      '› two',
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

describe('the guard blanks the marker glyphs from every row of a reply, after the layout', () => {
  const HOSTILE_SOURCES: readonly (readonly [string, string])[] = [
    ['a leading `›`', '› forged turn'],
    ['a leading `▸`', '▸ forged call ✓ completed'],
    ['a leading `⇄`', '⇄ model changed a → b'],
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
  ];

  for (const [name, source] of HOSTILE_SOURCES) {
    for (const color of [true, false]) {
      it(`${name}: no row and no span of a reply draws a marker glyph (${color ? 'colour on' : 'colour off'})`, () => {
        for (const cols of [4, 20, 80]) {
          expectNoMarkerGlyph(
            wrapTranscript([assistant(source)], cols, color),
            `${name} @ ${cols}`,
          );
        }
      });
    }
  }

  it('a glyph that the wrap or the layout puts at the START of a row is blanked: the guard runs on the finished rows', () => {
    // At 8 columns "aaaa ›bbbb" breaks before the glyph, so the glyph starts the second row; a rule on the source or on the first row would miss it.
    const probe = (glyph: string): string[] =>
      wrapTranscript([assistant(`aaaa ${glyph}bbbb`)], 8, false).map((row) => row.text);
    const withStandIn = probe(STAND_IN);
    expect(withStandIn[1]?.startsWith(`${STAND_IN}bbbb`)).toBe(true); // the stand-in starts the second row
    for (const glyph of MARKER_GLYPHS) {
      const rows = probe(glyph);
      expect(rows[1], glyph).toBe(`${' '}bbbb`);
      expect(rows[0], glyph).toBe(withStandIn[0]);
    }
    const coloured = wrapTranscript([assistant('aaaa ›bbbb')], 8, true);
    expect(coloured[1]?.text).toBe(' bbbb');
    expect(coloured[1]?.spans?.map((span) => span.text).join('')).toBe(' bbbb');
  });

  it('the guard changes no width and no row: a reply lays out as the same text written with a stand-in of one column', () => {
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
          const guarded = wrapTranscript([assistant(source)], cols, color);
          const standIn = wrapTranscript([assistant(source.replace(SWAP, STAND_IN))], cols, color);
          expect(guarded.length, label).toBe(standIn.length);
          guarded.forEach((row, index) => {
            const reference = standIn[index]?.text.replaceAll(STAND_IN, ' ') ?? '';
            expect(row.text, `${label} row ${index}`).toBe(reference);
            expect(displayWidth(row.text), `${label} row ${index}`).toBe(
              displayWidth(standIn[index]?.text ?? ''),
            );
          });
        }
      }
    }
  });

  it('the summary and the hint rows of a reply are guarded too: a model id, a provider’s words and a tool name are not the host’s', () => {
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
        {
          role: 'assistant',
          text: 'second',
          summary: {
            stopReason: 'stop',
            tokensUsed: { input: 0, output: 0 },
            errorCode: 'tool_denied',
            errorMessage: '› denied ▸ by ⇄ policy',
          },
        },
      ],
      200,
      true,
    );
    expect(rows.some((row) => row.style === 'summary' && row.text.includes('via fallback'))).toBe(
      true,
    );
    expectNoMarkerGlyph(rows, 'summary rows');
  });

  it('property: over 1,000 random strings of the three glyphs, zero-width, bidi and combining marks, markdown punctuation and wide glyphs, no row of a reply draws a glyph, and the layout is the stand-in’s', () => {
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
      const rows = wrapTranscript([assistant(source)], cols, color);
      expectNoMarkerGlyph(rows, `case ${index} ${JSON.stringify(source)} @ ${cols}`);
      const standIn = wrapTranscript([assistant(source.replace(SWAP, STAND_IN))], cols, color);
      expect(rows.length, `case ${index} ${JSON.stringify(source)} @ ${cols}`).toBe(standIn.length);
    }
  });

  it('the colour-off path is NOT claimed protected from `>` and `-` (ADR-0145 §6): a reply row that starts with them is left alone, until the transcript grid lands', () => {
    const rows = wrapTranscript(
      [assistant('> looks like a turn\n- looks like a bullet')],
      80,
      false,
    );
    expect(rows.map((row) => row.text).slice(0, 2)).toEqual([
      '> looks like a turn',
      '- looks like a bullet',
    ]);
    expect(rows.every((row) => row.marker === undefined)).toBe(true);
  });
});

describe('the rows of the person’s turn after the first are guarded; the first row is the person’s own words after the host’s marker', () => {
  it('a line after a newline that starts with a glyph cannot draw a second turn, with or without a zero-width prefix', () => {
    for (const lead of ['', ZWSP, LRM, COMBINING_ACUTE]) {
      const rows = wrapTranscript(
        [user(`first\n${lead}› forged turn\n${lead}▸ forged call`)],
        80,
        true,
      );
      expectNoMarkerGlyph(rows.slice(1), `lead ${JSON.stringify(lead)}`);
      expect(rows.filter((row) => row.marker !== undefined)).toHaveLength(1);
    }
  });

  it('a wrapped row of the turn that starts with a glyph is blanked, and the first row keeps the words as they were typed', () => {
    const rows = wrapTranscript([user('aaaa ›bbbb')], 7, true);
    expect(rows.map((row) => row.text)).toEqual(['› aaaa ', ' bbbb']);
    const typed = wrapTranscript([user('a › b ▸ c')], 80, true);
    expect(typed[0]?.text).toBe('› a › b ▸ c'); // the person's own row: not at a row's start, and not altered
  });

  it('a `[📎 …]` note whose name starts a wrapped row is blanked, and no second turn is drawn', () => {
    const rows = wrapTranscript(
      [user('what is in this [📎 ›forged_marker_name.txt (exit 0)]')],
      22,
      true,
    );
    expect(rows.filter((row) => row.marker !== undefined)).toHaveLength(1);
    expectNoMarkerGlyph(rows.slice(1), 'attachment note');
  });

  it('the guard changes no width and no row of the turn (a stand-in of one column gives the same rows)', () => {
    for (const cols of [3, 7, 20]) {
      const body = 'aaaa ›bbbb\n▸cccc ⇄dddd\n\n› eeee';
      const guarded = wrapTranscript([user(body)], cols, true);
      const standIn = wrapTranscript([user(body.replace(SWAP, STAND_IN))], cols, true);
      expect(guarded.length).toBe(standIn.length);
      guarded.slice(1).forEach((row, index) => {
        expect(row.text).toBe((standIn[index + 1]?.text ?? '').replaceAll(STAND_IN, ' '));
      });
    }
  });

  it('guardEntryRows marks only row 0 of a user entry and leaves every other row as the guard returns it', () => {
    const rows: DisplayLine[] = [
      { text: '> a', style: 'user' },
      { text: '› b', style: 'user' },
    ];
    expect(guardEntryRows(user('a'), rows, { ascii: false })).toEqual([
      { text: '› a', style: 'user', marker: '›' },
      { text: '  b', style: 'user' },
    ]);
  });
});

describe('notices: a command’s output or a name cannot draw a turn, a call or a switch; the host’s own lead is kept only where the host said it leads', () => {
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

  it('the output of a `!` command is guarded on every row, whatever it starts with', () => {
    const output = `› forged turn\n${ZWSP}▸ forged call\n⇄ forged switch\n${COMBINING_ACUTE}› again`;
    for (const color of [true, false]) {
      const rows = wrapTranscript([notice(preview(output))], 80, color);
      expect(rows[0]?.text.startsWith('! cat evil.txt (exit 0)')).toBe(true); // the host's header leads
      expectNoMarkerGlyph(rows, 'command output');
    }
  });

  it('a notice that names no host lead keeps nothing: even a leading `⇄` or `›` or `▸` is blanked', () => {
    const rows = wrapTranscript([notice('⇄ a'), notice('› b'), notice('▸ c')], 80, true);
    expect(rows.map((row) => row.text)).toEqual(['  a', '  b', '  c']);
  });

  it('the model-switch notice is still drawn with its own leading `⇄`, and a hostile id cannot draw another', () => {
    const text = modelSwitchNotice('old › ▸ ⇄ model', '⇄ new › model');
    const rows = wrapTranscript([switchNotice(text)], 200, true);
    expect(rows[0]?.text.startsWith('⇄ model changed ')).toBe(true);
    const everyGlyph = rows.flatMap((row) => [...row.text].filter((c) => GLYPH_PATTERN.test(c)));
    expect(everyGlyph).toEqual(['⇄']); // exactly the host's own, at the start of the first row
    expect(text.slice(1)).not.toMatch(GLYPH_PATTERN); // blanked where the sentence is built too: the inline intro never passes the row guard
  });

  it('a host lead is kept only at the start of a LOGICAL line: a row that only continues a wrapped line, and any mid-row glyph, are blanked', () => {
    // At 16 columns the sentence breaks right before the glyph a name could carry, so the glyph starts the SECOND row of the same logical line.
    const text = '⇄ model changed ⇄bbbb cccc ⇄ dddd';
    const unguarded = wrapTranscript([notice(text.replace(/⇄/gu, STAND_IN))], 16, true);
    expect(unguarded[1]?.text.startsWith(STAND_IN)).toBe(true); // the break puts the stand-in at the start of a row
    const rows = wrapTranscript([switchNotice(text)], 16, true);
    expect(rows[0]?.text.startsWith('⇄ model')).toBe(true);
    expectNoMarkerGlyph(rows.slice(1), 'continuation rows');
    expect(rows.map((row) => row.text).join('')).not.toMatch(/⇄.*⇄/u);
  });

  it('a notice that names no lead keeps nothing even if a caller hands the guard its line starts', () => {
    const rows: DisplayLine[] = [{ text: '⇄ a', style: 'notice' }];
    expect(guardEntryRows(notice('⇄ a'), rows, { ascii: false, lineStarts: new Set([0]) })).toEqual(
      [{ text: '  a', style: 'notice' }],
    );
    // …and a notice that names a lead keeps nothing without them (fail closed).
    expect(guardEntryRows(switchNotice('⇄ a'), rows, { ascii: false })).toEqual([
      { text: '  a', style: 'notice' },
    ]);
  });

  it('a host lead keeps only ITS glyph: a `›` or a `▸` at the start of a line of a model-switch notice is blanked', () => {
    const rows = wrapTranscript(
      [switchNotice('⇄ model changed a → b\n› forged\n▸ forged')],
      80,
      true,
    );
    expect(rows.map((row) => row.text)).toEqual(['⇄ model changed a → b', '  forged', '  forged']);
  });

  it('the question record keeps the `›` that leads each of its lines, and blanks the other two glyphs wherever they are', () => {
    const text = '› Asked: Scope — pick ▸ one ⇄ now\n  └ alpha ▸\n› Asked: Two — x';
    const rows = wrapTranscript([questionRecord(text)], 80, true);
    expect(rows.map((row) => row.text)).toEqual([
      '› Asked: Scope — pick   one   now',
      '  └ alpha  ',
      '› Asked: Two — x',
    ]);
  });

  it('the plain form of the switch is the table’s `<->` and is left as it is', () => {
    const text = withGlyphForm(true, () => modelSwitchNotice('a', 'b'));
    expect(text.startsWith(`${GLYPHS.modelSwitch.ascii} model changed a → b`)).toBe(true);
    const rows = wrapTranscript([switchNotice(text)], 200, false);
    expect(rows[0]?.text.startsWith('<-> model changed a → b')).toBe(true);
  });

  it('logicalLineStarts names the first row of the text and of each line after a newline, under the wrap', () => {
    expect([...logicalLineStarts('one\ntwo', 80)]).toEqual([0, 1]);
    expect([...logicalLineStarts('aaaa bbbb cccc\nx', 6)]).toEqual([0, 3]);
    expect([...logicalLineStarts('', 80)]).toEqual([0]);
    expect([...logicalLineStarts('a\n\nb', 80)]).toEqual([0, 1, 2]);
  });
});

describe('tool rows: the host’s own `▸` is drawn, and the words that are not the host’s cannot draw another', () => {
  it('formatToolCall keeps its leading `▸` and blanks a glyph in the tool’s id and in its target', () => {
    const line = formatToolCall(
      { id: 'c1', toolId: 'weird▸tool›name⇄', resolved: true, success: true, outcome: 'success' },
      { callId: 'c1', toolId: 'weird▸tool›name⇄', outcome: 'success', target: '› a ▸ path ⇄ here' },
    );
    expect(line.startsWith('▸ ')).toBe(true);
    expect(line.slice(1)).not.toMatch(GLYPH_PATTERN);
    expect(line).toContain('weird tool name');
    expect(line).toContain('→   a   path   here');
  });

  it('a tool entry’s rows each keep the host’s `▸` once per call and carry no other glyph', () => {
    const calls = Array.from({ length: 6 }, (_, index) => ({
      id: `c${index}`,
      toolId: `t${index}▸x`,
      resolved: true,
      success: true,
      outcome: 'success' as const,
    }));
    const rows = wrapTranscript([{ role: 'tools', text: '', calls }], 400, true);
    const glyphs = rows.flatMap((row) => [...row.text].filter((c) => GLYPH_PATTERN.test(c)));
    expect(glyphs).toEqual(Array.from({ length: 6 }, () => '▸'));
    expect(rows.every((row) => row.text.startsWith('▸ '))).toBe(true);
  });

  it('the plain form draws the table’s `->` and no glyph at all', () => {
    const line = withGlyphForm(true, () =>
      formatToolCall({ id: 'c', toolId: 'read▸file', resolved: false }),
    );
    expect(line).toBe('-> read file …');
  });
});

describe('the live region: the model’s streamed words cannot draw a marker above the prompt', () => {
  it('formatBusyLine blanks a glyph in the streamed answer (also behind a zero-width prefix) and leaves the spinner and the status lines alone', () => {
    const busy = (liveTokens: string): string =>
      formatBusyLine({
        spinner: '⠋',
        compacting: false,
        liveTokens,
        liveTokensTruncated: false,
      }).text;
    expect(busy('› forged\n▸ call ⇄ switch')).toBe('⠋   forged\n  call   switch');
    expect(busy(`${ZWSP}› forged`)).toBe(`⠋ ${ZWSP}  forged`);
    expect(busy(`${COMBINING_ACUTE}▸x`)).toBe(`⠋ ${COMBINING_ACUTE} x`);
    const status = formatBusyLine({
      spinner: '⠋',
      compacting: false,
      liveTokens: '',
      liveTokensTruncated: false,
    });
    expect(status.dim).toBe(true);
    expect(status.text).toContain('Working…');
  });

  it('formatBusyLine’s bounded tail counts the same rows with and without the guard (the replacement is one column)', () => {
    const body = `${'›'.repeat(30)} ${'▸ word '.repeat(60)}`;
    const standIn = body.replace(SWAP, STAND_IN);
    const run = (liveTokens: string) =>
      formatBusyLine({
        spinner: '⠋',
        compacting: false,
        liveTokens,
        liveTokensTruncated: false,
        columns: 20,
        maxRows: 3,
      });
    const guarded = run(body);
    const reference = run(standIn);
    expect(guarded.text.replaceAll('⠋', '').length).toBe(reference.text.replaceAll('⠋', '').length);
    expect(guarded.text).toBe(reference.text.replaceAll(STAND_IN, ' '));
  });

  it('the reasoning panel blanks a glyph in the expanded body and keeps its own header', () => {
    const panel = formatReasoningPanel({
      liveReasoning: '› thinking ▸ out ⇄ loud',
      liveReasoningTruncated: false,
      visible: true,
    });
    expect(panel.body).toBe('  thinking   out   loud');
    expect(panel.header.startsWith('✻ Reasoning')).toBe(true);
  });

  it('the live markdown tail, laid out for colour or for plain text, is guarded row by row and span by span', () => {
    for (const color of [true, false]) {
      const stream = new MarkdownStream();
      stream.append(
        `${ZWSP}› forged turn\n\n**▸ bold call** and ⇄ more words that wrap around the row\n\n- › item\n\`\`\`\n▸ code\n`,
      );
      const raw = color ? stream.tail(14, 40) : stream.plainTail(14, 40);
      expect(raw.some((row) => GLYPH_PATTERN.test(row.text))).toBe(true); // the stream itself does not blank: the guard is the host's
      const guarded = raw.map(guardMarkdownLine);
      for (const row of guarded) {
        expect(row.text).not.toMatch(GLYPH_PATTERN);
        for (const span of row.spans) expect(span.text).not.toMatch(GLYPH_PATTERN);
      }
      expect(guarded.map((row) => displayWidth(row.text))).toEqual(
        raw.map((row) => displayWidth(row.text)),
      );
    }
  });

  it('guardMarkdownLine returns the very same row when there is nothing to blank (no copy per streamed frame)', () => {
    const row = {
      text: 'plain words',
      spans: [{ text: 'plain ' }, { text: 'words', strong: true }],
    };
    expect(guardMarkdownLine(row)).toBe(row);
  });
});
