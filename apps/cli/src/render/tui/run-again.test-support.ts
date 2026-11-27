/**
 * What the tests of `r` on a run's detail share (MVP-11 unit 7, W4c): a project's catalog of three workflows (two that parse, one that does
 * not), the detail of a finished run as the loader would have read it, and the History tab's list read for that run. Fixtures only: nothing
 * here asserts, and nothing here is imported by the product.
 */
import type { RunDetailRecord, RunSummaryRecord, StepSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';
import { vi } from 'vitest';

import { buildDefinedModel, type DefinedEntry } from '../../history/defined-model.js';
import { buildHistoryRows } from '../../history/history-model.js';
import type { HistoryRead } from '../../history/history-source.js';
import { buildRunDetailModel } from '../../history/run-detail-model.js';
import type { RunDetailRead, RunDirectory } from '../../history/run-detail-source.js';
import type { DefinedPort } from '../../history/defined-model.js';

export const T0 = Date.parse('2026-11-23T10:00:00.000Z');
/** The run every fixture here is about. */
export const RUN = '0a1b2c3d-0000-4000-8000-000000000001';

/** The project's catalog: `nightly` and `code-review` parse, `broken` does not (its parse error is a text no line may repeat). */
export const CATALOG: readonly DefinedEntry[] = [
  { slug: 'code-review', name: 'Code Review', nodeCount: 5, path: 'code-review.yaml', valid: true },
  { slug: 'nightly', name: undefined, nodeCount: 1, path: 'nightly.yaml', valid: true },
  { slug: 'broken', name: undefined, path: 'broken.yaml', valid: false, error: 'PARSE-ERROR-TEXT' },
];

/** The Defined tab's port over `list`, with its read counted. */
export function definedPortOver(list: readonly DefinedEntry[] = CATALOG) {
  const read = vi.fn(() => ({
    model: buildDefinedModel({ entries: list, pins: [] }),
    slugOf: (index: number) => list[index]?.slug,
    pathOf: (index: number) => list[index]?.path,
  }));
  return { port: { read } satisfies DefinedPort, read };
}

export const SUMMARY: RunSummaryRecord = {
  id: RUN,
  workflowId: 'wf',
  status: 'failed',
  executionMode: 'local',
  triggerType: 'manual',
  startedAt: new Date(T0).toISOString(),
  completedAt: new Date(T0).toISOString(),
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  createdAt: new Date(T0).toISOString(),
  updatedAt: new Date(T0).toISOString(),
};

/**
 * A finished run's detail through the real model, with what the loader says of where it was started and which workflow it is. The default
 * is a failed run of this directory whose workflow is `nightly`.
 */
export function runDetailRead(
  over: {
    readonly directory?: RunDirectory | undefined;
    readonly workflowSlug?: string | undefined;
    /** How the one node ended: `failed` (the default: the run has a failed node, `[n]` has a target) or `completed` (none did). */
    readonly nodeStatus?: 'failed' | 'completed';
    /** How many nodes the frozen snapshot listed (absent: the read could not say). */
    readonly authoredNodeCount?: number | undefined;
  } = { directory: 'here', workflowSlug: 'nightly' },
): RunDetailRead {
  const at = new Date(T0).toISOString();
  const status: RunStatus = over.nodeStatus === 'completed' ? 'completed' : 'failed';
  const run: RunDetailRecord = {
    ...SUMMARY,
    status,
    outputJson: null,
    outputByteLength: null,
    errorJson: null,
    errorByteLength: null,
  };
  const steps: readonly StepSummaryRecord[] = [
    {
      nodeId: 'build',
      nodeType: 'agent',
      status: over.nodeStatus ?? 'failed',
      attemptNumber: 1,
      startedAt: at,
      completedAt: at,
      durationMs: 3100,
      costMicrocents: 0,
      inputTokens: 12,
      outputTokens: 4,
    },
  ];
  return {
    runId: RUN,
    status,
    ...(over.directory === undefined ? {} : { directory: over.directory }),
    ...(over.workflowSlug === undefined ? {} : { workflowSlug: over.workflowSlug }),
    ...(over.authoredNodeCount === undefined ? {} : { authoredNodeCount: over.authoredNodeCount }),
    model: buildRunDetailModel({
      run,
      steps,
      events: [],
      workflowSlug: 'nightly',
      terminalHeld: false,
    }),
    terminalHeld: false,
    heldUnread: false,
    events: [{ seq: 0, type: 'node:started', nodeId: 'build' }],
    eventsComplete: true,
    stepsComplete: true,
    skippedRows: 0,
  };
}

/** A run that started after `RUN` did: what the History list holds once `r` has started one. */
export const NEWER_RUN = '0a1b2c3d-0000-4000-8000-000000000002';

/**
 * The History list of this project holding the one run, with the runs of `newer` listed ahead of it (the list is newest first) and `page` as
 * the page it is (the first by default).
 */
export function historyListOfRun(newer: readonly string[] = [], page = 0): HistoryRead {
  const later = new Date(T0 + 30_000).toISOString();
  return {
    query: { scope: 'project', status: undefined, page },
    pinned: [],
    rows: buildHistoryRows({
      runs: [...newer.map((id) => ({ ...SUMMARY, id, createdAt: later })), SUMMARY],
      nowMs: T0 + 60_000,
      pinnedRunIds: new Set(),
      workflowLabels: new Map([['wf', 'nightly']]),
    }).map((row) => ({ kind: 'run' as const, row })),
    hasPrev: page > 0,
    hasNext: false,
  };
}
