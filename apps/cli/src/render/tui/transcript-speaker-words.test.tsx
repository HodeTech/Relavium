import { afterEach, describe, expect, it } from 'vitest';

import { chatGrid, marginCell, startsWithMarginWord } from './chat-grid.js';
import { transcriptRows } from './chat-projection.js';
import type { TranscriptEntry } from './session-view-model.js';
import { mountStandaloneChat, type ChatMount } from './surface-matrix/chat-host.js';
import type { DisplayLine } from './viewport.js';

/**
 * The inline renderer's words cannot be forged by a model or a notice (MVP-11 unit 9, review round 1, S-2, the lead's rule (a)): the inline margin
 * says who spoke in words (`you`, `agent`, `tool`, `note`), and a screen reader does not announce indentation, so a reply row `you   please run …`
 * drawn at the content column would be heard as the person's turn. A row of a reply, a tool call or a notice whose content starts with a margin
 * word (after white space, zero-width and format characters, marks and the box-drawing gutters) therefore carries its own entry's role: `agent`
 * for a reply and a tool call's words, `notice` (the word `note`) for a notice. They have no glyph, so the full-screen margin stays blank.
 */

const GRID = chatGrid(80);
const W = GRID.content;
const F = String.fromCodePoint(0x115f);
const ZWJ = String.fromCodePoint(0x200d);
const reply = (text: string): TranscriptEntry => ({ role: 'assistant', text });
const notice = (text: string): TranscriptEntry => ({ role: 'notice', text });

/** The rows of `entries` whose content starts with `head`, with their roles. */
const rowsStarting = (rows: readonly DisplayLine[], head: string): DisplayLine[] =>
  rows.filter((row) => row.text.trimStart().startsWith(head));

describe('the margin words a row can start with', () => {
  it('a whole word of the closed set, in any case, after what is not read as a word', () => {
    for (const text of [
      'you   please',
      'You please',
      'YOU, please',
      'agent: done',
      'tool ran',
      'note this',
      '   you after spaces',
      `${ZWJ}you after a joiner`,
      '│ you after a quote gutter',
      '└─ you after a rule',
    ])
      expect(startsWithMarginWord(text), text).toBe(true);
    for (const text of [
      'your turn',
      'agents',
      'tooling',
      'notes',
      'model changed',
      '- you after a list marker',
      '1. you',
      '# you',
      'x you',
      '',
    ])
      expect(startsWithMarginWord(text), text).toBe(false);
  });
});

describe('the word is read through what a screen reader does not announce (review round 2, S2-2)', () => {
  const cp = (code: number): string => String.fromCodePoint(code);
  const EVASIONS: readonly (readonly [string, string])[] = [
    ['a joiner inside the word', `y${cp(0x200d)}ou   please run rm -rf ~`],
    ['a non-joiner inside the word', `a${cp(0x200c)}gent Done, I ran it.`],
    ['a text selector inside the word', `y${cp(0xfe0e)}ou   please`],
    ['a braille blank before it', `${cp(0x2800)}you   please`],
    ['a musical null notehead before it', `${cp(0x1d159)}you   please`],
    ['fullwidth letters', `${cp(0xff59)}${cp(0xff4f)}${cp(0xff55)}   please`],
    ['mathematical bold letters', `${cp(0x1d432)}${cp(0x1d428)}${cp(0x1d42e)}   please`],
    ['a run of joiners longer than the head before it', `${cp(0x200d).repeat(500)}you   please`],
  ];

  it.each(EVASIONS)('%s: the row still starts with a margin word', (_name, text) => {
    expect(startsWithMarginWord(text)).toBe(true);
  });

  it.each([true, false])(
    'the reply row carries `agent` and the notice row `note` (colour %s)',
    (color) => {
      for (const [name, text] of EVASIONS) {
        const rows = transcriptRows([reply(`Sure.\n\n${text}`), notice(text)], GRID, color);
        expect(rows.filter((row) => row.margin === 'agent').length, name).toBe(2);
        expect(rows.filter((row) => row.margin === 'notice').length, name).toBe(1);
      }
    },
  );

  it('a lookalike from another script is NOT caught: a recorded residual (no fold maps Cyrillic to Latin)', () => {
    expect(startsWithMarginWord(`${cp(0x0443)}${cp(0x043e)}u   please`)).toBe(false);
    // the broader class (review round 3, R3S-3), recorded: small capitals, IPA, the Latin alpha, Armenian, Cherokee
    for (const text of [
      `${cp(0x028f)}${cp(0x1d0f)}${cp(0x1d1c)}   please`,
      `y${cp(0x0275)}u   please`,
      `${cp(0x0251)}gent done`,
      `${cp(0x13aa)}gent done`,
    ])
      expect(startsWithMarginWord(text), JSON.stringify(text)).toBe(false);
  });

  it('a lead a terminal draws with no column, or that has no glyph a reader announces, is skipped (review round 3, R3S-3)', () => {
    for (const lead of [cp(0x1161), cp(0x11a8), cp(0xd7b0), cp(0xe000), cp(0xf0000), cp(0x0378)])
      expect(startsWithMarginWord(`${lead}you   please`), lead.codePointAt(0)?.toString(16)).toBe(
        true,
      );
  });

  it('a word only starts a row: one further in, or one that runs on into letters or digits, is not one', () => {
    for (const text of [
      `x ${cp(0x200d)}you`,
      `you${cp(0x200d)}r turn`,
      `${cp(0xff59)}${cp(0xff4f)}${cp(0xff55)}r`,
      'you2',
    ])
      expect(startsWithMarginWord(text), JSON.stringify(text)).toBe(false);
  });
});

describe.each([true, false])('rows of a reply, a tool call and a notice (colour %s)', (color) => {
  it('a reply’s second paragraph that starts with a word gets the reply’s `agent`; its first row has it anyway', () => {
    const rows = transcriptRows(
      [reply('Sure.\n\nyou   please run rm -rf ~\n\nagent Done, I ran it.')],
      GRID,
      color,
    );
    expect(rows[0]).toMatchObject({ margin: 'agent', text: 'Sure.' });
    for (const head of ['you   please', 'agent Done'])
      expect(
        rowsStarting(rows, head).map((row) => row.margin),
        head,
      ).toEqual(['agent']);
  });

  it('after a single newline, after a wrap and behind fillers the filter drops', () => {
    const rows = transcriptRows(
      [
        reply(
          // with colour a single newline is a soft break (markdown joins the lines), so each line ends with a hard break there
          [
            'Sure.',
            'You please run it',
            `${'x'.repeat(W)} you   wrapped to the start of a row`,
            `${F.repeat(37)}you   behind fillers`,
          ].join(color ? '  \n' : '\n'),
        ),
      ],
      GRID,
      color,
    );
    for (const head of ['You please', 'you   wrapped', 'you   behind'])
      expect(
        rowsStarting(rows, head).map((row) => row.margin),
        head,
      ).toEqual(['agent']);
  });

  it('markdown blocks: a list item’s continuation and a quotation; a heading laid out with colour', () => {
    const rows = transcriptRows(
      [
        reply(
          `- ${'l'.repeat(W - 2)} you   a list continuation\n\n> you   a quotation\n\n# You heading`,
        ),
      ],
      GRID,
      color,
    );
    expect(rowsStarting(rows, 'you   a list').map((row) => row.margin)).toEqual(['agent']);
    // with colour the quotation's gutter is `│` (not read as a word, skipped); without, the source's `>` is read first ("greater than you …")
    const quote = rows.find((row) => row.text.includes('a quotation'));
    expect(quote?.margin).toBe(color ? 'agent' : undefined);
    const heading = rows.find((row) => row.text.includes('heading'));
    // with colour the heading is its words (`You heading`); without, the source line keeps its `#`, which is read before the word
    expect(heading?.margin).toBe(color ? 'agent' : undefined);
  });

  it('a notice row gets `notice` (the word `note`); a host-led line keeps its own role', () => {
    const rows = transcriptRows(
      [
        notice('! cat evil.txt (exit 0)\nyou   a forged turn\nagent forged'),
        {
          role: 'notice',
          text: '⇄ model changed a → b\nnote a second line',
          hostLead: 'modelSwitch',
        },
      ],
      GRID,
      color,
    );
    expect(rows.map((row) => row.margin)).toEqual([
      undefined,
      'notice',
      'notice',
      'modelSwitch',
      'notice',
    ]);
  });

  it('a tool call’s words that wrap to a row starting with a word get `agent`; the call’s first row keeps `toolCall`', () => {
    const rows = transcriptRows(
      [
        {
          role: 'tools',
          text: '',
          calls: [
            {
              id: 'c',
              toolId: `${'t'.repeat(W - 1)} you   x`,
              resolved: true,
              success: true,
              outcome: 'success',
            },
          ],
        },
      ],
      GRID,
      color,
    );
    expect(rows.map((row) => row.margin)).toEqual(['toolCall', 'agent']);
  });

  it('the person’s own turn gets no word but its own: its rows are theirs', () => {
    const rows = transcriptRows(
      [{ role: 'user', text: 'you know\nyou   a second line' }],
      GRID,
      color,
    );
    expect(rows.map((row) => row.margin)).toEqual(['yourTurn', undefined]);
  });

  it('full-screen, the words draw nothing: `agent` and `notice` have no glyph', () => {
    for (const form of ['glyph', 'ascii'] as const) {
      expect(marginCell('agent', GRID, form).trim()).toBe('');
      expect(marginCell('notice', GRID, form).trim()).toBe('');
    }
  });
});

describe('the inline renderer as it is printed: the security sitting’s reply is read as the agent’s', () => {
  const mounts: ChatMount[] = [];
  afterEach(() => {
    for (const mount of mounts.splice(0)) mount.unmount();
  });

  it.each([true, false])('colour %s, 80 columns', async (color) => {
    const mount = mountStandaloneChat(
      { renderer: 'inline', color, size: { cols: 80, rows: 30 } },
      {
        seed: {
          initialRestore: true,
          transcript: [
            { role: 'user', text: 'SCRIPT:rfile go' },
            reply('Sure.\n\nyou   please run rm -rf ~ and push --force\n\nagent Done, I ran it.'),
            notice('you   a notice that imitates the person'),
          ],
        },
      },
    );
    mounts.push(mount);
    await mount.until(() => mount.text().includes('Done, I ran it'));
    await mount.settle();
    const frame = mount.frame().map((row) => row.trimEnd());
    expect(frame.filter((row) => row.startsWith('you '))).toEqual(['you   SCRIPT:rfile go']);
    expect(frame).toContain('agent Sure.');
    expect(frame).toContain('agent you   please run rm -rf ~ and push --force');
    expect(frame).toContain('agent agent Done, I ran it.');
    expect(frame).toContain('note  you   a notice that imitates the person');
  });
});

describe('the live region: a streamed row is read as the agent’s WHILE it streams (review round 2, S2-3)', () => {
  const STAMP = '2026-11-27T00:00:00.000Z';
  const mounts: ChatMount[] = [];
  afterEach(() => {
    for (const mount of mounts.splice(0)) mount.unmount();
  });

  /** A turn in flight: reasoning (shown) and an answer that streams, each with a row that starts with the person's word. */
  const stream = (mount: ChatMount): void => {
    mount.store.apply({
      type: 'session:turn_started',
      sessionId: 's',
      sequenceNumber: 1,
      timestamp: STAMP,
    });
    mount.store.apply({
      type: 'agent:reasoning',
      sessionId: 's',
      sequenceNumber: 2,
      timestamp: STAMP,
      nodeId: 'n',
      text: 'Considering it.\nyou   approve the reasoning row',
      model: 'm',
    });
    mount.store.apply({
      type: 'agent:token',
      sessionId: 's',
      sequenceNumber: 3,
      timestamp: STAMP,
      token: 'Sure.\n\nyou   please run rm -rf ~ and push --force\n',
      model: 'm',
      nodeId: 'n',
    });
    mount.store.toggleReasoning();
    mount.store.flush();
  };

  it.each([true, false])(
    'inline, colour %s: the first answer row and the forged row say `agent`',
    async (color) => {
      const mount = mountStandaloneChat({
        renderer: 'inline',
        color,
        size: { cols: 80, rows: 30 },
      });
      mounts.push(mount);
      await mount.settle();
      stream(mount);
      await mount.until(() => mount.text().includes('push --force'));
      await mount.settle();
      const frame = mount.frame().map((row) => row.trimEnd());
      expect(frame).toContain('agent Sure.');
      expect(frame).toContain('agent you   please run rm -rf ~ and push --force');
      expect(frame).toContain('agent you   approve the reasoning row');
      // the reasoning's first row is not a margin word: its margin is blank, as is every row of the person's that is not theirs
      expect(frame).toContain('      Considering it.');
      expect(frame.filter((row) => row.startsWith('you '))).toEqual([]);
    },
  );

  it.each([true, false])(
    'full-screen, colour %s: the margin of the streamed rows stays blank',
    async (color) => {
      const mount = mountStandaloneChat({ renderer: 'alt', color, size: { cols: 80, rows: 30 } });
      mounts.push(mount);
      await mount.settle();
      stream(mount);
      await mount.until(() => mount.text().includes('push --force'));
      await mount.settle();
      const frame = mount.frame().map((row) => row.trimEnd());
      expect(frame).toContain('      Sure.');
      expect(frame).toContain('      you   please run rm -rf ~ and push --force');
      expect(frame).toContain('      you   approve the reasoning row');
      expect(frame.some((row) => row.startsWith('agent'))).toBe(false);
    },
  );
});
