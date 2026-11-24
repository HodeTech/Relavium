import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { PermissionsSnapshot } from '../../permissions/chat-permissions.js';
import {
  initialPermissionsSheetState,
  type PermissionsSheetState,
  type SheetMessage,
} from './permissions-sheet.js';
import { PermissionsSheetView } from './permissions-sheet-view.js';

/**
 * The sheet's view (ADR-0137 §2, ADR-0122 §7.2): which role is drawn in which style, with colour on, and that colour off loses no meaning.
 * ink-testing-library output is colourless unless chalk is forced, which `force-color.js` does for this file (it must be imported first).
 */
afterEach(cleanup);

const SNAPSHOT: PermissionsSnapshot = {
  project: {
    ok: true,
    rows: [
      { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-19 12:00Z' },
      { id: 'b', label: 'node, 1 argument', remembered: '2026-11-18 09:30Z' },
    ],
  },
  session: [{ argv: ['git', 'status'], text: 'git status', alsoRemembered: false }],
};
const ESC = String.fromCharCode(0x1b);
const CYAN = `${ESC}[36m`;
const YELLOW = `${ESC}[33m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
/** Any foreground colour code (the regular and the bright palette). */
const ANY_COLOUR = new RegExp(`${ESC}\\[(3[0-7]|9[0-7])m`, 'u');

const open = (armed = false): PermissionsSheetState => ({
  ...initialPermissionsSheetState(SNAPSHOT, 'chat', 'ask', 0),
  armed,
});
const withMessage = (message: SheetMessage): PermissionsSheetState => ({
  ...open(),
  message,
});

const frame = (state: PermissionsSheetState, color: boolean): string =>
  render(<PermissionsSheetView state={state} color={color} columns={80} rows={24} />).lastFrame() ??
  '';

/** A frame without its style codes: what a person without them reads. */
const plain = (text: string): string => text.replace(new RegExp(`${ESC}\\[\\d+m`, 'gu'), '');

/** The styled text of the first line of a frame that contains `needle`. */
const lineWith = (text: string, needle: string): string =>
  text.split('\n').find((line) => line.includes(needle)) ?? '';

describe('PermissionsSheetView with colour on', () => {
  it('draws the rule dim with its title in bold, the headings in bold, and the note dim', () => {
    const text = frame(open(), true);
    const rule = lineWith(text, 'Permissions · ask mode');
    expect(rule.startsWith(`${DIM}─ `)).toBe(true);
    expect(rule).toContain(`${BOLD}Permissions · ask mode`);
    expect(lineWith(text, 'This project · remembered (2)')).toContain(BOLD);
    expect(lineWith(text, 'This session · approved (1)')).toContain(BOLD);
    expect(lineWith(text, 'Session-approved commands run unasked here')).toContain(DIM);
  });

  it('draws the selected row in cyan with its action key in red and its date dimmed; an unselected row has no colour', () => {
    const text = frame(open(), true);
    const selected = lineWith(text, '› npm, 1 argument');
    expect(selected).toContain(CYAN);
    expect(selected).toMatch(new RegExp(`${ESC}\\[31m\\[d\\]`, 'u'));
    expect(selected).toContain(`${DIM}2026-11-19 12:00Z`);
    expect(lineWith(text, 'node, 1 argument')).not.toMatch(ANY_COLOUR);
  });

  it('draws the hint dim with its key in red, and the legend with the keys apart from the words', () => {
    const text = frame(open(), true);
    // the dim stretch is closed (ESC[22m) before the key, so the key is red and bold on its own, not red inside a dimmed line
    expect(lineWith(text, 'to withdraw it: auto mode')).toMatch(
      new RegExp(`${ESC}\\[2mPress ${ESC}\\[22m${ESC}\\[31m${ESC}\\[1m\\[d\\]`, 'u'),
    );
    const legend = lineWith(text, 'select');
    expect(legend).toContain(`${BOLD}↑/↓`);
    expect(legend).toMatch(new RegExp(`${ESC}\\[31m${ESC}\\[1m\\[d\\] / Del`, 'u'));
    expect(legend).toContain(`${BOLD}Esc`);
    expect(legend).toContain(`${DIM} withdraw`);
  });

  it('draws an armed row and its question in yellow, and the confirming key in yellow and bold', () => {
    const text = frame(open(true), true);
    const row = lineWith(text, '› npm, 1 argument');
    expect(row).toContain(YELLOW);
    expect(row).toContain(`${BOLD}Enter`);
    expect(lineWith(text, 'Withdraw npm, 1 argument')).toContain(`${YELLOW}${BOLD}`);
    expect(lineWith(text, 'Any other key keeps it.')).toContain(BOLD);
    expect(lineWith(text, 'Esc')).toMatch(new RegExp(`${ESC}\\[33m${ESC}\\[1mEnter`, 'u'));
  });

  it('draws a withdrawal’s answer by its tone: done in green with a tick, a failure in red with a cross, a note in yellow', () => {
    const done = lineWith(frame(withMessage({ tone: 'done', text: 'Withdrawn.' }), true), '✓');
    expect(done).toContain(GREEN);
    expect(done).toContain('✓ Withdrawn.');
    const failed = lineWith(frame(withMessage({ tone: 'failed', text: 'No room.' }), true), '✗');
    expect(failed).toContain(RED);
    expect(failed).toContain('✗ No room.');
    const note = lineWith(
      frame(withMessage({ tone: 'note', text: 'That row was already withdrawn.' }), true),
      'That row was already withdrawn.',
    );
    expect(note).toContain(YELLOW);
    expect(note).not.toContain('✓');
    expect(note).not.toContain('✗');
  });
});

describe('PermissionsSheetView with colour off', () => {
  it('emits no colour at all and loses no meaning: the marker, the action, the headings, the question and the legend are words and glyphs', () => {
    const styled = frame(open(), false);
    expect(styled).not.toMatch(ANY_COLOUR);
    const text = plain(styled);
    expect(text).toContain('> npm, 1 argument');
    expect(text).toContain('[d] withdraw');
    expect(text).toContain('This project · remembered (2)');
    expect(text).toContain('↑/↓ select · [d] / Del withdraw · Esc close');
    const armedStyled = frame(open(true), false);
    expect(armedStyled).not.toMatch(ANY_COLOUR);
    const armed = plain(armedStyled);
    expect(armed).toContain('Enter withdraw');
    expect(armed).toContain(
      'Withdraw npm, 1 argument (2026-11-19 12:00Z)? Any other key keeps it.',
    );
    expect(armed).toContain('Enter withdraw · Esc keep');
    for (const message of [
      { tone: 'done', text: 'Withdrawn.' },
      { tone: 'failed', text: 'No room.' },
      { tone: 'note', text: 'Already gone.' },
    ] as const) {
      const answerStyled = frame(withMessage(message), false);
      expect(answerStyled, message.tone).not.toMatch(ANY_COLOUR);
      expect(plain(answerStyled), message.tone).toContain(
        `${message.tone === 'done' ? 'ok ' : message.tone === 'failed' ? 'x ' : ''}${message.text}`,
      );
    }
  });

  it('keeps the sheet the same height whatever the row under the list says, so the legend never moves', () => {
    const heights = [
      open(),
      open(true),
      withMessage({ tone: 'done', text: 'Withdrawn.' }),
      withMessage({ tone: 'note', text: 'Wait a moment, then press [d].' }),
    ].map((state) => {
      const lines = plain(frame(state, false)).split('\n');
      return [lines.length, lines.findIndex((line) => line.includes(' Esc '))] as const;
    });
    for (const height of heights) expect(height).toEqual(heights[0]);
  });

  it('keeps the blank message row as a row when there is nothing to select', () => {
    const empty: PermissionsSnapshot = { project: { ok: true, rows: [] }, session: [] };
    const lines = plain(frame(initialPermissionsSheetState(empty, 'chat', 'ask', 0), false)).split(
      '\n',
    );
    const legend = lines.findIndex((line) => line.startsWith('Esc close'));
    expect(lines[legend - 1]?.trim()).toBe('');
    expect(lines[legend - 2]).toContain('Session-approved commands run unasked here');
  });
});
