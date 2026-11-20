import { describe, expect, it } from 'vitest';

import type {
  PermissionsSnapshot,
  ProjectGrantRow,
  SessionApprovalRow,
} from '../../permissions/chat-permissions.js';
import { displayWidth } from './viewport.js';
import {
  SHEET_CONFIRM_DWELL_MS,
  SHEET_ENTER_NOTE,
  SHEET_KEYS,
  SHEET_LEGEND_ARMED,
  SHEET_LEGEND_EMPTY,
  SHEET_LEGEND_IDLE,
  SHEET_QUIET_MS,
  SHEET_SETTLE_MS,
  SHEET_WINDOW,
  disarmPermissionsSheet,
  foldPermissionsSheetKey,
  initialPermissionsSheetState,
  permissionsSheetLines,
  reloadPermissionsSheet,
  sheetCanArm,
  sheetEntries,
  sheetNote,
  sheetTitle,
  type PermissionsSheetState,
  type PermissionsSheetStep,
} from './permissions-sheet.js';
import { SHEET_MAX_COLUMNS } from './sheet-frame.js';

/** The `/permissions` sheet's pure half (ADR-0137 §2): the key ladder, its clock, and the lines. No terminal, no React. */
const project = (
  id: string,
  label = 'npm, 1 argument',
  at = '2026-11-19 12:00Z',
): ProjectGrantRow => ({ id, label, remembered: at });
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

/** A right-to-left override, built here because the character itself must not sit in a source file. */
const RLO = String.fromCharCode(0x202e);

/** The sheet opened at T0; every key below is pressed a stated number of milliseconds later on the injected clock. */
const T0 = 50_000;
const SETTLED = T0 + 1_000;

const open = (
  snap: PermissionsSnapshot,
  surface: 'chat' | 'project' = 'chat',
  mode: PermissionsSheetState['mode'] = 'ask',
): PermissionsSheetState => initialPermissionsSheetState(snap, surface, mode, T0);

const press = (
  state: PermissionsSheetState,
  input: string,
  key: Parameters<typeof foldPermissionsSheetKey>[1] = {},
  at = SETTLED,
  canArm = true,
): PermissionsSheetStep => foldPermissionsSheetKey(input, key, state, canArm, at);

function stateOf(step: PermissionsSheetStep): PermissionsSheetState {
  if (step.kind === 'close') throw new Error('expected a state, got close');
  return step.state;
}

const TWO_AND_ONE = snapshot(
  [project('a'), project('b', 'node, 1 argument')],
  [session('git status')],
);

/** The sheet with the question up, asked at SETTLED. */
const armedAt = (from: PermissionsSheetState = open(TWO_AND_ONE)): PermissionsSheetState =>
  stateOf(press(from, 'd', {}, SETTLED));

const ARROW_DOWN = { downArrow: true } as const;
const ARROW_UP = { upArrow: true } as const;
const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const CTRL_C = { ctrl: true } as const;
const CONFIRM_AT = SETTLED + SHEET_CONFIRM_DWELL_MS;

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
    let state = reloadPermissionsSheet(open(TWO_AND_ONE), TWO_AND_ONE, 'Withdrawn.');
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
    const many = projectOnly(
      Array.from({ length: 30 }, (_, index) => project(`g${String(index)}`)),
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

  it('`d`, Delete and Backspace arm the selected row once the sheet has settled; nothing is withdrawn by arming', () => {
    for (const [input, key] of [
      ['d', {}],
      ['D', {}],
      ['', { delete: true }],
      ['', { backspace: true }],
    ] as const) {
      const step = press(open(TWO_AND_ONE), input, key);
      expect(step.kind).toBe('state');
      expect(stateOf(step).armed).toBe(true);
      expect(stateOf(step).armedAt).toBe(SETTLED);
    }
  });

  it('does not arm with Ctrl or Meta held, with nothing to select, or where the frame cannot show the question', () => {
    expect(stateOf(press(open(TWO_AND_ONE), 'd', { ctrl: true })).armed).toBe(false);
    expect(stateOf(press(open(TWO_AND_ONE), 'd', { meta: true })).armed).toBe(false);
    expect(stateOf(press(open(snapshot([], [])), 'd')).armed).toBe(false);
    expect(stateOf(press(open(TWO_AND_ONE), 'd', {}, SETTLED, false)).armed).toBe(false);
  });

  describe('the clock: a typed line is not a command (security sitting, step 5 round 1)', () => {
    it('`d` does nothing until the sheet has been open for the settle time, and arms at it', () => {
      const fresh = open(TWO_AND_ONE);
      expect(stateOf(press(fresh, 'd', {}, T0 + SHEET_SETTLE_MS - 1)).armed).toBe(false);
      expect(stateOf(press(fresh, 'd', {}, T0 + SHEET_SETTLE_MS)).armed).toBe(true);
    });

    it('`d` does nothing until the keyboard has been quiet, and any key, an arrow included, restarts the quiet', () => {
      let state = open(TWO_AND_ONE);
      state = stateOf(press(state, '', ARROW_DOWN, SETTLED));
      expect(stateOf(press(state, 'd', {}, SETTLED + SHEET_QUIET_MS - 1)).armed).toBe(false);
      expect(stateOf(press(state, 'd', {}, SETTLED + SHEET_QUIET_MS)).armed).toBe(true);
      // A refused `d` is itself a key: it restarts the quiet, so a typed `dd` cannot arm on the second press.
      const refused = stateOf(press(state, 'd', {}, SETTLED + 100));
      expect(refused.armed).toBe(false);
      expect(refused.lastKeyAt).toBe(SETTLED + 100);
      expect(stateOf(press(refused, 'd', {}, SETTLED + 200)).armed).toBe(false);
    });

    it('a line typed after `/permissions` and Enter that ends in `d`, then Enter, withdraws nothing', () => {
      let state = open(TWO_AND_ONE);
      let at = T0 + 450; // the sheet has settled; the person keeps typing "run the build" a character every 120 ms
      for (const char of 'run the build') {
        const step = press(state, char, {}, at);
        if (step.kind === 'close') throw new Error('typing closed the sheet');
        state = step.state;
        at += 120;
      }
      expect(state.armed, 'the last d came 120 ms after the l').toBe(false);
      expect(press(state, '', ENTER, at).kind).toBe('state');
    });

    it('a Delete key typed ahead and an Enter in the same instant withdraws nothing', () => {
      const typed = stateOf(press(open(TWO_AND_ONE), '', { delete: true }, T0 + 5));
      expect(typed.armed).toBe(false);
      expect(press(typed, '', ENTER, T0 + 6).kind).toBe('state');
    });

    it('Enter withdraws only after the question has been up for the dwell, and a hasty Enter drops it with a note', () => {
      const armed = armedAt();
      const early = press(armed, '', ENTER, CONFIRM_AT - 1);
      expect(early.kind).toBe('state');
      expect(stateOf(early).armed).toBe(false);
      expect(stateOf(early).message).toBe(SHEET_ENTER_NOTE);
      expect(press(armed, '', ENTER, CONFIRM_AT).kind).toBe('withdraw');
    });

    it('only an Enter with nothing held confirms: Meta+Enter (an Esc then Enter), Ctrl+Enter and Shift+Enter drop the question', () => {
      const armed = armedAt();
      for (const key of [
        { return: true, meta: true },
        { return: true, ctrl: true },
        { return: true, shift: true },
      ] as const) {
        const step = press(armed, '', key, CONFIRM_AT + 500);
        expect(step.kind, JSON.stringify(key)).toBe('state');
        expect(stateOf(step).armed).toBe(false);
      }
    });
  });

  it('Enter withdraws an armed row: the step names the entry and the sheet comes back disarmed', () => {
    const second = stateOf(press(open(TWO_AND_ONE), '', ARROW_DOWN));
    const armed = stateOf(press(second, 'd', {}, SETTLED + SHEET_QUIET_MS + 10));
    const step = press(armed, '', ENTER, armed.armedAt + SHEET_CONFIRM_DWELL_MS);
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
    const kept = press(armedAt(), '', ESC, CONFIRM_AT);
    expect(kept.kind).toBe('state');
    expect(stateOf(kept).armed).toBe(false);
    expect(press(stateOf(kept), '', ESC, CONFIRM_AT + 10)).toEqual({ kind: 'close' });
  });

  it('while armed, every other key keeps the row and does nothing else, `d` included', () => {
    const armed = armedAt();
    for (const [input, key] of [
      ['x', {}],
      ['d', {}],
      ['', ARROW_DOWN],
      ['', { tab: true }],
      ['y', {}],
    ] as const) {
      const step = press(armed, input, key, CONFIRM_AT + 50);
      expect(step.kind, input).toBe('state');
      expect(stateOf(step).armed).toBe(false);
      expect(stateOf(step).cursor).toBe(armed.cursor);
    }
  });

  it('Ctrl+C closes from either state and never withdraws', () => {
    expect(press(armedAt(), 'c', CTRL_C, CONFIRM_AT)).toEqual({ kind: 'close' });
    expect(press(open(TWO_AND_ONE), 'c', CTRL_C)).toEqual({ kind: 'close' });
    expect(press(armedAt(), 'c', { ctrl: true, return: true }, CONFIRM_AT)).toEqual({
      kind: 'close',
    });
  });

  it('a terminal that shrinks below the floor while a question is up: Enter withdraws nothing, Esc closes, any other key drops it', () => {
    const armed = armedAt();
    const small = (key: Parameters<typeof foldPermissionsSheetKey>[1]) =>
      press(armed, '', key, CONFIRM_AT + 500, false);
    expect(small(ENTER).kind).toBe('state');
    expect(stateOf(small(ENTER)).armed).toBe(false);
    expect(small(ESC)).toEqual({ kind: 'close' });
    expect(stateOf(small(ARROW_DOWN)).armed).toBe(false);
  });

  it('a paste drops a waiting question, counts as a key for the quiet, and withdraws nothing', () => {
    const after = disarmPermissionsSheet(armedAt(), CONFIRM_AT);
    expect(after.armed).toBe(false);
    expect(after.lastKeyAt).toBe(CONFIRM_AT);
    const idle = disarmPermissionsSheet(open(TWO_AND_ONE), SETTLED);
    expect(idle.armed).toBe(false);
    expect(idle.lastKeyAt).toBe(SETTLED);
  });

  it('ignores printable letters that are not the withdraw key', () => {
    const step = press(open(TWO_AND_ONE), 'q');
    expect(step.kind).toBe('state');
    expect(stateOf(step)).toEqual({ ...open(TWO_AND_ONE), lastKeyAt: SETTLED });
  });
});

describe('the legend and the handler (ADR-0137 §5)', () => {
  it('names every key the handler answers to, in the grammar: dim separators, leaving key last', () => {
    expect(SHEET_LEGEND_IDLE).toBe('↑/↓ select · d withdraw · Esc close');
    expect(SHEET_LEGEND_ARMED).toBe('Enter withdraw · Esc keep');
    expect(SHEET_LEGEND_EMPTY).toBe('Esc close');
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
    expect(press(armed, '', ENTER, armed.armedAt + SHEET_CONFIRM_DWELL_MS).kind).toBe('withdraw');
    // keep: `Esc` keeps what is armed
    expect(stateOf(press(armed, '', ESC)).armed).toBe(false);
    // close: `Esc` closes an idle sheet
    expect(press(idle, '', ESC).kind).toBe('close');
  });
});

describe('reloading after a withdrawal', () => {
  it('keeps the cursor near where it was, clamps it to the shorter list, disarms and carries the message', () => {
    const state = { ...armedAt(), cursor: 2 };
    const after = reloadPermissionsSheet(state, snapshot([project('a')], []), 'Withdrawn.');
    expect(after.cursor).toBe(0);
    expect(after.armed).toBe(false);
    expect(after.message).toBe('Withdrawn.');
    const none = reloadPermissionsSheet(state, snapshot([], []), 'Withdrawn.');
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

  it('says what a grant is worth in each mode, never that plan runs anything, and every note fits one 80-column row', () => {
    expect(sheetNote(open(TWO_AND_ONE, 'chat', 'ask'))).toMatch(/only auto mode runs one unasked/u);
    expect(sheetNote(open(TWO_AND_ONE, 'chat', 'accept-edits'))).toMatch(
      /only auto mode runs one unasked/u,
    );
    expect(sheetNote(open(TWO_AND_ONE, 'chat', 'auto'))).toMatch(/asks once after a file write/u);
    expect(sheetNote(open(TWO_AND_ONE, 'chat', 'plan'))).toBe(
      'Plan mode refuses every command; nothing here runs.',
    );
    expect(sheetNote(open(projectOnly([]), 'project', undefined))).toMatch(
      /in a chat in this project/u,
    );
    for (const mode of ['ask', 'accept-edits', 'auto', 'plan'] as const)
      expect(displayWidth(sheetNote(open(TWO_AND_ONE, 'chat', mode)))).toBeLessThanOrEqual(78);
    expect(
      displayWidth(sheetNote(open(projectOnly([]), 'project', undefined))),
    ).toBeLessThanOrEqual(78);
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
    expect(text[2]).toMatch(/^› npm, 1 argument +2026-11-19 12:00Z$/u);
    expect(text[3]).toMatch(/^ {2}node, 1 argument +2026-11-19 12:00Z$/u);
    expect(text[4]).toBe('This session · approved (1)');
    expect(text[5]).toBe('  git status');
    expect(text.at(-1)).toBe(SHEET_LEGEND_IDLE);
  });

  it('flushes the date to the right edge and marks a session row a grant also covers', () => {
    const lines = permissionsSheetLines(
      open(snapshot([project('a')], [session('npm test', true)])),
      geometry,
    );
    expect(displayWidth(lines[2]?.text ?? '')).toBe(78);
    expect(lines[2]?.text.endsWith('2026-11-19 12:00Z')).toBe(true);
    expect(displayWidth(lines[4]?.text ?? '')).toBe(78);
    expect(lines[4]?.text.endsWith('(also remembered)')).toBe(true);
  });

  it('keeps a row’s value near its label on a wide terminal: nothing is drawn wider than the cap', () => {
    const lines = permissionsSheetLines(open(TWO_AND_ONE), { columns: 200, terminalRows: 60 });
    for (const line of lines)
      expect(displayWidth(line.text)).toBeLessThanOrEqual(SHEET_MAX_COLUMNS);
    expect(displayWidth(lines[2]?.text ?? '')).toBe(SHEET_MAX_COLUMNS);
  });

  it('offers only the way out when there is nothing to select', () => {
    expect(permissionsSheetLines(open(snapshot([], [])), geometry).at(-1)?.text).toBe(
      SHEET_LEGEND_EMPTY,
    );
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
      'The remembered-commands file could not be read, so nothing in it is trusted. Running relavium permissions revoke --all removes it.';
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
    const lines = texts(open(snapshot([], [session(`echo a<b${RLO}c\td`)])));
    const row = lines.find((line) => line.includes('echo')) ?? '';
    expect(row).toContain('<U+003C>');
    expect(row).toContain('<U+202E>');
    expect(row).toContain('<TAB>');
    expect(row).not.toContain(RLO);
  });

  it('shows a remembered row’s label and date as visible tokens too, never as their effect', () => {
    const lines = permissionsSheetLines(
      open(
        projectOnly([project('a', `np${RLO}m, 1 argument`, `2026${RLO}-11-19 12:00Z`)]),
        'project',
        undefined,
      ),
      geometry,
    );
    const row = lines.find((line) => line.kind === 'selected')?.text ?? '';
    expect(row).toContain('<U+202E>');
    expect(row).not.toContain(RLO);
  });

  it('draws the question of an armed row in the message row, with the row’s label and date, and the armed legend', () => {
    const lines = permissionsSheetLines(armedAt(), geometry);
    expect(lines.at(-2)).toEqual({
      kind: 'question',
      text: 'Withdraw npm, 1 argument (2026-11-19 12:00Z)? Any other key keeps it.',
    });
    expect(lines.at(-1)?.text).toBe(SHEET_LEGEND_ARMED);
  });

  it('keeps the date when it clips a long project label in the question', () => {
    const label = `(unnamed program), ${'9'.repeat(70)} arguments`;
    const armed = armedAt(open(snapshot([project('a', label)], [])));
    const question = permissionsSheetLines(armed, geometry).at(-2)?.text ?? '';
    expect(question).toMatch(/…\s\(2026-11-19 12:00Z\)\? Any other key keeps it\.$/u);
    expect(displayWidth(question)).toBeLessThanOrEqual(78);
  });

  it('clips a long session command in the question so the question always fits', () => {
    const longCommand = `curl ${'x'.repeat(200)}`;
    const armed = armedAt(open(snapshot([], [session(longCommand)])));
    const question = permissionsSheetLines(armed, geometry).at(-2)?.text ?? '';
    expect(question.startsWith('Withdraw curl ')).toBe(true);
    expect(question.endsWith('…? Any other key keeps it.')).toBe(true);
    expect(displayWidth(question)).toBeLessThanOrEqual(78);
  });

  it('always has a message row, empty or not, escaped, and clipped to the width', () => {
    const idle = permissionsSheetLines(open(TWO_AND_ONE), geometry);
    expect(idle.at(-2)).toEqual({ kind: 'message', text: '' });
    const answer = 'Withdrawn. Auto mode asks about it again.';
    const after = reloadPermissionsSheet(open(TWO_AND_ONE), TWO_AND_ONE, answer);
    expect(permissionsSheetLines(after, geometry).at(-2)?.text).toBe(answer);
    const long = reloadPermissionsSheet(
      open(TWO_AND_ONE),
      TWO_AND_ONE,
      `${RLO}hello ${'long '.repeat(40)}`,
    );
    const message = permissionsSheetLines(long, geometry).at(-2)?.text ?? '';
    expect(displayWidth(message)).toBeLessThanOrEqual(78);
    expect(message.endsWith('…')).toBe(true);
    expect(message.startsWith('<U+202E>hello')).toBe(true);
    expect(message).not.toContain(RLO);
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
      [80, 25],
      [81, 24],
      [100, 30],
      [120, 50],
      [200, 60],
    ] as const) {
      const state = { ...open(many), cursor: 20 };
      const lines = permissionsSheetLines(state, { columns, terminalRows: rows });
      const budget = Math.max(8, Math.min(Math.floor((rows * 3) / 5), rows - 8 - 4));
      expect(lines.length, `${String(columns)}x${String(rows)}`).toBeLessThanOrEqual(budget - 1);
      for (const line of lines)
        expect(displayWidth(line.text)).toBeLessThanOrEqual(
          Math.min(columns - 2, SHEET_MAX_COLUMNS),
        );
      expect(lines.filter((line) => line.kind === 'selected')).toHaveLength(1);
      expect(lines[0]?.kind).toBe('title');
      expect(lines.at(-1)?.kind).toBe('legend');
      expect(lines.some((line) => line.kind === 'note')).toBe(true);
    }
  });

  it('shows up to eight body lines when the terminal is tall enough, and never more', () => {
    const many = projectOnly(
      Array.from({ length: 30 }, (_, index) => project(`g${String(index)}`)),
    );
    const lines = permissionsSheetLines(
      { ...open(many, 'project', undefined), cursor: 12 },
      { columns: 120, terminalRows: 50 },
    );
    const body = lines.filter((line) =>
      ['heading', 'row', 'selected', 'marker', 'text'].includes(line.kind),
    );
    expect(body).toHaveLength(8);
    expect(SHEET_WINDOW).toBe(8);
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

describe('the markers count the rows they stand in for (step 5 round 1)', () => {
  const numbered = (prefix: string, count: number): string[] =>
    Array.from({ length: count }, (_, index) => `${prefix}${String(index)}`);
  const shapes: readonly (readonly [string, PermissionsSnapshot])[] = [
    ['30 remembered, no session', projectOnly(numbered('g', 30).map((id) => project(id)))],
    [
      '14 remembered, 5 approved',
      snapshot(
        numbered('g', 14).map((id) => project(id)),
        numbered('cmd', 5).map((text) => session(text)),
      ),
    ],
    [
      '2 remembered, 12 approved',
      snapshot(
        [project('a'), project('b')],
        numbered('cmd', 12).map((text) => session(text)),
      ),
    ],
    [
      'none remembered, 9 approved',
      snapshot(
        [],
        numbered('cmd', 9).map((text) => session(text)),
      ),
    ],
  ];
  const stateFor = (snap: PermissionsSnapshot, cursor: number): PermissionsSheetState => ({
    ...open(snap, snap.session === undefined ? 'project' : 'chat'),
    cursor,
  });

  it('visible rows plus the two counts are exactly the rows there are, for every cursor, at several sizes', () => {
    for (const [name, snap] of shapes) {
      const total = sheetEntries(snap).length;
      for (const geometry of [
        { columns: 80, terminalRows: 24 },
        { columns: 100, terminalRows: 30 },
        { columns: 120, terminalRows: 50 },
      ]) {
        for (let cursor = 0; cursor < total; cursor += 1) {
          const lines = permissionsSheetLines(stateFor(snap, cursor), geometry);
          const visible = lines.filter((l) => l.kind === 'row' || l.kind === 'selected').length;
          const counts = lines
            .filter((l) => l.kind === 'marker')
            .map((l) => Number(/\d+/u.exec(l.text)?.[0]));
          const sum = visible + counts.reduce((a, b) => a + b, 0);
          expect(
            sum,
            `${name}, ${String(geometry.terminalRows)} rows, cursor ${String(cursor)}`,
          ).toBe(total);
          expect(lines.filter((l) => l.kind === 'selected')).toHaveLength(1);
        }
      }
    }
  });

  it('never leaves a heading alone above a ▼ marker', () => {
    for (const [name, snap] of shapes) {
      const total = sheetEntries(snap).length;
      for (let cursor = 0; cursor < total; cursor += 1) {
        const lines = permissionsSheetLines(stateFor(snap, cursor), {
          columns: 80,
          terminalRows: 24,
        });
        const below = lines.findIndex((l) => l.kind === 'marker' && l.text.startsWith('▼'));
        if (below > 0)
          expect(lines[below - 1]?.kind, `${name}, cursor ${String(cursor)}`).not.toBe('heading');
      }
    }
  });

  it('says ▲ with the rows hidden above and ▼ with the rows hidden below on a long list', () => {
    const snap = shapes[0]?.[1] ?? projectOnly([]);
    const lines = permissionsSheetLines(stateFor(snap, 15), { columns: 80, terminalRows: 24 });
    const markers = lines.filter((l) => l.kind === 'marker').map((l) => l.text);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatch(/^▲ \d+ more$/u);
    expect(markers[1]).toMatch(/^▼ \d+ more$/u);
  });
});
