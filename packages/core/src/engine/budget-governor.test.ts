import { describe, expect, it } from 'vitest';
import {
  estimateMaxNextCost,
  type EndpointKind,
  type PricingOverlay,
  type ProviderId,
} from '@relavium/llm';
import type { Budget } from '@relavium/shared';

import {
  BudgetExceededError,
  BudgetGovernor,
  BudgetPauseError,
  CommitmentDurabilityError,
  isBudgetExceededError,
  isBudgetPauseError,
  type BudgetAdmission,
  type GovernorEventDraft,
} from './budget-governor.js';

describe('BudgetGovernor', () => {
  const budget: Budget = { max_cost_microcents: 1_000_000, on_exceed: 'warn' };

  function makeGovernor(
    overrides: {
      budget?: Budget;
      defaultMaxTokensEstimate?: number;
      resolvePrice?: PricingOverlay;
      resolveEndpoint?: (provider: ProviderId) => EndpointKind;
      /** Let a test make the durable write FAIL — ADR-0074 §2's "never releases capacity" path. */
      emitOutcome?: (event: GovernorEventDraft) => Promise<void>;
    } = {},
  ): {
    governor: BudgetGovernor;
    emitted: GovernorEventDraft[];
    /** The `budget:warning` subset — what every pre-ADR-0074 assertion in this file is about. */
    warnings: Extract<GovernorEventDraft, { type: 'budget:warning' }>[];
    unpriced: string[];
  } {
    const emitted: GovernorEventDraft[] = [];
    const warnings: Extract<GovernorEventDraft, { type: 'budget:warning' }>[] = [];
    const unpriced: string[] = [];
    const governor = new BudgetGovernor({
      budget: overrides.budget ?? budget,
      ...(overrides.defaultMaxTokensEstimate === undefined
        ? {}
        : { defaultMaxTokensEstimate: overrides.defaultMaxTokensEstimate }),
      ...(overrides.resolvePrice === undefined ? {} : { resolvePrice: overrides.resolvePrice }),
      ...(overrides.resolveEndpoint === undefined
        ? {}
        : { resolveEndpoint: overrides.resolveEndpoint }),
      onUnpriced: (model) => unpriced.push(model),
      emit: (event) => {
        emitted.push(event);
        if (event.type === 'budget:warning') warnings.push(event);
        return overrides.emitOutcome?.(event) ?? Promise.resolve();
      },
    });
    return { governor, emitted, warnings, unpriced };
  }

  it('allows a call whose estimate stays within the cap', async () => {
    const { governor, warnings } = makeGovernor();
    governor.updateCost(0);
    const admission = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(admission).toBeDefined();
    admission?.release();
    expect(warnings).toHaveLength(0);
  });

  it('dedupes an unchanged overage, then re-arms after realized spend with the projected threshold', async () => {
    const { governor, warnings } = makeGovernor();
    governor.updateCost(900_000);
    const first = await governor.checkPreEgress('claude-sonnet-4-6', 10_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.spentMicrocents).toBe(900_000);
    // The estimate carries the projection far beyond the cap, so the advisory percentage describes the proposed
    // post-call state rather than the misleading pre-call 90% value.
    expect(warnings[0]?.thresholdPct).toBe(100);

    // The same standing condition is one notice, even though warn mode admits both calls.
    const duplicate = await governor.checkPreEgress('claude-sonnet-4-6', 10_000);
    expect(warnings).toHaveLength(1);
    duplicate?.release();

    // A successful attempt replaces its reservation with actual spend. That new spend re-arms the advisory path
    // for a long-lived session, rather than leaving it permanently silent after its first overage.
    first?.settle(100_000);
    governor.updateCost(1_000_000); // mirrors the authoritative engine/session cost event after settlement
    const continued = await governor.checkPreEgress('claude-sonnet-4-6', 10_000);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]?.spentMicrocents).toBe(1_000_000);
    expect(warnings[1]?.thresholdPct).toBe(100);
    continued?.release();
  });

  it('makes concurrent warning admissions await one durable write, including a synchronous re-entry', async () => {
    const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
    let emits = 0;
    let resolveEmission: (() => void) | undefined;
    const pendingEmission = new Promise<void>((resolve) => {
      resolveEmission = () => resolve();
    });
    let reentrant: Promise<BudgetAdmission | undefined> | undefined;
    const governor = new BudgetGovernor({
      budget: {
        max_cost_microcents: estimatedCallCost + Math.floor(estimatedCallCost / 2),
        on_exceed: 'warn',
      },
      emit: () => {
        emits += 1;
        // A durable sink can synchronously call back into the governor (for example through an event listener).
        // The in-flight promise must already be installed, or this becomes recursive duplicate emission/egress.
        if (reentrant === undefined) {
          reentrant = governor.checkPreEgress('claude-haiku-4-5', 1000);
        }
        return pendingEmission;
      },
    });
    governor.updateCost(Math.floor(estimatedCallCost / 2) + 1);

    const outer = governor.checkPreEgress('claude-haiku-4-5', 1000);
    await Promise.resolve(); // enter the deferred durable sink
    expect(emits).toBe(1);
    if (reentrant === undefined || resolveEmission === undefined) {
      throw new Error('expected the warning sink to create one re-entrant admission');
    }

    let reentrantSettled = false;
    void reentrant.then(() => {
      reentrantSettled = true;
    });
    await Promise.resolve();
    expect(reentrantSettled).toBe(false); // it cannot egress while the first durable write may still fail

    resolveEmission();
    const [outerAdmission, reentrantAdmission] = await Promise.all([outer, reentrant]);
    expect(emits).toBe(1);
    outerAdmission?.release();
    reentrantAdmission?.release();
  });

  it('rolls every concurrent warning reservation back when their shared durable write rejects', async () => {
    const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
    let emits = 0;
    let rejectEmission: ((error: Error) => void) | undefined;
    const pendingEmission = new Promise<void>((_resolve, reject) => {
      rejectEmission = (error) => reject(error);
    });
    const governor = new BudgetGovernor({
      budget: {
        max_cost_microcents: estimatedCallCost + Math.floor(estimatedCallCost / 2),
        on_exceed: 'warn',
      },
      emit: () => {
        emits += 1;
        return pendingEmission;
      },
    });
    governor.updateCost(Math.floor(estimatedCallCost / 2) + 1);

    const first = governor.checkPreEgress('claude-haiku-4-5', 1000);
    const second = governor.checkPreEgress('claude-haiku-4-5', 1000);
    await Promise.resolve();
    if (rejectEmission === undefined) throw new Error('expected the warning sink to be pending');
    rejectEmission(new Error('durable warning sink failed'));
    await expect(Promise.all([first, second])).rejects.toThrow('durable warning sink failed');
    expect(emits).toBe(1);

    // Both failed callers released their separate reservations. A below-cap retry must not see a ghost lease.
    governor.updateCost(0);
    const retry = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(retry).toBeDefined();
    retry?.release();
  });

  it('keeps a newly re-armed warning armed when an older warning finishes persisting', async () => {
    const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
    let emits = 0;
    let resolveEmission: (() => void) | undefined;
    const pendingEmission = new Promise<void>((resolve) => {
      resolveEmission = () => resolve();
    });
    const governor = new BudgetGovernor({
      budget: {
        max_cost_microcents: estimatedCallCost + Math.floor(estimatedCallCost / 2),
        on_exceed: 'warn',
      },
      emit: () => {
        emits += 1;
        return emits === 1 ? pendingEmission : Promise.resolve();
      },
    });

    // First call is under the cap and holds a live reservation. The second crosses the cap and starts a durable
    // warning write. Settling the first with real spend re-arms the latch WHILE that write is still in flight.
    const first = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    const warning = governor.checkPreEgress('claude-haiku-4-5', 1000);
    await Promise.resolve();
    first?.settle(estimatedCallCost);
    if (resolveEmission === undefined)
      throw new Error('expected the first warning sink to be pending');
    resolveEmission();
    const warningAdmission = await warning;
    warningAdmission?.release();

    const continued = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(emits).toBe(2);
    continued?.release();
  });

  it('atomically reserves a priced call so a concurrent admission cannot overspend the cap', async () => {
    const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
    const { governor } = makeGovernor({
      budget: {
        max_cost_microcents: estimatedCallCost + Math.floor(estimatedCallCost / 2),
        on_exceed: 'fail',
      },
    });

    const first = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(first).toBeDefined();
    await expect(governor.checkPreEgress('claude-haiku-4-5', 1000)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );

    // A failed/cancelled attempt has no attributable charge, so its reservation releases capacity for the next one.
    first?.release();
    const retry = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(retry).toBeDefined();
    retry?.release();
  });

  it('reconciles one reservation with realized cost exactly once before the engine syncs its total', async () => {
    const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
    const { governor } = makeGovernor({
      budget: { max_cost_microcents: estimatedCallCost + 100_000, on_exceed: 'fail' },
    });

    const first = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(first).toBeDefined();
    first?.settle(100_000);
    first?.settle(999_999); // idempotent: an accidental second completion cannot inflate the ledger
    first?.release();

    // The reservation is gone, but its actual charge remains. The later authoritative sync is the same total,
    // not a second charge, so a next call exactly at the cap is still admitted.
    governor.updateCost(100_000);
    const next = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(next).toBeDefined();
    next?.release();
  });

  describe('typed error discriminants (D10)', () => {
    it('carries a stable `code` on both cap errors, narrowable without instanceof', () => {
      // D10, and it must precede Wave 3's `RelaviumError` migration. The guards exist because `instanceof` is
      // unsafe from a surface: the CLI bundles the engine, so two realizations of a class coexist and `instanceof`
      // answers `false` at exactly the boundary that has to catch it.
      const exceeded = new BudgetExceededError(10, 5, 12);
      const paused = new BudgetPauseError(10, 5, 90);
      expect(exceeded.code).toBe('budget_exceeded');
      expect(paused.code).toBe('budget_paused');
      expect(isBudgetExceededError(exceeded)).toBe(true);
      expect(isBudgetPauseError(paused)).toBe(true);
      // The discriminants are DISJOINT — a guard must not admit its sibling.
      expect(isBudgetExceededError(paused)).toBe(false);
      expect(isBudgetPauseError(exceeded)).toBe(false);
      expect(isBudgetExceededError(new CommitmentDurabilityError(new Error('x')))).toBe(false);
    });

    it('rejects a non-Error that merely carries the code', () => {
      // The guard requires `instanceof Error` before looking at `code`, so a bare payload shaped like the error
      // cannot smuggle itself past a catch.
      expect(isBudgetExceededError({ code: 'budget_exceeded' })).toBe(false);
      expect(isBudgetPauseError('budget_paused')).toBe(false);
      expect(isBudgetExceededError(undefined)).toBe(false);
    });
  });

  describe('durable conservative commitments (ADR-0074 §1/§2)', () => {
    it('emits budget:estimate_committed with the identity, the delta, and a cumulative that INCLUDES it', async () => {
      const { governor, emitted } = makeGovernor();
      const admission = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      admission?.settleAtReservedEstimate({ nodeId: 'g', attemptNumber: 2 });
      await governor.flushCommitments();

      expect(governor.conservativeDurabilityBroken).toBe(false); // clean until proven otherwise
      const commits = emitted.filter((e) => e.type === 'budget:estimate_committed');
      expect(commits).toHaveLength(1);
      const [commit] = commits;
      expect(commit?.nodeId).toBe('g');
      expect(commit?.attemptNumber).toBe(2);
      expect(commit?.model).toBe('claude-haiku-4-5');
      expect(commit?.estimateMicrocents).toBe(estimateMaxNextCost('claude-haiku-4-5', 1000));
      // Read AFTER the increment. The reverse is the one bug the schema refinement exists to catch, and it would
      // restore a total that forgets this commitment — silently reopening the cap.
      expect(commit?.cumulativeConservativeMicrocents).toBe(commit?.estimateMicrocents);
      expect(governor.conservativeCostMicrocents).toBe(commit?.estimateMicrocents);
    });

    it('OMITS nodeId/attemptNumber for a session turn, which has neither', async () => {
      const { governor, emitted } = makeGovernor();
      const admission = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      admission?.settleAtReservedEstimate(); // no origin — the chat path
      await governor.flushCommitments();

      const [commit] = emitted.filter((e) => e.type === 'budget:estimate_committed');
      // ABSENT, not undefined: an explicit `undefined` retains the key, and the store's
      // `'nodeId' in event ? … : null` projection reads that differently.
      expect(commit !== undefined && 'nodeId' in commit).toBe(false);
      expect(commit !== undefined && 'attemptNumber' in commit).toBe(false);
    });

    it('carries a RUNNING cumulative whose deltas sum to the total (the restore rule)', async () => {
      // ADR-0074 §2's restore rule is a SUM of `estimateMicrocents`, never last-wins over the snapshot. Pin both:
      // each event's own delta, and that they add up to what the governor holds.
      const { governor, emitted } = makeGovernor();
      for (let i = 0; i < 3; i += 1) {
        const admission = await governor.checkPreEgress('claude-haiku-4-5', 1000);
        admission?.settleAtReservedEstimate({ nodeId: 'g' });
      }
      await governor.flushCommitments();

      const commits = emitted.filter((e) => e.type === 'budget:estimate_committed');
      expect(commits).toHaveLength(3);
      const summed = commits.reduce((total, e) => total + e.estimateMicrocents, 0);
      expect(summed).toBe(governor.conservativeCostMicrocents);
      expect(commits.at(-1)?.cumulativeConservativeMicrocents).toBe(summed);
    });

    it('makes the NEXT pre-egress check wait for the prior commitment`s durable write', async () => {
      // §2's barrier: the crash window between a possibly-billable call and its durable record. Without the
      // await, the next attempt is admitted while the first commitment's write could still fail.
      let resolveWrite: (() => void) | undefined;
      const { governor } = makeGovernor({
        emitOutcome: (event) =>
          event.type === 'budget:estimate_committed'
            ? new Promise<void>((resolve) => {
                resolveWrite = resolve;
              })
            : Promise.resolve(),
      });
      const admission = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      admission?.settleAtReservedEstimate({ nodeId: 'g' });

      let admitted = false;
      const next = governor.checkPreEgress('claude-haiku-4-5', 1000).then((a) => {
        admitted = true;
        return a;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(admitted).toBe(false); // still blocked on the durable write
      resolveWrite?.();
      await next;
      expect(admitted).toBe(true);
    });

    it('a FAILED durable write never releases capacity, and fails the owner loudly', async () => {
      // §2, both halves. The in-memory debit must survive (the provider may have billed) AND the owner must be
      // told, because it is now spending against a cap whose state will not survive a crash.
      const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
      const { governor } = makeGovernor({
        budget: { max_cost_microcents: estimatedCallCost * 10, on_exceed: 'fail' },
        emitOutcome: (event) =>
          event.type === 'budget:estimate_committed'
            ? Promise.reject(new Error('disk full'))
            : Promise.resolve(),
      });
      const admission = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      admission?.settleAtReservedEstimate({ nodeId: 'g' });

      // Capacity NOT reopened — the conservative debit stands even though its write failed.
      expect(governor.conservativeCostMicrocents).toBe(estimatedCallCost);
      // And the failure surfaces at the barrier rather than vanishing as an unhandled rejection.
      // A TYPED failure carrying the original as `cause`, not a re-thrown unknown — so the engine narrows on the
      // class rather than on a message, and a log can still show what actually broke.
      const thrown = await governor.flushCommitments().catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(CommitmentDurabilityError);
      expect((thrown as CommitmentDurabilityError).cause).toBeInstanceOf(Error);
      expect(((thrown as CommitmentDurabilityError).cause as Error).message).toBe('disk full');
      expect(governor.conservativeCostMicrocents).toBe(estimatedCallCost); // still not rolled back
      // Surfaced once — a second flush is clean, so the owner is not told the same thing forever.
      await expect(governor.flushCommitments()).resolves.toBeUndefined();
    });

    it('one failed write does not skip the writes that follow it', async () => {
      const failures: string[] = [];
      const { governor, emitted } = makeGovernor({
        emitOutcome: (event) => {
          if (event.type !== 'budget:estimate_committed') return Promise.resolve();
          if (failures.length === 0) {
            failures.push('first');
            return Promise.reject(new Error('transient'));
          }
          return Promise.resolve();
        },
      });
      const a = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      a?.settleAtReservedEstimate({ nodeId: 'g' });
      // The barrier rejects for the first, but the chain must not be poisoned.
      await expect(governor.flushCommitments()).rejects.toBeInstanceOf(CommitmentDurabilityError);
      const b = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      b?.settleAtReservedEstimate({ nodeId: 'h' });
      await governor.flushCommitments();
      expect(emitted.filter((e) => e.type === 'budget:estimate_committed')).toHaveLength(2);
    });

    it('survives a sink that throws SYNCHRONOUSLY instead of bricking for the process', async () => {
      // A `better-sqlite3` write throws synchronously, and §4's transactional persister write will be one. If the
      // emit were called bare inside the `.then`, that throw would escape before `.catch`/`.finally`: no typed
      // error, the pending counter leaked at ≥1 forever, and the chain left permanently REJECTED — so every later
      // `checkPreEgress` would throw at the barrier BEFORE `#admit`, with no way for a new commitment to clear it.
      let mode: 'throw' | 'ok' = 'throw';
      const { governor, emitted } = makeGovernor({
        emitOutcome: (event) => {
          if (event.type === 'budget:estimate_committed' && mode === 'throw') {
            throw new Error('SQLITE_FULL');
          }
          return Promise.resolve();
        },
      });
      const a = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      a?.settleAtReservedEstimate({ nodeId: 'g' });

      // Classified, not escaped raw.
      await expect(governor.flushCommitments()).rejects.toBeInstanceOf(CommitmentDurabilityError);
      // And the governor still WORKS: a later admission and commitment go through.
      mode = 'ok';
      const b = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      expect(b).toBeDefined();
      b?.settleAtReservedEstimate({ nodeId: 'h' });
      await governor.flushCommitments();
      expect(emitted.filter((e) => e.type === 'budget:estimate_committed')).toHaveLength(2);
    });

    it('names the node whose commitment failed, not whichever node flushes first', async () => {
      // Under a `fan_out` both branches await the same chain link, so attributing the failure to the first
      // flusher blames a node that may have made no commitment at all.
      const { governor } = makeGovernor({
        emitOutcome: (event) =>
          event.type === 'budget:estimate_committed'
            ? Promise.reject(new Error('disk full'))
            : Promise.resolve(),
      });
      const a = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      a?.settleAtReservedEstimate({ nodeId: 'branch-b' });
      const thrown = await governor.flushCommitments().catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(CommitmentDurabilityError);
      expect((thrown as CommitmentDurabilityError).nodeId).toBe('branch-b');
    });

    it('does not FORGET that durability is broken after reporting it once', async () => {
      // The error is surfaced once, so after that nothing would remember — and a long-lived owner (a chat session)
      // would render its conservative amount as if safely recorded when a crash would lose it. §1 requires a
      // surface to show that amount; the sticky flag is how the surface knows to qualify it.
      let failNext = true;
      const { governor } = makeGovernor({
        emitOutcome: (event) => {
          if (event.type !== 'budget:estimate_committed') return Promise.resolve();
          return failNext ? Promise.reject(new Error('disk full')) : Promise.resolve();
        },
      });
      const a = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      a?.settleAtReservedEstimate({ nodeId: 'g' });
      await expect(governor.flushCommitments()).rejects.toBeInstanceOf(CommitmentDurabilityError);

      // A SECOND failure is still reported — proving the barrier is still being entered.
      const b = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      b?.settleAtReservedEstimate({ nodeId: 'h' });
      await expect(governor.flushCommitments()).rejects.toBeInstanceOf(CommitmentDurabilityError);

      // And a clean write afterwards does not throw — the flag REPORTS, it does not permanently block, because
      // the safety property (the debit still consuming capacity in memory) holds regardless.
      failNext = false;
      const c = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      c?.settleAtReservedEstimate({ nodeId: 'i' });
      await expect(governor.flushCommitments()).resolves.toBeUndefined();
      // …but the owner is still marked, which is what a surface reads to qualify the amount it renders.
      expect(governor.conservativeDurabilityBroken).toBe(true);
    });

    it('IGNORES a non-integer or non-positive restore rather than poisoning the next commitment', async () => {
      // A fractional total would ride the next commitment's `cumulativeConservativeMicrocents`, fail
      // `nonNegativeInt` at the bus, and surface a CALLER's bad input as a durability failure that kills the run.
      const { governor, emitted } = makeGovernor();
      for (const bad of [1234.5, -1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
        governor.restoreConservativeCost(bad);
        expect(governor.conservativeCostMicrocents).toBe(0);
      }
      governor.restoreConservativeCost(900);
      const admission = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      admission?.settleAtReservedEstimate({ nodeId: 'g' });
      await governor.flushCommitments();
      const [commit] = emitted.filter((e) => e.type === 'budget:estimate_committed');
      expect(Number.isSafeInteger(commit?.cumulativeConservativeMicrocents)).toBe(true);
    });

    it('restoreConservativeCost seeds a resume and never LOWERS a live total', () => {
      // §2 requires both totals restored before resumed work is scheduled. Taking the max means a double-restore,
      // or a restore racing a live commitment, cannot reopen capacity.
      const { governor } = makeGovernor();
      governor.restoreConservativeCost(900);
      expect(governor.conservativeCostMicrocents).toBe(900);
      governor.restoreConservativeCost(400); // a stale/duplicate restore
      expect(governor.conservativeCostMicrocents).toBe(900);
      governor.restoreConservativeCost(1500);
      expect(governor.conservativeCostMicrocents).toBe(1500);
    });

    it('a restored conservative total consumes cap capacity on the FIRST post-resume check', async () => {
      // The point of restoring it at all: without this the first check after a resume projects against a cap that
      // has forgotten money the provider may already have billed.
      const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
      const { governor } = makeGovernor({
        budget: {
          max_cost_microcents: estimatedCallCost + Math.floor(estimatedCallCost / 2),
          on_exceed: 'fail',
        },
      });
      governor.restoreConservativeCost(estimatedCallCost);
      await expect(governor.checkPreEgress('claude-haiku-4-5', 1000)).rejects.toBeInstanceOf(
        BudgetExceededError,
      );
    });

    it('releaseConservativeCommitments clears it — a user decision, never an engine heuristic', async () => {
      // §1's bound against an indefinite block. The engine never calls this; a surface does, on the user's choice.
      const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
      const { governor } = makeGovernor({
        budget: {
          max_cost_microcents: estimatedCallCost + Math.floor(estimatedCallCost / 2),
          on_exceed: 'fail',
        },
      });
      governor.restoreConservativeCost(estimatedCallCost);
      await expect(governor.checkPreEgress('claude-haiku-4-5', 1000)).rejects.toBeInstanceOf(
        BudgetExceededError,
      );

      expect(governor.releaseConservativeCommitments()).toBe(estimatedCallCost);
      expect(governor.conservativeCostMicrocents).toBe(0);
      // Capacity is genuinely back, so the same call now passes.
      await expect(governor.checkPreEgress('claude-haiku-4-5', 1000)).resolves.toBeDefined();
    });
  });

  it('keeps an uncertain billed attempt as a separate conservative debit across lower durable totals', async () => {
    const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
    const { governor } = makeGovernor({
      budget: {
        max_cost_microcents: estimatedCallCost + Math.floor(estimatedCallCost / 2),
        on_exceed: 'fail',
      },
    });

    const first = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    first?.settleAtReservedEstimate();
    // A usage-less provider attempt has no corresponding durable cost event. An unrelated/older zero total must
    // not erase its bounded debit and allow a second worst-case request through the cap.
    governor.updateCost(0);
    await expect(governor.checkPreEgress('claude-haiku-4-5', 1000)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it('restores a priced reservation for egress already submitted before a checkpoint resume', async () => {
    const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
    const { governor } = makeGovernor({
      budget: {
        max_cost_microcents: estimatedCallCost + Math.floor(estimatedCallCost / 2),
        on_exceed: 'fail',
      },
    });

    const restored = governor.reserveCommittedEgress('claude-haiku-4-5', 1000);
    expect(restored).toBeDefined();
    await expect(governor.checkPreEgress('claude-haiku-4-5', 1000)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    restored?.release();
  });

  it('rolls back a warning-path reservation when warning durability fails', async () => {
    const estimatedCallCost = estimateMaxNextCost('claude-haiku-4-5', 1000);
    let shouldFail = true;
    let emits = 0;
    const governor = new BudgetGovernor({
      budget: {
        max_cost_microcents: estimatedCallCost + Math.floor(estimatedCallCost / 2),
        on_exceed: 'warn',
      },
      emit: () => {
        emits += 1;
        return shouldFail
          ? Promise.reject(new Error('durable warning sink failed'))
          : Promise.resolve();
      },
    });
    governor.updateCost(Math.floor(estimatedCallCost / 2) + 1); // pushes the next call into warn mode

    await expect(governor.checkPreEgress('claude-haiku-4-5', 1000)).rejects.toThrow(
      'durable warning sink failed',
    );

    // Restore a below-cap authoritative state. A leaked reservation would turn this otherwise-allowed call back
    // into warn mode and invoke the sink a second time.
    shouldFail = false;
    governor.updateCost(0);
    const admission = await governor.checkPreEgress('claude-haiku-4-5', 1000);
    expect(emits).toBe(1);
    admission?.release();
  });

  it('fails when on_exceed is fail', async () => {
    const { governor } = makeGovernor({ budget: { ...budget, on_exceed: 'fail' } });
    governor.updateCost(900_000);
    await expect(governor.checkPreEgress('claude-sonnet-4-6', 10_000)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it('the BudgetExceededError carries the spent / limit / projected cost figures', async () => {
    const { governor } = makeGovernor({ budget: { ...budget, on_exceed: 'fail' } });
    governor.updateCost(900_000);
    const err = await governor.checkPreEgress('claude-sonnet-4-6', 10_000).catch((e: unknown) => e);
    if (!(err instanceof BudgetExceededError)) throw new Error('expected a BudgetExceededError'); // narrow (no `as`)
    expect(err.spentMicrocents).toBe(900_000);
    expect(err.limitMicrocents).toBe(1_000_000);
    // sonnet output is $15/MTok = 1_500 micro-cents/token → 10_000 tok projects 15_000_000 on top of the
    // 900_000 already spent (the estimate is output-only).
    expect(err.projectedMicrocents).toBe(900_000 + 15_000_000);
    expect(err.projectedMicrocents).toBeGreaterThan(err.limitMicrocents);
    expect(err.reason).toBe('projected_over_cap');
  });

  it('pauses when on_exceed is pause_for_approval', async () => {
    const { governor } = makeGovernor({ budget: { ...budget, on_exceed: 'pause_for_approval' } });
    governor.updateCost(900_000);
    const err = await governor.checkPreEgress('claude-sonnet-4-6', 10_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetPauseError);
    if (!(err instanceof BudgetPauseError)) throw new Error('expected a BudgetPauseError'); // narrow (no `as`)
    const gate = err.toGateRequest();
    expect(gate.gateType).toBe('approval');
    expect(gate.message).toContain('budget cap');
    expect(gate.spentMicrocents).toBe(900_000);
    expect(gate.limitMicrocents).toBe(1_000_000);
  });

  it('uses the default max_tokens_estimate when maxTokens is omitted', async () => {
    const { governor, warnings } = makeGovernor({
      budget: { ...budget, on_exceed: 'warn' },
      defaultMaxTokensEstimate: 1,
    });
    // At exactly the cap minus the default estimate, the call is allowed.
    governor.updateCost(1_000_000 - 500); // haiku output is 500_000_000 micro-cents/MTok
    const admission = await governor.checkPreEgress('claude-haiku-4-5', undefined);
    admission?.release();
    expect(warnings).toHaveLength(0);
  });

  it('clamps thresholdPct to [0, 100]', async () => {
    const { governor, warnings } = makeGovernor();
    governor.updateCost(2_000_000);
    const admission = await governor.checkPreEgress('claude-sonnet-4-6', 1000);
    admission?.release();
    expect(warnings[0]?.thresholdPct).toBe(100);
  });

  it('treats max_cost_microcents: 0 as unbounded — always allows, never divides by zero', async () => {
    // 0 = unbounded ([chat] semantics). The governor must never block and never reach the thresholdPct
    // division (cumulative / 0 → NaN). Even far "over" a 0 cap, every check resolves with no warning.
    const { governor, warnings } = makeGovernor({
      budget: { max_cost_microcents: 0, on_exceed: 'fail' },
    });
    governor.updateCost(5_000_000);
    await expect(governor.checkPreEgress('claude-sonnet-4-6', 10_000)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  it('degrades to allow (does not crash the run) for any unlisted/unpriced model when strict mode is off', async () => {
    // An unpriced model id has no pricing row → estimateMaxNextCost throws UnknownModelError. With strict mode off,
    // the governor deliberately permits BOTH custom/self-hosted ids and first-party catalog gaps, because it has no
    // trustworthy price estimate for either. It says so once rather than silently pretending the cap applied.
    const { governor, warnings, unpriced } = makeGovernor({
      budget: { ...budget, on_exceed: 'fail' },
    });
    governor.updateCost(900_000);
    await expect(governor.checkPreEgress('my-self-hosted-model', 10_000)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(0); // it did not exceed — nothing WAS billed
    // …but it is UNPRICED, so the cap could not apply, and that is said once (ADR-0071 §K7): a cap that silently
    // does not apply is a false sense of safety.
    expect(unpriced).toEqual(['my-self-hosted-model']);
  });

  describe('strict_cost_cap (ADR-0071 §K7)', () => {
    it('BLOCKS every unpriced model when on — "if you cannot price it, do not run it"', () => {
      // Strict mode intentionally makes no provenance distinction at this seam: both a self-hosted id and a
      // first-party catalog gap are unpriced, so both would leave a user-requested cap unenforceable.
      const { governor } = makeGovernor({
        budget: { ...budget, on_exceed: 'fail', strict_cost_cap: true },
      });
      for (const model of ['my-self-hosted-model', 'unlisted-first-party-model']) {
        const result = governor.evaluatePreEgress(model, 10_000);
        expect(result.kind).toBe('fail');
        if (result.kind === 'fail') {
          expect(result.error.message).toContain('no price');
          expect(result.error.message).toContain('strict_cost_cap');
          expect(result.error.projectedMicrocents).toBeUndefined();
          expect(result.error.reason).toBe('unpriced_model');
        }
      }
    });

    it('does NOT block a PRICED model — strict only bites when we genuinely cannot price', () => {
      const { governor } = makeGovernor({
        budget: { ...budget, on_exceed: 'fail', strict_cost_cap: true },
      });
      governor.updateCost(0);
      expect(governor.evaluatePreEgress('claude-haiku-4-5', 1000).kind).toBe('allow');
    });

    it('does not fabricate an over-cap projection for an unpriced strict refusal while another lease is live', async () => {
      const { governor } = makeGovernor({
        budget: { ...budget, on_exceed: 'fail', strict_cost_cap: true },
      });
      const live = await governor.checkPreEgress('claude-haiku-4-5', 1000);
      const result = governor.evaluatePreEgress('unlisted-first-party-model', 1000);
      expect(result.kind).toBe('fail');
      if (result.kind === 'fail') {
        expect(result.error.spentMicrocents).toBe(0);
        expect(result.error.projectedMicrocents).toBeUndefined();
        expect(result.error.reason).toBe('unpriced_model');
      }
      live?.release();
    });

    it('OFF (the default) permits every unpriced model with a notice, not a block', async () => {
      const { governor, unpriced } = makeGovernor({ budget: { ...budget, on_exceed: 'fail' } });
      // `evaluatePreEgress` classifies; `checkPreEgress` is what APPLIES the result and fires the sink. Drive the
      // applying path, so the "with a notice" in this test's name is actually asserted.
      expect(governor.evaluatePreEgress('my-self-hosted-model', 10_000).kind).toBe('unpriced');
      await expect(
        governor.checkPreEgress('my-self-hosted-model', 10_000),
      ).resolves.toBeUndefined();
      expect(unpriced).toEqual(['my-self-hosted-model']);
    });

    it('is inert without a positive cap, even when strict mode is on', async () => {
      const { governor, unpriced } = makeGovernor({
        budget: { max_cost_microcents: 0, on_exceed: 'fail', strict_cost_cap: true },
      });
      await expect(
        governor.checkPreEgress('unlisted-first-party-model', 10_000),
      ).resolves.toBeUndefined();
      expect(unpriced).toEqual([]);
    });
  });

  it('notifies UNPRICED only once per model — a loop must not repeat it every turn', async () => {
    const { governor, unpriced } = makeGovernor();
    await governor.checkPreEgress('my-self-hosted-model', 1000);
    await governor.checkPreEgress('my-self-hosted-model', 1000);
    await governor.checkPreEgress('another-unpriced-one', 1000);
    expect(unpriced).toEqual(['my-self-hosted-model', 'another-unpriced-one']); // deduped per model
  });

  it('does not let a throwing unpriced advisory sink veto the deliberate allow-degrade decision', async () => {
    let notices = 0;
    const governor = new BudgetGovernor({
      budget: { ...budget, on_exceed: 'fail' },
      emit: () => Promise.resolve(),
      onUnpriced: () => {
        notices += 1;
        throw new Error('renderer unavailable');
      },
    });

    await expect(governor.checkPreEgress('my-self-hosted-model', 1000)).resolves.toBeUndefined();
    await expect(governor.checkPreEgress('my-self-hosted-model', 1000)).resolves.toBeUndefined();
    expect(notices).toBe(1);
  });

  it('accepts a media-unit estimate and folds it as a disjoint addend (1.AF/D17)', () => {
    // No 1.AF model carries a media rate, so the media estimate degrades to 0 — the decision matches the
    // token-only projection (the units×rate math is covered in mediaCost/estimateMediaCost). This pins the
    // wiring: the governor accepts the estimate and never crashes/over-blocks on a media-output turn.
    const { governor } = makeGovernor();
    governor.updateCost(0);
    const tokenOnly = governor.evaluatePreEgress('claude-haiku-4-5', 1000);
    const withMedia = governor.evaluatePreEgress('claude-haiku-4-5', 1000, [
      { modality: 'image', units: 4 },
      { modality: 'audio', units: 30 },
    ]);
    expect(withMedia).toEqual(tokenOnly); // media adds 0 (unrated model) — decision unchanged
    expect(withMedia.kind).toBe('allow');
  });

  it('an unpriced model still degrades to allow even WITH a media estimate (H4)', async () => {
    const { governor } = makeGovernor({ budget: { ...budget, on_exceed: 'fail' } });
    governor.updateCost(900_000);
    await expect(
      governor.checkPreEgress('my-self-hosted-model', 10_000, [{ modality: 'image', units: 2 }]),
    ).resolves.toBeUndefined();
  });

  describe('user-pricing overlay (2.5.G S10, ADR-0065 §2 — closes the cost-cap gap)', () => {
    // A user price for a model the static registry does not know — output $9/MTok so 10_000 tok ⇒ 9_000_000µ¢.
    const OVERLAY: PricingOverlay = new Map([
      [
        'acme-custom-1',
        {
          provider: 'openai',
          nativeId: 'acme-custom-1',
          displayName: 'Acme Custom 1',
          contextWindowTokens: 32_000,
          maxOutputTokens: 4_000,
          inputPerMtokMicrocents: 300_000_000,
          outputPerMtokMicrocents: 900_000_000,
          cachedInputPerMtokMicrocents: 0,
        },
      ],
    ]);

    it('ENFORCES the cap on a user-priced model that WOULD have degraded to allow without the overlay', async () => {
      // THE ACCEPTANCE: with the overlay, `acme-custom-1` is priced, so the projected 9_000_000µ¢ (10_000 out
      // @ $9/MTok) far exceeds the 1_000_000µ¢ cap → fail (not the old silent degrade-to-allow).
      const { governor } = makeGovernor({
        budget: { ...budget, on_exceed: 'fail' },
        resolvePrice: OVERLAY,
      });
      governor.updateCost(0);
      await expect(governor.checkPreEgress('acme-custom-1', 10_000)).rejects.toBeInstanceOf(
        BudgetExceededError,
      );
    });

    it('the SAME model WITHOUT the overlay degrades to allow (proves the overlay is what closes the gap)', async () => {
      const { governor } = makeGovernor({ budget: { ...budget, on_exceed: 'fail' } });
      governor.updateCost(0);
      await expect(governor.checkPreEgress('acme-custom-1', 10_000)).resolves.toBeUndefined();
    });

    it('a user-priced model UNDER the cap is allowed (no false positive)', async () => {
      // 1_000 output tokens @ $9/MTok = 900_000µ¢, under the 1_000_000µ¢ cap → allow, no warning (warn-cap is 0.9).
      const { governor, warnings } = makeGovernor({
        budget: { ...budget, on_exceed: 'fail' },
        resolvePrice: OVERLAY,
      });
      governor.updateCost(0);
      const admission = await governor.checkPreEgress('acme-custom-1', 1_000);
      expect(admission).toBeDefined();
      admission?.release();
      expect(warnings).toHaveLength(0);
    });
  });

  describe('endpoint keys on the ROUTING provider, not the model catalog (review M2)', () => {
    // A custom `openai` gateway (OpenRouter/LiteLLM) serving `deepseek-v4-flash`: the wire is UNCLAMPED (a gateway
    // may serve anything under a familiar id), so the estimate must reflect the FULL request — keyed on the routing
    // provider ('openai' = custom here), never the model's catalog provider ('deepseek' = official) which clamps to
    // the ceiling and under-authorizes. Before M2, resolveEndpoint(model)→catalog provider→official→clamp→allow.
    const HUGE = 10_000_000;
    const resolveEndpoint = (provider: ProviderId): EndpointKind =>
      provider === 'openai' ? 'custom' : 'official';

    it('routes the endpoint by the provider argument — same model, opposite clamp', () => {
      const official = estimateMaxNextCost('deepseek-v4-flash', HUGE, undefined, 'official');
      const custom = estimateMaxNextCost('deepseek-v4-flash', HUGE, undefined, 'custom');
      expect(custom).toBeGreaterThan(official); // the catalog ceiling clamp is real for this model

      // A cap between the clamped and unclamped cost: official passes, custom must not.
      const cap = official + Math.round((custom - official) / 2);
      const { governor } = makeGovernor({
        budget: { max_cost_microcents: cap, on_exceed: 'fail' },
        resolveEndpoint,
      });
      governor.updateCost(0);

      // On its own API (official) → clamped to the ceiling → under the cap → allow.
      expect(
        governor.evaluatePreEgress('deepseek-v4-flash', HUGE, undefined, 'deepseek').kind,
      ).toBe('allow');
      // Through the custom 'openai' gateway → unclamped → over the cap → fail. Keying on the catalog provider
      // ('deepseek') would have wrongly clamped THIS path and waved the overspend through (the M2 defect).
      expect(governor.evaluatePreEgress('deepseek-v4-flash', HUGE, undefined, 'openai').kind).toBe(
        'fail',
      );
    });

    it('omitting the provider (a media-only gate) defaults to official — a harmless no-op at maxTokens 0', () => {
      const { governor } = makeGovernor({
        budget: { ...budget, on_exceed: 'fail' },
        resolveEndpoint,
      });
      governor.updateCost(0);
      // maxTokens 0 → token estimate 0 regardless of endpoint, so the absent provider cannot mis-authorize.
      expect(governor.evaluatePreEgress('deepseek-v4-flash', 0).kind).toBe('allow');
    });
  });
});
