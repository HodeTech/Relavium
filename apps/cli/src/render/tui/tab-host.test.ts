/**
 * The tab host's pure model ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §1, §3): the tab registry, every key its legend names, the `Esc` and `Ctrl+C` ladder, `Backspace` on Permissions (the sheet's withdraw key,
 * not a way back), what each tab remembers, the lines it fits in 23 rows, and the allowlist section. No ink, no controller and no real
 * clock: the port is a fake and the time is a number the test moves.
 *
 * `home-tab-host.test.ts` owns the controller's use of it (the slot, the reset on close, the run view opened from it, the exits) and
 * `permissions-tab-reentry.test.ts` the fresh read on entering a tab; this file owns the decisions that need neither.
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  PermissionEntry,
  PermissionsPort,
  PermissionsSnapshot,
  RepoAllowlist,
  WithdrawAnswer,
} from '../../permissions/chat-permissions.js';
import type { ChatKey } from './chat-input.js';
import {
  SHEET_CONFIRM_DWELL_MS,
  SHEET_ENTER_NOTE,
  SHEET_SETTLE_MS,
  sheetEntries,
} from './permissions-sheet.js';
import { usableColumns, type SheetLine } from './sheet-frame.js';
import { HISTORY_UNREADABLE } from './tab-host-history.js';
import {
  TABS,
  TAB_HOST_KEYS,
  TAB_HOST_ROWS,
  disarmTabHost,
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  tabHostLegendItems,
  tabHostLines,
  tabHostMemory,
  type TabHostContext,
  type TabHostState,
  type TabHostStep,
  type TabId,
} from './tab-host.js';
import { displayWidth } from './viewport.js';

const ENTER: ChatKey = { return: true };
const ESC: ChatKey = { escape: true };

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `g${String(index)}`,
    label: `tool${String(index)}, 1 argument`,
    remembered: '2026-11-19 12:00Z',
  }));

const snapshotOf = (count: number, allowlist?: RepoAllowlist): PermissionsSnapshot => ({
  project: { ok: true, rows: rows(count) },
  session: undefined,
  ...(allowlist === undefined ? {} : { allowlist }),
});

/** A port over a snapshot the test can replace, that counts its reads and records its withdrawals. */
function fakePort(initial: PermissionsSnapshot) {
  let current = initial;
  const loads = vi.fn(() => current);
  const withdraw = vi.fn((entry: PermissionEntry): WithdrawAnswer => {
    if (entry.kind === 'project' && current.project.ok)
      current = {
        ...current,
        project: { ok: true, rows: current.project.rows.filter((row) => row.id !== entry.row.id) },
      };
    return { tone: 'done', text: 'Withdrawn. Auto mode asks about it again.' };
  });
  const port: PermissionsPort = { surface: 'project', load: loads, withdraw };
  return {
    port,
    loads,
    withdraw,
    set: (next: PermissionsSnapshot): void => {
      current = next;
    },
  };
}

/** A tab host and the time it is read at; the clock only moves when the test says so. */
function rig(initial: PermissionsSnapshot = snapshotOf(3), tab: TabId = 'permissions') {
  const fake = fakePort(initial);
  let now = 10_000;
  const entry = () => ({ port: fake.port, now });
  const context = (over: Partial<TabHostContext> = {}): TabHostContext => ({
    ...entry(),
    canArm: true,
    ...over,
  });
  let state: TabHostState = enterTab(freshTabMemory(tab), tab, entry());
  /** One key; the state follows it unless the step closed the screen. Returns the step. */
  const press = (
    input: string,
    key: ChatKey = {},
    over: Partial<TabHostContext> = {},
  ): TabHostStep => {
    const step = foldTabHostKey(state, input, key, context(over));
    if (step.kind === 'state') state = step.state;
    return step;
  };
  return {
    ...fake,
    press,
    get state(): TabHostState {
      return state;
    },
    set state(next: TabHostState) {
      state = next;
    },
    advance: (ms: number): void => {
      now += ms;
    },
    /** The time the next key is read at. */
    get now(): number {
      return now;
    },
    entry,
    context,
  };
}

const sheetOf = (state: TabHostState) => {
  if (state.sheet === undefined) throw new Error('the Permissions tab holds no sheet');
  return state.sheet;
};

describe('the tab registry', () => {
  it('is Defined, Active, History and Permissions, in that order, the last being the real one', () => {
    expect(TABS.map((tab) => tab.id)).toEqual(['defined', 'active', 'history', 'permissions']);
    expect(TABS.map((tab) => tab.title)).toEqual(['Defined', 'Active', 'History', 'Permissions']);
  });

  it('says History cannot be read when nothing feeds it, and reads no port for it', () => {
    const r = rig(snapshotOf(2), 'history');
    const text = tabHostLines(r.state, { columns: 80, terminalRows: 24 }).map((line) => line.text);
    expect(text).toContain(HISTORY_UNREADABLE);
    expect(text.join('\n')).not.toContain('available in the next increment');
    expect(r.state.sheet, 'nothing to withdraw on History').toBeUndefined();
    expect(r.loads, 'the port is the Permissions tab’s').not.toHaveBeenCalled();
  });

  it('Active, with nothing to read it from, says it cannot be read, and reads no port', () => {
    const r = rig(snapshotOf(2), 'active');
    const text = tabHostLines(r.state, { columns: 80, terminalRows: 24 }).map((line) => line.text);
    expect(text).toContain('The active runs could not be read.');
    expect(r.state.sheet).toBeUndefined();
    expect(r.loads).not.toHaveBeenCalled();
  });
});

describe('entering a tab', () => {
  it('reads the port now, opens a project sheet at the top, and keeps nothing of an earlier read', () => {
    const r = rig();
    expect(r.loads).toHaveBeenCalledTimes(1);
    expect(r.state.tab).toBe('permissions');
    expect(sheetOf(r.state).surface).toBe('project');
    expect(sheetOf(r.state).cursor).toBe(0);
    expect(r.state.unreadable).toBe(false);
  });

  it('says the tab is unreadable, and holds no sheet, when the port throws or there is no port at all', () => {
    const throwing: PermissionsPort = {
      surface: 'project',
      load: () => {
        throw new Error('boom');
      },
      withdraw: vi.fn(),
    };
    const failed = enterTab(freshTabMemory(), 'permissions', { port: throwing, now: 1 });
    expect(failed.unreadable).toBe(true);
    expect(failed.sheet).toBeUndefined();
    const none = enterTab(freshTabMemory(), 'permissions', { port: undefined, now: 1 });
    expect(none.unreadable).toBe(true);
    const text = tabHostLines(failed, { columns: 80, terminalRows: 24 }).map((line) => line.text);
    expect(text).toContain('Could not read the permissions.');
    expect(text.at(-1), 'the way out is still the last line').toContain('Esc close');
  });

  it('puts the cursor where the tab left it, clamped to the rows there are now', () => {
    const memory = {
      tab: 'permissions' as const,
      positions: { ...freshTabMemory().positions, permissions: 7 },
    };
    const r = rig(snapshotOf(3));
    expect(enterTab(memory, 'permissions', r.entry()).sheet?.cursor, 'three rows: the last').toBe(
      2,
    );
    expect(
      enterTab(memory, 'permissions', { port: fakePort(snapshotOf(0)).port, now: 1 }).sheet?.cursor,
    ).toBe(0);
  });
});

/** The presses that make each key of a legend do what its verb says, and what the state must show afterwards. */
describe('every key the legend names, pressed', () => {
  type Rig = ReturnType<typeof rig>;
  /** Keyed by what the legend prints for the item (`keys verb`): a legend item that has no entry here fails the test that reads it. */
  const PRESSES: Readonly<Record<string, (r: Rig) => void>> = {
    [`${TAB_HOST_KEYS.tab.keys} ${TAB_HOST_KEYS.tab.verb}`]: (r) => {
      const before = r.state.tab;
      r.press('', { leftArrow: true });
      expect(r.state.tab, '← moves to the tab before').toBe(
        TABS[Math.max(0, TABS.findIndex((tab) => tab.id === before) - 1)]?.id,
      );
      r.press('', { rightArrow: true });
      expect(r.state.tab, '→ moves back').toBe(before);
    },
    [`${TAB_HOST_KEYS.cycle.keys} ${TAB_HOST_KEYS.cycle.verb}`]: (r) => {
      const before = r.state.tab;
      r.press('', { tab: true });
      const forward = TABS[(TABS.findIndex((tab) => tab.id === before) + 1) % TABS.length]?.id;
      expect(r.state.tab, 'Tab goes to the next tab, around the end').toBe(forward);
      r.press('', { tab: true, shift: true });
      expect(r.state.tab, 'Shift+Tab goes back').toBe(before);
    },
    '↑/↓ select': (r) => {
      r.press('', { downArrow: true });
      expect(sheetOf(r.state).cursor, '↓ selects the next row').toBe(1);
      r.press('', { upArrow: true });
      expect(sheetOf(r.state).cursor, '↑ selects the one before').toBe(0);
    },
    '[d / Del] withdraw': (r) => {
      r.advance(SHEET_SETTLE_MS + 100);
      r.press('d');
      expect(sheetOf(r.state).armed, 'd asks').toBe(true);
      r.press('', ESC);
      r.press('', { delete: true });
      expect(sheetOf(r.state).armed, 'Del asks too').toBe(true);
    },
    '[Enter] withdraw': (r) => {
      r.advance(SHEET_DWELL_AFTER_ASK);
      r.press('', ENTER);
      expect(r.withdraw, 'Enter withdraws the selected row').toHaveBeenCalledTimes(1);
      expect(r.withdraw.mock.calls[0]?.[0]).toMatchObject({ kind: 'project', row: { id: 'g0' } });
    },
    [`${TAB_HOST_KEYS.close.keys} ${TAB_HOST_KEYS.close.verb}`]: (r) => {
      expect(r.press('', ESC).kind, 'Esc closes').toBe('close');
    },
    'Esc keep': (r) => {
      expect(r.press('', ESC).kind, 'Esc keeps the screen').toBe('state');
      expect(sheetOf(r.state).armed, 'and drops the question').toBe(false);
      expect(r.withdraw, 'and withdraws nothing').not.toHaveBeenCalled();
    },
  };
  const SHEET_DWELL_AFTER_ASK = SHEET_CONFIRM_DWELL_MS;

  const asked = (): Rig => {
    const r = rig();
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('d');
    return r;
  };

  it.each([
    [
      'Permissions with rows',
      () => rig(snapshotOf(3)),
      '←/→ tab,Tab cycle,↑/↓ select,[d / Del] withdraw,Esc close',
    ],
    [
      'an unreadable History tab',
      () => rig(snapshotOf(3), 'history'),
      '←/→ tab,Tab cycle,Esc close',
    ],
    ['Permissions with nothing to select', () => rig(snapshotOf(0)), '←/→ tab,Tab cycle,Esc close'],
    ['Permissions while a withdrawal waits', asked, '[Enter] withdraw,Esc keep'],
  ] as const)(
    '%s: each key named does what it says, and the leaving key is last',
    (_name, make, named) => {
      const items = tabHostLegendItems(make().state);
      const labels = items.map((item) => `${item.keys} ${item.verb}`);
      expect(labels.join(',')).toBe(named);
      for (const label of labels) {
        const press = PRESSES[label];
        if (press === undefined)
          throw new Error(`the legend names "${label}", which no test presses`);
        press(make());
      }
    },
  );

  it('names no key the model does not answer to: an Enter on a row opens nothing and withdraws nothing, and the legend does not offer it', () => {
    const r = rig();
    const names = tabHostLegendItems(r.state).map((item) => item.keys);
    expect(names).not.toContain('Enter');
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('', ENTER);
    expect(r.withdraw).not.toHaveBeenCalled();
    expect(r.state.tab).toBe('permissions');
  });
});

describe('moving between tabs', () => {
  it('stops at the ends with ← and →, and goes around with Tab and Shift+Tab', () => {
    const r = rig(snapshotOf(3), 'defined');
    r.press('', { leftArrow: true });
    expect(r.state.tab, '← at the first tab stays').toBe('defined');
    r.press('', { tab: true, shift: true });
    expect(r.state.tab, 'Shift+Tab at the first goes round to the last').toBe('permissions');
    r.press('', { rightArrow: true });
    expect(r.state.tab, '→ at the last stays').toBe('permissions');
    r.press('', { tab: true });
    expect(r.state.tab, 'Tab at the last goes round to the first').toBe('defined');
  });

  it('ignores a tab key that carries Ctrl or Alt: those are other chords', () => {
    const r = rig(snapshotOf(3), 'active');
    r.press('', { rightArrow: true, ctrl: true });
    r.press('', { leftArrow: true, meta: true });
    r.press('', { tab: true, ctrl: true });
    expect(r.state.tab).toBe('active');
  });

  it('leaves the other tabs alone: a key that is not theirs does nothing on an unreadable tab', () => {
    const r = rig(snapshotOf(3), 'active');
    const before = r.state;
    for (const press of [
      () => r.press('x'),
      () => r.press('', ENTER),
      () => r.press('', { downArrow: true }),
      () => r.press('', { pageDown: true }),
    ])
      expect(press().kind).toBe('state');
    expect(r.state).toBe(before);
  });
});

describe('Esc and Ctrl+C (ADR-0140 §1)', () => {
  it('Esc closes an unreadable tab and an unarmed Permissions tab; the Esc ladder of the sheet drops the question first', () => {
    expect(rig(snapshotOf(1), 'defined').press('', ESC).kind).toBe('close');
    expect(rig().press('', ESC).kind).toBe('close');
    const r = rig();
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('d');
    expect(sheetOf(r.state).armed).toBe(true);
    expect(r.press('', ESC).kind, 'the first Esc keeps the screen and drops the question').toBe(
      'state',
    );
    expect(sheetOf(r.state).armed).toBe(false);
    expect(r.press('', ESC).kind, 'the second closes').toBe('close');
    expect(r.withdraw, 'neither withdrew anything').not.toHaveBeenCalled();
  });

  it('Ctrl+C closes from every tab and from a waiting question, and never withdraws', () => {
    for (const tab of ['defined', 'active', 'history', 'permissions'] as const) {
      expect(rig(snapshotOf(2), tab).press('c', { ctrl: true }).kind, tab).toBe('close');
    }
    const r = rig();
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('d');
    r.advance(SHEET_CONFIRM_DWELL_MS);
    const step = r.press('c', { ctrl: true });
    expect(step).toEqual({ kind: 'close' });
    expect(r.withdraw).not.toHaveBeenCalled();
  });

  it('a tab key does not move a tab while a question is up: it drops the question and the tab stays', () => {
    const r = rig();
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('d');
    r.press('', { leftArrow: true });
    expect(r.state.tab, 'a key typed ahead moves nothing').toBe('permissions');
    expect(sheetOf(r.state).armed).toBe(false);
    // the key that dropped the question counted as typing: an arrow key says the person is choosing a row again
    r.press('', { downArrow: true });
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('d');
    expect(sheetOf(r.state).armed).toBe(true);
    r.press('', { tab: true });
    expect(r.state.tab, 'Tab typed ahead moves nothing either').toBe('permissions');
    expect(sheetOf(r.state).armed).toBe(false);
  });

  it('an Enter outside the question’s window withdraws nothing and says so, as the sheet does', () => {
    const r = rig();
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('d');
    r.press('', ENTER); // at once: too early
    expect(r.withdraw).not.toHaveBeenCalled();
    expect(sheetOf(r.state).message).toEqual({ tone: 'note', text: SHEET_ENTER_NOTE });
  });

  it('a withdrawal that cannot read the list again closes the screen with the sheet’s sentence', () => {
    const r = rig();
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('d');
    r.advance(SHEET_CONFIRM_DWELL_MS);
    r.loads.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const step = r.press('', ENTER);
    expect(step.kind).toBe('close');
    expect(step.kind === 'close' ? step.note : undefined).toMatch(
      /Could not read the permissions again\.$/u,
    );
  });

  it('a port that is gone closes the screen instead of freezing the keyboard', () => {
    const r = rig();
    expect(foldTabHostKey(r.state, 'x', {}, { port: undefined, canArm: true, now: 1 })).toEqual({
      kind: 'close',
    });
  });
});

describe('Backspace on the Permissions tab (the maintainer’s ruling for this increment)', () => {
  it('is the sheet’s own withdraw key, as Delete is: it asks, and Enter withdraws; it does not go back', () => {
    const r = rig();
    r.advance(SHEET_SETTLE_MS + 100);
    const step = r.press('', { backspace: true });
    expect(step.kind, 'it does not close the screen').toBe('state');
    expect(sheetOf(r.state).armed, 'it asks').toBe(true);
    r.advance(SHEET_CONFIRM_DWELL_MS);
    r.press('', ENTER);
    expect(r.withdraw).toHaveBeenCalledTimes(1);
    expect(r.withdraw.mock.calls[0]?.[0]).toMatchObject({ kind: 'project', row: { id: 'g0' } });
  });

  it('asks nothing of a sheet that is not settled or that has been typed into, exactly as in the sheet', () => {
    const r = rig();
    r.press('', { backspace: true });
    expect(sheetOf(r.state).armed, 'too soon').toBe(false);
    expect(sheetOf(r.state).message?.text).toBe('Wait a moment, then press d.');
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('x');
    r.press('', { backspace: true });
    expect(sheetOf(r.state).armed, 'typed first').toBe(false);
  });

  it('does nothing on an unreadable tab, where there is no list to withdraw from and no level to go back from', () => {
    const r = rig(snapshotOf(3), 'history');
    const step = r.press('', { backspace: true });
    expect(step.kind).toBe('state');
    expect(r.state.tab).toBe('history');
    expect(r.withdraw).not.toHaveBeenCalled();
  });
});

describe('what a tab remembers', () => {
  it('keeps the cursor of Permissions while another tab is in front, and puts it back, reading the list again', () => {
    const r = rig(snapshotOf(5));
    r.press('', { downArrow: true });
    r.press('', { downArrow: true });
    expect(sheetOf(r.state).cursor).toBe(2);
    r.press('', { leftArrow: true });
    expect(r.state.tab).toBe('history');
    expect(r.state.sheet, 'nothing of the list is held while it is away').toBeUndefined();
    expect(r.state.positions.permissions, 'but where it stood is').toBe(2);
    expect(r.loads, 'and nothing was read for an unreadable tab').toHaveBeenCalledTimes(1);
    r.press('', { rightArrow: true });
    expect(r.loads, 'entered again: read again').toHaveBeenCalledTimes(2);
    expect(sheetOf(r.state).cursor).toBe(2);
  });

  it('a tab entered again starts as a new sheet does: the settle time counts again, and nothing typed before counts', () => {
    const r = rig(snapshotOf(3));
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('x'); // typed: `d` would ask nothing now
    r.press('', { leftArrow: true });
    r.press('', { rightArrow: true });
    expect(sheetOf(r.state).typed).toBe(false);
    r.press('d');
    expect(sheetOf(r.state).armed, 'too soon after entering').toBe(false);
    expect(sheetOf(r.state).message?.text).toBe('Wait a moment, then press d.');
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('d');
    expect(sheetOf(r.state).armed).toBe(true);
  });

  it('the memory of a state is its tab and every position, the current tab’s own included', () => {
    const r = rig(snapshotOf(5));
    r.press('', { downArrow: true });
    expect(tabHostMemory(r.state)).toEqual({
      tab: 'permissions',
      positions: { defined: 0, active: 0, history: 0, permissions: 1 },
    });
    r.press('', { tab: true });
    expect(tabHostMemory(r.state).tab).toBe('defined');
    expect(tabHostMemory(r.state).positions.permissions).toBe(1);
  });

  it('clamps a remembered cursor to the rows that are there when the tab is entered again', () => {
    const r = rig(snapshotOf(5));
    for (let i = 0; i < 4; i += 1) r.press('', { downArrow: true });
    r.press('', { leftArrow: true });
    r.set(snapshotOf(2));
    r.press('', { rightArrow: true });
    expect(sheetOf(r.state).cursor).toBe(1);
    expect(sheetEntries(sheetOf(r.state).snapshot)).toHaveLength(2);
  });
});

describe('a paste', () => {
  it('drops a waiting question and withdraws nothing, and is the same state when nothing was waiting on a tab with no sheet', () => {
    const r = rig();
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('d');
    const after = disarmTabHost(r.state);
    expect(sheetOf(after).armed).toBe(false);
    expect(sheetOf(after).typed, 'a paste is typing').toBe(true);
    expect(r.withdraw).not.toHaveBeenCalled();
    const placeholder = rig(snapshotOf(1), 'active').state;
    expect(disarmTabHost(placeholder)).toBe(placeholder);
  });
});

/** The lines a tab host draws, as text. */
const textOf = (lines: readonly SheetLine[]): string[] => lines.map((line) => line.text);

describe('what is drawn', () => {
  const SIZES = [
    [80, 24],
    [100, 30],
    [120, 50],
    [200, 100],
  ] as const;
  const bigList: RepoAllowlist = {
    ok: true,
    commands: Array.from({ length: 20 }, (_, i) => `cmd-${String(i)}`),
    globs: ['git *', 'npm run *'],
    omitted: 4,
  };

  it.each(SIZES)(
    'fits 23 rows and the width at %i×%i, with a long list and a long allowlist, on every tab',
    (columns, terminalRows) => {
      const geometry = { columns, terminalRows };
      for (const tab of TABS) {
        const r = rig(snapshotOf(40, bigList), tab.id);
        for (let step = 0; step < 6; step += 1) {
          const lines = tabHostLines(r.state, geometry);
          expect(lines.length, `${tab.id} after ${String(step)} keys`).toBeLessThanOrEqual(
            TAB_HOST_ROWS,
          );
          for (const line of lines)
            expect(displayWidth(line.text), line.text).toBeLessThanOrEqual(usableColumns(columns));
          expect(lines.at(-1)?.kind, 'the legend is the last line').toBe('legend');
          r.press('', { pageDown: true });
          r.press('', { downArrow: true });
        }
      }
      expect(TAB_HOST_ROWS).toBe(23);
    },
  );

  it('draws the tab strip first, with a glyph on the current tab, then a rule', () => {
    for (const tab of TABS) {
      const lines = tabHostLines(rig(snapshotOf(1), tab.id).state, {
        columns: 80,
        terminalRows: 24,
      });
      expect(lines[0]?.text).toContain(`▸ ${tab.title}`);
      expect(lines[0]?.text.match(/▸/gu), 'exactly one tab carries the glyph').toHaveLength(1);
      expect(lines[0]?.text.startsWith('Defined') || lines[0]?.text.startsWith('▸ Defined')).toBe(
        true,
      );
      expect(lines[1]?.kind).toBe('rule');
    }
  });

  it('draws the sheet’s own rows, cursor, note and message row on Permissions, and the tab host’s legend under them', () => {
    const lines = textOf(tabHostLines(rig(snapshotOf(2)).state, { columns: 80, terminalRows: 24 }));
    expect(lines).toContain('This project · remembered (2)');
    expect(
      lines.some((line) => line.startsWith('› tool0, 1 argument') && line.includes('[d] withdraw')),
    ).toBe(true);
    expect(lines).toContain(
      'Only auto mode runs a remembered command unasked, in a chat in this project.',
    );
    expect(lines.at(-1)).toBe('←/→ tab · Tab cycle · ↑/↓ select · [d / Del] withdraw · Esc close');
    expect(lines.join('\n'), 'no second legend and no sheet rule').not.toContain(
      'Permissions · this project',
    );
  });

  it('shows the withdrawal’s question and its legend while one is up', () => {
    const r = rig(snapshotOf(2));
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('d');
    const lines = textOf(tabHostLines(r.state, { columns: 80, terminalRows: 24 }));
    expect(lines.some((line) => line.startsWith('Withdraw tool0, 1 argument'))).toBe(true);
    expect(lines.at(-1)).toBe('[Enter] withdraw · Esc keep');
  });

  it('below 80×24 is two lines: the hint that says to enlarge, and the legend with the way out (`Esc close` at a tab’s list)', () => {
    for (const geometry of [
      { columns: 79, terminalRows: 24 },
      { columns: 80, terminalRows: 23 },
      { columns: 40, terminalRows: 10 },
    ]) {
      expect(textOf(tabHostLines(rig().state, geometry))).toEqual([
        'Enlarge the terminal — Esc steps back, or closes at the list.',
        'Esc close',
      ]);
    }
  });

  it('below 80×24 with a withdrawal’s question still up, `Esc close` is true: the question is not on screen, so the first `Esc` closes the screen and withdraws nothing', () => {
    const r = rig(snapshotOf(2));
    r.advance(SHEET_SETTLE_MS + 100);
    r.press('d');
    expect(r.state.sheet?.armed, 'the question is up').toBe(true);
    // The terminal was made smaller after the question was asked: it cannot be shown, and it is still up.
    const small = { columns: 60, terminalRows: 20 };
    expect(textOf(tabHostLines(r.state, small))).toEqual([
      'Enlarge the terminal — Esc steps back, or closes at the list.',
      'Esc close',
    ]);
    // What the legend says is what the key does there (the sheet's rule: a frame that cannot say what it asks never leaves it waiting).
    expect(r.press('', ESC, { canArm: false }).kind).toBe('close');
    expect(r.withdraw).not.toHaveBeenCalled();
    // At the floor the question is on screen, and its own legend says what `Esc` does there: it keeps the row, and the screen stays.
    const floor = rig(snapshotOf(2));
    floor.advance(SHEET_SETTLE_MS + 100);
    floor.press('d');
    expect(textOf(tabHostLines(floor.state, { columns: 80, terminalRows: 24 })).at(-1)).toBe(
      '[Enter] withdraw · Esc keep',
    );
    expect(floor.press('', ESC).kind).toBe('state');
    expect(floor.state.sheet?.armed).toBe(false);
  });

  it('draws the project list unchanged next to the sheet’s own body: the same rows, the same markers', () => {
    const r = rig(snapshotOf(30));
    for (let i = 0; i < 12; i += 1) r.press('', { downArrow: true });
    const lines = textOf(tabHostLines(r.state, { columns: 80, terminalRows: 24 }));
    expect(lines.some((line) => /^▲ \d+ more$/u.test(line))).toBe(true);
    expect(lines.some((line) => /^▼ \d+ more$/u.test(line))).toBe(true);
    expect(lines.some((line) => line.startsWith('› tool12, 1 argument'))).toBe(true);
  });
});

describe('the repository’s allowlist, read-only under the list', () => {
  const draw = (allowlist: RepoAllowlist | undefined, count = 1): string[] =>
    textOf(
      tabHostLines(rig(snapshotOf(count, allowlist)).state, { columns: 80, terminalRows: 24 }),
    );

  it('is absent where the surface lists none (a snapshot without it draws nothing of it)', () => {
    expect(draw(undefined).join('\n')).not.toContain('allowlist');
  });

  it('lists the entries and the patterns, each under its own word, with the counts, and says what the list is worth', () => {
    const lines = draw({
      ok: true,
      commands: ['git status', 'npm test'],
      globs: ['git *'],
      omitted: 0,
    });
    expect(lines).toContain('This repository · allowlist, read-only (2 commands, 1 pattern)');
    expect(lines).toContain('A listed command still asks in a chat; its card only says so.');
    expect(lines).toContain('  command git status');
    expect(lines).toContain('  command npm test');
    expect(lines).toContain('  pattern git *');
    expect(lines.some((line) => line.includes('more in the config'))).toBe(false);
  });

  it('masks an entry that is shaped like a key, command and pattern alike: the repository’s file can hold a pasted token', () => {
    const secret = `sk-ant-api03-${'K'.repeat(40)}`;
    const text = draw({
      ok: true,
      commands: [`deploy --token ${secret}`],
      globs: [`curl -H "x-api-key: ${secret}" *`],
      omitted: 0,
    }).join('\n');
    expect(text).not.toContain('sk-ant-api03');
    expect(text).not.toContain('KKKKKKKK');
    expect(text).toContain('  command deploy --token ');
    expect(text).toContain('[REDACTED]');
  });

  it('says nothing is listed for an empty allowlist, and says so for one that could not be read', () => {
    const empty = draw({ ok: true, commands: [], globs: [], omitted: 0 });
    expect(empty).toContain('This repository · allowlist, read-only (0 commands, 0 patterns)');
    expect(empty).toContain('Nothing is listed in the repository’s [chat] config.');
    const unreadable = draw({
      ok: false,
      text: 'The repository’s [chat] allowlist could not be read.',
    });
    expect(unreadable).toContain('This repository · allowlist, read-only');
    expect(unreadable).toContain('The repository’s [chat] allowlist could not be read.');
  });

  it('draws at most four entry rows, the last of them the count of the rest, and counts what the snapshot left out too', () => {
    const lines = draw({
      ok: true,
      commands: ['a', 'b', 'c', 'd', 'e'],
      globs: ['g1'],
      omitted: 7,
    });
    const entries = lines.filter((line) => /^ {2}(command|pattern) /u.test(line));
    expect(entries).toEqual(['  command a', '  command b', '  command c']);
    expect(lines).toContain('… 10 more in the config');
  });

  it('shows a control or an override character as a visible token, never as the character: the entries are the repository’s words', () => {
    const lines = draw({
      ok: true,
      commands: [`git‮push`, `rm\tx`],
      globs: [],
      omitted: 0,
    });
    const joined = lines.join('\n');
    expect(joined).not.toContain('‮');
    expect(joined).not.toContain('\t');
    expect(joined).toContain('<U+202E>');
    expect(joined).toContain('<TAB>');
  });

  it('clips a long entry to the width instead of wrapping it', () => {
    const lines = draw({ ok: true, commands: ['x'.repeat(500)], globs: [], omitted: 0 });
    const entry = lines.find((line) => line.startsWith('  command x'));
    expect(entry).toBeDefined();
    expect(displayWidth(entry ?? '')).toBeLessThanOrEqual(usableColumns(80));
    expect(entry?.endsWith('…')).toBe(true);
  });

  it('leaves the list its room: the body and the allowlist together still fit 23 rows with thirty rows and a long allowlist', () => {
    const lines = tabHostLines(
      rig(
        snapshotOf(30, { ok: true, commands: ['a', 'b', 'c', 'd', 'e'], globs: ['g'], omitted: 3 }),
      ).state,
      { columns: 80, terminalRows: 24 },
    );
    expect(lines.length).toBeLessThanOrEqual(TAB_HOST_ROWS);
    expect(textOf(lines).some((line) => line.startsWith('› tool0'))).toBe(true);
  });
});
