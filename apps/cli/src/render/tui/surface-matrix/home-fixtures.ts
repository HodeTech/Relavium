import { createClient, createRunHistoryReader, runMigrations } from '@relavium/db';

import { classifyActiveRuns } from '../../../history/active-model.js';
import { buildAgentsModel, type AgentsModelItem } from '../../../history/agents-model.js';
import { buildDefinedModel, type DefinedEntry } from '../../../history/defined-model.js';
import { createHistorySource } from '../../../history/history-source.js';
import { createNodeDetailLoader } from '../../../history/node-detail-source.js';
import {
  FIXTURE_RUN_IDS,
  FIXTURE_SNAPSHOT,
  seedFixtureRuns,
} from '../../../history/node-run-fixture.js';
import { createRunDetailLoader } from '../../../history/run-detail-source.js';
import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../../home/home-store.js';
import type { RunGates } from '../../../home/run-gates.js';
import type { HostedLaunch, HostedLegEnd, RunHostSnapshot } from '../../../home/run-host.js';
import type { PermissionsPort } from '../../../permissions/chat-permissions.js';
import type { ParkedRunRow } from '../home-attention.js';
import type { HomeActivePort, HomeGateCardsPort } from '../home-controller.js';
import type { ApprovalGuard } from '../tool-review-model.js';
import type { AgentsPort } from '../tab-host-agents.js';
import type { HistoryPort } from '../tab-host-history.js';
import type { SessionsPort } from '../tab-host-sessions.js';
import type { DefinedPort } from '../tab-host-workflows.js';
import type { HomeSetup } from './home-host.js';

/**
 * The data the Home's surfaces read, built from the same fakes the Home's component tests use: scripted ports, no engine, no operator home.
 * The history surfaces read a real in-memory SQLite (the run-detail and node-page fixtures), so what they draw is what the product draws.
 */

export const NOW_MS = Date.parse('2026-11-23T01:00:00.000Z');
export const RUN = 'run-0001';

const run = (id: string, status: HomeRunRow['status'], slug: string): HomeRunRow => ({
  runId: `run-${id}`,
  workflowSlug: slug,
  status,
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 1_200_000,
});
const session = (n: number): HomeSessionRow => ({
  sessionId: `session-${String(n)}`,
  workingDir: `/work/${String(n)}`,
  title: `Conversation ${String(n)}`,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 300_000,
});

/** A Home with something on each strip: a failed run needing attention, two conversations, a finished run and an agent. */
export const POPULATED_SNAPSHOT: HomeSnapshot = {
  attention: { gates: [], failedRuns: [run('f1', 'failed', 'ship-it')] },
  recentSessions: [session(1), session(2)],
  recentRuns: [run('r1', 'completed', 'nightly-report')],
  recentAgents: [{ agentSlug: 'reviewer', lastUsedAt: '2026-11-22T00:00:00.000Z' }],
  unreadableRunIds: [],
  isEmpty: false,
};

/** The run host with nothing running, and with one run executing. */
export const IDLE_HOST: RunHostSnapshot = { launching: false, active: undefined, last: undefined };
export const RUNNING_HOST: RunHostSnapshot = {
  launching: false,
  active: { leg: 'start', runId: RUN, cancelling: false },
  last: undefined,
};
const PAUSED_END: HostedLegEnd = {
  leg: 'start',
  runId: RUN,
  terminal: {
    disposition: 'paused',
    safety: undefined,
    headline: `Run ${RUN} is paused at a gate.`,
    remedy: undefined,
  },
  handedOff: true,
  retirement: 'retired',
  fault: undefined,
};
export const PARKED_HOST: RunHostSnapshot = {
  launching: false,
  active: undefined,
  last: PAUSED_END,
};

export const APPROVAL_RUN: RunGates = {
  runId: RUN,
  workflowId: 'wf',
  gates: [
    {
      runId: RUN,
      gateId: 'g1',
      nodeId: 'review-step',
      gateType: 'approval',
      message: 'Ship the release?',
      accepts: ['approved', 'rejected'],
    },
  ],
  budgetGates: [],
  degraded: false,
};
/** A run parked at two gates: its card lists them, and the one under the cursor is the card's selected row. */
export const TWO_GATES_RUN: RunGates = {
  ...APPROVAL_RUN,
  gates: [
    ...APPROVAL_RUN.gates,
    {
      runId: RUN,
      gateId: 'g2',
      nodeId: 'publish-step',
      gateType: 'approval',
      message: 'Publish the notes?',
      accepts: ['approved', 'rejected'],
    },
  ],
};
export const BUDGET_RUN: RunGates = {
  runId: RUN,
  workflowId: 'wf',
  gates: [],
  budgetGates: [
    { gateId: 'b1', nodeId: 'writer', allowance: { kind: 'amount', microcents: 4_200_000 } },
  ],
  degraded: false,
};
const PARKED_ROW: ParkedRunRow = { runId: RUN, kind: 'approval', gates: 1, workflow: 'ship-it' };
const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'resume',
  runId: RUN,
  ended: new Promise(() => undefined),
};
/** Every guard layer off: the matrix reads what is drawn, not how long a key is held back. */
const GUARD_OFF: ApprovalGuard = { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 };

/** The Home with one parked run (a gate or a budget one): its Attention row, and the card the row opens. */
export function parkedRunSetup(gates: RunGates, kind: ParkedRunRow['kind']): HomeSetup {
  const gateCards: HomeGateCardsPort = {
    list: () => [{ ...PARKED_ROW, kind }],
    read: (runId) => (runId === RUN ? gates : undefined),
    resume: () => Promise.resolve(STARTED),
    guard: GUARD_OFF,
  };
  return {
    snapshot: POPULATED_SNAPSHOT,
    deps: {
      gateCards,
      hostedRuns: {
        snapshot: () => PARKED_HOST,
        cancel: () => false,
        close: () => Promise.resolve(),
      },
    },
  };
}

/** The Defined tab over two workflows, one pinned and one file that does not parse. */
export const DEFINED_PORT: DefinedPort = {
  read: () => {
    const entries: readonly DefinedEntry[] = [
      { slug: 'alpha', name: 'Alpha', nodeCount: 3, path: 'a.yaml', valid: true },
      { slug: 'beta', name: undefined, nodeCount: 1, path: 'b.yaml', valid: true },
      { slug: 'torn', name: undefined, path: 't.yaml', valid: false, error: 'not a workflow' },
    ];
    return {
      model: buildDefinedModel({
        entries,
        pins: [{ kind: 'workflow', ref: 'beta', rowid: 1, oversized: false }],
      }),
      slugOf: (index) => entries[index]?.slug,
      pathOf: (index) => entries[index]?.path,
    };
  },
};

const AGENT_ITEMS: readonly AgentsModelItem[] = [
  {
    entry: { slug: 'reviewer', name: 'Reviewer', path: 'agents/reviewer.yaml', valid: true },
    agent: {
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      system_prompt: 'You review a diff and report what is wrong with it.',
      tools: ['read_file', 'search_files'],
      temperature: 0.2,
      reasoning_effort: undefined,
    },
  },
  {
    entry: {
      slug: 'torn',
      name: undefined,
      path: 'agents/torn.yaml',
      valid: false,
      error: 'not an agent',
    },
    agent: undefined,
  },
];

export const AGENTS_PORT: AgentsPort = {
  read: () => ({
    model: buildAgentsModel(AGENT_ITEMS),
    slugOf: (index) => AGENT_ITEMS[index]?.entry.slug,
    pathOf: (index) => AGENT_ITEMS[index]?.entry.path,
    definitionOf: () => undefined,
  }),
};

export const SESSIONS_PORT: SessionsPort = {
  read: () => ({
    rows: [
      { id: 's1', title: 'Fix the flaky test', agent: 'chat', age: '5m ago' },
      { id: 's2', title: 'Untitled', agent: 'reviewer', age: '2h ago' },
    ],
    more: true,
  }),
};

/** The project's permissions, read-only at the bare Home. */
export const PROJECT_PERMISSIONS_PORT: PermissionsPort = {
  surface: 'project',
  load: () => ({
    project: {
      ok: true,
      rows: [
        { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-19 12:00Z' },
        { id: 'b', label: 'node, 1 argument', remembered: '2026-11-18 09:30Z' },
      ],
    },
    session: undefined,
    allowlist: { ok: true, commands: ['git status', 'npm test'], globs: ['git *'], omitted: 0 },
  }),
  withdraw: () => ({ tone: 'done', text: 'Withdrawn.' }),
};

/** The Active tab over a hosted run, a paused one, a stalled one and one whose terminal is held. */
export const ACTIVE_PORT: HomeActivePort = (() => {
  const now = NOW_MS;
  const base = {
    workflowId: 'wf',
    executionMode: 'local',
    triggerType: 'manual',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    projectRoot: '/work/here',
    updatedAt: new Date(now - 1_000).toISOString(),
  } as const;
  const young = new Date(now - 5_000).toISOString();
  const old = new Date(now - 300_000).toISOString();
  const rows = classifyActiveRuns({
    runs: [
      { ...base, id: 'hostrun1', status: 'running', createdAt: young },
      { ...base, id: 'gaterun1', status: 'paused', createdAt: young },
      { ...base, id: 'stallrun', status: 'running', createdAt: old },
      { ...base, id: 'heldrun1', status: 'running', createdAt: young },
    ],
    leases: new Map(),
    hostedRunId: 'hostrun1',
    currentProjectRoot: '/work/here',
    outboxHeldRunIds: new Set(['heldrun1']),
    nowMs: now,
    leaseTtlMs: 60_000,
    pendingGateCounts: new Map([['gaterun1', 1]]),
  });
  return {
    token: () => ({ dataVersion: 1, generation: 1 }),
    read: () =>
      Promise.resolve({
        rows,
        more: [{ status: 'paused' as const, count: 3, atLeast: false }],
        heldUnread: false,
      }),
    isClosed: () => false,
  };
})();

/**
 * The History tab over a real in-memory database holding the fixture runs of the run-detail and node-page tests: a failed run (a node that
 * was retried, one that failed twice), a running one, one that ran in reverse, one stopped mid-node and one that never began. The setup
 * is asynchronous because the fixture is seeded through the real store; `dispose` closes the database.
 */
export async function historySetup(): Promise<HomeSetup> {
  const client = createClient(':memory:');
  runMigrations(client.db);
  await seedFixtureRuns(client.db);
  const reader = createRunHistoryReader(client.db);
  const loadSnapshot = (): string => FIXTURE_SNAPSHOT;
  const history: HistoryPort = {
    ...createHistorySource({
      reader,
      listRunPins: () => [],
      projectRoot: '/work/project',
      now: () => NOW_MS,
    }),
    loadDetail: createRunDetailLoader({
      reader,
      listHeld: () => Promise.resolve([]),
      loadSnapshot,
    }),
    loadNode: createNodeDetailLoader({ reader, loadSnapshot }),
  };
  return {
    deps: { history },
    dispose: () => {
      client.sqlite.close();
    },
  };
}

export { FIXTURE_RUN_IDS };
