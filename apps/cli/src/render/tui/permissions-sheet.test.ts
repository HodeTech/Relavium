import { describe, expect, it } from 'vitest';

import type {
  PermissionsSnapshot,
  ProjectGrantRow,
  SessionApprovalRow,
} from '../../permissions/chat-permissions.js';
import { displayWidth } from './viewport.js';
import {
  SHEET_KEYS,
  SHEET_LEGEND_ARMED,
  SHEET_LEGEND_IDLE,
  SHEET_WINDOW,
  clipLine,
  disarmPermissionsSheet,
  foldPermissionsSheetKey,
  initialPermissionsSheetState,
  permissionsSheetLines,
  reloadPermissionsSheet,
  sheetCanArm,
  sheetEntries,
  sheetNote,
  sheetTitle,
  windowBody,
  type PermissionsSheetState,
  type PermissionsSheetStep,
} from './permissions-sheet.js';

/** The `/permissions` sheet's pure half (ADR-0137 §2): the key ladder and the lines. No terminal, no React. */
const project = (
  id: string,
  label = 'npm, 1 argument',
  at = '2026-11-19 12:00Z',
): ProjectGrantRow => ({
  id,
  label,
  remembered: at,
});
const session = (text: string, alsoRemembered = false): SessionApprovalRow => ({
  argv: text.split(' '),
  text,
  alsoRemembered,
});

const snapshot = (
  projectRows: readonly ProjectGrantRow[],
  sessionRows: readonly SessionApprovalRow[] = [],
): PermissionsSnapshot => ({ project: { ok: true, rows: projectRows }, session: sessionRows });
/** The project-only surface (the bare Home, a bare `relavium permissions`): no session list at all. */
const projectOnly = (projectRows: readonly ProjectGrantRow[]): PermissionsSnapshot => ({
  project: { ok: true, rows: projectRows },
  session: undefined,
});

const open = (
  snap: PermissionsSnapshot,
  surface: 'chat' | 'project' = 'chat',
  mode: PermissionsSheetState['mode'] = 'ask',
): PermissionsSheetState => initialPermissionsSheetState(snap, surface, mode);

const press = (
  state: PermissionsSheetState,
  input: string,
  key: Parameters<typeof foldPermissionsSheetKey>[1] = {},
  canArm = true,
): PermissionsSheetStep => foldPermissionsSheetKey(input, key, state, canArm);

function stateOf(step: PermissionsSheetStep): PermissionsSheetState {
  if (step.kind === 'close') throw new Error('expected a state, got close');
  return step.state;
}

const TWO_AND_ONE = snapshot(
  [project('a'), project('b', 'node, 1 argument')],
  [session('git status')],
);
const ARROW_DOWN = { downArrow: true } as const;
const ARROW_UP = { upArrow: true } as const;
const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const CTRL_C = { ctrl: true } as const;

describe('the entries', () => {
  it('are the project rows then the session rows, the order they are drawn in', () => {
    const entries = sheetEntries(TWO_AND_ONE);
    expect(
      entries.map((entry) => [
        entry.kind,
        entry.kind === 'project' ? entry.row.id : entry.row.text,
      ]),
    ).toEqual([
      ['project', 'a'],
      ['project', 'b'],
      ['session', 'git status'],
    ]);
  });

  it('are only the session rows when the project’s store cannot answer', () => {
    const entries = sheetEntries({
      project: { ok: false, text: 'nope' },
      session: [session('git status')],
    });
    expect(entries.map((entry) => entry.kind)).toEqual(['session']);
  });
});

describe('the key ladder (ADR-0137 §2)', () => {
  it('moves the cursor with the arrows and clamps at both ends, clearing the last message', () => {
    let state = reloadPermissionsSheet(open(TWO_AND_ONE), TWO_AND_ONE, 'Withdrew x.');
    state = stateOf(press(state, '', ARROW_DOWN));
    expect(state.cursor).toBe(1);
    expect(state.message).toBe('');
    state = stateOf(press(state, '', ARROW_DOWN));
    state = stateOf(press(state, '', ARROW_DOWN));
    expect(state.cursor).toBe(2);
    state = stateOf(press(state, '', ARROW_UP));
    state = stateOf(press(state, '', ARROW_UP));
    state = stateOf(press(state, '', ARROW_UP));
    expect(state.cursor).toBe(0);
  });

  it('Home and End go to the ends and the page keys move by a page, clamped', () => {
    const many = snapshot(
      Array.from({ length: 30 }, (_, index) => project(`g${String(index)}`)),
      undefined,
    );
    let state = open(many, 'project', undefined);
    state = stateOf(press(state, '', { end: true }));
    expect(state.cursor).toBe(29);
    state = stateOf(press(state, '', { pageUp: true }));
    expect(state.cursor).toBe(29 - (SHEET_WINDOW - 2));
    state = stateOf(press(state, '', { home: true }));
    expect(state.cursor).toBe(0);
    state = stateOf(press(state, '', { pageDown: true }));
    expect(state.cursor).toBe(SHEET_WINDOW - 2);
  });

  it('Esc closes an idle sheet, and so does Ctrl+C', () => {
    expect(press(open(TWO_AND_ONE), '', ESC)).toEqual({ kind: 'close' });
    expect(press(open(TWO_AND_ONE), 'c', CTRL_C)).toEqual({ kind: 'close' });
  });

  it('`d`, Delete and Backspace arm the selected row; nothing is withdrawn by arming', () => {
    for (const [input, key] of [
      ['d', {}],
      ['D', {}],
      ['', { delete: true }],
      ['', { backspace: true }],
    ] as const) {
      const step = press(open(TWO_AND_ONE), input, key);
      expect(step.kind).toBe('state');
      expect(stateOf(step).armed).toBe(true);
    }
  });

  it('does not arm with Ctrl or Meta held, with nothing to select, or where the frame cannot show the question', () => {
    expect(stateOf(press(open(TWO_AND_ONE), 'd', { ctrl: true })).armed).toBe(false);
    expect(stateOf(press(open(TWO_AND_ONE), 'd', { meta: true })).armed).toBe(false);
    expect(stateOf(press(open(snapshot([], [])), 'd')).armed).toBe(false);
    expect(stateOf(press(open(TWO_AND_ONE), 'd', {}, false)).armed).toBe(false);
  });

  it('Enter withdraws an armed row: the step names the entry and the sheet comes back disarmed', () => {
    const armed = stateOf(press(stateOf(press(open(TWO_AND_ONE), '', ARROW_DOWN)), 'd'));
    const step = press(armed, '', ENTER);
    expect(step.kind).toBe('withdraw');
    if (step.kind !== 'withdraw') return;
    expect(step.entry).toMatchObject({ kind: 'project', row: { id: 'b' } });
    expect(step.state.armed).toBe(false);
  });

  it('Enter withdraws nothing that is not armed', () => {
    const step = press(open(TWO_AND_ONE), '', ENTER);
    expect(step.kind).toBe('state');
    expect(stateOf(step).armed).toBe(false);
  });

  it('while armed, Esc keeps the row and does not close; a second Esc closes', () => {
    const armed = stateOf(press(open(TWO_AND_ONE), 'd'));
    const kept = press(armed, '', ESC);
    expect(kept.kind).toBe('state');
    expect(stateOf(kept).armed).toBe(false);
    expect(press(stateOf(kept), '', ESC)).toEqual({ kind: 'close' });
  });

  it('while armed, every other key keeps the row and does nothing else, `d` included', () => {
    const armed = stateOf(press(open(TWO_AND_ONE), 'd'));
    for (const [input, key] of [
      ['x', {}],
      ['d', {}],
      ['', ARROW_DOWN],
      ['', { tab: true }],
      ['y', {}],
    ] as const) {
      const step = press(armed, input, key);
      expect(step.kind, input).toBe('state');
      expect(stateOf(step).armed).toBe(false);
      expect(stateOf(step).cursor).toBe(armed.cursor);
    }
  });

  it('Ctrl+C closes from either state and never withdraws', () => {
    const armed = stateOf(press(open(TWO_AND_ONE), 'd'));
    expect(press(armed, 'c', CTRL_C)).toEqual({ kind: 'close' });
    expect(press(open(TWO_AND_ONE), 'c', CTRL_C)).toEqual({ kind: 'close' });
  });

  it('Enter with Ctrl held is not a confirm of a withdrawal either: the interrupt closes first', () => {
    const armed = stateOf(press(open(TWO_AND_ONE), 'd'));
    expect(press(armed, 'c', { ctrl: true, return: true })).toEqual({ kind: 'close' });
  });

  it('a paste while armed drops the question and withdraws nothing', () => {
    const armed = stateOf(press(open(TWO_AND_ONE), 'd'));
    expect(disarmPermissionsSheet(armed).armed).toBe(false);
    const idle = open(TWO_AND_ONE);
    expect(disarmPermissionsSheet(idle)).toBe(idle);
  });

  it('ignores printable letters that are not the withdraw key', () => {
    const step = press(open(TWO_AND_ONE), 'q');
    expect(step.kind).toBe('state');
    expect(stateOf(step)).toEqual(open(TWO_AND_ONE));
  });
});

describe('the legend and the handler read one constant (ADR-0137 §5)', () => {
  it('names every key the handler answers to, in the grammar: dim separators, leaving key last', () => {
    expect(SHEET_LEGEND_IDLE).toBe('↑/↓ select · d withdraw · Esc close');
    expect(SHEET_LEGEND_ARMED).toBe('Enter withdraw · Esc keep');
    expect(SHEET_LEGEND_IDLE.endsWith(`${SHEET_KEYS.close.keys} ${SHEET_KEYS.close.verb}`)).toBe(
      true,
    );
  });

  it('every item the legend promises does what its verb says, pressed on a real state', () => {
    const idle = open(TWO_AND_ONE);
    // select: `↑/↓`
    expect(stateOf(press(idle, '', ARROW_DOWN)).cursor).toBe(1);
    expect(stateOf(press(stateOf(press(idle, '', ARROW_DOWN)), '', ARROW_UP)).cursor).toBe(0);
    // withdraw: `d` arms
    const armed = stateOf(press(idle, SHEET_KEYS.withdraw.keys));
    expect(armed.armed).toBe(true);
    // confirm: `Enter` withdraws what is armed
    expect(press(armed, '', ENTER).kind).toBe('withdraw');
    // keep: `Esc` keeps what is armed
    expect(stateOf(press(armed, '', ESC)).armed).toBe(false);
    // close: `Esc` closes an idle sheet
    expect(press(idle, '', ESC).kind).toBe('close');
  });
});

describe('reloading after a withdrawal', () => {
  it('keeps the cursor near where it was, clamps it to the shorter list, disarms and carries the message', () => {
    let state = stateOf(press(open(TWO_AND_ONE), 'd'));
    state = { ...state, cursor: 2 };
    const after = reloadPermissionsSheet(state, snapshot([project('a')], []), 'Withdrew it.');
    expect(after.cursor).toBe(0);
    expect(after.armed).toBe(false);
    expect(after.message).toBe('Withdrew it.');
    const none = reloadPermissionsSheet(state, snapshot([], []), 'Withdrew it.');
    expect(none.cursor).toBe(0);
  });
});

describe('what is drawn', () => {
  const geometry = { columns: 80, terminalRows: 24 };
  const texts = (state: PermissionsSheetState, g = geometry) =>
    permissionsSheetLines(state, g).map((line) => line.text);

  it('titles a chat by its mode and the project-only surface by the project', () => {
    expect(sheetTitle(open(TWO_AND_ONE, 'chat', 'auto'))).toBe('Permissions · auto mode');
    expect(sheetTitle(open(TWO_AND_ONE, 'chat', 'plan'))).toBe('Permissions · plan mode');
    expect(sheetTitle(open(projectOnly([project('a')]), 'project', undefined))).toBe(
      'Permissions · this project',
    );
  });

  it('says what a grant is worth in each mode, and never that plan runs anything', () => {
    expect(sheetNote(open(TWO_AND_ONE, 'chat', 'ask'))).toMatch(/only auto mode runs one unasked/u);
    expect(sheetNote(open(TWO_AND_ONE, 'chat', 'accept-edits'))).toMatch(
      /only auto mode runs one unasked/u,
    );
    expect(sheetNote(open(TWO_AND_ONE, 'chat', 'auto'))).toMatch(/asks once after a file write/u);
    expect(sheetNote(open(TWO_AND_ONE, 'chat', 'plan'))).toBe(
      'Plan mode refuses every command; nothing here runs.',
    );
    expect(sheetNote(open(projectOnly([]), 'project', undefined))).toMatch(
      /in a chat opened in this project/u,
    );
  });

  it('draws the title, the two sections with their counts, the rows, the note, the message row and the legend, in that order', () => {
    const lines = permissionsSheetLines(open(TWO_AND_ONE), geometry);
    expect(lines.map((line) => line.kind)).toEqual([
      'title',
      'heading',
      'selected',
      'row',
      'heading',
      'row',
      'note',
      'message',
      'legend',
    ]);
    const text = lines.map((line) => line.text);
    expect(text[0]).toBe('Permissions · ask mode');
    expect(text[1]).toBe('This project · remembered (2)');
    expect(text[2]).toMatch(/^› npm, 1 argument +remembered 2026-11-19 12:00Z$/u);
    expect(text[3]).toMatch(/^ {2}node, 1 argument +remembered 2026-11-19 12:00Z$/u);
    expect(text[4]).toBe('This session · approved (1)');
    expect(text[5]).toBe('  git status');
    expect(text.at(-1)).toBe(SHEET_LEGEND_IDLE);
  });

  it('flushes the remembered date to the right edge and marks a session row a grant also covers', () => {
    const lines = permissionsSheetLines(
      open(snapshot([project('a')], [session('npm test', true)])),
      geometry,
    );
    const width = 78;
    expect(displayWidth(lines[2]?.text ?? '')).toBe(width);
    expect(lines[2]?.text.endsWith('remembered 2026-11-19 12:00Z')).toBe(true);
    expect(displayWidth(lines[4]?.text ?? '')).toBe(width);
    expect(lines[4]?.text.endsWith('(also remembered)')).toBe(true);
  });

  it('leaves the project-only surface without a session section', () => {
    const lines = texts(open(projectOnly([project('a')]), 'project', undefined));
    expect(lines.some((line) => line.startsWith('This session'))).toBe(false);
    expect(lines[0]).toBe('Permissions · this project');
  });

  it('says what to do when nothing is remembered, per surface, and that nothing is approved for the session', () => {
    const chat = texts(open(snapshot([], []))).join(' ');
    expect(chat).toContain(
      'Nothing is remembered for this project. Press Ctrl+O on a command card to remember one.',
    );
    expect(chat).toContain('Nothing is approved for this session.');
    const bare = texts(open(projectOnly([]), 'project', undefined));
    expect(bare.join(' ')).toMatch(
      /A command is remembered from its card in a chat \(Ctrl\+O\)\./u,
    );
  });

  it('shows a store failure as a fixed sentence in place of the rows, wrapped to the width, and the session section still works', () => {
    const long =
      'The remembered-commands file could not be read, so nothing in it is trusted. `relavium permissions revoke --all` removes it.';
    const lines = permissionsSheetLines(
      open({ project: { ok: false, text: long }, session: [session('git status')] }),
      geometry,
    );
    const text = lines.map((line) => line.text);
    expect(text[1]).toBe('This project · remembered');
    expect(text.slice(2, 4).join(' ')).toContain('could not be read');
    // With no project rows the session row is the first entry, so it is the selected one.
    expect(text.some((line) => line === '› git status')).toBe(true);
    for (const line of text) expect(displayWidth(line)).toBeLessThanOrEqual(78);
  });

  it('shows a command as the card does: a `<`, a bidi override and a tab are visible tokens, not their effect', () => {
    const lines = texts(open(snapshot([], [session('echo a<b‮c\td')])));
    const row = lines.find((line) => line.includes('echo')) ?? '';
    expect(row).toContain('<U+003C>');
    expect(row).toContain('<U+202E>');
    expect(row).toContain('<TAB>');
    expect(row).not.toContain('‮');
  });

  it('draws the question of an armed row in the message row, with the row’s label and date, and the armed legend', () => {
    const armed = stateOf(press(open(TWO_AND_ONE), 'd'));
    const lines = permissionsSheetLines(armed, geometry);
    expect(lines.at(-2)).toEqual({
      kind: 'question',
      text: 'Withdraw npm, 1 argument (2026-11-19 12:00Z)? Enter withdraws · Esc keeps it',
    });
    expect(lines.at(-1)?.text).toBe(SHEET_LEGEND_ARMED);
  });

  it('clips a long session command in the question so the question and its keys always fit', () => {
    const longCommand = `curl ${'x'.repeat(200)}`;
    const armed = stateOf(press(open(snapshot([], [session(longCommand)])), 'd'));
    const question = permissionsSheetLines(armed, geometry).at(-2)?.text ?? '';
    expect(question.startsWith('Withdraw curl ')).toBe(true);
    expect(question.endsWith('…? Enter withdraws · Esc keeps it')).toBe(true);
    expect(displayWidth(question)).toBeLessThanOrEqual(78);
  });

  it('always has a message row, empty or not, and shows the last result there', () => {
    const idle = permissionsSheetLines(open(TWO_AND_ONE), geometry);
    expect(idle.at(-2)).toEqual({ kind: 'message', text: '' });
    const after = reloadPermissionsSheet(
      open(TWO_AND_ONE),
      TWO_AND_ONE,
      'Withdrew npm, 1 argument. Auto mode asks about it again.',
    );
    expect(permissionsSheetLines(after, geometry).at(-2)?.text).toBe(
      'Withdrew npm, 1 argument. Auto mode asks about it again.',
    );
  });

  it('keeps every line within the width and the whole sheet within the card’s budget, at 80x24 and above', () => {
    const many = snapshot(
      Array.from({ length: 40 }, (_, index) =>
        project(`g${String(index)}`, `a-very-long-program-name-${String(index)}, 12 arguments`),
      ),
      Array.from({ length: 12 }, (_, index) =>
        session(`curl https://example.test/${'y'.repeat(120)}${String(index)}`, true),
      ),
    );
    for (const [columns, rows] of [
      [80, 24],
      [100, 30],
      [120, 50],
      [200, 60],
    ] as const) {
      const state = { ...open(many), cursor: 20 };
      const lines = permissionsSheetLines(state, { columns, terminalRows: rows });
      const budget = Math.max(8, Math.min(Math.floor((rows * 3) / 5), rows - 8 - 4));
      expect(lines.length, `${String(columns)}x${String(rows)}`).toBeLessThanOrEqual(budget - 1);
      for (const line of lines) expect(displayWidth(line.text)).toBeLessThanOrEqual(columns - 2);
      expect(lines.filter((line) => line.kind === 'selected')).toHaveLength(1);
      expect(lines[0]?.kind).toBe('title');
      expect(lines.at(-1)?.kind).toBe('legend');
    }
  });

  it('draws the note only when the budget has a row for it, and never drops the title, message row or legend', () => {
    const lines = permissionsSheetLines(open(TWO_AND_ONE), { columns: 80, terminalRows: 24 });
    expect(lines.some((line) => line.kind === 'note')).toBe(true);
    const kinds = permissionsSheetLines(open(TWO_AND_ONE), { columns: 80, terminalRows: 24 }).map(
      (line) => line.kind,
    );
    expect(kinds[0]).toBe('title');
    expect(kinds.at(-2)).toMatch(/^(message|question)$/u);
    expect(kinds.at(-1)).toBe('legend');
  });

  it('below the 80x24 floor it draws a way out and arms nothing', () => {
    expect(sheetCanArm({ columns: 79, terminalRows: 24 })).toBe(false);
    expect(sheetCanArm({ columns: 80, terminalRows: 23 })).toBe(false);
    expect(sheetCanArm({ columns: 80, terminalRows: 24 })).toBe(true);
    const lines = permissionsSheetLines(open(TWO_AND_ONE), { columns: 60, terminalRows: 20 });
    expect(lines.map((line) => line.text)).toEqual([
      'Permissions · ask mode',
      'Enlarge the terminal to use this screen — Esc closes.',
      'Esc close',
    ]);
  });
});

describe('the window', () => {
  it('shows everything that fits, and otherwise keeps the cursor on a real line with a marker on each hidden side', () => {
    expect(windowBody(5, 2, 8)).toEqual({ start: 0, end: 5 });
    for (const total of [9, 12, 30, 100]) {
      for (const height of [3, 5, 8]) {
        for (let cursor = 0; cursor < total; cursor += 1) {
          const { start, end } = windowBody(total, cursor, height);
          expect(end - start, `${String(total)}/${String(height)}/${String(cursor)}`).toBe(height);
          const top = start > 0 ? 1 : 0;
          const bottom = end < total ? 1 : 0;
          expect(cursor).toBeGreaterThanOrEqual(start + top);
          expect(cursor).toBeLessThan(end - bottom);
        }
      }
    }
  });

  it('draws the markers with the counts of the lines hidden above and below', () => {
    const many = snapshot(
      Array.from({ length: 30 }, (_, index) => project(`g${String(index)}`)),
      undefined,
    );
    const state = { ...open(many, 'project', undefined), cursor: 15 };
    const lines = permissionsSheetLines(state, { columns: 80, terminalRows: 24 });
    const markers = lines.filter((line) => line.kind === 'marker').map((line) => line.text);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatch(/^▲ \d+ more$/u);
    expect(markers[1]).toMatch(/^▼ \d+ more$/u);
    const body = lines.filter(
      (line) => line.kind === 'row' || line.kind === 'selected' || line.kind === 'heading',
    ).length;
    const hiddenAbove = Number(/\d+/u.exec(markers[0] ?? '')?.[0]);
    const hiddenBelow = Number(/\d+/u.exec(markers[1] ?? '')?.[0]);
    // 30 rows and one heading, less what is on screen (markers stand in for lines)
    expect(hiddenAbove + hiddenBelow + body + 2).toBeGreaterThanOrEqual(31);
  });
});

describe('clipLine', () => {
  it('leaves a line that fits whole and cuts one that does not with an ellipsis within the width', () => {
    expect(clipLine('abc', 5)).toBe('abc');
    expect(clipLine('abcdefghij', 5)).toBe('abcd…');
    expect(displayWidth(clipLine('日本語のテキストです', 9))).toBeLessThanOrEqual(9);
    expect(clipLine('abc', 1)).toBe('a');
  });
});
