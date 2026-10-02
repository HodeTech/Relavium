const TOKEN = Symbol('dispatch-allowance');

/** Opaque process-local ownership; the book's WeakMap is authoritative, not the object's shape. */
export interface DispatchAllowanceToken {
  readonly [TOKEN]: true;
}

export type AllowanceRefusal = 'owner_invalid' | 'in_flight' | 'exhausted';

export class InvalidDispatchAllowanceError extends Error {
  readonly code = 'invalid_dispatch_allowance';
  constructor(
    readonly reason:
      | 'invalid_identity'
      | 'invalid_amount'
      | 'inactive_owner'
      | 'stale_dispatch'
      | 'invalid_debit'
      | 'invalid_settlement',
  ) {
    super('dispatch allowance state is invalid');
    this.name = 'InvalidDispatchAllowanceError';
  }
}

interface Owner {
  readonly token: DispatchAllowanceToken;
  readonly nodeId: string;
  readonly dispatchId: number;
  readonly initial: number;
  readonly isLive: () => boolean;
  remaining: number;
  inFlight: boolean;
  closed: boolean;
  exhausted: boolean;
}

export interface AllowanceDebit {
  readonly settle: (actualMicrocents: number) => void;
  readonly release: () => void;
  readonly retain: () => void;
}

export type AllowanceAcquisition =
  | { readonly kind: 'admitted'; readonly debit: AllowanceDebit }
  | { readonly kind: 'refused'; readonly reason: AllowanceRefusal };

/**
 * Monetary dispatch ownership, consumed only from the governor's synchronous evaluate/admit window.
 * The engine activates a frozen amount only after authoritative authorization acknowledges ownership.
 * Global possible spend remains the governor's ledger even after this owner closes or is replaced.
 */
export class DispatchAllowanceBook {
  readonly #tokens = new WeakMap<DispatchAllowanceToken, Owner>();
  readonly #owners = new Map<string, Owner>();
  readonly #lastDispatch = new Map<string, number>();

  activate(
    nodeId: string,
    dispatchId: number,
    amount: number,
    isLive: () => boolean,
  ): DispatchAllowanceToken {
    if (nodeId.length === 0 || !Number.isSafeInteger(dispatchId) || dispatchId < 0)
      throw new InvalidDispatchAllowanceError('invalid_identity');
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new InvalidDispatchAllowanceError('invalid_amount');
    const last = this.#lastDispatch.get(nodeId);
    if (last !== undefined && dispatchId <= last)
      throw new InvalidDispatchAllowanceError('stale_dispatch');
    // The predicate is trusted host code, but it can re-enter. Recheck the book after invoking it and
    // before installing a new owner; no older activation can replace a newer one from that callback.
    let live = false;
    try {
      live = isLive();
    } catch {
      /* Refuse without propagating private host predicate details. */
    }
    if (!live) throw new InvalidDispatchAllowanceError('inactive_owner');
    const afterCallback = this.#lastDispatch.get(nodeId);
    if (afterCallback !== undefined && dispatchId <= afterCallback) {
      throw new InvalidDispatchAllowanceError('stale_dispatch');
    }
    const prior = this.#owners.get(nodeId);
    if (prior !== undefined) prior.closed = true;
    const token: DispatchAllowanceToken = Object.freeze({ [TOKEN]: true as const });
    const owner: Owner = {
      token,
      nodeId,
      dispatchId,
      initial: amount,
      isLive,
      remaining: amount,
      inFlight: false,
      closed: false,
      exhausted: false,
    };
    this.#tokens.set(token, owner);
    this.#owners.set(nodeId, owner);
    this.#lastDispatch.set(nodeId, dispatchId);
    return token;
  }

  close(token: DispatchAllowanceToken): void {
    const owner = this.#tokens.get(token);
    if (owner !== undefined) owner.closed = true;
  }

  /** Unsafe prospective arithmetic cannot turn an active approval into a fresh pause or retry. */
  exhaust(token: DispatchAllowanceToken): void {
    const owner = this.#current(token);
    if (owner !== undefined) owner.exhausted = true;
  }

  #current(token: DispatchAllowanceToken): Owner | undefined {
    const owner = this.#tokens.get(token);
    return owner !== undefined && !owner.closed && this.#owners.get(owner.nodeId) === owner
      ? owner
      : undefined;
  }

  /** Call BEFORE pricing/projection and after every external await or notice; never within the atomic debit. */
  validateLive(
    token: DispatchAllowanceToken,
    alreadyAdmitted = false,
  ): AllowanceRefusal | undefined {
    const owner = this.#current(token);
    if (owner === undefined) return 'owner_invalid';
    let live = false;
    try {
      live = owner.isLive();
    } catch {
      /* A failed host predicate cannot revive an owner. */
    }
    if (!live || this.#current(token) !== owner) {
      owner.closed = true;
      return 'owner_invalid';
    }
    return owner.exhausted
      ? 'exhausted'
      : owner.inFlight && !alreadyAdmitted
        ? 'in_flight'
        : undefined;
  }

  /**
   * No callbacks or awaits. The governor reserves global money in the same uninterrupted window.
   * Undefined is an unpriced call under ordinary allow-degrade policy, never a fabricated priced zero.
   * Both still hold the one in-flight slot, so a priced zero's unexpected bill cannot race another bill.
   */
  acquire(token: DispatchAllowanceToken, estimate: number | undefined): AllowanceAcquisition {
    const owner = this.#current(token);
    if (owner === undefined) return { kind: 'refused', reason: 'owner_invalid' };
    if (owner.exhausted) return { kind: 'refused', reason: 'exhausted' };
    if (owner.inFlight) return { kind: 'refused', reason: 'in_flight' };
    if (estimate !== undefined && (!Number.isSafeInteger(estimate) || estimate < 0)) {
      throw new InvalidDispatchAllowanceError('invalid_debit');
    }
    if (estimate !== undefined && estimate > owner.remaining) {
      owner.exhausted = true;
      return { kind: 'refused', reason: 'exhausted' };
    }
    owner.inFlight = true;
    if (estimate !== undefined) owner.remaining -= estimate;
    let settled = false;
    const finish = (actual: number | undefined, released: boolean): void => {
      if (settled) return;
      if (actual !== undefined && (!Number.isSafeInteger(actual) || actual < 0)) {
        throw new InvalidDispatchAllowanceError('invalid_settlement');
      }
      settled = true;
      // Keep the slot held through the host predicate and reconciliation. A reentrant admission must
      // see this call as in flight until its actual charge has consumed the frozen allowance.
      try {
        // The governor settles GLOBAL money first. Late actuals remain global truth but cannot refund
        // a replacement dispatch, or reopen an owner that became inactive during provider work.
        if (this.#current(token) !== owner) return;
        let live = false;
        try {
          live = owner.isLive();
        } catch {
          /* Inactive ownership is fail-closed. */
        }
        if (!live || this.#current(token) !== owner) {
          owner.closed = true;
          return;
        }
        // An initially unpriced call had no estimated debit. A later known actual still spends this
        // owner's allowance; retaining/releasing an unpriced call must not invent an amount.
        const estimatedDebit = estimate ?? 0;
        const delta = released ? -estimatedDebit : (actual ?? estimatedDebit) - estimatedDebit;
        if (delta < 0) {
          owner.remaining += -delta;
        } else if (delta > 0) {
          if (delta >= owner.remaining) {
            owner.remaining = 0;
            owner.exhausted = true;
          } else owner.remaining -= delta;
        }
        // A positive tranche spent exactly is exhausted too. An originally zero, genuinely free
        // allowance preserves ordinary non-strict unpriced policy until an actual positive charge arrives.
        if (owner.initial > 0 && owner.remaining === 0) owner.exhausted = true;
      } finally {
        owner.inFlight = false;
      }
    };
    return {
      kind: 'admitted',
      debit: {
        settle: (actual) => finish(actual, false),
        release: () => finish(undefined, true),
        retain: () => finish(undefined, false),
      },
    };
  }

  /** Fresh immutable diagnostic state; no token or host predicate crosses a durable boundary. */
  snapshot(token: DispatchAllowanceToken):
    | {
        readonly initial: number;
        readonly remaining: number;
        readonly inFlight: boolean;
        readonly closed: boolean;
        readonly exhausted: boolean;
      }
    | undefined {
    const owner = this.#tokens.get(token);
    return owner === undefined
      ? undefined
      : Object.freeze({
          initial: owner.initial,
          remaining: owner.remaining,
          inFlight: owner.inFlight,
          closed: owner.closed,
          exhausted: owner.exhausted,
        });
  }
}
