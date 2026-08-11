/**
 * The append-audit harness (`CR-10`) — is the durable log a PREFIX of what the engine asked to persist?
 *
 * **Why this cannot be a log assertion, which is the whole reason the file exists.** `CR-10`'s property is
 * "no persisted event is missing from the middle". That is not expressible from the durable log alone: the
 * run's sequence numbers are shared with STREAMED events (`agent:token`, `agent:reasoning`, `cost:updated`, …)
 * which take a number and are deliberately never persisted, so a healthy completed run reads
 * `[0,1,2,3,5,10,11,12,13,14]` and a streamed event's absence is byte-identical to a lost one. Asserting
 * `0..n-1` fails a correct engine — measured, in the durable-truth oracle, which records the same limitation
 * and points here.
 *
 * So the predicate needs a witness the log does not carry: **what the engine ASKED to persist**. This
 * decorator sits in front of a {@link RunStore} and records, per run, the order of asks, the order of
 * commits, and each ask's outcome. From those three it can answer the question the log cannot.
 *
 * **What "prefix" means here, precisely.** Committed events, read in sequence order, must be an unbroken
 * leading run of the asked events read in sequence order. `asked=[0,1,2,3]` `committed=[0,1,2]` is a PREFIX
 * (the tail was cut by a crash — legitimate). `asked=[0,1,2,3]` `committed=[0,1,3]` is a HOLE, and is the
 * defect. Note the asked list is itself the ground truth for "was there anything between 1 and 3" — which is
 * why a set comparison would pass a holed log and a prefix comparison would not. That distinction is what the
 * harness's own vacuity test mutates.
 *
 * **Ask ORDER is checked separately from the prefix.** A store may commit in order while the engine issued
 * the asks unordered; that is exactly the pre-`CR-10` state and it is a latent defect even when timing hides
 * it. {@link AppendAuditVerdict.askOrderViolations} reports it independently, so an engine change that
 * re-introduces concurrent starts goes red on a synchronous store where the commit order would still look
 * fine.
 *
 * **Scoped per RUN SEGMENT, not per runId for all time.** A resume re-seeds the bus from the durable maximum
 * (`bus.seedSequence(runId, lastSequenceNumber + 1)`), so a resumed leg legitimately begins at a sequence far
 * above 0 and its asks are a continuation, not a fresh prefix. {@link createAppendAudit} therefore treats each
 * decorator instance as one segment; a caller auditing a resume wraps the store again for the second leg.
 *
 * Exported from `packages/core` as a supported testing API, the same way `checkDurableTruth` is — `CR-92`'s
 * acceptance has to be certified in `apps/cli` against the real `history.db` store, not only against the
 * in-memory reference.
 */

import type { RunEvent } from '@relavium/shared';

import type { InterruptedRun, RunStore } from './execution-host.js';

/** One recorded `persistEvent` call. `committedAt` is the ask index of the commit, so order is comparable. */
export interface AppendAskRecord {
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly type: RunEvent['type'];
  /** 0-based position in the ASK order — when `persistEvent` was called. */
  readonly askIndex: number;
  /** 0-based position in the COMMIT order — when it resolved. `undefined` while in flight or if it rejected. */
  readonly commitIndex: number | undefined;
  readonly outcome: 'pending' | 'committed' | 'rejected';
}

export interface AppendAuditVerdict {
  readonly holds: boolean;
  readonly runId: string;
  /** Sequence numbers the engine asked to persist, in ask order. */
  readonly asked: readonly number[];
  /** Sequence numbers that committed, in commit order. */
  readonly committed: readonly number[];
  /**
   * A committed event with an EARLIER-sequenced ask that did not commit — the hole `CR-10` exists to remove.
   * Empty when the committed set is a clean prefix (including the empty and fully-committed cases).
   */
  readonly holes: readonly number[];
  /** Asks issued out of sequence order — the pre-`CR-10` concurrent start, visible even when commits are ordered. */
  readonly askOrderViolations: readonly string[];
  /** Commits that landed out of sequence order. */
  readonly commitOrderViolations: readonly string[];
  /** One sentence per violation, in the order checked. Empty iff `holds`. */
  readonly problems: readonly string[];
}

export interface AppendAudit {
  /** The decorated store to hand to `createInMemoryHost` / a real host. */
  readonly store: RunStore;
  /** Every recorded ask, in ask order, across all runs. */
  readonly records: () => readonly AppendAskRecord[];
  /** The verdict for one run segment. */
  readonly verdict: (runId: string) => AppendAuditVerdict;
  /** Run ids this segment has seen an ask for, in first-ask order. */
  readonly runIds: () => readonly string[];
}

/**
 * Fail a persist deliberately — the injection point the acceptance tests drive.
 *
 * Returning `'commit'` lets the write through. Returning a rejection makes the ask fail, which is how a hole
 * is MANUFACTURED: fail sequence `N` while letting `N+1` through, and a store without an ordered tail commits
 * `N+1` anyway. With the tail in place the engine never issues `N+1`'s ask at all, which is the property
 * under test — so the two halves of `CR-10` are checked by two different assertions on the same fixture.
 */
export type AppendFault = (event: RunEvent, askIndex: number) => 'commit' | Error;

export interface AppendAuditOptions {
  /** Decide per ask whether the inner store is called. Default: always commit. */
  readonly fault?: AppendFault;
}

function isBefore(a: number, b: number): boolean {
  return a < b;
}

/** Wrap a {@link RunStore} so its append behaviour can be audited. The inner store is otherwise untouched. */
export function createAppendAudit(inner: RunStore, options: AppendAuditOptions = {}): AppendAudit {
  const records: AppendAskRecord[] = [];
  const mutable: {
    runId: string;
    sequenceNumber: number;
    type: RunEvent['type'];
    askIndex: number;
    commitIndex: number | undefined;
    outcome: 'pending' | 'committed' | 'rejected';
  }[] = [];
  let commitCounter = 0;

  const store: RunStore = {
    resolveWorkflowId: (slug) => inner.resolveWorkflowId(slug),
    listInterruptedRuns: (): Promise<readonly InterruptedRun[]> => inner.listInterruptedRuns(),
    persistEvent: async (event: RunEvent): Promise<void> => {
      // A dual event with no runId is out of the run store's scope, exactly as `InMemoryRunStore` treats it.
      // Recording it would put a `sessionId`-only event into a run's ask list and manufacture a false hole.
      if (event.runId === undefined) {
        await inner.persistEvent(event);
        return;
      }
      const entry = {
        runId: event.runId,
        sequenceNumber: event.sequenceNumber,
        type: event.type,
        askIndex: mutable.length,
        commitIndex: undefined as number | undefined,
        outcome: 'pending' as 'pending' | 'committed' | 'rejected',
      };
      mutable.push(entry);
      records.push(entry);

      const fault = options.fault?.(event, entry.askIndex) ?? 'commit';
      if (fault !== 'commit') {
        entry.outcome = 'rejected';
        throw fault;
      }
      try {
        await inner.persistEvent(event);
      } catch (error) {
        entry.outcome = 'rejected';
        throw error;
      }
      entry.commitIndex = commitCounter;
      commitCounter += 1;
      entry.outcome = 'committed';
    },
  };

  const verdict = (runId: string): AppendAuditVerdict => {
    const mine = mutable.filter((r) => r.runId === runId);
    const asked = mine.map((r) => r.sequenceNumber);
    const committedRecords = mine
      .filter((r) => r.outcome === 'committed')
      .sort((a, b) => (a.commitIndex ?? 0) - (b.commitIndex ?? 0));
    const committed = committedRecords.map((r) => r.sequenceNumber);

    const problems: string[] = [];

    // 1. THE PREFIX PROPERTY. Read both lists in SEQUENCE order — commit order is checked separately below,
    //    and conflating them would report a re-ordered-but-complete log as a hole.
    const askedBySeq = [...mine].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const committedSeqs = new Set(committed);
    const firstMissing = askedBySeq.find((r) => !committedSeqs.has(r.sequenceNumber));
    const holes =
      firstMissing === undefined
        ? []
        : askedBySeq
            .filter(
              (r) =>
                isBefore(firstMissing.sequenceNumber, r.sequenceNumber) &&
                committedSeqs.has(r.sequenceNumber),
            )
            .map((r) => r.sequenceNumber);
    if (holes.length > 0) {
      problems.push(
        `the durable log is not a PREFIX of what was asked: sequence ${String(firstMissing?.sequenceNumber)} ` +
          `(${String(firstMissing?.type)}) never committed, yet ${JSON.stringify(holes)} did — a crash here ` +
          `leaves a log whose reader cannot tell the hole from an event that was never persisted`,
      );
    }

    // 2. ASK ORDER, independently. This is the half a synchronous store hides: it can commit in order while
    //    the engine issued the asks concurrently, which is the pre-CR-10 state and a latent defect.
    const askOrderViolations: string[] = [];
    for (let i = 1; i < mine.length; i += 1) {
      const prev = mine[i - 1];
      const cur = mine[i];
      if (prev === undefined || cur === undefined) continue;
      if (cur.sequenceNumber < prev.sequenceNumber) {
        askOrderViolations.push(
          `ask #${String(i)} is sequence ${String(cur.sequenceNumber)} (${cur.type}) after ` +
            `#${String(i - 1)}'s ${String(prev.sequenceNumber)} (${prev.type})`,
        );
      }
    }
    if (askOrderViolations.length > 0) {
      problems.push(
        `the engine ISSUED appends out of sequence order (${String(askOrderViolations.length)}): ` +
          `${askOrderViolations.join('; ')} — the store may still have committed them in order, which is ` +
          `timing, not a guarantee`,
      );
    }

    // 3. COMMIT ORDER. What the store actually did with the asks it accepted.
    const commitOrderViolations: string[] = [];
    for (let i = 1; i < committed.length; i += 1) {
      const prev = committed[i - 1];
      const cur = committed[i];
      if (prev === undefined || cur === undefined) continue;
      if (cur < prev) {
        commitOrderViolations.push(`sequence ${String(cur)} committed after ${String(prev)}`);
      }
    }
    if (commitOrderViolations.length > 0) {
      problems.push(
        `the store COMMITTED out of sequence order (${String(commitOrderViolations.length)}): ` +
          `${commitOrderViolations.join('; ')}`,
      );
    }

    return {
      holds: problems.length === 0,
      runId,
      asked,
      committed,
      holes,
      askOrderViolations,
      commitOrderViolations,
      problems,
    };
  };

  return {
    store,
    records: () => records,
    verdict,
    runIds: () => [...new Set(mutable.map((r) => r.runId))],
  };
}

/** Render a verdict for an assertion message — every list on its own line, so the diff reads at a glance. */
export function formatAppendAudit(verdict: AppendAuditVerdict): string {
  return [
    `append audit for run ${verdict.runId}: ${verdict.holds ? 'HOLDS' : 'VIOLATED'}`,
    `  asked    : ${JSON.stringify(verdict.asked)}`,
    `  committed: ${JSON.stringify(verdict.committed)}`,
    ...verdict.problems.map((p) => `  ✖ ${p}`),
  ].join('\n');
}
