import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { SheetLinesView } from './sheet-lines-view.js';
import { titleRule, type SheetLine } from './sheet-frame.js';

/**
 * The one painter of a list of {@link SheetLine}s ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5,
 * ADR-0122 §7.2): which kind of line is drawn in which colour, which role a stretch of a line takes, and that colour off loses no meaning. It
 * paints every popup frame and the tab host's body; the permissions sheet's own view pinned these same mappings through the sheet and went with
 * the sheet (review round 1 of MVP-11 unit 8, D-3), so they are pinned here through hand-made lines. ink-testing-library output is colourless
 * unless chalk is forced, which `force-color.js` does for this file (it must be imported first).
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const CYAN = `${ESC}[36m`;
const YELLOW = `${ESC}[33m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const ANY_COLOUR = new RegExp(`${ESC}\\[(3[0-7]|9[0-7])m`, 'u');

const frame = (lines: readonly SheetLine[], color: boolean): string =>
  render(<SheetLinesView lines={lines} color={color} />).lastFrame() ?? '';

/** A frame without its style codes: what a person without them reads. */
const plain = (text: string): string => text.replace(new RegExp(`${ESC}\\[\\d+m`, 'gu'), '');

/** The styled text of the first line of a frame that contains `needle`. */
const lineWith = (text: string, needle: string): string =>
  text.split('\n').find((line) => line.includes(needle)) ?? '';

const LINES: readonly SheetLine[] = [
  titleRule('Permissions · ask mode', 60),
  { kind: 'heading', text: 'This project · remembered (2)' },
  { kind: 'note', text: 'Session-approved commands run unasked here.' },
  {
    kind: 'selected',
    text: '› npm, 1 argument   [d] withdraw   2026-11-19 12:00Z',
    spans: [
      { from: 20, to: 23, role: 'danger' },
      { from: 23, to: 32, role: 'dim' },
      { from: 35, to: 52, role: 'dim' },
    ],
  },
  { kind: 'row', text: '  node, 1 argument' },
  {
    kind: 'hint',
    text: 'Press [d] to withdraw it: this command will need approval again.',
    spans: [
      { from: 0, to: 6, role: 'dim' },
      { from: 6, to: 9, role: 'danger' },
      {
        from: 9,
        to: 'Press [d] to withdraw it: this command will need approval again.'.length,
        role: 'dim',
      },
    ],
  },
  { kind: 'question', text: 'Withdraw npm, 1 argument? Any other key keeps it.' },
  { kind: 'done', text: '✓ Withdrawn.' },
  { kind: 'failed', text: '✗ No room.' },
  { kind: 'notice', text: 'That row was already withdrawn.' },
  {
    kind: 'legend',
    text: 'Enter withdraw · Esc keep',
    spans: [
      { from: 0, to: 5, role: 'warn' },
      { from: 5, to: 14, role: 'dim' },
      { from: 17, to: 20, role: 'strong' },
    ],
  },
];

describe('SheetLinesView with colour on', () => {
  const text = frame(LINES, true);

  it('draws the rule dim with its title in bold, a heading in bold and a note dim', () => {
    const rule = lineWith(text, 'Permissions · ask mode');
    expect(rule.startsWith(`${DIM}─ `)).toBe(true);
    expect(rule).toContain(`${BOLD}Permissions · ask mode`);
    expect(lineWith(text, 'This project · remembered (2)')).toContain(BOLD);
    expect(lineWith(text, 'Session-approved commands')).toContain(DIM);
  });

  it('draws the selected row in cyan with its key in red and its value dimmed; an unselected row has no colour', () => {
    const selected = lineWith(text, '› npm, 1 argument');
    expect(selected).toContain(CYAN);
    expect(selected).toMatch(new RegExp(`${ESC}\\[31m\\[d\\]`, 'u'));
    expect(selected).toContain(`${DIM}2026-11-19 12:00Z`);
    expect(lineWith(text, 'node, 1 argument')).not.toMatch(ANY_COLOUR);
  });

  it('draws a hint dim with its key red and bold on its own: the dim stretch is closed before the key', () => {
    expect(lineWith(text, 'to withdraw it: this command')).toMatch(
      new RegExp(`${ESC}\\[2mPress ${ESC}\\[22m${ESC}\\[31m${ESC}\\[1m\\[d\\]`, 'u'),
    );
  });

  it('draws a question in bold yellow, an answer by its tone, and a legend with its keys apart from the words', () => {
    expect(lineWith(text, 'Withdraw npm, 1 argument?')).toContain(`${YELLOW}${BOLD}`);
    expect(lineWith(text, '✓ Withdrawn.')).toContain(GREEN);
    expect(lineWith(text, '✗ No room.')).toContain(RED);
    const notice = lineWith(text, 'That row was already withdrawn.');
    expect(notice).toContain(YELLOW);
    expect(notice).not.toContain('✓');
    expect(notice).not.toContain('✗');
    const legend = lineWith(text, 'Enter');
    expect(legend).toMatch(new RegExp(`${ESC}\\[33m${ESC}\\[1mEnter`, 'u'));
    expect(legend).toContain(`${BOLD}Esc`);
    expect(legend).toContain(`${DIM} withdraw`);
  });

  it('never closes a line’s own style early: every row ends with nothing open', () => {
    for (const line of text.split('\n')) {
      const opens = [...line.matchAll(new RegExp(`${ESC}\\[(\\d+)m`, 'gu'))].map((m) => m[1]);
      const open = new Set<string>();
      for (const code of opens) {
        if (code === undefined) continue;
        if (code === '22') {
          open.delete('1');
          open.delete('2');
        } else if (code === '39') open.delete('colour');
        else if (code === '27') open.delete('7');
        else open.add(/^3[0-7]$|^9[0-7]$/u.test(code) ? 'colour' : code);
      }
      expect([...open], line).toEqual([]);
    }
  });
});

describe('SheetLinesView with colour off', () => {
  it('emits no colour at all and loses no meaning: every state is a word or a glyph', () => {
    const styled = frame(LINES, false);
    expect(styled).not.toMatch(ANY_COLOUR);
    const text = plain(styled);
    expect(text).toContain('› npm, 1 argument');
    expect(text).toContain('[d] withdraw');
    expect(text).toContain('✓ Withdrawn.');
    expect(text).toContain('✗ No room.');
    expect(text).toContain('Enter withdraw · Esc keep');
  });

  it('draws a blank line as a row, so a state change moves nothing', () => {
    const lines = plain(
      frame(
        [
          { kind: 'row', text: 'a' },
          { kind: 'text', text: '' },
        ],
        false,
      ),
    ).split('\n');
    expect(lines).toHaveLength(2);
  });
});
