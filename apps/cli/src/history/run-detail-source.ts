import type { RunHistoryReader } from '@relavium/db';
import { MAX_RUN_STEP_SUMMARIES, MAX_RUN_TAIL_EVENTS } from '@relavium/db';
import type { RunEvent, RunStatus } from '@relavium/shared';

import { readPerRunOrDegrade } from './per-run-read.js';
import { isProjectRootHere, recordedProjectRoot } from './project-root.js';
import { buildRunDetailModel, isFinishedRun, type RunDetailModel } from './run-detail-model.js';
import { readSnapshotNodes } from './snapshot-nodes.js';

/**
 * The read behind the History tab's run detail ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, §4, MVP-8 step 4): one run, its attempt rows and its event log, folded by `buildRunDetailModel` into the header and the node table.
 * It reads and builds; it writes nothing, reconciles nothing and claims nothing.
 *
 * - **The log is read in pages, and the cursor moves over `scannedThroughSeq`.** `loadRunEventsAfter` returns the events it could read and
 *   the highest `seq` it SCANNED, rows a newer binary wrote included. The loop advances to that mark and stops when a call scans
 *   nothing, never to the last event's own sequence: a log whose tail is a row of a newer type would otherwise be read again, and its
 *   skipped row counted again, on every page ({@link pageRunEvents}). The last, empty call is the stop, not a short page, so the rule
 *   that ends the loop is the same one that moves it.
 * - **A bounded read.** At most {@link RUN_DETAIL_MAX_PAGES} pages of {@link RUN_DETAIL_EVENT_PAGE} events. A longer log is read as far
 *   as that and says so ({@link RunDetailRead.eventsComplete}), so the figures on the page are never presented as whole when they are not.
 * - **A run whose terminal is held is not in progress.** The terminal outbox is a file, read by {@link createRunDetailLoader}; a run that
 *   is not finished and has its end there is built as finished (`terminalHeld`, see the model), and the page says `held`.
 * - **The node order is the workflow's.** The run's frozen snapshot, when the caller read it, gives the authored order and the type of
 *   each node: the nodes that ran keep the order they ran in, and a node the workflow names that has no record at all is listed after them,
 *   pending (see `RunDetailInput.workflowNodeOrder`). A snapshot that cannot be read leaves the table in the order the run ran, and says nothing
 *   of the workflow.
 * - **Damage is per run.** A damaged row or a row of a newer type that the strict model cannot use ends in `unreadable` for THIS run (the
 *   per-run isolation of `readPerRunOrDegrade`); any other fault (a closed database) propagates.
 */

/** Events per page of the log read; the most one `loadRunEventsAfter` call returns. */
export const RUN_DETAIL_EVENT_PAGE = MAX_RUN_TAIL_EVENTS;
/** The most attempt rows one detail reads: the store's own read bound, so a list this long may be a part of the run's. */
export const RUN_DETAIL_MAX_STEPS = MAX_RUN_STEP_SUMMARIES;
/** The most pages one detail reads: 20,000 events. A log longer than that is read as far as it, and flagged. */
export const RUN_DETAIL_MAX_PAGES = 20;

/** What the page keeps of an event to list it: its place, its type and its node. The event itself is dropped once the model is built. */
export interface DetailEvent {
  readonly seq: number;
  readonly type: RunEvent['type'];
  /** The node the event belongs to, as the event carries it (raw: the view cuts and scrubs it as it draws). */
  readonly nodeId?: string;
}

/**
 * Where a run was started, against the directory the Home is in, as a CLOSED word (never the stored path): `here` (the run's recorded
 * project is the Home's directory, exactly), `elsewhere` (another recorded project), `unrecorded` (the run recorded none, or an empty one:
 * unknown is never `here`). It is what decides whether a run may be run again from this Home (MVP-11 unit 7, W4c).
 */
export type RunDirectory = 'here' | 'elsewhere' | 'unrecorded';

/** One run's detail, ready to draw. */
export interface RunDetailRead {
  readonly runId: string;
  readonly status: RunStatus;
  /**
   * Where the run was started ({@link RunDirectory}); absent when the read was not told the Home's directory (a test, or a caller that
   * has none), which says nothing and offers nothing.
   */
  readonly directory?: RunDirectory | undefined;
  /**
   * The slug the run was recorded under, as a KEY for the catalog to match (`r` runs the workflow of that slug again); never drawn
   * (the header draws its own scrubbed label). Absent when the workflow was deleted since: the run no longer names a workflow of a project.
   */
  readonly workflowSlug?: string | undefined;
  readonly model: RunDetailModel;
  /** The run's end is held in the terminal outbox: it is over, and the page says `held`, never `in progress`. */
  readonly terminalHeld: boolean;
  /** The outbox could not be read and the run is not finished, so its end may be held without the page being able to say so. */
  readonly heldUnread: boolean;
  /** The events that were read, in order. */
  readonly events: readonly DetailEvent[];
  /** `false` when the log is longer than the pages read: the figures cover the first part of it. */
  readonly eventsComplete: boolean;
  /**
   * `false` when the attempt rows are cut at the store's read bound: a list of exactly {@link MAX_RUN_STEP_SUMMARIES} rows is the only
   * list that may be a part of the run's (PR #102 review: P3), so the node table covers the first rows in execution order, not all.
   */
  readonly stepsComplete: boolean;
  /** Rows a NEWER binary wrote, counted once each. */
  readonly skippedRows: number;
}

/** What one open of a run's detail came to. */
export type RunDetailLoad =
  | { readonly kind: 'ready'; readonly detail: RunDetailRead }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' };

/** The reads the detail needs. */
export type RunDetailReader = Pick<
  RunHistoryReader,
  'loadRunDetail' | 'listStepSummaries' | 'loadRunEventsAfter' | 'loadWorkflowSlugs'
>;

export interface PagedEvents {
  readonly events: readonly RunEvent[];
  readonly skipped: number;
  /** The log ended inside the pages read. */
  readonly complete: boolean;
}

/**
 * A run's whole log, read page by page with the cursor on `scannedThroughSeq`. `-1` reads from the start. The loop ends on a call that
 * scanned nothing past the cursor; if `maxPages` pages were read and the log goes on, it ends there and is not `complete`.
 */
export function pageRunEvents(
  reader: Pick<RunHistoryReader, 'loadRunEventsAfter'>,
  runId: string,
  options: { readonly page?: number; readonly maxPages?: number } = {},
): PagedEvents {
  const page = options.page ?? RUN_DETAIL_EVENT_PAGE;
  const maxPages = options.maxPages ?? RUN_DETAIL_MAX_PAGES;
  const events: RunEvent[] = [];
  let skipped = 0;
  let after = -1;
  for (let read = 0; read < maxPages; read += 1) {
    const tail = reader.loadRunEventsAfter(runId, after, page);
    events.push(...tail.events);
    skipped += tail.skipped.length;
    // The cursor moves over every row scanned, a skipped one too. A call that scanned nothing is the end of the log.
    if (tail.scannedThroughSeq <= after) return { events, skipped, complete: true };
    after = tail.scannedThroughSeq;
  }
  // The pages were all used: one more look says whether the log ended exactly there or goes on.
  const more = reader.loadRunEventsAfter(runId, after, 1);
  return { events, skipped, complete: more.scannedThroughSeq <= after };
}

function detailEventOf(event: RunEvent): DetailEvent {
  const nodeId = 'nodeId' in event && typeof event.nodeId === 'string' ? event.nodeId : undefined;
  return {
    seq: event.sequenceNumber,
    type: event.type,
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

export interface ReadRunDetailInput {
  readonly reader: RunDetailReader;
  readonly runId: string;
  /** The run's terminal event is in the outbox. Ignored for a run that is finished: its end is durable. */
  readonly terminalHeld: boolean;
  /** The outbox could not be read. */
  readonly heldUnread?: boolean;
  /** The run's frozen workflow snapshot as stored (`runs.workflow_definition_snapshot`); absent when it was not read. */
  readonly snapshotJson?: string | undefined;
  /**
   * The directory the Home is in: what the run's recorded project is compared with ({@link RunDetailRead.directory}), exactly as the History
   * list's `this project` scope compares it. Absent, the detail says nothing of where the run was started.
   */
  readonly projectRoot?: string | undefined;
  /** Test seams: the size of a page and the most pages read. */
  readonly eventPage?: number;
  readonly maxPages?: number;
}

/**
 * Where a run was started, against the Home's directory: `undefined` when the Home's directory is not known to the read (absent, or not an
 * absolute path), `unrecorded` for a run whose stored root names no directory (none, empty or relative: `recordedProjectRoot`), `here` when
 * the two are the same absolute text (`isProjectRootHere`, the one match every reader of a run's root uses), else `elsewhere`.
 */
function directoryOf(
  recorded: string | undefined,
  home: string | undefined,
): RunDirectory | undefined {
  if (recordedProjectRoot(home) === undefined) return undefined;
  if (recordedProjectRoot(recorded) === undefined) return 'unrecorded';
  return isProjectRootHere(recorded, home) ? 'here' : 'elsewhere';
}

/**
 * Read one run's detail. Synchronous: every read here is SQLite on the caller's own connection. `missing` for a run that is not there (or
 * was deleted), `unreadable` for one whose log this binary cannot read; a fault that is not about this run's rows propagates.
 */
export function readRunDetail(input: ReadRunDetailInput): RunDetailLoad {
  const { reader, runId } = input;
  const run = reader.loadRunDetail(runId);
  if (run === undefined) return { kind: 'missing' };
  const body = readPerRunOrDegrade<
    | {
        readonly steps: ReturnType<RunDetailReader['listStepSummaries']>;
        readonly log: PagedEvents;
      }
    | undefined
  >(undefined, () => ({
    steps: reader.listStepSummaries(runId),
    log: pageRunEvents(reader, runId, {
      ...(input.eventPage === undefined ? {} : { page: input.eventPage }),
      ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages }),
    }),
  }));
  if (body.degraded || body.value === undefined) return { kind: 'unreadable' };
  const { steps, log } = body.value;
  const finished = isFinishedRun(run.status);
  const terminalHeld = input.terminalHeld && !finished;
  const workflowSlug = reader.loadWorkflowSlugs([run.workflowId]).get(run.workflowId);
  const nodes = readSnapshotNodes(input.snapshotJson);
  const model = buildRunDetailModel({
    run,
    steps,
    events: log.events,
    ...(workflowSlug === undefined ? {} : { workflowSlug }),
    ...(nodes === undefined
      ? {}
      : {
          workflowNodeOrder: nodes.map((node) => node.id),
          nodeTypes: new Map(nodes.map((node): [string, string] => [node.id, node.type])),
        }),
    terminalHeld,
  });
  const directory = directoryOf(run.projectRoot, input.projectRoot);
  return {
    kind: 'ready',
    detail: {
      runId,
      status: run.status,
      ...(directory === undefined ? {} : { directory }),
      ...(workflowSlug === undefined ? {} : { workflowSlug }),
      model,
      terminalHeld,
      heldUnread: input.heldUnread === true && !finished && !terminalHeld,
      events: log.events.map(detailEventOf),
      eventsComplete: log.complete,
      stepsComplete: steps.length < RUN_DETAIL_MAX_STEPS,
      skippedRows: log.skipped,
    },
  };
}

export interface RunDetailLoaderDeps {
  readonly reader: RunDetailReader;
  /** The directory the Home is in ({@link ReadRunDetailInput.projectRoot}): the loader the Home builds is always given it. */
  readonly projectRoot?: string | undefined;
  /** The events the terminal outbox holds (`createFileTerminalOutbox(...).list`). Rejects when the file cannot be read. */
  readonly listHeld: () => Promise<readonly { readonly runId?: string | undefined }[]>;
  /**
   * The run's frozen workflow snapshot text (`loadRunSnapshot(db, runId)?.workflowDefinitionSnapshot`); `undefined` for a run with none.
   * It may throw: a snapshot that cannot be read leaves the node order as the run ran, it never fails the page.
   */
  readonly loadSnapshot?: ((runId: string) => string | undefined) | undefined;
}

/**
 * The detail as one asynchronous call: the outbox first (a file), then every database read in one synchronous stretch. An outbox that
 * cannot be read leaves the run's end unknown and says so in the result, as `status` degrades: it never fails the page.
 */
export function createRunDetailLoader(
  deps: RunDetailLoaderDeps,
): (runId: string) => Promise<RunDetailLoad> {
  return async (runId) => {
    let terminalHeld = false;
    let heldUnread = false;
    try {
      const held = await deps.listHeld();
      terminalHeld = held.some((event) => event.runId === runId);
    } catch {
      heldUnread = true;
    }
    let snapshotJson: string | undefined;
    try {
      snapshotJson = deps.loadSnapshot?.(runId);
    } catch {
      snapshotJson = undefined;
    }
    return readRunDetail({
      reader: deps.reader,
      runId,
      terminalHeld,
      heldUnread,
      snapshotJson,
      projectRoot: deps.projectRoot,
    });
  };
}
