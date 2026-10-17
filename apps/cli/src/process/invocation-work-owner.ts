import { EgressWorkScope } from '../engine/egress-work.js';
import { toUserFacing } from './errors.js';
import type { CliInvocation } from './invocation.js';
import type { CommandOwner, OwnerRetirement, SessionOwner } from './invocation-registry.js';

const observePromise: unknown = Object.getOwnPropertyDescriptor(Promise.prototype, 'then')?.value;

export interface InvocationWorkOwnerPorts {
  /** Finite cancellation only, including when the common termination budget is exhausted. */
  readonly cancel: () => void;
  /** After entered roots settle, initiate shutdown that transferred lifetime ACKs depend on.
   * May retain its exact cleanup work; final cleanup still follows every transferred ACK. */
  readonly beforeWorkJoin?: () => Promise<void>;
  /** Fulfilment must mean actual complete cleanup, independently of any retained receipt failure. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Retain entered roots and transferred raw work for one no-health owner. Session wrappers
 * keep their actual surface identity; management commands do not impersonate an AgentSession.
 */
export class InvocationWorkOwner {
  readonly invocation: CliInvocation;
  readonly #ports: InvocationWorkOwnerPorts;
  readonly #roots = new EgressWorkScope();
  readonly #work = new EgressWorkScope();
  /** Already-entered roots may still transfer cleanup/receipt tails. This grants no new egress authority. */
  readonly work = Object.freeze({
    retainWork: <T>(factory: () => Promise<T>): Promise<T> => {
      const raw = this.#work.retainWork(factory);
      if (this.#work.observationFailed)
        this.failure(new Error('Session work observation is unavailable.'));
      return raw;
    },
  });
  readonly #cancel = new AbortController();
  readonly #stoppedMarker: Error;
  readonly #retired: Promise<OwnerRetirement>;
  #resolveRetired: (facts: OwnerRetirement) => void = () => undefined;
  #stopped = false;
  #cleanupUncertain = false;
  #closing: Promise<void> | undefined;
  #firstFailure: { readonly cause: unknown } | undefined;

  constructor(
    invocation: CliInvocation,
    identity: Pick<SessionOwner, 'kind' | 'surface'> | Pick<CommandOwner, 'kind'>,
    ports: InvocationWorkOwnerPorts,
  ) {
    this.invocation = invocation;
    this.#stoppedMarker = Object.freeze(
      new Error(
        identity.kind === 'session' ? 'Session operation stopped.' : 'Command operation stopped.',
      ),
    );
    this.#ports = Object.freeze({ ...ports });
    invocation.finiteExit.activateFallback();
    this.#retired = new Promise((resolve) => {
      this.#resolveRetired = resolve;
    });
    invocation.registry.register({
      ...identity,
      retired: this.#retired,
      stop: this.stop,
      join: this.close,
      classifyFailure: () => 'cli_internal',
    });
  }

  get signal(): AbortSignal {
    return this.#cancel.signal;
  }

  get firstFailure(): { readonly cause: unknown } | undefined {
    return this.#firstFailure;
  }

  /** Cleanup consumers must retain signal custody when no positive native release fact exists. */
  get hasCleanupUncertainty(): boolean {
    return this.#cleanupUncertain;
  }

  /** Positive actual cleanup fact, shared with the invocation registry; expiry/rejection never resolves it. */
  get retired(): Promise<OwnerRetirement> {
    return this.#retired;
  }

  readonly isStoppedFailure = (cause: unknown): boolean => cause === this.#stoppedMarker;

  readonly assertAdmitting = (): void => {
    if (this.#stopped || this.invocation.registry.termination !== undefined)
      throw this.#stoppedMarker;
    this.invocation.registry.assertAdmitting();
  };

  /** Register before entry, observe escaping infrastructure immediately, and return the exact raw promise. */
  readonly enter = <T>(operation: () => Promise<T>): Promise<T> => {
    this.assertAdmitting();
    let raw: Promise<T>;
    try {
      raw = this.#roots.retainWork(operation);
    } catch (cause) {
      this.failure(cause);
      throw cause;
    }
    try {
      if (typeof observePromise !== 'function') throw new Error('Promise observation unavailable.');
      Reflect.apply(observePromise, raw, [undefined, this.failure]);
    } catch (cause) {
      // A failed observer is not settlement; the independently retained scope still owes its slot.
      this.failure(cause);
    }
    return raw;
  };

  /** Known inline refusals are not the eventual surface outcome. Only unexpected faults stop the invocation. */
  readonly failure = (cause: unknown): void => {
    if (this.isStoppedFailure(cause)) return;
    const facing = toUserFacing(cause);
    if (facing.code !== 'cli_internal' && facing.code !== 'output_unavailable') return;
    this.#firstFailure ??= { cause };
    this.invocation.finiteExit.fail(facing.code);
  };

  /** A callback-reported close fault is retained even when the manager's close promise fulfils. */
  readonly cleanupUncertain = (cause: unknown): void => {
    this.failure(cause); // Keep an observed output disposition before any cleanup join can hold.
    this.#cleanupUncertain = true;
    this.#firstFailure ??= { cause };
    this.invocation.finiteExit.fail('cli_internal');
  };

  readonly stop = (): void => {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#roots.seal();
    this.#cancel.abort(this.#stoppedMarker);
    try {
      this.#ports.cancel();
    } catch (cause) {
      this.cleanupUncertain(cause);
    }
  };

  /** Publish one shared cleanup promise before callbacks. Cancellation, rejection and expiry grant no retirement. */
  readonly close = (): Promise<void> => {
    if (this.#closing !== undefined) return this.#closing;
    let complete: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.#closing = pending;
    this.stop();
    void Promise.resolve()
      .then(async () => {
        // Cancellation seals future roots, not the cleanup continuations of roots already entered.
        // Those roots can still register iterator.return/receipt tails before their actual settlement.
        await this.#roots.done;
        await this.#ports.beforeWorkJoin?.();
        this.#work.seal();
        await this.#work.done;
        if (this.invocation.registry.budget.remainingMs() === 0) return;
        await this.#ports.cleanup();
        if (this.#cleanupUncertain) return;
        this.#resolveRetired({ kind: 'settled' });
        complete();
      })
      .catch(this.cleanupUncertain);
    return pending;
  };
}
