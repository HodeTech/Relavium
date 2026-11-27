import { describe, expect, it } from 'vitest';

import type { Agent } from '@relavium/shared';
import { agentNoticeBody } from '../../chat/agent-notice.js';
import { boundAgentView } from '../../chat/bound-agent-view.js';
import { cutPathLead } from '../notation.js';
import { nativePopupLayout } from '../../popups/native-popup-body.js';
import type { NativePromptSnapshot } from './native-prompt-channel.js';
import { withGlyphForm } from './glyphs.js';
import { initialQuestionCard } from './question-card-model.js';
import { projectQuestionCard } from './question-card.js';
import { keepEnd } from './place-label.js';
import { clipLine, clipPieces } from './sheet-frame.js';
import { keepEnds, keepStart } from './status-line.js';
import { displayWidth, fitColumns } from './viewport.js';

/**
 * Every cutter of a drawn row cuts whole clusters that fit (MVP-11 unit 9, review round 5, R5-S-6): a chain of 21 conjoined consonants is ONE
 * cluster 21 columns wide (the measure counts what a terminal draws), and a cutter that kept a cluster straddling its cut (the selection's
 * intersect rule) overshot its width by up to 20 columns. Each family below gets the chain across its cut and is held to its width.
 */
const CHAIN = `${'क्'.repeat(20)}क`;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Whether `row` holds the chain whole or not at all (never a piece of it: a cut inside a cluster). */
const chainWholeOrAbsent = (row: string): boolean =>
  [...segmenter.segment(row)].every(
    ({ segment }) => !segment.includes('क') || segment === CHAIN || segment.length === 1,
  );

describe('the shared cutter keeps whole clusters that fit (review round 5, R5-S-6)', () => {
  it('from the start and from the end: the chain that straddles the budget is left out, never kept', () => {
    expect(displayWidth(CHAIN)).toBe(21);
    const text = `${'a'.repeat(10)}${CHAIN}${'b'.repeat(10)}`;
    expect(fitColumns(text, 25)).toBe('a'.repeat(10));
    expect(fitColumns(text, 25, 'end')).toBe('b'.repeat(10));
    expect(fitColumns(text, 31)).toBe(`${'a'.repeat(10)}${CHAIN}`);
    expect(fitColumns(text, 31, 'end')).toBe(`${CHAIN}${'b'.repeat(10)}`);
  });

  it('a cluster wider than the whole budget is drawn as `?`, so the text after it is not lost', () => {
    expect(fitColumns(`${CHAIN}xyz`, 10)).toBe('?xyz');
    expect(fitColumns(`xyz${CHAIN}`, 10, 'end')).toBe('xyz?');
    expect(fitColumns('anything', 0)).toBe('');
    // the rest of a row: a cluster narrower than the whole row is left out where it does not fit what is left, never drawn `?`
    expect(fitColumns(`${CHAIN}xyz`, 10, 'start', 40)).toBe('');
  });

  it.each([20, 25, 30, 31, 40])(
    '`clipLine` at %i columns: never wider, the chain whole or absent',
    (width) => {
      const row = clipLine(`${'a'.repeat(15)}${CHAIN}${'b'.repeat(30)}`, width);
      expect(displayWidth(row), row).toBeLessThanOrEqual(width);
      expect(chainWholeOrAbsent(row), row).toBe(true);
    },
  );

  it('`clipPieces`: the piece that straddles the cut is cut, each piece keeps its place', () => {
    const pieces = clipPieces(['(reverse-i-search) ', CHAIN, ` → ${'a'.repeat(40)}`], 30);
    expect(displayWidth(pieces.join('')), pieces.join('|')).toBeLessThanOrEqual(30);
    expect(pieces[0]).toBe('(reverse-i-search) ');
    expect(pieces[1]).toBe('…');
    expect(pieces[2]).toBe('');
  });
});

describe('every cutter family holds its width with a chain across its cut (review round 5, R5-S-6)', () => {
  const lead = (n: number): string => 'a'.repeat(n);

  it.each([20, 25, 30])('the status line’s start, ends and end cuts at %i columns', (width) => {
    for (const row of [
      keepStart(`${lead(15)}${CHAIN}${lead(30)}`, width),
      keepEnds(`${lead(15)}${CHAIN}${lead(30)}`, width),
      keepEnds(`${lead(30)}${CHAIN}${lead(5)}`, width),
      keepEnd(`${lead(30)}${CHAIN}${lead(5)}`, width),
    ]) {
      expect(displayWidth(row), row).toBeLessThanOrEqual(width);
      expect(chainWholeOrAbsent(row), row).toBe(true);
    }
  });

  it.each([12, 20, 25])('a directory label’s lead cut at %i columns', (room) => {
    const row = cutPathLead(`${lead(30)}${CHAIN}${lead(5)}`, room);
    expect(displayWidth(row), row).toBeLessThanOrEqual(room);
    expect(chainWholeOrAbsent(row), row).toBe(true);
  });

  it('an agent file’s label cut from its front on the notice', () => {
    const agent: Agent = {
      id: 'reviewer',
      name: 'Code reviewer',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      system_prompt: 'You review code.',
      tools: ['read_file'],
    };
    const view = boundAgentView(agent, undefined, {
      sourceLabel: `agents/${lead(30)}${CHAIN}x.yaml`,
    });
    for (const width of [40, 50, 60]) {
      const rows = agentNoticeBody(view, width, 20).map((line) => line.text);
      for (const row of rows) {
        expect(displayWidth(row), row).toBeLessThanOrEqual(width);
        expect(chainWholeOrAbsent(row), row).toBe(true);
      }
      // the label is cut from its FRONT: its end, which tells one file from another, is what the row keeps
      expect(
        rows.some((row) => row.trimEnd().endsWith('x.yaml')),
        rows.join('\n'),
      ).toBe(true);
    }
  });

  it('a native popup’s typed field, scrolled to its end', () => {
    const snapshot: NativePromptSnapshot = {
      active: true,
      kind: 'text',
      message: 'Name it',
      note: '',
      options: [],
      selected: 0,
      display: `${lead(40)}${CHAIN}${lead(20)}`,
      error: '',
      escape: 'cancel',
      details: [],
      popup: {
        title: '/agents',
        origin: 'home',
        stepIndex: 0,
        stepCount: 1,
        stepNames: ['Name'],
        exitLabel: 'close',
        depth: 1,
      },
    };
    for (const innerWidth of [30, 36, 40]) {
      const rows = withGlyphForm(true, () =>
        nativePopupLayout(snapshot, { bodyRows: 10, listRows: 10, innerWidth }),
      ).lines.map((line) => line.text);
      for (const row of rows) {
        expect(displayWidth(row), row).toBeLessThanOrEqual(innerWidth);
        expect(chainWholeOrAbsent(row), row).toBe(true);
      }
      // the field scrolls to where one types: its row keeps the END of what was typed, after a leading ellipsis
      const field = rows.find((row) => row.startsWith('> '));
      expect(field, rows.join('\n')).toMatch(/^> ….*a$/u);
    }
  });

  it('the question card’s option rows (a label cut at the row’s end)', () => {
    const card = initialQuestionCard({
      questions: [
        {
          header: 'Pick',
          question: 'Which one?',
          multiSelect: false,
          options: [
            { label: `${lead(60)}${CHAIN}`, description: 'The first' },
            { label: 'beta', description: 'The second' },
          ],
        },
      ],
    });
    for (const columns of [70, 80, 90]) {
      const rows = projectQuestionCard(card, columns).body.map((row) => row.text);
      for (const row of rows) {
        expect(displayWidth(row), row).toBeLessThanOrEqual(columns);
        expect(chainWholeOrAbsent(row), row).toBe(true);
      }
    }
  });
});
