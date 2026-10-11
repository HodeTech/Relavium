/**
 * The owner's money and usage-durability barrier — the single place a caller waits for BOTH kinds of money write
 * ([ADR-0077](../../../../docs/decisions/0077-realized-cost-ledger-uses-the-conservative-commitment-barrier.md)).
 *
 * Realized settlement and incomplete-usage dispositions share this queue. Pending markers are
 * acknowledged before invocation; the same B1/B2/B3 join observes settlement failures.
 *
 * Two events record money and both are emitted from the SAME synchronous `onAttempt` callback, a few lines
 * apart in `agent-turn.ts`: `budget:estimate_committed` (a conservative ESTIMATE, ADR-0074 §2) and
 * `cost:attempt_settled` (the REALIZED charge, ADR-0076). Neither can be awaited at its emit site — the seam's
 * observer is `(record: AttemptRecord) => void` — so each STARTS its durable write there and something joins it
 * later. This owns the realized chain and fronts the join for both.
 *
 * **Why it is not part of `BudgetGovernor`, which is where every signpost points.** The governor owns the
 * conservative chain and `node-executor.ts`'s comment literally says "add it to the governor's emit type
 * instead". But the engine constructs a governor only when the workflow declares a `budget`, and the realized
 * ledger is not optional: an unbudgeted run spends real money and must still record it. Hosting it there would
 * have silently skipped every unbudgeted run while passing any test written against a budgeted fixture.
 *
 * **One join, not two** (ADR-0077 §4). `join()` awaits the realized chain AND the conservative one, and
 * reports whichever failure it finds. `waitForWrites()` separately observes realized-write lifetime
 * without consuming an error; it is not a money barrier or a durability certificate.
 */

import type { UsageDisposition, UsageInvocation } from '@relavium/shared';

export interface PendingUsageDraft {
  readonly nodeId: string;
  readonly model: string;
  readonly round: number;
  readonly chainAttempt: number;
}
export interface UsageDispositionDraft {
  readonly nodeId: string;
  readonly model: string;
  readonly invocation: UsageInvocation;
  readonly disposition: UsageDisposition;
  readonly receiptPending?: true;
}

/** A realized-cost ledger write that did not reach the store. Carries the owning node for attribution. */
export class LedgerDurabilityError extends Error {
  readonly nodeId: string | undefined;

  constructor(cause: unknown, nodeId?: string) {
    // Secret-free by construction: the cause can carry a filesystem path, so it rides `cause` and never the
    // message — the same posture `CommitmentDurabilityError` takes for its estimate twin.
    super('a realized-cost ledger write could not be made durable', { cause });
    this.name = 'LedgerDurabilityError';
    this.nodeId = nodeId;
  }
}

export function isLedgerDurabilityError(error: unknown): error is LedgerDurabilityError {
  return error instanceof LedgerDurabilityError;
}

/** The per-attempt ledger draft, minus the run-wide total the ENGINE stamps (it owns that counter). */
export interface SettledAttemptDraft {
  readonly invocation?: UsageInvocation;
  readonly nodeId: string;
  readonly model: string;
  readonly attemptNumber: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrocents: number;
  readonly priced: boolean;
}

export interface MoneyDurabilityOptions {
  /** Both coverage callbacks are supplied together, or neither for a volatile money owner. */
  readonly beginUsageInvocation?: (draft: PendingUsageDraft) => Promise<UsageInvocation>;
  readonly emitUsageDisposition?: (draft: UsageDispositionDraft) => Promise<void> | void;
  /**
   * Start the durable write for one settled attempt. The engine wires this to `#emitDurable`. **May throw
   * synchronously** — a `better-sqlite3` store does — which is why {@link MoneyDurability.record} never calls
   * it bare.
   *
   * `cumulativeCostMicrocents` is passed IN rather than read here, and that is the whole point of the
   * parameter: the writes are chained, so this callback runs an unbounded time after the attempt it describes
   * — behind the previous write's `persistEvent`, which is real I/O. Reading the engine's live counter at that
   * moment yields the total including every attempt that settled DURING the wait, which under a `fan_out`
   * (concurrent nodes sharing one chain) is a different number. The contract says each absolute is "a true
   * run-wide total at that instant"; only a value captured at `record()` time is.
   */
  readonly emit: (
    draft: SettledAttemptDraft,
    cumulativeCostMicrocents: number,
  ) => Promise<void> | void;
  /**
   * Join the CONSERVATIVE chain, when a budget governor exists. Wired to `BudgetGovernor.flushCommitments`,
   * which throws its own retained failure. Absent on an unbudgeted run — the realized half still applies.
   */
  readonly flushConservative?: () => Promise<void>;
}

/**
 * The port `agent-turn.ts` sees. Narrower than the class on purpose: the turn core may START a write and JOIN
 * the barrier, and has no business inspecting or clearing durability state.
 */
export interface TurnMoneyPort {
  /** Retain late accounting failure independently of an already published terminal. */
  readonly accountingFailure?: (error: unknown) => void;
  readonly emitCost?: (
    event: Extract<import('./node-executor.js').NodeStreamEvent, { type: 'cost:updated' }>,
  ) => void;
  /** The pending/claim/disposition capabilities form one all-or-none coverage feature. */
  readonly beginUsageInvocation?: (draft: PendingUsageDraft) => Promise<UsageInvocation>;
  readonly claimUsage?: (
    invocation: UsageInvocation,
    kind: 'complete' | 'incomplete' | 'released' | 'retired',
  ) => boolean;
  readonly usageDisposition?: (draft: UsageDispositionDraft) => void;
  readonly record: (draft: SettledAttemptDraft) => void;
  readonly join: () => Promise<void>;
}

export class MoneyDurability {
  readonly #options: MoneyDurabilityOptions;

  /**
   * The realized chain. Chaining (rather than a set) serializes the writes, so two attempts settling in the
   * same tick cannot interleave their persists — the same reason ADR-0074 §2 chains its estimates.
   */
  #inFlight: Promise<void> = Promise.resolve();

  /**
   * How many ledger writes are outstanding, so the barrier costs NOTHING when there is nothing to wait for.
   * Awaiting an already-resolved promise still burns a microtask, and the barriers sit on the hot path; worse
   * than the cost, an unconditional await changes observable interleaving that existing tests legitimately
   * pin. Copied from `#pendingCommitments` for exactly those reasons.
   */
  #pending = 0;

  /**
   * A ledger write that FAILED, retained until someone joins the barrier.
   *
   * Nobody awaits the write at its call site, so without this the rejection would be unhandled. It is
   * surfaced ONCE — a later join must not re-report the same broken write as if it were new — while
   * {@link #broken} stays set, so the barrier is still entered and a subsequent failure is still reported.
   */
  #failure: LedgerDurabilityError | undefined;

  /** Sticky: a run whose ledger has ever failed keeps paying the barrier for the rest of the process. */
  #broken = false;
  readonly #usageClaims = new WeakMap<UsageInvocation, 'pending' | 'incomplete' | 'finished'>();

  constructor(options: MoneyDurabilityOptions) {
    if (
      (options.beginUsageInvocation === undefined) !==
      (options.emitUsageDisposition === undefined)
    )
      throw new LedgerDurabilityError(
        new Error('usage durability callbacks must be supplied together'),
      );
    this.#options = options;
  }

  /** Whether a ledger write has ever failed on this run — the state a caller checks alongside the await. */
  get durabilityBroken(): boolean {
    return this.#broken;
  }

  /**
   * START one settled attempt's durable write. Synchronous by necessity (the caller is a chain observer that
   * cannot await) and never awaited here, so a rejection is captured and re-thrown at the next barrier.
   */
  record(draft: SettledAttemptDraft, cumulativeCostMicrocents: number): void {
    this.#pending += 1;
    this.#inFlight = this.#inFlight.then(() =>
      // `Promise.resolve().then(…)`, NOT a bare `emit(draft)`. A sink that throws SYNCHRONOUSLY — which a
      // `better-sqlite3`-backed store does — would escape before `.catch`/`.finally` attach: no typed error,
      // `#pending` leaked at >= 1 forever, and `#inFlight` left permanently REJECTED so every later join
      // throws with no way to clear it. The governor's estimate twin documents the same brick at length.
      // The inner chain therefore ALWAYS resolves, which is why there is no onRejected arm here.
      Promise.resolve()
        // The captured total, not a fresh read — see `MoneyDurabilityOptions.emit`. It rides the closure so
        // the write describes the instant it was recorded, not the instant the chain got round to it.
        .then(() => this.#options.emit(draft, cumulativeCostMicrocents))
        .catch((error: unknown) => {
          // Keep the FIRST failure: it is the one that broke durability, and later writes may well fail for
          // the same reason.
          this.#failure ??= new LedgerDurabilityError(error, draft.nodeId);
          this.#broken = true;
        })
        .finally(() => {
          this.#pending -= 1;
        }),
    );
  }

  async beginUsageInvocation(draft: PendingUsageDraft): Promise<UsageInvocation> {
    await this.join();
    // Allocation, durable append and the owner's coverage fold are one serialized operation.
    // Join BEFORE enqueueing: joining from our own queued callback would await itself. A second
    // caller can have crossed the same join, so check the sticky failure again inside the queue.
    this.#pending++;
    const invocation = this.#inFlight.then(async () => {
      if (this.#broken || this.#options.beginUsageInvocation === undefined)
        throw new LedgerDurabilityError(
          new Error('Usage durability is not attached'),
          draft.nodeId,
        );
      try {
        const identity = await this.#options.beginUsageInvocation(draft);
        this.#usageClaims.set(identity, 'pending');
        return identity;
      } catch (error) {
        this.#broken = true;
        throw new LedgerDurabilityError(error, draft.nodeId);
      }
    });
    // The returned promise carries this caller's failure. The shared tail must remain fulfilled,
    // just like realized/disposition writes, so queued callers can observe the sticky refusal.
    this.#inFlight = invocation
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.#pending--;
      });
    return invocation;
  }

  accountingFailure(error: unknown): void {
    this.#failure ??= new LedgerDurabilityError(error);
    this.#broken = true;
  }

  claimUsage(
    invocation: UsageInvocation,
    kind: 'complete' | 'incomplete' | 'released' | 'retired',
  ): boolean {
    const state = this.#usageClaims.get(invocation);
    if (state === undefined || state === 'finished') return false;
    if (kind === 'incomplete' && state === 'incomplete') return false;
    if (kind === 'released' && state !== 'pending') return false;
    this.#usageClaims.set(invocation, kind === 'incomplete' ? 'incomplete' : 'finished');
    return true;
  }

  usageDisposition(draft: UsageDispositionDraft): void {
    this.#pending++;
    this.#inFlight = this.#inFlight.then(() =>
      Promise.resolve()
        .then(() => {
          if (this.#options.emitUsageDisposition === undefined)
            throw new Error('Usage durability is not attached');
          return this.#options.emitUsageDisposition(draft);
        })
        .catch((error: unknown) => {
          this.#failure ??= new LedgerDurabilityError(error, draft.nodeId);
          this.#broken = true;
        })
        .finally(() => {
          this.#pending--;
        }),
    );
  }

  /** Internal lifetime observation only: drain realized writes without consuming their retained error. */
  async waitForWrites(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.#inFlight;
      await observed;
    } while (observed !== this.#inFlight);
  }

  /**
   * The barrier — ADR-0077's B1 / B2 / B3, all three of them this one call.
   *
   * Awaits the realized chain and the conservative one, then throws the first retained failure. Both halves
   * matter: ordinary event delivery contains store faults, but the engine's required-money bridge rejects
   * each refused or failed append acknowledgement. This chain retains that failure for the accounting
   * barrier; a lifecycle-only tail wait does not consume or classify it. The throw is how a turn-core
   * caller, which has no access to the engine's own failure state, observes missing durability.
   *
   * **ADR-0078's ordered append does not change this argument** — re-derived rather than left to age. Its
   * compare-and-append refusal is another missing money acknowledgement, and both money events are
   * non-terminal. The required bridge and retained-error observation keep the barrier stronger than a
   * lifetime wait even when an unrelated run failure already existed.
   */
  async join(): Promise<void> {
    let observedTail: Promise<void>;
    do {
      observedTail = this.#inFlight;
      if (this.#pending > 0 || this.#failure !== undefined) {
        await observedTail;
      }
      // The governor drains its current conservative tail. Recheck the realized tail AFTER that await too:
      // a sibling can record another realized charge while either half is suspended. A single snapshot, or
      // draining only before the conservative flush, would let the next attempt outrun that new write.
      await this.#options.flushConservative?.();
    } while (observedTail !== this.#inFlight);
    const failure = this.#failure;
    if (failure !== undefined) {
      this.#failure = undefined;
      throw failure;
    }
  }

  /**
   * The narrow port handed to the turn core. Bound so a destructured `record` still works.
   *
   * `snapshotCumulative` is read SYNCHRONOUSLY here, inside `record`, because that is the only moment the
   * run-wide total is the one this attempt produced: the turn core calls `record` immediately after the
   * engine folded this charge into its counter, and the chained write runs later.
   */
  turnPort(snapshotCumulative: () => number): TurnMoneyPort {
    return {
      accountingFailure: (error) => this.accountingFailure(error),
      ...(this.#options.beginUsageInvocation === undefined
        ? {}
        : {
            beginUsageInvocation: (draft: PendingUsageDraft) => this.beginUsageInvocation(draft),
            claimUsage: (
              invocation: UsageInvocation,
              kind: 'complete' | 'incomplete' | 'released' | 'retired',
            ) => this.claimUsage(invocation, kind),
            usageDisposition: (draft: UsageDispositionDraft) => this.usageDisposition(draft),
          }),
      record: (draft) => {
        this.record(draft, snapshotCumulative());
      },
      join: () => this.join(),
    };
  }
}
