import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MarkdownStream } from '../markdown/index.js';
import { chatGrid, SUSPENDED_GRID, type ChatGrid } from './chat-grid.js';
import {
  entryGap,
  entryLines,
  formatToolCall,
  transcriptDocument,
  transcriptEntrySpan,
  transcriptRows,
  transcriptScrollGeometry,
  transcriptSelectionText,
  wrapTranscript,
} from './chat-projection.js';
import { withGlyphForm } from './glyphs.js';
import type { TranscriptEntry } from './session-view-model.js';
import type { ToolDisplay } from './tool-display.js';
import { displayWidth, type DisplayLine } from './viewport.js';

/**
 * The transcript's rows on the chat's grid (MVP-11 unit 9, plan §3.1 and §4): the width every row is laid out at, the separator rows, the one
 * function every consumer reads, the documents that do not change, and the source pin that keeps the width in one place. The rows' marks and the
 * hostile corpus's pure side are in `speaker-marker-guard.test.ts`; the DRAWN frame is in `transcript-grid-margin.test.tsx`.
 */

const ESC = String.fromCharCode(0x1b);
const ZWSP = String.fromCharCode(0x200b);
const RLO = String.fromCharCode(0x202e);
const COMBINING_ACUTE = String.fromCharCode(0x0301);

/** One entry of every kind and shape the transcript holds, each of which can reach the edge of a row. */
const CORPUS: readonly TranscriptEntry[] = [
  { role: 'notice', text: `Resuming session x — ${'a long banner word '.repeat(6)}` },
  {
    role: 'user',
    text: `hello 中文 wide ${'x'.repeat(90)} and 😀 emoji\nsecond line [📎 file.txt]\n\n${COMBINING_ACUTE}› pasted`,
  },
  {
    role: 'assistant',
    text: [
      '# A heading that is long enough to wrap at a narrow width',
      '',
      `A **bold** and \`code\` line with 中文 and a URL https://example.test/${'p'.repeat(120)}`,
      '',
      '- › an item',
      '  - a nested item with words',
      '1. ⇄ ordered',
      '',
      '> › quoted text that is long enough to wrap around the row',
      '',
      '| col | 中文 value |',
      '| --- | ---: |',
      '| › | ▸ ⇄ |',
      '',
      '```ts',
      `const token = '${'y'.repeat(140)}';`,
      '```',
      '',
      `${ZWSP}› ${RLO}after an override`,
    ].join('\n'),
    summary: {
      stopReason: 'stop',
      tokensUsed: { input: 12, output: 34 },
      model: 'fallback-model-with-a-long-identifier',
      errorCode: 'provider_unavailable',
      errorMessage: '503 upstream down',
    },
  },
  {
    role: 'tools',
    text: '',
    calls: Array.from({ length: 6 }, (_, index) => ({
      id: `c${index}`,
      toolId: `read_file_${index}▸x`,
      resolved: index % 2 === 0,
      success: true,
      outcome: 'success' as const,
    })),
    omitted: 3,
  },
  {
    role: 'notice',
    text: `› Asked: Scope — ${'which files to change? '.repeat(4)}\n  └ alpha.ts, “and this”`,
    hostLead: 'yourTurn',
  },
  {
    role: 'notice',
    text: `⇄ model changed claude-a → claude-b — ${'the new model sees the text '.repeat(5)}`,
    hostLead: 'modelSwitch',
  },
  { role: 'user', text: '' },
  { role: 'assistant', text: '' },
];

const DISPLAYS: ReadonlyMap<string, ToolDisplay> = new Map(
  Array.from({ length: 6 }, (_, index): [string, ToolDisplay] => [
    `c${index}`,
    {
      callId: `c${index}`,
      toolId: `read_file_${index}`,
      outcome: 'success',
      target: `src/${'deep/'.repeat(30)}file-${index}.ts`,
      stats: { addedLines: 12, removedLines: 3, beforeBytes: 400, afterBytes: 520 },
    },
  ]),
);

/** Every cell of a row a renderer draws: its text, and its spans when it has them. */
const drawnTexts = (row: DisplayLine): string[] => [
  row.text,
  ...(row.spans === undefined ? [] : [row.spans.map((span) => span.text).join('')]),
];

describe('the width invariant: margin + content never exceeds the terminal (plan §4, invariant 3)', () => {
  it('every row of every role, at every width from 1 to 300, with colour on and off, fits its content column', () => {
    for (let columns = 1; columns <= 300; columns += 1) {
      const grid = chatGrid(columns);
      for (const color of [true, false]) {
        const rows = transcriptRows(CORPUS, grid, color, DISPLAYS);
        expect(rows.length, `${columns}`).toBeGreaterThan(CORPUS.length);
        for (const row of rows)
          for (const text of drawnTexts(row)) {
            const width = displayWidth(text);
            expect(width, `${columns} ${color} ${JSON.stringify(text)}`).toBeLessThanOrEqual(
              grid.content,
            );
            expect(grid.margin + width, `${columns} ${color}`).toBeLessThanOrEqual(columns);
          }
      }
    }
  });

  it('the rows are `wrapTranscript` at the content column, and a suspended grid has none', () => {
    for (const columns of [1, 20, 80, 100, 120, 200]) {
      const grid = chatGrid(columns);
      expect(transcriptRows(CORPUS, grid, true, DISPLAYS)).toEqual(
        wrapTranscript(CORPUS, grid.content, true, DISPLAYS),
      );
    }
    expect(transcriptRows(CORPUS, SUSPENDED_GRID, true)).toEqual([]);
    expect(transcriptScrollGeometry(CORPUS, SUSPENDED_GRID, 9)).toEqual({
      totalLines: 0,
      height: 9,
    });
  });

  it('a wider terminal past 112 columns keeps the 96-column content (left-hung, OQ5): the rows do not change', () => {
    expect(transcriptRows(CORPUS, chatGrid(200), true, DISPLAYS)).toEqual(
      transcriptRows(CORPUS, chatGrid(120), true, DISPLAYS),
    );
  });
});

describe('one blank row between turns (OQ3)', () => {
  const user = (text: string): TranscriptEntry => ({ role: 'user', text });
  const reply = (text: string): TranscriptEntry => ({ role: 'assistant', text });
  const notice = (text: string): TranscriptEntry => ({ role: 'notice', text });
  const tools: TranscriptEntry = {
    role: 'tools',
    text: '',
    calls: [{ id: 'c', toolId: 'read_file', resolved: true, success: true, outcome: 'success' }],
  };

  it('before a turn and a reply, never before the first entry, a tool entry or a notice', () => {
    expect(entryGap(undefined, user('a'))).toBe(false);
    expect(entryGap(undefined, reply('a'))).toBe(false);
    expect(entryGap(user('a'), reply('b'))).toBe(true);
    expect(entryGap(reply('a'), user('b'))).toBe(true);
    expect(entryGap(notice('a'), user('b'))).toBe(true);
    expect(entryGap(tools, reply('b'))).toBe(true);
    expect(entryGap(user('a'), tools)).toBe(false);
    expect(entryGap(reply('a'), notice('b'))).toBe(false);
  });

  it('the frame’s exchange: turn, blank, reply, the tool row hugging it, blank, reply', () => {
    const rows = transcriptRows(
      [user('Add VAT'), reply('total() multiplies'), tools, reply('Found it.')],
      chatGrid(80),
      true,
    );
    expect(rows.map((row) => [row.margin ?? '-', row.text])).toEqual([
      ['yourTurn', 'Add VAT'],
      ['-', ''],
      ['agent', 'total() multiplies'],
      ['toolCall', 'read_file ✓ completed'],
      ['-', ''],
      ['agent', 'Found it.'],
    ]);
  });

  it('the inline renderer, which prints one entry at a time, gets the same rows from the entry before it', () => {
    const transcript = [user('one'), reply('two'), tools, notice('n'), user('three')];
    const whole = transcriptRows(transcript, chatGrid(80), true);
    const pieces = transcript.flatMap((entry, index) =>
      transcriptRows([entry], chatGrid(80), true, undefined, transcript[index - 1]),
    );
    expect(pieces).toEqual(whole);
  });
});

describe('the drag-copy is the content a person sees (OQ9)', () => {
  it('copies the person’s words without the margin’s mark and without the text form’s `> `', () => {
    const transcript: TranscriptEntry[] = [
      { role: 'user', text: 'hello there' },
      { role: 'assistant', text: 'a reply' },
    ];
    const grid = chatGrid(80);
    const whole = { start: { line: 0, column: 0 }, end: { line: 2, column: 999 } };
    expect(transcriptSelectionText(transcript, grid, whole, true)).toBe('hello there\n\na reply');
    expect(transcriptSelectionText(transcript, grid, whole, false)).toBe('hello there\n\na reply');
    expect(transcriptDocument(transcript)).toBe('> hello there\na reply');
  });
});

describe('the measured-frame span of one entry (plan §4, invariant 7)', () => {
  it('counts the separator rows of the prefix in one walk: the span is the entry’s rows as drawn', () => {
    const transcript: TranscriptEntry[] = [
      { role: 'user', text: 'one' },
      { role: 'assistant', text: 'two\nlines' },
      { role: 'notice', text: 'a notice' },
      { role: 'user', text: 'three' },
    ];
    const grid = chatGrid(80);
    const rows = transcriptRows(transcript, grid);
    expect(rows.map((row) => row.text)).toEqual([
      'one',
      '',
      'two',
      'lines',
      'a notice',
      '',
      'three',
    ]);
    expect(transcriptEntrySpan(transcript, 0, grid)).toEqual({ start: 0, end: 1 });
    expect(transcriptEntrySpan(transcript, 1, grid)).toEqual({ start: 2, end: 4 });
    expect(transcriptEntrySpan(transcript, 2, grid)).toEqual({ start: 4, end: 5 });
    expect(transcriptEntrySpan(transcript, 3, grid)).toEqual({ start: 6, end: 7 });
  });

  it('is undefined outside the transcript and on a suspended grid', () => {
    const transcript: TranscriptEntry[] = [{ role: 'notice', text: 'n' }];
    for (const index of [-1, 1, 0.5, Number.NaN])
      expect(transcriptEntrySpan(transcript, index, chatGrid(80))).toBeUndefined();
    expect(transcriptEntrySpan(transcript, 0, SUSPENDED_GRID)).toBeUndefined();
  });
});

describe('the documents are byte-stable (plan §4, invariant 4)', () => {
  // The unchanged text forms, pinned byte for byte over an entry of every kind (a differential run against the code before unit 9 produced the
  // same bytes; the increment's report records it). The screen's rows changed; these did not.
  it('transcriptDocument, entryLines and the tool-call string are the text forms', () => {
    const corpus: TranscriptEntry[] = [
      { role: 'user', text: 'hi\nthere' },
      {
        role: 'assistant',
        text: '› a reply',
        summary: {
          stopReason: 'stop',
          tokensUsed: { input: 1, output: 2 },
          errorCode: 'provider_auth',
        },
      },
      {
        role: 'tools',
        text: '',
        calls: Array.from({ length: 5 }, (_, index) => ({
          id: `c${index}`,
          toolId: `t${index}`,
          resolved: true,
          success: true,
          outcome: 'success' as const,
        })),
        omitted: 2,
      },
      { role: 'notice', text: '› Asked: H — Q\n  └ a', hostLead: 'yourTurn' },
      { role: 'notice', text: `plain ${ESC}[31mnotice` },
    ];
    expect(transcriptDocument(corpus)).toBe(
      [
        '> hi',
        'there',
        '› a reply',
        ' error: provider_auth · ↑1 ↓2',
        ' → Provider authentication failed — check the API key, or unlock the OS keychain if it locked mid-session. The session is still active; fix the key from the Home (/providers) and resend.',
        '▸ t0 ✓ completed · ▸ t1 ✓ completed · ▸ t2 ✓ completed · ▸ t3 ✓ completed',
        '▸ t4 ✓ completed · 2 omitted calls',
        '› Asked: H — Q',
        '  └ a',
        'plain notice',
      ].join('\n'),
    );
    expect(withGlyphForm(true, () => entryLines(corpus[2] as TranscriptEntry))).toEqual([
      {
        style: 'notice',
        text: '-> t0 ok completed · -> t1 ok completed · -> t2 ok completed · -> t3 ok completed',
      },
      { style: 'notice', text: '-> t4 ok completed · 2 omitted calls' },
    ]);
    expect(formatToolCall({ id: 'c', toolId: 'read_file', resolved: false })).toBe('▸ read_file …');
  });
});

describe('the live answer wraps as the finished reply will (plan §4, invariant 5)', () => {
  // Part B's live region lays the stream out at the content column (`props.markdown.tail(grid.content, …)`): the rows it shows are the rows the
  // finished reply takes in the transcript, so nothing reflows when the turn completes.
  const SOURCES = [
    `A paragraph of words that is long enough to wrap at every width the grid gives, with 中文 and 😀 in it, and › a glyph.`,
    '# Heading\n\n- an item\n- › another item that wraps around the content column of the chat\n\n> a quotation',
    '```ts\nconst token = "' + 'z'.repeat(120) + '";\n```',
    '| a | b |\n| - | - |\n| one | two words in a cell |',
  ];

  it.each([80, 100, 120, 40])(
    'at %i columns, the stream’s rows are the finished reply’s rows',
    (columns) => {
      const grid: ChatGrid = chatGrid(columns);
      for (const source of SOURCES) {
        const stream = new MarkdownStream();
        stream.append(source);
        const finished = transcriptRows([{ role: 'assistant', text: source }], grid, true);
        expect(
          stream.tail(grid.content, 10_000).map((row) => row.text),
          `${columns} ${JSON.stringify(source.slice(0, 30))}`,
        ).toEqual(finished.map((row) => row.text));
        const plain = transcriptRows([{ role: 'assistant', text: source }], grid, false);
        expect(stream.plainTail(grid.content, 10_000).map((row) => row.text)).toEqual(
          plain.map((row) => row.text),
        );
      }
    },
  );
});

describe('the source pin: one width for the transcript (plan §3.1)', () => {
  // Every consumer reads the transcript through `transcriptRows` (or the geometry, copy and span helpers built on it), so the width it is laid out
  // at is the grid's content column everywhere. A direct call of the low-level functions with a terminal width is the drift this holds off.
  const SRC = fileURLToPath(new URL('../..', import.meta.url));
  /** The files allowed to call them: their home, and a test fixture that measures the cold layout at a fixed width. */
  const ALLOWED = new Set([
    'render/tui/chat-projection.ts',
    'render/markdown/fixtures/autolink-resource.mjs',
  ]);
  const isTest = (path: string): boolean => /\.test\.|\.test-support\./u.test(path);

  function sources(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(?:ts|tsx|mjs|js)$/u.test(name) ? [path] : [];
    });
  }

  it('no non-test file outside chat-projection.ts calls wrapTranscript( or liveScrollGeometry(', () => {
    const offenders = sources(SRC)
      .map((path) => relative(SRC, path).split('\\').join('/'))
      .filter((path) => !isTest(path) && !ALLOWED.has(path))
      .filter((path) =>
        /\b(?:wrapTranscript|liveScrollGeometry)\(/u.test(readFileSync(join(SRC, path), 'utf8')),
      );
    expect(offenders).toEqual([]);
    // the pin reads real files: the home of both functions is found and does call them
    expect(readFileSync(join(SRC, 'render/tui/chat-projection.ts'), 'utf8')).toMatch(
      /wrapTranscript\(/u,
    );
  });
});
