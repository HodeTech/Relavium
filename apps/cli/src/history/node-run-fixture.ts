import type { Db } from '@relavium/db';

import { seedSnapshotRun, type SeedEvent } from '../test-support.js';

/**
 * Five runs of one frozen workflow, for the tests of the run detail and the node page (MVP-8 step 4). Every run goes through the real store,
 * so its `step_executions` rows are what the engine's own events fold into, and each carries the snapshot below as its frozen workflow. The
 * workflow has four nodes in this authored order: `plan`, `build`, `review`, `ship`. This module is imported only by tests.
 *
 * | Run | What it holds |
 * |---|---|
 * | `failed` | `plan` ok; `build` failed on attempt 1 and ended well on attempt 2 (retried, then succeeded); `review` failed on both attempts (its last attempt failed, with a trace holding a call that has no recorded result); `ship` has no record. The run failed. |
 * | `running` | `plan` done; `build` still running; `ship` has no record. The run is still going. |
 * | `reversed` | The nodes ran in the reverse of the authored order (`review`, `build`, `plan`); `plan` has an older log (no trace field), `build` made no tool call, `review` made four calls (one answered in 12 ms, one answered with no duration, one refused, one that failed after 340 ms); `ship` was skipped. The run completed. |
 * | `stopped` | `plan` done; `build` started and never ended; the run failed, so `build` was left running. |
 * | `empty` | No node ran at all; the run failed at once. |
 */

export const FIXTURE_NODES = ['plan', 'build', 'review', 'ship'] as const;

/** The frozen workflow, as the engine stores it (only the fields the pages read are meaningful here). */
export const FIXTURE_SNAPSHOT = JSON.stringify({
  schema_version: '1.0',
  workflow: {
    id: 'ship-it',
    name: 'Ship it',
    agents: [{ id: 'planner', model: 'claude-planner' }],
    nodes: [
      { id: 'plan', type: 'agent', agent_ref: 'planner' },
      { id: 'build', type: 'agent', agent_ref: 'builder', model: 'claude-builder' },
      { id: 'review', type: 'agent', agent_ref: 'reviewer' },
      { id: 'ship', type: 'transform' },
    ],
    edges: [],
  },
});

export const FIXTURE_RUN_IDS = {
  failed: '11111111-0000-4000-8000-000000000001',
  running: '11111111-0000-4000-8000-000000000002',
  reversed: '11111111-0000-4000-8000-000000000003',
  stopped: '11111111-0000-4000-8000-000000000004',
  empty: '11111111-0000-4000-8000-000000000005',
} as const;

const started = (nodeId: string, attemptNumber?: number): SeedEvent => ({
  type: 'node:started',
  nodeId,
  nodeType: nodeId === 'ship' ? 'transform' : 'agent',
  ...(attemptNumber === undefined ? {} : { attemptNumber }),
});

const completed = (
  nodeId: string,
  output: unknown,
  extra: {
    readonly attemptNumber?: number;
    readonly toolActivity?: Extract<SeedEvent, { type: 'node:completed' }>['toolActivity'];
  } = {},
): SeedEvent => ({
  type: 'node:completed',
  nodeId,
  output,
  tokensUsed: { input: 10, output: 20 },
  durationMs: 1500,
  ...extra,
});

const retrying = (nodeId: string, attemptNumber: number): SeedEvent => ({
  type: 'node:retrying',
  nodeId,
  attemptNumber,
  error: { code: 'tool_failed', message: 'the tool failed', retryable: true },
  delayMs: 100,
});

const failed = (
  nodeId: string,
  attemptNumber: number,
  toolActivity: Extract<SeedEvent, { type: 'node:failed' }>['toolActivity'],
): SeedEvent => ({
  type: 'node:failed',
  nodeId,
  attemptNumber,
  error: { code: 'tool_failed', message: 'The review found a problem.', retryable: false },
  ...(toolActivity === undefined ? {} : { toolActivity }),
});

const settled = (nodeId: string, model: string, cost: number): SeedEvent => ({
  type: 'cost:attempt_settled',
  nodeId,
  model,
  attemptNumber: 1,
  inputTokens: 10,
  outputTokens: 20,
  costMicrocents: cost,
  cumulativeCostMicrocents: cost,
  priced: true,
});

const runFailed: SeedEvent = {
  type: 'run:failed',
  error: { code: 'tool_failed', message: 'The review found a problem.', retryable: false },
  partialOutputs: {},
};

const runCompleted: SeedEvent = {
  type: 'run:completed',
  outputs: {},
  totalTokensUsed: { input: 30, output: 60 },
  totalCostMicrocents: 0,
  durationMs: 9000,
};

const EVENTS: Readonly<Record<keyof typeof FIXTURE_RUN_IDS, readonly SeedEvent[]>> = {
  failed: [
    started('plan'),
    completed('plan', 'planned', {
      toolActivity: [{ toolId: 'read_file', ok: true, resultRecorded: true, durationMs: 12 }],
    }),
    started('build', 1),
    retrying('build', 1),
    started('build', 2),
    settled('build', 'claude-builder', 1000),
    completed('build', { built: true }, { attemptNumber: 2, toolActivity: [] }),
    started('review', 1),
    retrying('review', 1),
    started('review', 2),
    failed('review', 2, [{ toolId: 'run_command', ok: false, resultRecorded: false }]),
    runFailed,
  ],
  running: [
    started('plan'),
    completed('plan', 'planned', { toolActivity: [] }),
    started('build', 1),
  ],
  reversed: [
    started('review'),
    completed('review', 'looks fine', {
      toolActivity: [
        { toolId: 'read_file', ok: true, resultRecorded: true, durationMs: 12 },
        { toolId: 'list_dir', ok: true, resultRecorded: true },
        { toolId: 'write_file', ok: false, resultRecorded: true },
        { toolId: 'run_command', ok: false, resultRecorded: true, durationMs: 340 },
      ],
    }),
    started('build'),
    completed('build', { built: true }, { toolActivity: [] }),
    started('plan'),
    completed('plan', 'planned'),
    { type: 'node:skipped', nodeId: 'ship', reason: 'branch_not_taken' },
    runCompleted,
  ],
  stopped: [
    started('plan'),
    completed('plan', 'planned', { toolActivity: [] }),
    started('build', 1),
    runFailed,
  ],
  empty: [runFailed],
};

/**
 * Seed the five runs into `db`, the `running` one last so it is the newest. Each run's id is in {@link FIXTURE_RUN_IDS}. Awaits every write.
 */
export async function seedFixtureRuns(db: Db): Promise<void> {
  let atMs = 1_750_000_000_000;
  for (const name of ['failed', 'reversed', 'stopped', 'empty', 'running'] as const) {
    atMs += 60_000;
    await seedSnapshotRun(db, {
      slug: 'ship-it',
      runId: FIXTURE_RUN_IDS[name],
      definitionJson: FIXTURE_SNAPSHOT,
      events: EVENTS[name],
      atMs,
    });
  }
}
