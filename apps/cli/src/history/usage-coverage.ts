import type { RunHistoryReader } from '@relavium/db';
import { UsageCoverageFold, type UsageCoverage } from '@relavium/shared';

/** Conservative fallback for old/foreign histories. A read never establishes a fresh basis. */
export const UNVERIFIED_USAGE: UsageCoverage = Object.freeze({
  unverified: true,
  pendingInvocations: 0,
  unknownCalls: 0,
});

/** One bounded-memory snapshot read, on discovery rather than each render frame. */
export function readRunUsageCoverage(
  reader: Pick<RunHistoryReader, 'visitRunEventsForReplay'>,
  runId: string,
): {
  readonly usageCoverage: UsageCoverage;
  readonly unpricedCalls: number;
  readonly nodes: ReadonlyMap<string, UsageCoverage>;
} {
  const fold = new UsageCoverageFold();
  let unpricedCalls = 0;
  const nodes = new Map<string, UsageCoverageFold>();
  reader.visitRunEventsForReplay(
    runId,
    (event) => {
      fold.apply(event);
      if (
        'nodeId' in event &&
        (event.type === 'cost:usage_pending' ||
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
      if (event.type === 'cost:attempt_settled' && event.priced === false) unpricedCalls++;
    },
    { streamingIncluded: false },
  );
  return {
    usageCoverage: fold.snapshot().coverage,
    unpricedCalls,
    nodes: new Map([...nodes].map(([id, node]) => [id, node.snapshot().coverage])),
  };
}
