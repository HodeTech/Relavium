import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { PermissionsSnapshot } from '../../permissions/chat-permissions.js';
import { initialPermissionsSheetState, type PermissionsSheetState } from './permissions-sheet.js';
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
const CYAN = '\u001b[36m';
const YELLOW = '\u001b[33m';
const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const ESC = String.fromCharCode(0x1b);
/** Any foreground colour code (the regular and the bright palette). */
const ANY_COLOUR = new RegExp(`${ESC}\\[(3[0-7]|9[0-7])m`, 'u');

const open = (armed = false): PermissionsSheetState => ({
  ...initialPermissionsSheetState(SNAPSHOT, 'chat', 'ask', 0),
  armed,
});

const frame = (state: PermissionsSheetState, color: boolean): string =>
  render(<PermissionsSheetView state={state} color={color} columns={80} rows={24} />).lastFrame() ??
  '';

/** The styled text of the first line of a frame that contains `needle`. */
const lineWith = (text: string, needle: string): string =>
  text.split('\n').find((line) => line.includes(needle)) ?? '';

describe('PermissionsSheetView with colour on', () => {
  it('draws the title and the selected row in cyan, the headings in bold, the note and the legend dim', () => {
    const text = frame(open(), true);
    expect(lineWith(text, 'Permissions · ask mode')).toContain(CYAN);
    expect(lineWith(text, '› npm, 1 argument')).toContain(CYAN);
    expect(lineWith(text, 'This project · remembered (2)')).toContain(BOLD);
    expect(lineWith(text, 'This session · approved (1)')).toContain(BOLD);
    expect(lineWith(text, 'Session-approved commands run unasked here')).toContain(DIM);
    expect(lineWith(text, '↑/↓ select · d withdraw · Esc close')).toContain(DIM);
    // an unselected row is plain: no colour at all
    expect(lineWith(text, 'node, 1 argument')).not.toMatch(ANY_COLOUR);
  });

  it('draws a withdrawal’s question in yellow', () => {
    const text = frame(open(true), true);
    expect(lineWith(text, 'Withdraw npm, 1 argument')).toContain(YELLOW);
  });
});

describe('PermissionsSheetView with colour off', () => {
  it('emits no colour at all and loses no meaning: the marker, the headings, the question and the legend are all words and glyphs', () => {
    const text = frame(open(), false);
    expect(text).not.toMatch(ANY_COLOUR);
    expect(text).toContain('› npm, 1 argument');
    expect(text).toContain('This project · remembered (2)');
    expect(text).toContain('↑/↓ select · d withdraw · Esc close');
    const armed = frame(open(true), false);
    expect(armed).not.toMatch(ANY_COLOUR);
    expect(armed).toContain(
      'Withdraw npm, 1 argument (2026-11-19 12:00Z)? Any other key keeps it.',
    );
    expect(armed).toContain('Enter withdraw · Esc keep');
  });

  it('keeps the blank message row as a row, so the legend never moves when a message comes and goes', () => {
    const lines = frame(open(), false).split('\n');
    const legend = lines.findIndex((line) => line.includes('↑/↓ select'));
    expect(lines[legend - 1]?.trim()).toBe('');
    expect(lines[legend - 2]).toContain('Session-approved commands run unasked here');
  });
});
