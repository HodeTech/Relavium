import type { RunLeaseSummary, RunSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';

import { RUN_STATUS_GLYPH } from './history-model.js';
import { MAX_PROJECT_ROOT_CHARS, scrubbedBounded, shortRunId } from './run-detail-model.js';

/**
 * The pure classification of the Home's Active tab (ADR-0140 §2, "Active"; ADR-0139 §3 and §7; MVP-8 step 1).
 * One row per run that is not finished, in classes that never mix. The caller reads the runs, the lease rows and
 * the outbox's held ids; the clock is an argument, so a stalled run is a function of the inputs and nothing else.
 *
 * | class | who | actionable |
 * |---|---|---|
 * | `hosted` | the leg this Home executes | yes: reopen its view |
 * | `other-running` | another process's `pending` or `running` run | no: read-only, no cross-process cancel |
 * | `other-paused-here` | a run paused at a gate, started in THIS project | yes: open the gate card |
 * | `other-paused-media` | a run paused only on a media job, in this project | yes when its jobs are known to be in flight: `Enter` asks whether to continue it here; else no |
 * | `paused-gate-unknown` | paused in this project, and the caller did not say whether it holds a gate | no |
 * | `other-paused-elsewhere` | a paused run started in another project | no: ADR-0139 §7 |
 * | `held` | a run whose terminal event sits in the outbox | no |
 *
 * **Gate versus media park.** `RunSummaryRecord` has no pause reason: a run parked at a human or budget gate and
 * a run parked only on an async media job both read `paused`, and the difference lives in the run's event log
 * (`run:paused` carries `pendingGateCount` and `pendingMediaJobNodeIds`). This model therefore does NOT guess.
 * The caller passes `pendingGateCounts` (run id to its pending gate count, read from the log) for the paused runs
 * of this project; a run absent from that map is `paused-gate-unknown` and is NOT actionable, so a media park is
 * never offered a gate card it cannot answer. MUST BE RESOLVED IN MVP-8 STEP 4 (the Active tab): the tab's reader
 * has to read the pending gates of every paused run in THIS project (per-run isolated, as `readPerRunOrDegrade`
 * does) and fill that map; until it does, no paused row is actionable. A media park CAN be continued with no decision
 * (ADR-0139 §3, the 2026-11-23 amendment note): the caller also passes `pendingMediaJobCounts` (run id to the number of media
 * jobs its log has in flight), and a gate-less paused run with a count above zero is actionable. A run absent from that map,
 * or counted zero, stays read-only: the tab never offers a continue it cannot tell the engine will accept.
 *
 * Precedence, so a run is in exactly one class: `held`/`hosted` are decided by the run's id; then the status
 * decides. A run that is `hosted` stays `hosted` even if its terminal is also held (the view is where the held
 * remedy is shown); a paused run that is also held is `held`. A run whose status is terminal is not active and is
 * dropped, whatever the outbox says (an outbox entry for a run that already has its terminal is stale).
 */

export type ActiveClass =
  | 'hosted'
  | 'other-running'
  | 'other-paused-here'
  | 'other-paused-media'
  | 'paused-gate-unknown'
  | 'other-paused-elsewhere'
  | 'held';

/** What `Enter` does on a row. Nothing here cancels, retries or edits a run; `continue-media` asks first (a Yes/No whose default is No). */
export type ActiveEnter = 'reopen-view' | 'open-gate-card' | 'continue-media' | 'inspect';

export const STALLED_REASON = 'settled by the next start';

/** What a gate-less paused run waits for: said on the row, and the reason a read-only one gives. */
const MEDIA_PARK_REASON = 'waiting for a media job';

export interface ActiveRow {
  readonly runId: string;
  /** The first 8 characters of the id, through the one-line floor. */
  readonly shortId: string;
  /** The workflow's slug when resolved, else its id; sanitized. */
  readonly label: string;
  readonly status: RunStatus;
  readonly glyph: string;
  readonly class: ActiveClass;
  /** `true` only for the classes whose `Enter` acts on the run: the hosted leg, a gate park, and a media park that can be continued. */
  readonly actionable: boolean;
  readonly enter: ActiveEnter;
  /** Why a read-only row is read-only; absent for an actionable row, except the media park, which keeps what it waits for. */
  readonly reason?: string;
  /**
   * A `running` run, not hosted here, that is older than one TTL and whose lease is missing or expired by more than
   * one TTL. A younger run is never stalled (see {@link isStalled}).
   */
  readonly stalled: boolean;
  readonly stalledReason?: typeof STALLED_REASON;
  readonly createdAt: string;
  /** Through the one-line floor: for display, never for comparison (the class decision used the stored value). */
  readonly projectRoot?: string;
}

export interface ClassifyActiveInput {
  readonly runs: readonly RunSummaryRecord[];
  /** Run id to its lease row; a run with no lease is absent (`loadRunLeases`). */
  readonly leases: ReadonlyMap<string, RunLeaseSummary>;
  /** The run this Home's executing leg hosts, when one executes. */
  readonly hostedRunId?: string;
  readonly currentProjectRoot: string;
  /** Run ids whose terminal event is held in the outbox. */
  readonly outboxHeldRunIds: ReadonlySet<string>;
  readonly nowMs: number;
  /** The lease TTL; a run older than this whose lease is missing or expired for more than this is stalled. */
  readonly leaseTtlMs: number;
  /** Run id to the pending gate count of its `run:paused` (see the module note). Absent entries are unknown. */
  readonly pendingGateCounts?: ReadonlyMap<string, number>;
  /** Run id to the number of media jobs its log has in flight (see the module note). Absent entries are unknown, and unknown is read-only. */
  readonly pendingMediaJobCounts?: ReadonlyMap<string, number>;
  /** Workflow id to slug (`loadWorkflowSlugs`). */
  readonly workflowLabels?: ReadonlyMap<string, string>;
}

const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'pending',
  'running',
  'paused',
]);

interface Verdict {
  readonly class: ActiveClass;
  readonly actionable: boolean;
  readonly enter: ActiveEnter;
  readonly reason?: string;
}

const READ_ONLY = (cls: ActiveClass, reason: string): Verdict => ({
  class: cls,
  actionable: false,
  enter: 'inspect',
  reason,
});

function verdictFor(run: RunSummaryRecord, input: ClassifyActiveInput): Verdict {
  if (run.id === input.hostedRunId) {
    return { class: 'hosted', actionable: true, enter: 'reopen-view' };
  }
  if (input.outboxHeldRunIds.has(run.id)) {
    return READ_ONLY('held', 'terminal held in the outbox');
  }
  if (run.status !== 'paused') {
    return READ_ONLY('other-running', 'running in another process');
  }
  if (run.projectRoot !== input.currentProjectRoot) {
    return READ_ONLY(
      'other-paused-elsewhere',
      run.projectRoot === undefined ? 'project not recorded' : 'another project',
    );
  }
  const gates = input.pendingGateCounts?.get(run.id);
  if (gates === undefined) return READ_ONLY('paused-gate-unknown', 'gate state not read');
  if (gates === 0) {
    const media = input.pendingMediaJobCounts?.get(run.id) ?? 0;
    if (media > 0) {
      return {
        class: 'other-paused-media',
        actionable: true,
        enter: 'continue-media',
        reason: MEDIA_PARK_REASON,
      };
    }
    return READ_ONLY('other-paused-media', MEDIA_PARK_REASON);
  }
  return { class: 'other-paused-here', actionable: true, enter: 'open-gate-card' };
}

/** The display order: hosted, then paused in this project, then running, then the rest. */
function groupRank(cls: ActiveClass): number {
  switch (cls) {
    case 'hosted':
      return 0;
    case 'other-paused-here':
    case 'other-paused-media':
    case 'paused-gate-unknown':
      return 1;
    case 'other-running':
      return 2;
    case 'other-paused-elsewhere':
    case 'held':
      return 3;
  }
}

/** Newest first by `createdAt` (compared as time, text only as a last resort), then by id descending. */
function newestFirst(a: ActiveRow, b: ActiveRow): number {
  const left = Date.parse(a.createdAt);
  const right = Date.parse(b.createdAt);
  if (!Number.isNaN(left) && !Number.isNaN(right)) {
    if (left !== right) return right - left;
  } else if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  if (a.runId === b.runId) return 0;
  return a.runId < b.runId ? 1 : -1;
}

/**
 * Whether a run is YOUNGER than one lease TTL at `nowMs`, by the rule `reconcile()` applies (ADR-0079, the
 * 2026-11-06 amendment): its owner persists `run:started` before it can take the lease, so a run with no lease
 * yet may have started a moment ago. Young means `-ttl < age < ttl`: a run that is exactly one TTL old is not
 * young, and neither is one whose start lies a full TTL or more in the future (a clock that moved back), which
 * `reconcile()` settles too. A creation time that cannot be read is not young, as `reconcile()` treats a run with
 * no recorded start.
 */
function isYoungerThanLeaseTtl(createdAt: string, nowMs: number, leaseTtlMs: number): boolean {
  const age = nowMs - Date.parse(createdAt);
  return age > -leaseTtlMs && age < leaseTtlMs;
}

/**
 * Whether a running run another process owns is stalled: it is NOT younger than one lease TTL, AND it holds no
 * live lease — no lease row, or one expired by MORE than one TTL at `nowMs` (`nowMs - expiresAt > ttl`). A lease
 * that expired exactly one TTL ago is not yet stalled — the boundary is strict — and a missing lease is, once the
 * run is past one TTL. A fresh run is never stalled, whatever its lease says: its owner may not have taken it yet.
 */
export function isStalled(input: {
  readonly lease: RunLeaseSummary | undefined;
  readonly createdAt: string;
  readonly nowMs: number;
  readonly leaseTtlMs: number;
}): boolean {
  const { lease, createdAt, nowMs, leaseTtlMs } = input;
  if (isYoungerThanLeaseTtl(createdAt, nowMs, leaseTtlMs)) return false;
  return lease === undefined || nowMs - lease.expiresAt > leaseTtlMs;
}

/** Classify the not-finished runs the Home can see. See the module note for the classes and their order. */
export function classifyActiveRuns(input: ClassifyActiveInput): ActiveRow[] {
  const rows: ActiveRow[] = [];
  for (const run of input.runs) {
    if (!ACTIVE_STATUSES.has(run.status)) continue;
    const verdict = verdictFor(run, input);
    const stalled =
      verdict.class === 'other-running' &&
      run.status === 'running' &&
      isStalled({
        lease: input.leases.get(run.id),
        createdAt: run.createdAt,
        nowMs: input.nowMs,
        leaseTtlMs: input.leaseTtlMs,
      });
    rows.push({
      runId: run.id,
      shortId: shortRunId(run.id),
      label: scrubbedBounded(input.workflowLabels?.get(run.workflowId) ?? run.workflowId),
      status: run.status,
      glyph: RUN_STATUS_GLYPH[run.status],
      class: verdict.class,
      actionable: verdict.actionable,
      enter: verdict.enter,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      stalled,
      ...(stalled ? { stalledReason: STALLED_REASON } : {}),
      createdAt: run.createdAt,
      ...(run.projectRoot === undefined
        ? {}
        : { projectRoot: scrubbedBounded(run.projectRoot, MAX_PROJECT_ROOT_CHARS) }),
    });
  }
  return rows.sort((a, b) => groupRank(a.class) - groupRank(b.class) || newestFirst(a, b));
}
