import './force-color.js';

import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { chatGrid, startsWithMarginWord } from './chat-grid.js';
import { emitIntro } from './chat-ink.js';
import { transcriptRows } from './chat-projection.js';
import { dropOrphanMarks, screenPieces, screenText } from './screen-text.js';
import type { TranscriptEntry } from './session-view-model.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';
import { terminalWidth, wrappedIntoMargin } from './terminal-wrap.test-support.js';
import { wrapWords } from './viewport.js';

/**
 * Round 2 mutation review of unit 9: the behaviours of the fix wave that no test pinned, found by mutating the shipped code in a private copy.
 * Each test names the mutant it kills. Code points are written by their code (no invisible character in this source).
 */

const c = (code: number): string => String.fromCodePoint(code);
const FILLER = c(0x115f);
const BLACK_FLAG = c(0x1f3f4);
const ACUTE = c(0x0301);
const ZWNJ = c(0x200c);

describe('the tag range of an emoji tag sequence is exactly U+E0020 to U+E007F (S08, S08b, S09b)', () => {
  it('keeps the first two tags after the flag, drops the code points just outside the range', () => {
    expect(screenText(`${BLACK_FLAG}${c(0xe0020)}${c(0xe0021)}`)).toBe(
      `${BLACK_FLAG}${c(0xe0020)}${c(0xe0021)}`,
    );
    expect(screenText(`${BLACK_FLAG}${c(0xe001f)}`)).toBe(BLACK_FLAG);
    expect(screenText(`${BLACK_FLAG}${c(0xe0080)}`)).toBe(BLACK_FLAG);
  });
});

describe('an orphan joiner or mark is dropped where a row starts, and not elsewhere (S12, S21)', () => {
  it('a ZWNJ at the start of the text and after a newline is dropped; a ZWNJ inside a word stays', () => {
    expect(dropOrphanMarks(`${ZWNJ}x`)).toBe('x');
    expect(screenText(`a\n${ZWNJ}b`)).toBe('a\nb');
    expect(screenText(`a${ZWNJ}b`)).toBe(`a${ZWNJ}b`);
  });

  it('across the styled pieces only the START of the row is leading: a mark that starts a later piece after text stays', () => {
    const pieces = [{ text: 'a' }, { text: `${ACUTE}b`, strong: true }];
    expect(screenPieces(pieces)).toBe(pieces);
    const filled = [{ text: `${FILLER}a` }, { text: `${ACUTE}b` }];
    expect(screenPieces(filled)).toEqual([{ text: 'a' }, { text: `${ACUTE}b` }]);
  });
});

describe('a margin word is a WHOLE word, after only what is not read as one (G10, G11, G14, G17, G17b)', () => {
  it('a word followed by a digit or an underscore is another word', () => {
    for (const text of ['you2', 'note9', 'agent_x', 'you_', `tool${c(0x0663)}`])
      expect(startsWithMarginWord(text), text).toBe(false);
    for (const text of ['you.', 'tool-x', 'agent, done', 'note:'])
      expect(startsWithMarginWord(text), text).toBe(true);
  });

  it('a combining mark before the word is skipped; the box-drawing block ends at U+257F', () => {
    expect(startsWithMarginWord(`${ACUTE}you`)).toBe(true);
    expect(startsWithMarginWord(`${c(0x257f)}you`)).toBe(true);
    expect(startsWithMarginWord(`${c(0x2580)}you`)).toBe(false);
    expect(startsWithMarginWord(`${c(0x24ff)}you`)).toBe(false);
  });
});

describe('a tool call whose id starts with a margin word keeps the tool role (P06)', () => {
  it.each(['agent.run', 'tool.search', 'note', 'you'])('%s', (toolId) => {
    for (const color of [true, false]) {
      const entry: TranscriptEntry = {
        role: 'tools',
        text: '',
        calls: [{ id: 'c', toolId, resolved: true, success: true, outcome: 'success' }],
      };
      const rows = transcriptRows([entry], chatGrid(80), color);
      expect(rows.map((row) => row.margin)).toEqual(['toolCall']);
      expect(rows[0]?.text.startsWith(toolId)).toBe(true);
    }
  });
});

describe('a reply of only fillers is an empty reply (E01)', () => {
  it.each([true, false])(
    'no body row, no separator of its own; the summary is its first row (colour %s)',
    (color) => {
      const grid = chatGrid(80);
      const fillers = FILLER.repeat(40);
      const rows = transcriptRows(
        [
          { role: 'user', text: 'hi' },
          { role: 'assistant', text: fillers },
        ],
        grid,
        color,
      );
      expect(rows.map((row) => row.text)).toEqual(['hi']);
      const withSummary = transcriptRows(
        [
          { role: 'user', text: 'hi' },
          {
            role: 'assistant',
            text: fillers,
            summary: { stopReason: 'aborted', tokensUsed: { input: 1, output: 0 } },
          },
        ],
        grid,
        color,
      );
      expect(withSummary.map((row) => row.margin ?? '-')).toEqual(['yourTurn', '-', 'agent']);
    },
  );
});

describe('the summary row goes through the filter as a reply’s row does (A12)', () => {
  it.each([true, false])('a model id of fillers draws none of them (colour %s)', (color) => {
    const rows = transcriptRows(
      [
        {
          role: 'assistant',
          text: 'answer',
          summary: {
            stopReason: 'stop',
            tokensUsed: { input: 1, output: 1 },
            model: `fb${FILLER.repeat(40)}x`,
          },
        },
      ],
      chatGrid(120),
      color,
    );
    const summary = rows.find((row) => row.style === 'summary')?.text ?? '';
    expect(summary).toContain('fbx');
    expect(summary).not.toContain(FILLER);
  });
});

describe('the grapheme wrap drops the break spaces and never leaves an empty row (V04, V05)', () => {
  it('spaces after a full row of wide characters are the break, not a row of their own', () => {
    expect(wrapWords(`${'中'.repeat(34)}     `, 68, true)).toEqual(['中'.repeat(34)]);
    expect(wrapWords(`${'中'.repeat(34)}     `, 68)).toEqual(['中'.repeat(34), '     ']);
  });

  it('a no-break space at the start of a wrapped row is content, never dropped', () => {
    const nbsp = c(0x00a0);
    const rows = wrapWords(`中中 ${nbsp}${nbsp}x`, 5, true);
    expect(rows.join('')).toContain(`${nbsp}${nbsp}x`);
    expect(rows.slice(1).join('')).toContain(nbsp);
  });
});

describe('the hint row of both hosts draws a notification through the filter (A62, A63)', () => {
  const mounts: ChatMount[] = [];
  afterEach(() => {
    for (const mount of mounts.splice(0)) mount.unmount();
    cleanup();
  });
  const VARIANTS: readonly Variant[] = [
    { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
    { renderer: 'inline', color: false, size: { cols: 80, rows: 24 } },
  ];

  it.each(
    VARIANTS.flatMap((variant) => [['standalone', variant] as const, ['home', variant] as const]),
  )(
    'the %s chat, %j: no filler is drawn and no row of it wraps into the margin',
    async (host, variant) => {
      const mount =
        host === 'standalone' ? mountStandaloneChat(variant) : await mountHostedChat(variant);
      mounts.push(mount);
      await mount.settle();
      // a combining mark that starts the row is painted by a terminal on the cell before it: the margin's last column (S-3)
      mount.notifications.notify(`${ACUTE}${FILLER.repeat(40)}you   a refused popup`);
      await mount.until(() => mount.text().includes('a refused popup'));
      await mount.settle();
      const frame = mount.frame();
      expect(frame.join('\n')).not.toContain(FILLER);
      expect(frame.join('\n')).not.toContain(ACUTE);
      const grid = chatGrid(80);
      expect(frame.find((row) => row.includes('a refused popup'))?.trimEnd()).toBe(
        `${' '.repeat(grid.margin)}you   a refused popup`,
      );
      expect(wrappedIntoMargin(frame, 80, grid.margin)).toEqual([]);
    },
  );
});

describe('a wrapped heading starts each row at its text (L10)', () => {
  it.each([true, false])(
    'no continuation row of a long heading starts with a space (colour %s)',
    (color) => {
      const words = Array.from({ length: 30 }, (_, index) => `word${'x'.repeat(index % 5)}`).join(
        ' ',
      );
      for (const columns of [30, 41, 57, 80, 100]) {
        const rows = transcriptRows(
          [{ role: 'assistant', text: `# ${words}` }],
          chatGrid(columns),
          color,
        );
        expect(rows.length, String(columns)).toBeGreaterThan(1);
        for (const row of rows.slice(1))
          expect(row.text.startsWith(' '), `${columns} ${row.text}`).toBe(false);
      }
    },
  );
});

describe('the simulated terminal draws the kept joiners and the tags of a tag sequence with no column of their own (W04, W05)', () => {
  it('a ZWJ, a ZWNJ, a presentation selector and a tag character are 0 columns, as the layout measures them', () => {
    for (const code of [0x200d, 0x200c, 0xfe0e, 0xfe0f, 0xe0020, 0xe0067, 0xe007f])
      expect(terminalWidth(c(code)), code.toString(16)).toBe(0);
    expect(terminalWidth(c(0x115f))).toBe(2);
    expect(terminalWidth(c(0x00ad))).toBe(1);
  });
});

describe('every default-ignorable class is dropped, not only the sampled ones (D-class)', () => {
  it.each([
    0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2065, 0x2066, 0x2069, 0x206a, 0x206f, 0xfe0d, 0xfff0,
    0xfff8, 0xe0002, 0xe001f, 0xe0080, 0xe00ff, 0xe01f0, 0xe0fff,
  ])('U+%i is dropped from a row of text', (code) => {
    expect(screenText(`a${c(code)}b`)).toBe('ab');
    expect(screenText(`${c(code).repeat(37)}   please`)).toBe('   please');
  });

  it('a spacing combining mark (Mc) that starts a row is an orphan too', () => {
    expect(dropOrphanMarks(`${c(0x0903)}x`)).toBe('x');
    expect(screenText(`a\n${c(0x093e)}b`)).toBe('a\nb');
  });
});

describe('only a model-switch glyph followed by a space leads the intro (A53)', () => {
  it('a glyph glued to the first word names no lead', () => {
    const leads: (string | undefined)[] = [];
    const ports = {
      notice: (_text: string, lead?: 'yourTurn' | 'modelSwitch') => void leads.push(lead),
      writeOut: () => undefined,
    };
    emitIntro(`${c(0x21c4)}model changed a to b`, true, ports);
    emitIntro(`${c(0x21c4)} model changed a to b`, true, ports);
    expect(leads).toEqual([undefined, 'modelSwitch']);
  });
});
