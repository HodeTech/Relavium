/**
 * The Runs screen's pure model ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §1, §3 and its 2026-11-27 note; [MVP-11 unit 8](../../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §5, OD-24 D2): the tab registry (Active and
 * History only: the catalogue, the agents and the permissions are popups now), moving between the two tabs, the `Esc` and `Ctrl+C` ladder, what each tab
 * remembers (the Active tab's scope too), the legend that names both keys of the way out, and the lines it fits in 23 rows. No ink, no controller and no
 * real clock: the ports are fakes and the time is a number the test moves.
 *
 * `home-tab-host.test.ts` owns the controller's use of it (the slot, the reset on close, the run view opened from it, the exits); each tab's own keys are
 * `tab-host-active.test.ts` and `tab-host-history.test.ts`; this file owns the decisions that need neither.
 */
import { describe, expect, it } from 'vitest';

import { classifyActiveRuns } from '../../history/active-model.js';
import type { ActiveRead } from '../../history/active-source.js';
import type { ChatKey } from './chat-input.js';
import { keyLabel, type LegendItem } from './legend.js';
import { usableColumns } from './sheet-frame.js';
import { ACTIVE_EMPTY, ACTIVE_KEYS } from './tab-host-active.js';
import { HISTORY_UNREADABLE } from './tab-host-history.js';
import {
  TABS,
  TAB_HOST_CLOSE_EITHER,
  TAB_HOST_KEYS,
  TAB_HOST_ROWS,
  TAB_HOST_TOO_SMALL,
  disarmTabHost,
  enterTab,
  foldTabHostKey,
  freshTabMemory,
  legendFitsTheFloor,
  tabHostCanDraw,
  tabHostLegend,
  tabHostLines,
  tabHostMemory,
  type TabHostContext,
  type TabHostState,
  type TabId,
} from './tab-host.js';
import { displayWidth } from './viewport.js';

const ENTER: ChatKey = { return: true };
const ESC: ChatKey = { escape: true };
const HERE = '/work/here';
const THERE = '/work/there';

/** One legend entry as the screen prints it (`keys verb`, the keys by the bracket rule of ADR-0145 §3). */
const printed = (item: LegendItem): string =>
  'keys' in item ? `${keyLabel(item.keys)} ${item.verb}` : item.text;
/** Every entry the legend of `state` prints, the key that leaves last. */
const legendLabels = (state: TabHostState): string[] => {
  const { items, exit } = tabHostLegend(state);
  return [...items, exit].map(printed);
};

const base = {
  workflowId: 'wf',
  executionMode: 'local',
  triggerType: 'manual',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  createdAt: '2026-11-27T10:00:00.000Z',
  updatedAt: '2026-11-27T10:00:00.000Z',
} as const;

/** A read with one run of this directory (running in another process) and one paused in another project. */
function activeRead(): ActiveRead {
  const rows = classifyActiveRuns({
    runs: [
      { ...base, id: '11111111-0000-0000-0000-000000000001', status: 'running', projectRoot: HERE },
      { ...base, id: '22222222-0000-0000-0000-000000000002', status: 'paused', projectRoot: THERE },
    ],
    leases: new Map(),
    currentProjectRoot: HERE,
    outboxHeldRunIds: new Set(),
    nowMs: Date.parse('2026-11-27T10:00:10.000Z'),
    leaseTtlMs: 60_000,
  });
  return { rows, more: [], heldUnread: false };
}

/** The screen and the time it is read at; the clock only moves when the test says so. */
function rig(tab: TabId = 'history', last: ActiveRead | undefined = activeRead()) {
  const context = (over: Partial<TabHostContext> = {}): TabHostContext => ({
    now: 10_000,
    active: { last },
    ...over,
  });
  let state: TabHostState = enterTab(freshTabMemory(tab), tab, context());
  return {
    press: (input: string, key: ChatKey = {}) => {
      const step = foldTabHostKey(state, input, key, context());
      if (step.kind === 'state') state = step.state;
      return step;
    },
    context,
    get state(): TabHostState {
      return state;
    },
    set state(next: TabHostState) {
      state = next;
    },
  };
}

describe('the tab registry (OD-24 D2)', () => {
  it('is Active and History, in that order, and nothing else: the catalogue, the agents and the permissions left the screen', () => {
    expect(TABS.map((tab) => [tab.id, tab.title])).toEqual([
      ['active', 'Active'],
      ['history', 'History'],
    ]);
  });

  it('opens on History unless a caller names Active', () => {
    expect(freshTabMemory().tab).toBe('history');
    expect(freshTabMemory('active').tab).toBe('active');
  });

  it('says History cannot be read when nothing feeds it, and Active too, in words', () => {
    const none = enterTab(freshTabMemory('history'), 'history', { now: 0 });
    expect(
      tabHostLines(none, { columns: 80, terminalRows: 24 }).map((line) => line.text),
    ).toContain(HISTORY_UNREADABLE);
    const active = enterTab(freshTabMemory('active'), 'active', { now: 0 });
    expect(active.active?.phase).toBe('unreadable');
  });
});

describe('moving between tabs', () => {
  it('stops at the ends with ← and →, and goes around with Tab and Shift+Tab', () => {
    const r = rig('history');
    r.press('', { leftArrow: true });
    expect(r.state.tab).toBe('active');
    r.press('', { leftArrow: true });
    expect(r.state.tab).toBe('active');
    r.press('', { rightArrow: true });
    r.press('', { rightArrow: true });
    expect(r.state.tab).toBe('history');
    r.press('', { tab: true });
    expect(r.state.tab).toBe('active');
    r.press('', { tab: true, shift: true });
    expect(r.state.tab).toBe('history');
  });

  it('ignores a tab key that carries Ctrl or Alt: those are other chords', () => {
    const r = rig('history');
    r.press('', { leftArrow: true, ctrl: true });
    r.press('', { rightArrow: true, meta: true });
    expect(r.state.tab).toBe('history');
  });
});

describe('Esc and Ctrl+C (ADR-0140 §1)', () => {
  it('Esc closes the screen from a tab’s list and changes nothing', () => {
    for (const tab of ['active', 'history'] as const) {
      const r = rig(tab);
      expect(r.press('', ESC)).toEqual({ kind: 'close' });
    }
  });

  it('Ctrl+C closes the screen from every tab', () => {
    for (const tab of ['active', 'history'] as const) {
      const r = rig(tab);
      expect(r.press('c', { ctrl: true })).toEqual({ kind: 'close' });
    }
  });

  it('a paste is typing, and nothing the screen answers to: the same state back', () => {
    const r = rig('active');
    expect(disarmTabHost(r.state)).toBe(r.state);
  });
});

describe('what a tab remembers', () => {
  it('the memory of a state is its tab and every position, the current tab’s own included', () => {
    const r = rig('active');
    r.press('', { downArrow: true });
    const memory = tabHostMemory(r.state);
    expect(memory.tab).toBe('active');
    expect(memory.positions.active).toBe(r.state.active?.cursor);
  });

  it('the Active tab remembers its scope: `[a] all` is kept while History is in front, and comes back as it was left', () => {
    const r = rig('active');
    expect(r.state.active?.scope).toBe('project');
    r.press('a');
    expect(r.state.active?.scope).toBe('all');
    // Leave for History and come back: the scope is the one the tab was left in.
    r.press('', { rightArrow: true });
    expect(r.state.tab).toBe('history');
    expect(tabHostMemory(r.state).activeScope).toBe('all');
    r.press('', { leftArrow: true });
    expect(r.state.active?.scope).toBe('all');
  });

  it('the default scope is not stored: a screen that never widened it remembers none', () => {
    const r = rig('active');
    expect(tabHostMemory(r.state).activeScope).toBeUndefined();
  });
});

describe('the legend that names both keys of the way out', () => {
  it('fits the 80-column floor up to its last usable column, and not past it', () => {
    const floor = usableColumns(80);
    expect(legendFitsTheFloor(floor)).toBe(true);
    expect(legendFitsTheFloor(floor + 1)).toBe(false);
  });

  it('names Esc and Ctrl+C as one item on a list where the whole fits the floor, and says where it goes: back to Home', () => {
    const r = rig('active');
    const labels = legendLabels(r.state);
    expect(labels.at(-1)).toBe(printed(TAB_HOST_CLOSE_EITHER));
    expect(labels.at(-1)).toMatch(/back to Home$/u);
    expect(displayWidth(labels.join(' · '))).toBeLessThanOrEqual(usableColumns(80) + 8);
  });

  it('names `Tab` nowhere: with two tabs `←/→ tab` says it, and the room goes to the keys of the tab', () => {
    for (const tab of ['active', 'history'] as const) {
      const labels = legendLabels(rig(tab).state);
      expect(labels).toContain(printed(TAB_HOST_KEYS.tab));
      expect(labels.join(' ')).not.toContain('Tab cycle');
    }
  });

  it('offers `[a] all` on both lists while they are this directory’s, and `[a] here` after it was widened (Active)', () => {
    const r = rig('active');
    expect(legendLabels(r.state)).toContain(printed(ACTIVE_KEYS.widen));
    r.press('a');
    expect(legendLabels(r.state)).toContain(printed(ACTIVE_KEYS.narrow));
    expect(legendLabels(r.state)).not.toContain(printed(ACTIVE_KEYS.widen));
  });
});

describe('what is drawn', () => {
  const SIZES = [
    { columns: 80, terminalRows: 24 },
    { columns: 100, terminalRows: 30 },
    { columns: 132, terminalRows: 50 },
  ] as const;

  it.each(SIZES)(
    'is at most 23 rows and leaves one row of a 24-row terminal spare ($columns×$terminalRows)',
    (size) => {
      for (const tab of ['active', 'history'] as const) {
        const lines = tabHostLines(rig(tab).state, size);
        expect(lines.length).toBeLessThanOrEqual(Math.min(TAB_HOST_ROWS, size.terminalRows - 1));
      }
    },
  );

  it('draws the tab strip first, with a glyph on the current tab, then a rule', () => {
    const lines = tabHostLines(rig('history').state, { columns: 80, terminalRows: 24 });
    expect(lines[0]?.text).toMatch(/Active\s+│\s+› History/u);
    expect(lines[1]?.kind).toBe('rule');
  });

  it('lists this directory’s runs by default: the run paused in another project is not a row, and `[a]` brings it, read-only', () => {
    const r = rig('active');
    const text = (): string =>
      tabHostLines(r.state, { columns: 80, terminalRows: 24 })
        .map((line) => line.text)
        .join('\n');
    expect(text()).toContain('11111111');
    expect(text()).not.toContain('22222222');
    expect(text()).toContain('this project');
    r.press('a');
    expect(text()).toContain('22222222');
    expect(text()).toContain('all projects');
  });

  it('with nothing active here the Active tab says where to start one and how to see the other directories’', () => {
    const r = rig('active', { rows: [], more: [], heldUnread: false });
    const text = tabHostLines(r.state, { columns: 100, terminalRows: 30 })
      .map((line) => line.text)
      .join('\n');
    expect(text).toContain(ACTIVE_EMPTY);
    expect(text).toContain('Start one from the Home');
    expect(text).toContain('[a] lists every project’s');
  });

  it('below 80×24 is two lines: the hint that says to enlarge, and the legend with the way out', () => {
    const r = rig('history');
    for (const size of [
      { columns: 79, terminalRows: 24 },
      { columns: 80, terminalRows: 23 },
      { columns: 60, terminalRows: 20 },
    ]) {
      expect(tabHostCanDraw(size)).toBe(false);
      const lines = tabHostLines(r.state, size);
      expect(lines).toHaveLength(2);
      expect(lines[0]?.text).toBe(TAB_HOST_TOO_SMALL);
      expect(lines[1]?.text).toContain('Esc');
    }
    expect(tabHostCanDraw({ columns: 80, terminalRows: 24 })).toBe(true);
  });
});

describe('Enter is the list’s own', () => {
  it('on an empty Active list it opens nothing and the screen stays', () => {
    const r = rig('active', { rows: [], more: [], heldUnread: false });
    const step = r.press('', ENTER);
    expect(step.kind).toBe('state');
  });
});
