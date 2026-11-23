import type { RunHistoryReader } from '@relavium/db';

import { buildNodeDetailModel, type NodeDetailModel } from './node-detail-model.js';
import { readPerRunOrDegrade } from './per-run-read.js';
import { collapseAttemptRows, isFinishedRun, lastAttemptRow } from './run-detail-model.js';
import { pageRunEvents, type PagedEvents } from './run-detail-source.js';
import { readSnapshotNodes, type SnapshotNode } from './snapshot-nodes.js';

/**
 * The read behind the node page of the Home's History tab ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, §4, MVP-8 step 4): one node of one run, with the attempt it inspects, every attempt row of the node, the run's event log and the node's
 * place in the frozen workflow. It reads and builds (`buildNodeDetailModel`); it writes nothing, reconciles nothing and claims nothing.
 *
 * - **The output and the error come through the store's size gate.** `loadStepDetail` returns a document only when it is at most 1 MiB (in SQL);
 *   an over-bound one arrives as `null` text with its byte length, and the model says the length and shows no text. Nothing here parses a
 *   document: the model's masking and caps are the only way an output or an error reaches a page.
 * - **Which attempt.** The node's LAST attempt unless the caller names one (the page's `n` names the first that failed). An attempt number the
 *   node has no row for is `unavailable`, never another attempt in its place.
 * - **The place and the type are the workflow's.** The frozen snapshot, when it can be read, says how many nodes the workflow has, which one this
 *   is, and the type the workflow authored; with no snapshot the page shows neither and says nothing about the workflow.
 * - **A node with no attempt row** (skipped, or not reached) has no step detail to read: the answer is `no-attempts`, and the page says why from
 *   the run detail's row. A node whose record cannot be read (the attempt row is gone, the run is gone, or the log is damaged) is `unavailable`;
 *   any other fault (a closed database) propagates.
 * - **Synchronous.** Every read is SQLite on the caller's own connection, in one stretch, like the run detail's. The terminal outbox is not read
 *   here: the run detail already knows whether the run's end is held, and the caller says so.
 */

/** The reads the node page makes. */
export type NodeDetailReader = Pick<
  RunHistoryReader,
  'loadRunSummariesByIds' | 'listStepSummaries' | 'loadStepDetail' | 'loadRunEventsAfter'
>;

export interface NodeDetailRequest {
  readonly runId: string;
  /** The node's raw id, as the run detail's row carries it. */
  readonly nodeId: string;
  /** The attempt to inspect; absent means the node's last. */
  readonly attemptNumber?: number | undefined;
  /** The run's end is held in the terminal outbox (the run detail read it): the run is over whatever its row says. */
  readonly terminalHeld: boolean;
}

/** A node's place in the frozen workflow: `index` of `of`, counted from one. */
export interface NodePosition {
  readonly index: number;
  readonly of: number;
}

/** One node's detail, ready to draw. */
export interface NodeDetailRead {
  readonly runId: string;
  readonly nodeId: string;
  readonly model: NodeDetailModel;
  /** The node's place in the frozen workflow; absent when the snapshot could not be read or does not name the node. */
  readonly position?: NodePosition;
  /** The type the workflow authored for the node, as the snapshot spells it (raw: the view scrubs it as it draws). */
  readonly authoredType?: string;
  /** The attempt numbers the node has rows for, ascending. */
  readonly attemptNumbers: readonly number[];
  /** `false` when the run's log is longer than the pages read: the figures cover the first part of it. */
  readonly eventsComplete: boolean;
}

/** What one open of a node's page came to. */
export type NodeDetailLoad =
  | { readonly kind: 'ready'; readonly detail: NodeDetailRead }
  | {
      /** The node has no attempt row: skipped, or not reached. The run detail's row says which. */
      readonly kind: 'no-attempts';
      readonly position?: NodePosition;
      readonly authoredType?: string;
    }
  | { readonly kind: 'unavailable' };

export interface NodeDetailLoaderDeps {
  readonly reader: NodeDetailReader;
  /**
   * The run's frozen workflow snapshot text (`loadRunSnapshot(db, runId)?.workflowDefinitionSnapshot`); `undefined` for a run with none. It may
   * throw: a snapshot that cannot be read costs the page its place and type, never the page.
   */
  readonly loadSnapshot?: ((runId: string) => string | undefined) | undefined;
  /** Test seams: the size of a page of the log and the most pages read. */
  readonly eventPage?: number;
  readonly maxPages?: number;
}

function snapshotOf(
  deps: NodeDetailLoaderDeps,
  runId: string,
): readonly SnapshotNode[] | undefined {
  try {
    return readSnapshotNodes(deps.loadSnapshot?.(runId));
  } catch {
    return undefined;
  }
}

/** The node's place and authored type in `nodes`; empty when `nodes` is absent or does not name the node. */
function placeIn(
  nodes: readonly SnapshotNode[] | undefined,
  nodeId: string,
): {
  readonly node?: SnapshotNode;
  readonly position?: NodePosition;
} {
  const at = nodes?.findIndex((candidate) => candidate.id === nodeId) ?? -1;
  const node = at < 0 ? undefined : nodes?.[at];
  if (nodes === undefined || node === undefined) return {};
  return { node, position: { index: at + 1, of: nodes.length } };
}

/**
 * Read one node's page. `unavailable` for a run or an attempt that is not there and for a run whose log this binary cannot read; a fault
 * that is not about this run's rows propagates.
 */
export function readNodeDetail(
  deps: NodeDetailLoaderDeps,
  request: NodeDetailRequest,
): NodeDetailLoad {
  const { reader } = deps;
  const { runId, nodeId } = request;
  const run = reader.loadRunSummariesByIds([runId]).get(runId);
  if (run === undefined) return { kind: 'unavailable' };
  const rows = reader.listStepSummaries(runId).filter((row) => row.nodeId === nodeId);
  const { node, position } = placeIn(snapshotOf(deps, runId), nodeId);
  const place = {
    ...(position === undefined ? {} : { position }),
    ...(node === undefined ? {} : { authoredType: node.type }),
  };
  if (rows.length === 0) return { kind: 'no-attempts', ...place };

  const attempts = collapseAttemptRows(rows).sort((a, b) => a.attemptNumber - b.attemptNumber);
  const inspected = request.attemptNumber ?? lastAttemptRow(attempts)?.attemptNumber;
  if (inspected === undefined) return { kind: 'unavailable' };
  const detail = reader.loadStepDetail(runId, nodeId, inspected);
  if (detail === undefined) return { kind: 'unavailable' };

  const body = readPerRunOrDegrade<PagedEvents | undefined>(undefined, () =>
    pageRunEvents(reader, runId, {
      ...(deps.eventPage === undefined ? {} : { page: deps.eventPage }),
      ...(deps.maxPages === undefined ? {} : { maxPages: deps.maxPages }),
    }),
  );
  if (body.degraded || body.value === undefined) return { kind: 'unavailable' };
  const log = body.value;

  const authored = {
    ...(node?.agent === undefined ? {} : { agentSlug: node.agent }),
    ...(node?.model === undefined ? {} : { model: node.model }),
  };
  const model = buildNodeDetailModel({
    detail,
    attempts,
    events: log.events,
    authored,
    runFinished: isFinishedRun(run.status) || request.terminalHeld,
  });
  return {
    kind: 'ready',
    detail: {
      runId,
      nodeId,
      model,
      ...place,
      attemptNumbers: attempts.map((row) => row.attemptNumber),
      eventsComplete: log.complete,
    },
  };
}

/** The node page's read as a function of a request, over the deps. */
export function createNodeDetailLoader(
  deps: NodeDetailLoaderDeps,
): (request: NodeDetailRequest) => NodeDetailLoad {
  return (request) => readNodeDetail(deps, request);
}
