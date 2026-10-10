import type { RunEvent } from './run-event.js';
import type {
  UsageCoverage,
  UsageCoverageBasis,
  UsageDisposition,
  UsageInvocation,
} from './usage-coverage.js';

interface MutableCoverage {
  unverified: boolean;
  pendingInvocations: number;
  unknownCalls: number;
}
interface PendingEntry {
  readonly model: string;
  readonly invocation: UsageInvocation;
  state: 'pending' | 'unknown';
}
export interface UsageCoverageSnapshot {
  readonly coverage: UsageCoverage;
  readonly models: readonly { readonly model: string; readonly coverage: UsageCoverage }[];
  readonly started: boolean;
  readonly highWater: number;
}
const empty = (unverified: boolean): MutableCoverage => ({
  unverified,
  pendingInvocations: 0,
  unknownCalls: 0,
});
const keyOf = (invocation: UsageInvocation): string =>
  JSON.stringify([invocation.producerId, invocation.ordinal]);
const matches = (a: UsageInvocation, b: UsageInvocation): boolean =>
  a.producerId === b.producerId &&
  a.ordinal === b.ordinal &&
  a.dispatchId === b.dispatchId &&
  a.round === b.round &&
  a.chainAttempt === b.chainAttempt;

/** Incremental accounting only. Persisted correlation never grants permission to invoke or charge. */
export class UsageCoverageFold {
  readonly #total: MutableCoverage = empty(true);
  readonly #models = new Map<string, MutableCoverage>();
  readonly #pending = new Map<string, PendingEntry>();
  #started = false;
  #highWater = 0;

  constructor(snapshot?: UsageCoverageSnapshot) {
    if (snapshot === undefined) return;
    Object.assign(this.#total, snapshot.coverage);
    this.#started = snapshot.started;
    this.#highWater = snapshot.highWater;
    for (const entry of snapshot.models) this.#models.set(entry.model, { ...entry.coverage });
  }

  get retainedInvocations(): number {
    return this.#pending.size;
  }
  get highWater(): number {
    return this.#highWater;
  }
  get started(): boolean {
    return this.#started;
  }
  start(basis: UsageCoverageBasis): void {
    if (this.#started) throw new Error('Usage coverage basis already established');
    this.#started = true;
    this.#total.unverified = basis === 'legacy_unverified';
  }
  #model(model: string): MutableCoverage {
    let coverage = this.#models.get(model);
    if (coverage === undefined) {
      coverage = empty(this.#total.unverified);
      this.#models.set(model, coverage);
    }
    return coverage;
  }
  pending(model: string, invocation: UsageInvocation): void {
    // The owner-wide ordinal is monotonically minted at the durable pending boundary. Retired
    // identities cannot be reintroduced and need no completed-identity tombstones.
    if (invocation.ordinal <= this.#highWater)
      throw new Error('Usage invocation ordinal is not increasing');
    this.#highWater = invocation.ordinal;
    this.#pending.set(keyOf(invocation), { model, invocation, state: 'pending' });
    this.#total.pendingInvocations++;
    this.#model(model).pendingInvocations++;
  }
  disposition(
    model: string,
    invocation: UsageInvocation,
    disposition: UsageDisposition,
    receiptPending = false,
  ): boolean {
    const entry = this.#pending.get(keyOf(invocation));
    if (entry === undefined || entry.model !== model || !matches(entry.invocation, invocation))
      return false;
    if (entry.state === 'unknown') {
      if (disposition.kind !== 'incomplete' || receiptPending) return false;
      this.#pending.delete(keyOf(invocation));
      return true;
    }
    const perModel = this.#model(model);
    this.#total.pendingInvocations--;
    perModel.pendingInvocations--;
    if (disposition.kind === 'incomplete') {
      this.#total.unknownCalls++;
      perModel.unknownCalls++;
      entry.state = 'unknown';
      if (receiptPending) return true;
    }
    this.#pending.delete(keyOf(invocation));
    return true;
  }
  complete(model: string, invocation: UsageInvocation): boolean {
    const entry = this.#pending.get(keyOf(invocation));
    if (entry === undefined || entry.model !== model || !matches(entry.invocation, invocation))
      return false;
    const perModel = this.#model(model);
    if (entry.state === 'pending') {
      this.#total.pendingInvocations--;
      perModel.pendingInvocations--;
    } else {
      this.#total.unknownCalls--;
      perModel.unknownCalls--;
    }
    this.#pending.delete(keyOf(invocation));
    return true;
  }
  /** Fencing a producer drops correlation state, preserving all aggregate uncertainty. */
  retire(): void {
    this.#pending.clear();
  }
  apply(event: RunEvent): void {
    switch (event.type) {
      case 'cost:coverage_started':
        this.start(event.basis);
        return;
      case 'cost:usage_pending':
        this.pending(event.model, event.invocation);
        return;
      case 'cost:usage_disposition':
        this.disposition(event.model, event.invocation, event.disposition, event.receiptPending);
        return;
      case 'cost:updated':
      case 'cost:attempt_settled':
        if (event.invocation !== undefined) this.complete(event.model, event.invocation);
        return;
      default:
        return;
    }
  }
  snapshot(): UsageCoverageSnapshot {
    return {
      coverage: { ...this.#total },
      models: [...this.#models].map(([model, coverage]) => ({ model, coverage: { ...coverage } })),
      started: this.#started,
      highWater: this.#highWater,
    };
  }
}
