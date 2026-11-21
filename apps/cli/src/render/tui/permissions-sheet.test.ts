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
  SHEET_CONFIRM_WINDOW_MS,
  SHEET_SETTLE_MS,
  SHEET_TYPED_NOTE,
  SHEET_WAIT_NOTE,
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
  type SheetMessage,
} from './permissions-sheet.js';
import { SHEET_MAX_COLUMNS } from './sheet-frame.js';
import { MAX_ROW_TEXT } from '../../permissions/chat-permissions.js';

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
const DONE: SheetMessage = { tone: 'done', text: 'Withdrawn.' };
const note = (text: string): SheetMessage => ({ tone: 'note', text });

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
    let state = reloadPermissionsSheet(open(TWO_AND_ONE), TWO_AND_ONE, DONE);
    state = stateOf(press(state, '', ARROW_DOWN));
    expect(state.cursor).toBe(1);
    expect(state.message).toBeUndefined();
    state = stateOf(press(state, '', ARROW_DOWN));
    state = stateOf(press(state, '', ARROW_DOWN));
    expect(state.cursor).toBe(2);
    state = stateOf(press(state, '', ARROW_UP));
    state = stateOf(press(state, '', ARROW_UP));
    state = stateOf(press(state, '', ARROW_UP));
    expect(state.cursor).toBe(0);
  });

  it('ArrowUp and ArrowDown move exactly one row', () => {
    const five = open(
      snapshot(
        Array.from({ length: 5 }, (_, i) => project(`g${String(i)}`)),
        [],
      ),
    );
    let state = stateOf(press(five, '', { end: true }));
    expect(state.cursor).toBe(4);
    state = stateOf(press(state, '', ARROW_UP));
    expect(state.cursor).toBe(3);
    state = stateOf(press(state, '', ARROW_UP));
    expect(state.cursor).toBe(2);
    state = stateOf(press(state, '', ARROW_DOWN));
    expect(state.cursor).toBe(3);
  });

  it('Home and End go to the ends and the page keys move by a page, clamped', () => {
    const many = projectOnly(
      Array.from({ length: 30 }, (_, index) => project(`g${String(index)}`)),
    );
    let state = open(many, 'project', undefined);
    state = stateOf(press(state, '', { end: true }));
    expect(state.cursor).toBe(29);
    state = stateOf(press(state, '', { pageUp: true }));
    expect(state.cursor).toBe(23); // a page is six rows
    state = stateOf(press(state, '', { home: true }));
    expect(state.cursor).toBe(0);
    state = stateOf(press(state, '', { pageDown: true }));
    expect(state.cursor).toBe(6);
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

  describe('typed keys never arm: a typed line is not a command (security sittings, step 5 rounds 1 and 2)', () => {
    it('pins the numbers the ADR and the docs state', () => {
      expect(SHEET_SETTLE_MS).toBe(400);
      expect(SHEET_CONFIRM_DWELL_MS).toBe(800);
      expect(SHEET_CONFIRM_WINDOW_MS).toBe(10_000);
    });

    it('`d` does nothing until the sheet has been open for the settle time, says to wait, and arms at the settle time', () => {
      const fresh = open(TWO_AND_ONE);
      const early = press(fresh, 'd', {}, T0 + SHEET_SETTLE_MS - 1);
      expect(stateOf(early).armed).toBe(false);
      expect(stateOf(early).message).toEqual(note(SHEET_WAIT_NOTE));
      expect(
        stateOf(early).typed,
        'too soon is not typing: pressing it again after a moment arms',
      ).toBe(false);
      expect(stateOf(press(stateOf(early), 'd', {}, T0 + SHEET_SETTLE_MS)).armed).toBe(true);
      expect(stateOf(press(fresh, 'd', {}, T0 + SHEET_SETTLE_MS)).armed).toBe(true);
    });

    it('any key that is not navigation says the person may be typing: `d` then arms nothing until an arrow key, and says so', () => {
      let state = open(TWO_AND_ONE);
      state = stateOf(press(state, 'x', {}, SETTLED));
      expect(state.typed).toBe(true);
      const refused = press(state, 'd', {}, SETTLED + 5_000);
      expect(stateOf(refused).armed).toBe(false);
      expect(stateOf(refused).message).toEqual(note(SHEET_TYPED_NOTE));
      expect(stateOf(refused).typed).toBe(true);
      // An arrow key is a person choosing a row: after it, `d` is deliberate.
      const chosen = stateOf(press(stateOf(refused), '', ARROW_DOWN, SETTLED + 5_100));
      expect(chosen.typed).toBe(false);
      expect(stateOf(press(chosen, 'd', {}, SETTLED + 5_101)).armed).toBe(true);
    });

    it('Enter at an idle sheet, Tab, a letter and a paste all count as typing (a Delete or Backspace is an arming key, and arms when nothing was typed)', () => {
      for (const [input, key] of [
        ['', ENTER],
        ['', { tab: true }],
        ['q', {}],
      ] as const) {
        const typed = stateOf(press(open(TWO_AND_ONE), input, key, SETTLED));
        expect(typed.typed, JSON.stringify(key)).toBe(true);
        expect(stateOf(press(typed, 'd', {}, SETTLED + 60_000)).armed).toBe(false);
      }
      const pasted = disarmPermissionsSheet(open(TWO_AND_ONE));
      expect(pasted.typed).toBe(true);
      expect(stateOf(press(pasted, 'd', {}, SETTLED)).armed).toBe(false);
    });

    it('no typed line withdraws at ANY pace: 4,000 random typed streams ending in d and Enter, from instant to very slow, withdraw nothing', () => {
      let seed = 1234567;
      const next = (): number => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };
      const letters = 'abcdefghijklmnopqrstuvwxyz ';
      for (let run = 0; run < 4_000; run += 1) {
        let state = open(TWO_AND_ONE);
        const pace = [5, 40, 110, 250, 380, 700, 2_500][Math.floor(next() * 7)] ?? 110;
        let at = T0 + Math.floor(next() * 2_000);
        const length = 1 + Math.floor(next() * 14);
        const typed = Array.from(
          { length },
          () => letters[Math.floor(next() * letters.length)] ?? 'a',
        );
        typed.push('d');
        const steps = [...typed.map((char) => [char, {}] as const)];
        if (next() < 0.3) steps.push(['', { backspace: true }] as const);
        steps.push(['', ENTER] as const);
        for (const [input, key] of steps) {
          at += Math.floor(pace * (0.5 + next()));
          const step = press(state, input, key, at);
          expect(step.kind, `run ${String(run)}`).not.toBe('withdraw');
          if (step.kind === 'close') throw new Error('typing closed the sheet');
          state = step.state;
        }
      }
    });

    it('a Delete key typed ahead and an Enter in the same instant withdraws nothing', () => {
      const typed = stateOf(press(open(TWO_AND_ONE), '', { delete: true }, T0 + 5));
      expect(typed.armed).toBe(false);
      expect(press(typed, '', ENTER, T0 + 6).kind).toBe('state');
    });

    it('Enter withdraws only between the dwell and the window after the question, and an Enter outside it drops the question with a note', () => {
      const armed = armedAt();
      const early = press(armed, '', ENTER, CONFIRM_AT - 1);
      expect(early.kind).toBe('state');
      expect(stateOf(early).armed).toBe(false);
      expect(stateOf(early).message).toEqual(note(SHEET_ENTER_NOTE));
      expect(press(armed, '', ENTER, CONFIRM_AT).kind).toBe('withdraw');
      expect(press(armed, '', ENTER, SETTLED + SHEET_CONFIRM_WINDOW_MS).kind).toBe('withdraw');
      const late = press(armed, '', ENTER, SETTLED + SHEET_CONFIRM_WINDOW_MS + 1);
      expect(late.kind).toBe('state');
      expect(stateOf(late).message).toEqual(note(SHEET_ENTER_NOTE));
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
    const armed = stateOf(press(second, 'd', {}, SETTLED + 10));
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

  it('a paste drops a waiting question, counts as typing, and withdraws nothing', () => {
    const after = disarmPermissionsSheet(armedAt());
    expect(after.armed).toBe(false);
    expect(after.typed).toBe(true);
    expect(after.message).toBeUndefined();
    const idle = disarmPermissionsSheet(open(TWO_AND_ONE));
    expect(idle.armed).toBe(false);
    expect(idle.typed).toBe(true);
  });

  it('ignores printable letters that are not the withdraw key', () => {
    const step = press(open(TWO_AND_ONE), 'q');
    expect(step.kind).toBe('state');
    expect(stateOf(step)).toEqual({ ...open(TWO_AND_ONE), typed: true });
  });
});

describe('the legend and the handler (ADR-0137 §5)', () => {
  it('names every key the handler answers to, in the grammar: dim separators, leaving key last', () => {
    expect(SHEET_LEGEND_IDLE).toBe('↑/↓ select · [d / Del] withdraw · Esc close');
    expect(SHEET_LEGEND_ARMED).toBe('[Enter] withdraw · Esc keep');
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
    const armed = stateOf(press(idle, 'd'));
    expect(armed.armed).toBe(true);
    // ...and so does the Delete key the legend names beside it
    expect(stateOf(press(idle, '', { delete: true })).armed).toBe(true);
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
    const after = reloadPermissionsSheet(state, snapshot([project('a')], []), DONE);
    expect(after.cursor).toBe(0);
    expect(after.armed).toBe(false);
    expect(after.message).toEqual(DONE);
    const none = reloadPermissionsSheet(state, snapshot([], []), DONE);
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
    // A session approval removes the card in every mode that asks, so the note says so; a remembered command is what only `auto` runs unasked.
    expect(sheetNote(open(TWO_AND_ONE, 'chat', 'ask'))).toBe(
      'Session-approved commands run unasked here; a remembered one still asks.',
    );
    expect(sheetNote(open(TWO_AND_ONE, 'chat', 'accept-edits'))).toBe(
      'Session-approved commands run unasked here; a remembered one still asks.',
    );
    expect(sheetNote(open(TWO_AND_ONE, 'chat', 'auto'))).toBe(
      'Auto runs approved commands; remembered ones ask again after a file write.',
    );
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
      'rule',
      'heading',
      'selected',
      'row',
      'heading',
      'row',
      'note',
      'hint',
      'legend',
    ]);
    const text = lines.map((line) => line.text);
    expect(text[0]).toMatch(/^─ Permissions · ask mode ─+$/u);
    expect(displayWidth(text[0] ?? '')).toBe(78);
    expect(text[1]).toBe('This project · remembered (2)');
    // the selected row carries its own action, just before its date; the date stays flush right
    expect(text[2]).toMatch(/^› npm, 1 argument +\[d\] withdraw {3}2026-11-19 12:00Z$/u);
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
    expect(lines[3]?.kind).toBe('heading');
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
    expect(lines[0]).toMatch(/^─ Permissions · this project ─+$/u);
  });

  it('says what to do when nothing is remembered, per surface, and that nothing is approved for the session', () => {
    const chat = texts(open(snapshot([], []))).join(' ');
    expect(chat).toContain(
      'Nothing is remembered for this project. Press Ctrl+O on a command card, then Enter, to remember one.',
    );
    expect(chat).toContain('Nothing is approved for this session.');
    // `plan` has no cards, so it has nothing to point at.
    const plan = texts(open(snapshot([], []), 'chat', 'plan')).join(' ');
    expect(plan).toContain('Nothing is remembered for this project.');
    expect(plan).not.toContain('Ctrl+O');
    const bare = texts(open(projectOnly([]), 'project', undefined));
    expect(bare.join(' ')).toMatch(
      /A command is remembered from its card in a chat \(Ctrl\+O, then Enter\)\./u,
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
    expect(text.some((line) => line.startsWith('› git status'))).toBe(true);
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
    const nothing = permissionsSheetLines(open(snapshot([], [])), geometry);
    expect(nothing.at(-2)).toEqual({ kind: 'message', text: '' });
    const answer = 'Withdrawn. Auto mode asks about it again.';
    const after = reloadPermissionsSheet(open(TWO_AND_ONE), TWO_AND_ONE, {
      tone: 'done',
      text: answer,
    });
    expect(permissionsSheetLines(after, geometry).at(-2)).toEqual({
      kind: 'done',
      text: `✓ ${answer}`,
    });
    const long = reloadPermissionsSheet(open(TWO_AND_ONE), TWO_AND_ONE, {
      tone: 'note',
      text: `${RLO}hello ${'long '.repeat(40)}`,
    });
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
      expect(lines.length, `${String(columns)}x${String(rows)}`).toBeLessThanOrEqual(budget);
      for (const line of lines)
        expect(displayWidth(line.text)).toBeLessThanOrEqual(
          Math.min(columns - 2, SHEET_MAX_COLUMNS),
        );
      expect(lines.filter((line) => line.kind === 'selected')).toHaveLength(1);
      expect(lines[0]?.kind).toBe('rule');
      expect(lines.at(-1)?.kind).toBe('legend');
      expect(lines.some((line) => line.kind === 'note')).toBe(true);
    }
  });

  it('pins the bounds the docs state: a 100-column cap, 400 characters a row, an eight-line window', () => {
    expect(SHEET_MAX_COLUMNS).toBe(100);
    expect(MAX_ROW_TEXT).toBe(400);
    expect(SHEET_WINDOW).toBe(8);
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
    const text = lines.map((line) => line.text);
    expect(text[0]).toMatch(/^─ Permissions · ask mode ─+$/u);
    expect(text.slice(1)).toEqual([
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

  it('holds for EVERY shape from 0 to 20 remembered and 0 to 10 approved, every cursor, at three sizes: no empty marker, no lone heading, no dangling fragment', () => {
    let frames = 0;
    for (let remembered = 0; remembered <= 20; remembered += 1) {
      for (let approved = 0; approved <= 10; approved += 1) {
        const snap = snapshot(
          Array.from({ length: remembered }, (_, i) => project(`g${String(i)}`)),
          Array.from({ length: approved }, (_, i) => session(`cmd${String(i)}`)),
        );
        const total = remembered + approved;
        for (const geometry of [
          { columns: 80, terminalRows: 24 },
          { columns: 100, terminalRows: 30 },
          { columns: 120, terminalRows: 50 },
        ]) {
          for (let cursor = 0; cursor < Math.max(1, total); cursor += 1) {
            const lines = permissionsSheetLines({ ...open(snap), cursor }, geometry);
            frames += 1;
            const where = `${String(remembered)}+${String(approved)} rows, ${String(geometry.terminalRows)} lines, cursor ${String(cursor)}`;
            const rows = lines.filter((l) => l.kind === 'row' || l.kind === 'selected').length;
            const counts = lines
              .filter((l) => l.kind === 'marker')
              .map((l) => Number(/\d+/u.exec(l.text)?.[0]));
            for (const count of counts)
              expect(count, `${where}: a marker counts nothing`).toBeGreaterThan(0);
            expect(rows + counts.reduce((a, b) => a + b, 0), where).toBe(total);
            if (total > 0)
              expect(
                lines.filter((l) => l.kind === 'selected'),
                where,
              ).toHaveLength(1);
            const down = lines.findIndex((l) => l.kind === 'marker' && l.text.startsWith('▼'));
            if (down > 0)
              expect(lines[down - 1]?.kind, `${where}: a lone heading`).not.toBe('heading');
            const up = lines.findIndex((l) => l.kind === 'marker' && l.text.startsWith('▲'));
            if (up >= 0)
              expect(lines[up + 1]?.kind, `${where}: a dangling fragment`).not.toBe('text');
            // The first body line is a heading, a marker, or the first line of a whole sentence: never a row under a hidden heading and
            // never the middle of a sentence (round 3, F2: the earlier assertion above looked only below a `▲`, which these shapes never draw).
            const first = lines[1];
            expect(
              first?.kind === 'heading' ||
                first?.kind === 'marker' ||
                first?.text.startsWith('Nothing is remembered') === true,
              `${where}: a window that starts on "${first?.text ?? ''}"`,
            ).toBe(true);
          }
        }
      }
    }
    expect(frames).toBeGreaterThan(4_000);
  }, 60_000);

  it('the first view of nothing remembered and four approved shows the heading and the whole sentence, with no marker above', () => {
    const snap = snapshot(
      [],
      Array.from({ length: 4 }, (_, i) => session(`cmd${String(i)}`)),
    );
    const lines = permissionsSheetLines(open(snap), { columns: 80, terminalRows: 24 });
    expect(lines.some((l) => l.text.startsWith('▲'))).toBe(false);
    expect(lines[1]?.text).toBe('This project · remembered (0)');
    expect(lines.map((l) => l.text).join(' ')).toContain('to remember one.');
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

describe('the action is on the row it acts on, and every answer says how it went (the polish after step 5)', () => {
  const geometry = { columns: 80, terminalRows: 24 };
  const lineOf = (state: PermissionsSheetState, kind: string) =>
    permissionsSheetLines(state, geometry).find((line) => line.kind === kind);

  it('puts `[d] withdraw` on the selected row only, before its date, with the key in danger and the date dimmed', () => {
    const lines = permissionsSheetLines(open(TWO_AND_ONE), geometry);
    const selected = lines.find((line) => line.kind === 'selected');
    const other = lines.find((line) => line.kind === 'row');
    expect(selected?.text).toContain('[d] withdraw');
    expect(other?.text).not.toContain('withdraw');
    const text = selected?.text ?? '';
    const key = text.indexOf('[d]');
    expect(selected?.spans).toEqual([
      { from: key, to: key + 3, role: 'danger' },
      { from: text.indexOf('2026-11-19 12:00Z'), to: text.length, role: 'dim' },
    ]);
    // a session row without a date carries the action flush right
    const session = permissionsSheetLines({ ...open(TWO_AND_ONE), cursor: 2 }, geometry).find(
      (line) => line.kind === 'selected',
    );
    expect(session?.text.endsWith('[d] withdraw')).toBe(true);
  });

  it('keeps every date flush right however the selection moves, so the dates stay in one column', () => {
    for (const cursor of [0, 1, 2]) {
      const dated = permissionsSheetLines({ ...open(TWO_AND_ONE), cursor }, geometry).filter(
        (line) =>
          (line.kind === 'row' || line.kind === 'selected') && /\d{4}-\d{2}-\d{2}/u.test(line.text),
      );
      expect(dated.length, `cursor ${String(cursor)}`).toBeGreaterThan(0);
      for (const line of dated) {
        expect(line.text, `cursor ${String(cursor)}`).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z$/u);
        expect(displayWidth(line.text)).toBe(78);
      }
    }
  });

  it('says `[Enter] withdraw` on the armed row, in attention, and draws the row as armed', () => {
    const armed = lineOf(armedAt(), 'armed');
    expect(armed?.text).toContain('[Enter] withdraw');
    expect(armed?.text).not.toContain('[d]');
    const key = armed?.text.indexOf('[Enter]') ?? -1;
    expect(armed?.spans?.[0]).toEqual({ from: key, to: key + 7, role: 'warn' });
    expect(lineOf(armedAt(), 'selected')).toBeUndefined();
  });

  it('says what withdrawing the selected row will do before it is done, for each kind of row', () => {
    const hint = (state: PermissionsSheetState): string | undefined => lineOf(state, 'hint')?.text;
    const snap = snapshot([project('a')], [session('git status'), session('npm test', true)]);
    expect(hint(open(snap))).toBe(
      'Press d to withdraw it: auto mode will ask about this command again.',
    );
    expect(hint({ ...open(snap), cursor: 1 })).toBe(
      'Press d to withdraw it: this command will need approval again.',
    );
    expect(hint({ ...open(snap), cursor: 2 })).toBe(
      'Press d to withdraw the session approval; the project still remembers it.',
    );
    // the key in the hint is the one thing on it that is not dimmed
    expect(lineOf(open(snap), 'hint')?.spans).toEqual([
      { from: 0, to: 6, role: 'dim' },
      { from: 6, to: 7, role: 'danger' },
      { from: 7, to: hint(open(snap))?.length ?? 0, role: 'dim' },
    ]);
  });

  it('draws an answer by its tone: a tick for done, a cross for failed, nothing for a note, and a question wins over all of them', () => {
    const done = reloadPermissionsSheet(open(TWO_AND_ONE), TWO_AND_ONE, {
      tone: 'done',
      text: 'Withdrawn.',
    });
    expect(lineOf(done, 'done')?.text).toBe('✓ Withdrawn.');
    const failed = reloadPermissionsSheet(open(TWO_AND_ONE), TWO_AND_ONE, {
      tone: 'failed',
      text: 'No room.',
    });
    expect(lineOf(failed, 'failed')?.text).toBe('✗ No room.');
    const noted = reloadPermissionsSheet(open(TWO_AND_ONE), TWO_AND_ONE, note('Gone.'));
    expect(lineOf(noted, 'notice')?.text).toBe('Gone.');
    // a question is never hidden behind an old answer
    const asked = { ...armedAt(), message: { tone: 'done', text: 'Old.' } } as const;
    expect(lineOf(asked, 'question')?.text).toMatch(/^Withdraw npm/u);
    expect(lineOf(asked, 'done')).toBeUndefined();
  });

  it('opens with a rule that carries the title: the title in bold, the rest dim, one row wide enough for the frame', () => {
    const rule = permissionsSheetLines(open(TWO_AND_ONE), geometry)[0];
    expect(rule?.kind).toBe('rule');
    expect(rule?.spans).toEqual([
      { from: 0, to: 2, role: 'dim' },
      { from: 2, to: 2 + 'Permissions · ask mode'.length, role: 'strong' },
      { from: 2 + 'Permissions · ask mode'.length, to: rule?.text.length ?? 0, role: 'dim' },
    ]);
    expect(rule?.text.startsWith('─ Permissions · ask mode ─')).toBe(true);
  });

  it('names the keys in the legend by their role: the action in danger, the confirmation in attention, the rest emphasised', () => {
    expect(SHEET_KEYS.withdraw).toMatchObject({ keys: '[d / Del]', role: 'danger' });
    expect(SHEET_KEYS.confirm).toMatchObject({ keys: '[Enter]', role: 'warn' });
    const legendLine = permissionsSheetLines(open(TWO_AND_ONE), geometry).at(-1);
    const roles = legendLine?.spans?.filter((span) => span.role !== 'dim').map((span) => span.role);
    expect(roles).toEqual(['strong', 'danger', 'strong']);
    const armed = permissionsSheetLines(armedAt(), geometry).at(-1);
    expect(armed?.spans?.filter((span) => span.role !== 'dim').map((span) => span.role)).toEqual([
      'warn',
      'strong',
    ]);
  });

  it('keeps the sheet one height as the cursor moves through a long list, so the rule does not move under it', () => {
    const shapesToHold: readonly PermissionsSnapshot[] = [
      projectOnly(Array.from({ length: 30 }, (_, i) => project(`g${String(i)}`))),
      snapshot(
        Array.from({ length: 5 }, (_, i) => project(`g${String(i)}`)),
        [session('a'), session('b')],
      ),
      snapshot(
        Array.from({ length: 14 }, (_, i) => project(`g${String(i)}`)),
        Array.from({ length: 5 }, (_, i) => session(`cmd${String(i)}`)),
      ),
    ];
    for (const snap of shapesToHold) {
      const surface = snap.session === undefined ? 'project' : 'chat';
      const total = sheetEntries(snap).length;
      const heights = new Set<number>();
      for (let cursor = 0; cursor < total; cursor += 1)
        heights.add(permissionsSheetLines({ ...open(snap, surface), cursor }, geometry).length);
      // one height, and the whole budget: the rule, eight body lines, the note, the message row and the legend (twelve rows at 80x24)
      expect([...heights], `${String(total)} rows`).toEqual([12]);
    }
  });

  it('every navigation key says the person is choosing a row, and a refused `d` is typing (round 3, F3)', () => {
    for (const key of [
      { upArrow: true },
      { downArrow: true },
      { home: true },
      { end: true },
      { pageUp: true },
      { pageDown: true },
    ] as const) {
      const typed = { ...open(TWO_AND_ONE), typed: true };
      expect(stateOf(press(typed, '', key)).typed, JSON.stringify(key)).toBe(false);
    }
    // a `d` that could not arm (the frame is too small to ask) or had nothing to arm is typing: the next `d` must not arm until an arrow key
    const small = stateOf(press(open(TWO_AND_ONE), 'd', {}, SETTLED, false));
    expect(small.typed).toBe(true);
    expect(stateOf(press(small, 'd', {}, SETTLED + 1)).armed).toBe(false);
    const nothing = stateOf(press(open(snapshot([], [])), 'd'));
    expect(nothing.typed).toBe(true);
    // ...and a `d` after an arrow key arms again
    const chosen = stateOf(press(small, '', ARROW_DOWN, SETTLED + 2));
    expect(stateOf(press(chosen, 'd', {}, SETTLED + 3)).armed).toBe(true);
  });

  it('while a question is up, a key that is neither Esc nor a navigation key is typing: the next `d` is refused after the one and arms after the other', () => {
    const afterKey = stateOf(press(armedAt(), 'x', {}, CONFIRM_AT));
    expect(afterKey.armed).toBe(false);
    expect(afterKey.typed).toBe(true);
    expect(stateOf(press(afterKey, 'd', {}, CONFIRM_AT + 10)).armed).toBe(false);
    const afterEsc = stateOf(press(armedAt(), '', ESC, CONFIRM_AT));
    expect(afterEsc.armed).toBe(false);
    expect(afterEsc.typed).toBe(false);
    expect(stateOf(press(afterEsc, 'd', {}, CONFIRM_AT + 10)).armed).toBe(true);
  });

  it('while a question is up, a navigation key drops it and is not typing: the `d` after it arms again (review V6a-08, ADR-0137 §2)', () => {
    for (const key of [
      ARROW_DOWN,
      ARROW_UP,
      { pageUp: true },
      { pageDown: true },
      { home: true },
      { end: true },
    ] as const) {
      const armed = armedAt();
      const dropped = stateOf(press(armed, '', key, CONFIRM_AT));
      expect(dropped.armed, JSON.stringify(key)).toBe(false);
      expect(dropped.typed, JSON.stringify(key)).toBe(false);
      expect(dropped.cursor, 'it keeps the row, as every other key does').toBe(armed.cursor);
      const again = stateOf(press(dropped, 'd', {}, CONFIRM_AT + 10));
      expect(again.armed, `d after ${JSON.stringify(key)}`).toBe(true);
      expect(again.message).toBeUndefined();
    }
    // The whole sequence from the review: `d`, `↓`, `d`, then an Enter after the dwell withdraws the row the question names.
    const second = stateOf(
      press(stateOf(press(armedAt(), '', ARROW_DOWN, CONFIRM_AT)), 'd', {}, CONFIRM_AT + 10),
    );
    const step = press(second, '', ENTER, second.armedAt + SHEET_CONFIRM_DWELL_MS);
    expect(step.kind).toBe('withdraw');
  });

  it('...and that is the ONLY exception: after any other key the next `d` is refused with the typed-keys note', () => {
    for (const [input, key] of [
      ['x', {}],
      ['d', {}],
      ['', { tab: true }],
      ['', { backspace: true }],
    ] as const) {
      const dropped = stateOf(press(armedAt(), input, key, CONFIRM_AT));
      expect(dropped.typed, JSON.stringify([input, key])).toBe(true);
      const refused = stateOf(press(dropped, 'd', {}, CONFIRM_AT + 10));
      expect(refused.armed).toBe(false);
      expect(refused.message).toEqual(note(SHEET_TYPED_NOTE));
    }
  });

  it('a stream of letters, navigation keys, `d` and Enter at any pace behaves as the rule says, and withdraws only a row the person armed after choosing', () => {
    // An independent statement of ADR-0137 §2: a key that is not navigation is typing, navigation clears it, `d` arms only when
    // nothing was typed and the sheet has settled, and only an Enter after a `d` that armed, inside the window, withdraws.
    let seed = 7654321;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const alphabet: readonly (readonly [string, Parameters<typeof foldPermissionsSheetKey>[1]])[] =
      [
        ['a', {}],
        ['x', {}],
        [' ', {}],
        ['d', {}],
        ['d', {}],
        ['', { backspace: true }],
        ['', ARROW_DOWN],
        ['', ARROW_UP],
        ['', { pageDown: true }],
        ['', { home: true }],
        ['', ENTER],
        ['', ENTER],
        ['', { tab: true }],
      ];
    let withdrawals = 0;
    let rearmed = 0;
    for (let run = 0; run < 3_000; run += 1) {
      let state = open(TWO_AND_ONE);
      let typed = false;
      let armed = false;
      let askedAt = 0;
      let at = T0 + Math.floor(next() * 600);
      const pace = [5, 40, 110, 250, 700, 2_000][Math.floor(next() * 6)] ?? 110;
      const length = 2 + Math.floor(next() * 12);
      for (let index = 0; index < length; index += 1) {
        const [input, key] = alphabet[Math.floor(next() * alphabet.length)] ?? ['a', {}];
        at += Math.floor(pace * (0.5 + next()));
        const isNavigation =
          key.upArrow === true ||
          key.downArrow === true ||
          key.pageDown === true ||
          key.home === true;
        const isWithdrawKey = input === 'd' || key.backspace === true;
        let expectWithdraw = false;
        if (armed) {
          if (key.return === true) {
            const held = at - askedAt;
            expectWithdraw = held >= SHEET_CONFIRM_DWELL_MS && held <= SHEET_CONFIRM_WINDOW_MS;
          } else if (!isNavigation) typed = true;
          armed = false;
        } else if (isNavigation) typed = false;
        else if (isWithdrawKey) {
          if (!typed && at - T0 >= SHEET_SETTLE_MS) {
            armed = true;
            askedAt = at;
            if (index > 0) rearmed += 1;
          }
        } else typed = true;
        const step = press(state, input, key, at);
        const label = `run ${String(run)} key ${String(index)} ${JSON.stringify([input, key])}`;
        if (step.kind === 'close') throw new Error(`${label}: closed`);
        expect(step.kind === 'withdraw', label).toBe(expectWithdraw);
        if (expectWithdraw) withdrawals += 1;
        state = step.state;
        expect(state.armed, label).toBe(armed);
        expect(state.typed, label).toBe(typed);
      }
    }
    // The stream really reached both outcomes and the case the review found (a `d` that armed after a navigation key).
    expect(withdrawals).toBeGreaterThan(20);
    expect(rearmed).toBeGreaterThan(200);
  });

  it('a hasty Enter and a withdrawal are not typing: the `d` that follows arms again, as the sheet’s own note says to press it (round 3, F1)', () => {
    const armed = armedAt();
    const hasty = stateOf(press(armed, '', ENTER, armed.armedAt + 100));
    expect(hasty.message).toEqual(note(SHEET_ENTER_NOTE));
    expect(hasty.typed).toBe(false);
    expect(stateOf(press(hasty, 'd', {}, armed.armedAt + 200)).armed).toBe(true);
    const step = press(armed, '', ENTER, CONFIRM_AT);
    if (step.kind !== 'withdraw') throw new Error('expected a withdrawal');
    expect(step.state.typed).toBe(false);
    // after the host reloads the sheet, the next `d` arms the next row without an arrow detour
    const reloaded = reloadPermissionsSheet(step.state, TWO_AND_ONE, DONE);
    expect(stateOf(press(reloaded, 'd', {}, CONFIRM_AT + 50)).armed).toBe(true);
  });

  it('a command that imitates the sheet’s own keys is an ordinary row: it carries no chip, no role and no extra line (§5 amendment)', () => {
    const hostile = snapshot(
      [],
      [session('echo [d] withdraw [Enter] withdraw'), session('git status')],
    );
    const lines = permissionsSheetLines({ ...open(hostile), cursor: 1 }, geometry);
    const imitation = lines.find((line) => line.text.includes('echo [d]'));
    expect(imitation?.kind).toBe('row');
    expect(imitation?.spans ?? []).toEqual([]);
    expect(imitation?.text.startsWith('  echo ')).toBe(true);
    // the only chip is the selected row's, at its right edge
    expect(lines.filter((line) => line.spans?.some((span) => span.role === 'danger'))).toHaveLength(
      3,
    );
    expect(lines.filter((line) => line.kind === 'selected')).toHaveLength(1);
  });

  it('never carries a span outside its line, over every state it can draw', () => {
    const snaps = [TWO_AND_ONE, snapshot([], []), projectOnly([project('a')])];
    for (const snap of snaps) {
      for (const armed of [false, true]) {
        for (const cols of [80, 100, 140]) {
          for (let cursor = 0; cursor < Math.max(1, sheetEntries(snap).length); cursor += 1) {
            const state = {
              ...open(snap, snap.session === undefined ? 'project' : 'chat'),
              cursor,
              armed,
            };
            for (const line of permissionsSheetLines(state, { columns: cols, terminalRows: 30 })) {
              for (const span of line.spans ?? []) {
                expect(span.from, line.text).toBeGreaterThanOrEqual(0);
                expect(span.to, line.text).toBeLessThanOrEqual(line.text.length);
                expect(span.from, line.text).toBeLessThan(span.to);
              }
            }
          }
        }
      }
    }
  });
});
