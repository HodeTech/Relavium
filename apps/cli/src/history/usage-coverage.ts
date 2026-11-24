import type { RunHistoryReader, StepRecord } from '@relavium/db';
import { UsageCoverageFold, type RunEvent, type UsageCoverage } from '@relavium/shared';

/** Conservative fallback for old/foreign histories. A read never establishes a fresh basis. */
export const UNVERIFIED_USAGE: UsageCoverage = Object.freeze({
  unverified: true,
  pendingInvocations: 0,
  unknownCalls: 0,
});

/**
 * One pass over a run's events that yields its usage coverage, its per-node coverage and its count of calls whose price was unknown. The
 * ONE copy of that fold: the streaming read below ({@link readRunUsageCoverage}) and the in-memory fold of the run detail
 * (`foldUsageFacts` in `run-detail-model.ts`) both feed it, so a rule changed here changes both and the figures a list and a detail show
 * for one run cannot drift apart. It throws what the coverage fold throws (a corrupt-event error for a contradictory log); each caller
 * decides what that means for its own surface.
 */
export interface UsageAccumulator {
  /** Take one event, in the order the log holds them. */
  readonly apply: (event: RunEvent) => void;
  /** The run's coverage as the events so far say it (the fold's snapshot). */
  readonly coverage: () => UsageCoverage;
  /** Each node's coverage, for the nodes the accounting events name. */
  readonly nodes: () => Map<string, UsageCoverage>;
  /** Calls whose price was unknown, as the run-level counter and the ledger rows agree on. */
  readonly unpricedCalls: () => number;
}

export function createUsageAccumulator(): UsageAccumulator {
  const fold = new UsageCoverageFold();
  const nodes = new Map<string, UsageCoverageFold>();
  let ledgerUnpriced = 0;
  let snapshotUnpriced = 0;
  return {
    apply: (event) => {
      fold.apply(event);
      if (
        'nodeId' in event &&
        (event.type === 'node:started' ||
          event.type === 'cost:usage_pending' ||
          event.type === 'cost:usage_disposition' ||
          event.type === 'cost:attempt_settled')
      ) {
        let node = nodes.get(event.nodeId);
        if (node === undefined) {
          node = new UsageCoverageFold();
          node.start(fold.snapshot().coverage.unverified ? 'legacy_unverified' : 'complete');
          nodes.set(event.nodeId, node);
        }
        node.apply(event);
      }
      if (event.type === 'cost:attempt_settled' && event.priced === false) ledgerUnpriced++;
      snapshotUnpriced = Math.max(snapshotUnpriced, event.cumulativeUnpricedCalls ?? 0);
    },
    coverage: () => fold.snapshot().coverage,
    nodes: () => new Map([...nodes].map(([id, node]) => [id, node.snapshot().coverage])),
    // A queued boundary may already carry a later counter. Never add ledger rows to that snapshot.
    unpricedCalls: () => Math.max(ledgerUnpriced, snapshotUnpriced),
  };
}

/** One bounded-memory snapshot read, on discovery rather than each render frame. */
export function readRunUsageCoverage(
  reader: Pick<RunHistoryReader, 'visitRunEventsForReplay'>,
  runId: string,
  visitSteps?: (steps: readonly StepRecord[]) => void,
): {
  readonly totalCostMicrocents: number;
  readonly usageCoverage: UsageCoverage;
  readonly unpricedCalls: number;
  readonly nodes: ReadonlyMap<string, UsageCoverage>;
} {
  const facts = createUsageAccumulator();
  const run = reader.visitRunEventsForReplay(runId, (event) => facts.apply(event), {
    streamingIncluded: false,
    ...(visitSteps === undefined ? {} : { visitSteps }),
  });
  return {
    totalCostMicrocents: run?.totalCostMicrocents ?? 0,
    usageCoverage: run === undefined ? UNVERIFIED_USAGE : facts.coverage(),
    unpricedCalls: facts.unpricedCalls(),
    nodes: facts.nodes(),
  };
}
