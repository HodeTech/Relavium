/**
 * The append-audit harness (`CR-10`) — is the durable log a PREFIX of what the engine asked to persist?
 *
 * **Why this cannot be a log assertion, which is the whole reason the file exists.** `CR-10`'s property is
 * "no persisted event is missing from the middle". That is not expressible from the durable log alone: the
 * run's sequence numbers are shared with STREAMED events (`agent:token`, `agent:reasoning`, `cost:updated`, …)
 * which take a number and are deliberately never persisted, so a healthy completed run reads
 * `[0,1,2,3,5,10,11,12,13,14]` and a streamed event's absence is byte-identical to a lost one. Asserting
 * `0..n-1` fails a correct engine — measured, in the durable-truth oracle, which records the same limitation
 * and points here (`durable-truth.ts`, `checkLogShape`).
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
 * **OVERLAP is the predicate that expresses the ordered append, and it is not the same as ask ORDER.** This
 * distinction was measured, after a first version of this file got it wrong and said so in its own docblock.
 * ADR-0078 §1's property is *"ask `N+1` is not ISSUED until `N` has SETTLED"* — and `askOrderViolations`
 * cannot express it: the engine assigns the sequence number and starts the persist with **no await between
 * them**, so its asks go out in sequence order whether or not they overlap. Run the pre-`CR-10` emit shape
 * (persists started concurrently, in sequence order) against a synchronous store and the prefix, ask-order and
 * commit-order predicates all verdict HOLDS — so `CR-10`'s own acceptance clause, *"break-verify by restoring
 * the concurrent start"*, would go GREEN against the instrument built to prove it.
 *
 * {@link AppendAuditVerdict.overlapViolations} states the property directly: an ask issued for a run while a
 * prior ask for that run is still in flight. {@link AppendAuditVerdict.askOrderViolations} stays as a
 * separate, weaker check — it catches a *differently* broken engine, one that assigns and issues out of
 * sequence — and neither subsumes the other.
 *
 * **When it actually fires against today's engine — measured end to end, not inferred.** A single sequential
 * producer never trips it: every `#emitDurable` call site awaits, and `#emitDurable` awaits its own region
 * before returning, so an ordinary `input → agent → output` run reports zero overlaps (asked and committed
 * both `[0,1,2,3,6,7,8,9,10]`). It fires under GENUINE concurrency — a `max_parallel: 2` fan-out produced
 * exactly one: *"sequence 10 (node:completed) was asked while [9] was still in flight"*. That matches
 * ADR-0078 §1's own careful phrasing, *"nothing but timing prevents it"*, and an earlier draft of this
 * paragraph which claimed the engine overlaps on every event was simply wrong.
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

/** One recorded `persistEvent` call. */
export interface AppendAskRecord {
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly type: RunEvent['type'];
  /** 0-based position in the ASK order — when `persistEvent` was called. */
  readonly askIndex: number;
  /**
   * 0-based position in the COMMIT order, from a counter shared across runs — so it orders commits within
   * any single run even though its absolute value spans them. `undefined` while in flight, or if the ask
   * rejected.
   */
  readonly commitIndex: number | undefined;
  readonly outcome: 'pending' | 'committed' | 'rejected';
  /**
   * Sequence numbers for the SAME run that were still in flight when this ask was issued. Non-empty means the
   * engine did not wait — the ordered-append property ADR-0078 §1 establishes, stated as data.
   */
  readonly overlappedWith: readonly number[];
  /**
   * The belief the caller carried in its {@link DurableWriteContext}, or `undefined` for an unguarded
   * append. Recorded so a WRONG belief is visible in the record rather than only as a store rejection —
   * the harness's whole job is to see the ask side, and the belief is the ask's most load-bearing field.
   */
  readonly expectedLastSequenceNumber: number | undefined;
}

/**
 * The internal writer's view: {@link AppendAskRecord} with its `readonly`s removed, DERIVED rather than
 * hand-copied. One array holds these and `records()` hands the same objects out under the readonly interface,
 * so there is no second array to drift and no widening `as` at the construction site.
 */
type MutableAskRecord = { -readonly [K in keyof AppendAskRecord]: AppendAskRecord[K] };

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
  /**
   * Asks issued while a prior ask for the same run was still in flight — the ordered-append property stated
   * directly, and the ONE predicate that separates the pre-`CR-10` engine from the post-`CR-10` one. See the
   * module docblock: the other three all verdict HOLDS against a concurrent start on a synchronous store.
   */
  readonly overlapViolations: readonly string[];
  /** Asks issued out of SEQUENCE order — a differently broken engine, not the concurrent start. */
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
 * `N+1` anyway.
 *
 * **Which section of ADR-0078 stops that, stated because a first draft of this comment got it backwards.**
 * §1's tail does NOT stop the later ask from being issued — §6 deliberately preserves `#emitDurable`'s
 * totality for non-terminal events, so a failed write is absorbed and the run keeps emitting. What stops the
 * hole is §2's compare-and-append, which REJECTS the later append at the store. The two halves are therefore
 * checked by two different assertions: {@link AppendAuditVerdict.overlapViolations} for §1's ordering, and
 * {@link AppendAuditVerdict.holes} for §2's guard.
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
  const records: MutableAskRecord[] = [];
  let commitCounter = 0;

  const store: RunStore = {
    resolveWorkflowId: (slug) => inner.resolveWorkflowId(slug),
    listInterruptedRuns: (): Promise<readonly InterruptedRun[]> => inner.listInterruptedRuns(),
    // Typed as the port's own member rather than re-spelled, so `CR-11`'s fencing token and `CR-12`'s
    // journal correlation cannot be dropped here the way `CR-10`'s guard was: a decorator that names the
    // signature by hand silently keeps compiling when the signature grows, and this one did — it forwarded
    // only the event, so ADR-0078 §2's compare-and-append was OFF for every store the harness wrapped.
    // Found by review; the harness built to certify CR-10 was disabling the thing it certifies.
    persistEvent: async (event, ctx): Promise<void> => {
      // A dual event with no runId is out of the run store's scope, exactly as `InMemoryRunStore` treats it.
      // What this guard actually buys — corrected, because the first version of this comment claimed the
      // wrong thing: false-hole protection comes from the per-run filter in `verdict` below, which would drop
      // a `runId`-less record anyway. The guard keeps such an event out of `records()`, out of `runIds()`,
      // and out of the `askIndex` numbering the `fault` hook sees — so an auditing caller's indices count the
      // run's own appends and nothing else.
      if (event.runId === undefined) {
        await inner.persistEvent(event, ctx);
        return;
      }
      // THE ordered-append observation, taken at ask time because it cannot be reconstructed afterwards: a
      // settled record looks identical whether or not something else was in flight beside it.
      const overlappedWith = records
        .filter((r) => r.runId === event.runId && r.outcome === 'pending')
        .map((r) => r.sequenceNumber);
      const entry: MutableAskRecord = {
        runId: event.runId,
        sequenceNumber: event.sequenceNumber,
        type: event.type,
        askIndex: records.length,
        commitIndex: undefined,
        outcome: 'pending',
        overlappedWith,
        expectedLastSequenceNumber: ctx?.expectedLastSequenceNumber,
      };
      records.push(entry);

      // ONE try/catch over BOTH the fault hook and the inner write, and the hook has to be inside it.
      // `AppendFault` is typed to RETURN an `Error`, but a caller can throw one instead — a store double
      // that throws synchronously is the obvious way to write it, and `better-sqlite3` throws synchronously
      // for real. Left outside, such a throw escaped before `outcome` was set, orphaning the entry at
      // `pending` FOREVER: every later ask on that run then reads it as still-in-flight and reports a false
      // overlap, so the predicate this harness exists for would fire on a correctly ordered engine. Found in
      // the second review round, after a first round of 41 agents did not.
      try {
        const fault = options.fault?.(event, entry.askIndex) ?? 'commit';
        if (fault !== 'commit') throw fault;
        await inner.persistEvent(event, ctx);
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
    const mine = records.filter((r) => r.runId === runId);
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

    // 2. OVERLAP — the ordered-append property itself, and the only predicate here that separates the
    //    pre-CR-10 engine from the post-CR-10 one. Measured: with a concurrent start on a synchronous store,
    //    every OTHER predicate in this function verdicts HOLDS, so CR-10's own "break-verify by restoring the
    //    concurrent start" would have gone green against the instrument built to prove it.
    const overlapViolations: string[] = [];
    for (const record of mine) {
      if (record.overlappedWith.length > 0) {
        overlapViolations.push(
          `sequence ${String(record.sequenceNumber)} (${record.type}) was asked while ` +
            `${JSON.stringify(record.overlappedWith)} ${record.overlappedWith.length === 1 ? 'was' : 'were'} ` +
            `still in flight`,
        );
      }
    }
    if (overlapViolations.length > 0) {
      problems.push(
        `the engine did not WAIT for the previous append to settle (${String(overlapViolations.length)}): ` +
          `${overlapViolations.join('; ')} — the writes overlap, so nothing but the store's timing keeps the ` +
          `log a prefix`,
      );
    }

    // 3. ASK ORDER. A weaker, DIFFERENT check: an engine that assigns and issues out of sequence. Neither
    //    this nor the overlap predicate subsumes the other — an engine can overlap in perfect sequence order
    //    (today's) or issue sequentially out of order (a broken seq assignment).
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

    // 4. COMMIT ORDER. What the store actually did with the asks it accepted.
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
      overlapViolations,
      askOrderViolations,
      commitOrderViolations,
      problems,
    };
  };

  return {
    store,
    records: () => records,
    verdict,
    runIds: () => [...new Set(records.map((r) => r.runId))],
  };
}

/** Render a verdict for an assertion message — every list on its own line, so the diff reads at a glance. */
export function formatAppendAudit(verdict: AppendAuditVerdict): string {
  return [
    `append audit for run ${verdict.runId}: ${verdict.holds ? 'HOLDS' : 'VIOLATED'}`,
    `  asked    : ${JSON.stringify(verdict.asked)}`,
    `  committed: ${JSON.stringify(verdict.committed)}`,
    `  overlaps : ${String(verdict.overlapViolations.length)}`,
    ...verdict.problems.map((p) => `  ✖ ${p}`),
  ].join('\n');
}
