/**
 * What the tab host remembers of its tabs, through the real Home controller
 * ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §1): each tab comes back
 * as it was left after a visit to another tab, and after a run view opened from the tab host is left with `Esc`; the memory goes with the
 * screen (`closeScreen`), and the `/workflows` strip and the `/agents` strip share none of it. `tab-host-memory.test.ts` is the model;
 * the ports and the clock are scripted and no database is opened.
 */
import type { RunSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { buildAgentsModel, type AgentsModelItem } from '../../history/agents-model.js';
import { buildDefinedModel, type DefinedEntry } from '../../history/defined-model.js';
import { buildHistoryRows } from '../../history/history-model.js';
import type { HistoryRead } from '../../history/history-source.js';
import type { AgentsPort } from '../../home/agents-port.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { PermissionsPort, PermissionsSnapshot } from '../../permissions/chat-permissions.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeControllerDeps,
} from './home-controller.js';
import type { HistoryPort } from './tab-host-history.js';
import type { SessionsPort } from './tab-host-sessions.js';

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const IDLE: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const LEFT = { leftArrow: true } as const;
const RIGHT = { rightArrow: true } as const;
const DOWN = { downArrow: true } as const;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const FINISHED: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

const record = (index: number): RunSummaryRecord => {
  const at = new Date(NOW - index * 1_000).toISOString();
  return {
    id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
    workflowId: 'wf',
    status: FINISHED[index % 3] ?? 'completed',
    executionMode: 'local',
    triggerType: 'manual',
    startedAt: at,
    completedAt: at,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: at,
    updatedAt: at,
  };
};

/** This project has six finished runs; every project, twelve. */
const historyPort: HistoryPort = {
  read: (query): HistoryRead => ({
    query: { scope: query.scope, status: query.status, page: 0 },
    pinned: [],
    rows: buildHistoryRows({
      runs: Array.from({ length: query.scope === 'all' ? 12 : 6 }, (_, index) =>
        record(index),
      ).filter((run) => query.status === undefined || run.status === query.status),
      nowMs: NOW,
      pinnedRunIds: new Set(),
      workflowLabels: new Map([['wf', 'deploy']]),
    }).map((row) => ({ kind: 'run' as const, row })),
    hasPrev: false,
    hasNext: false,
  }),
  cost: () => ({ kind: 'text', text: '$0.01' }),
  loadDetail: () => Promise.resolve({ kind: 'missing' }),
};

const ENTRIES: readonly DefinedEntry[] = ['one', 'two', 'three', 'four'].map((slug) => ({
  slug,
  name: undefined,
  nodeCount: 1,
  path: `${slug}.relavium.yaml`,
  valid: true,
}));
const AGENTS: readonly AgentsModelItem[] = ['reviewer', 'writer', 'planner'].map((slug) => ({
  entry: { slug, name: `Agent ${slug}`, path: `.relavium/agents/${slug}.agent.yaml`, valid: true },
  agent: { model: 'claude-sonnet-4-6', provider: 'anthropic', system_prompt: 'You help.' },
}));
const agentsPort: AgentsPort = {
  read: () => ({
    model: buildAgentsModel(AGENTS),
    slugOf: (index) => AGENTS[index]?.entry.slug,
    pathOf: (index) => AGENTS[index]?.entry.path,
    definitionOf: () => undefined,
  }),
};
const sessionsPort: SessionsPort = {
  read: () => ({
    rows: ['a', 'b', 'c'].map((id) => ({
      id: `sess-${id}`,
      title: `Conversation ${id}`,
      agent: 'coder',
      age: '5m ago',
    })),
    more: false,
  }),
};
const SNAPSHOT: PermissionsSnapshot = {
  project: {
    ok: true,
    rows: Array.from({ length: 3 }, (_, index) => ({
      id: `g${String(index)}`,
      label: `tool${String(index)}, 1 argument`,
      remembered: '2026-11-19 12:00Z',
    })),
  },
  session: undefined,
};

function mount() {
  const permissions: PermissionsPort = {
    surface: 'project',
    load: () => SNAPSHOT,
    withdraw: () => ({ tone: 'done', text: 'Withdrawn.' }),
  };
  const deps: HomeControllerDeps = {
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: vi.fn(() => new Promise<HomeChatSession>(() => {})),
    homeStore: { read: () => EMPTY },
    permissions,
    defined: {
      read: () => ({
        model: buildDefinedModel({ entries: ENTRIES, pins: [] }),
        slugOf: (index) => ENTRIES[index]?.slug,
        pathOf: (index) => ENTRIES[index]?.path,
      }),
    },
    history: historyPort,
    agents: agentsPort,
    sessions: sessionsPort,
    hostedRuns: {
      snapshot: (): RunHostSnapshot => IDLE,
      cancel: () => true,
      close: () => Promise.resolve(),
    },
    schedule: () => () => {},
    now: () => 1_000,
    onExit: vi.fn(),
    onError: (cause) => {
      throw cause;
    },
  };
  return createHomeController(deps);
}

const hostOf = (c: HomeController) => {
  const screen = c.getSnapshot().screen;
  return screen?.kind === 'tab-host' ? screen.host : undefined;
};
const historyOf = (c: HomeController) => {
  const history = hostOf(c)?.history;
  if (history?.read === undefined) throw new Error('the History tab is in front and was read');
  return {
    scope: history.read.query.scope,
    status: history.read.query.status,
    focus: history.focus,
    cursor: history.cursor,
  };
};
const press = (c: HomeController, ...keys: readonly (string | object)[]): void => {
  for (const key of keys) {
    if (typeof key === 'string') c.handleKey(key, {});
    else c.handleKey('', key);
  }
};
/** A pasted command, submitted: a `/` typed at an empty prompt would open the palette. */
const command = async (c: HomeController, text: string): Promise<void> => {
  c.handlePaste(text);
  c.handleKey('', ENTER);
  await flush();
};

describe('a tab comes back as it was left, after a visit to another tab', () => {
  it('History: a, f, ↓, then → and ←, keeps the scope, the filter and the focused run', () => {
    const c = mount();
    expect(c.openScreen('tab-host', { tab: 'history' })).toBe(true);
    press(c, 'a', 'f', DOWN);
    const left = historyOf(c);
    expect(left).toMatchObject({ scope: 'all', cursor: 1 });
    expect(left.status).toBeDefined();
    expect(left.focus).toMatch(/^row:/u);

    press(c, RIGHT);
    expect(hostOf(c)?.tab).toBe('permissions');
    press(c, LEFT);
    expect(hostOf(c)?.tab).toBe('history');
    expect(historyOf(c)).toEqual(left);
  });

  it('History reached from the typed /workflows, as a person reaches it', async () => {
    const c = mount();
    await command(c, '/workflows');
    expect(hostOf(c)?.tab).toBe('defined');
    press(c, DOWN, DOWN, RIGHT, RIGHT);
    expect(hostOf(c)?.tab).toBe('history');
    press(c, 'a', DOWN, DOWN);
    const left = historyOf(c);
    press(c, LEFT, LEFT);
    expect(hostOf(c)?.defined?.cursor, 'Defined, entered again').toBe(2);
    press(c, RIGHT, RIGHT);
    expect(historyOf(c)).toEqual(left);
  });

  it('a run view opened from another tab and left with Esc finds History as it was left', () => {
    const c = mount();
    expect(c.openScreen('tab-host', { tab: 'history' })).toBe(true);
    press(c, 'a', DOWN);
    const left = historyOf(c);
    press(c, RIGHT);
    expect(c.openScreen('run-view', { runId: 'run-0001', from: 'tab-host' })).toBe(true);
    expect(c.getSnapshot().screen?.kind).toBe('run-view');
    press(c, ESC);
    expect(hostOf(c)?.tab, 'back on the tab it came from').toBe('permissions');
    press(c, LEFT);
    expect(historyOf(c)).toEqual(left);
  });
});

describe('the memory goes with the screen, and is not shared between the two strips', () => {
  it('closing the screen forgets it: a tab host opened again starts History at its top', async () => {
    const c = mount();
    await command(c, '/workflows');
    press(c, RIGHT, RIGHT, 'a', 'f', DOWN);
    expect(historyOf(c).scope).toBe('all');
    press(c, RIGHT);
    press(c, ESC);
    expect(c.getSnapshot().screen, 'Esc closed the screen').toBeUndefined();

    await command(c, '/workflows');
    expect(hostOf(c)?.tab).toBe('defined');
    press(c, RIGHT, RIGHT);
    expect(historyOf(c)).toMatchObject({ scope: 'project', status: undefined, cursor: 0 });
    expect(hostOf(c)?.positions).toEqual({
      defined: 0,
      active: 0,
      history: 0,
      permissions: 0,
      agents: 0,
      sessions: 0,
    });
  });

  it('the /agents strip starts at its top whatever the /workflows strip remembered, and the other way round', async () => {
    const c = mount();
    await command(c, '/workflows');
    press(c, RIGHT, RIGHT, 'a', DOWN, DOWN);
    expect(historyOf(c)).toMatchObject({ scope: 'all', cursor: 2 });
    press(c, ESC);

    await command(c, '/agents');
    expect(hostOf(c)?.tab).toBe('agents');
    expect(hostOf(c)?.agents?.cursor, 'nothing of the workflows strip is carried over').toBe(0);
    expect(hostOf(c)?.kept, 'and nothing is held for a tab of another strip').toBeUndefined();
    press(c, DOWN, DOWN, RIGHT, DOWN);
    expect(hostOf(c)?.sessions?.cursor).toBe(1);
    press(c, LEFT);
    expect(hostOf(c)?.agents?.cursor).toBe(2);
    press(c, ESC);

    await command(c, '/agents');
    expect(hostOf(c)?.agents?.cursor, 'the /agents memory went with its screen').toBe(0);
    press(c, ESC);

    await command(c, '/workflows');
    press(c, RIGHT, RIGHT);
    expect(historyOf(c)).toMatchObject({ scope: 'project', cursor: 0 });
  });
});
