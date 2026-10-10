/**
 * Internal ADR-0103 lifetime substrate, not a departure or persistence certificate. RunExecution
 * consumes it for receipt retirement; final departure and receipt disposition remain separate.
 * Nothing here grants provider, media, effect-prepare or other host capabilities.
 */
import { EngineStateError } from './errors.js';

// Observe actual Promise settlement, never a caller-overridden `raw.then` callback protocol.
const observePromise: unknown = Object.getOwnPropertyDescriptor(Promise.prototype, 'then')?.value;

/** A lifetime guard supplied only to a registered factory; receipt ports retain separate authority. */
export interface HostWorkScope {
  /** Guard a synchronous port entry. Throws EngineStateError('receipt_scope_ended') after settlement. */
  readonly assertActive: () => void;
  /** Register an entered host operation before invoking it; its lifetime is independent of this scope. */
  readonly enter: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Transfer to an independently registered child before invoking its factory. */
  readonly continue: <T>(operation: (scope: HostWorkScope) => Promise<T>) => Promise<T>;
}

/**
 * Tracks exact raw invocation promises, child scopes and entered host operations to quiescence.
 * A join observes work; it does not seal root admission. The execution owner must recheck idle and
 * retirement in its final synchronous claim. Never join this registry to delay terminal publication:
 * an executor or child that never settles intentionally holds only the future host-safe join.
 *
 * Rejections remain on the exact promise returned to the owner. Joining is a lifetime ACK only;
 * the appropriate money/effect/retention ports must retain their own semantic failure observations.
 */
export class HostWorkRegistry {
  readonly #runId: string;
  readonly #onChange: () => void;
  #pending = 0;
  #idleWaiters: (() => void)[] = [];
  #observationFailed = false;

  constructor(runId: string, onChange: () => void = () => undefined) {
    this.#runId = runId;
    this.#onChange = onChange;
  }

  get isIdle(): boolean {
    return this.#pending === 0;
  }

  /** Sticky, content-free diagnosis: unobservable raw work cannot certify safe host release. */
  get observationFailed(): boolean {
    return this.#observationFailed;
  }

  /**
   * Register BEFORE calling execute/factory, then observe and return its exact raw Promise. An
   * abort/grace wrapper is not the raw invocation. A synchronous throw ends only this scope and
   * becomes a rejection carrying the original error; children/entered operations remain joined.
   */
  invoke<T>(operation: (scope: HostWorkScope) => Promise<T>): Promise<T> {
    this.#pending += 1;
    this.#onChange();
    let active = true;
    const assertActive = (): void => {
      if (!active) {
        throw new EngineStateError('receipt_scope_ended', 'the receipt scope has already ended', {
          runId: this.#runId,
        });
      }
    };
    const scope: HostWorkScope = Object.freeze({
      assertActive,
      enter: <R>(factory: () => Promise<R>): Promise<R> => {
        assertActive();
        this.#pending += 1;
        this.#onChange();
        return this.#observe(factory, () => this.#finish());
      },
      continue: <R>(factory: (child: HostWorkScope) => Promise<R>): Promise<R> => {
        assertActive();
        return this.invoke(factory);
      },
    });
    return this.#observe(
      () => operation(scope),
      () => {
        active = false;
        this.#finish();
      },
    );
  }

  /**
   * Enter a host port whose contract permits synchronous completion. A void return or synchronous throw
   * completes its slot now; a Promise keeps its exact lifetime and original rejection. No future receipt
   * authority is created by this entry. This avoids inventing asynchronous work for native sync ports.
   */
  enter(operation: () => void | Promise<void>): void | Promise<void> {
    this.#pending += 1;
    this.#onChange();
    let raw: void | Promise<void>;
    try {
      raw = operation();
    } catch (error) {
      this.#finish();
      throw error;
    }
    if (raw === undefined) {
      this.#finish();
      return;
    }
    return this.#observe(
      () => raw,
      () => this.#finish(),
    );
  }

  /** Idle resolves immediately. Busy joins wait for actual completions, including transferred work. */
  async join(): Promise<void> {
    while (!this.isIdle) {
      await new Promise<void>((resolve) => {
        this.#idleWaiters.push(resolve);
      });
      // A new root may have entered between the zero-pending notification and this continuation.
      // Recheck instead of mistaking that notification or a prior tail snapshot for quiescence.
    }
  }

  #observe<T>(operation: () => Promise<T>, onSettled: () => void): Promise<T> {
    let raw: Promise<T>;
    try {
      raw = operation();
    } catch (error) {
      onSettled();
      // Preserve even an unknown thrown value for the existing executor/port error boundary.
      return Promise.resolve().then(() => {
        throw error;
      });
    }
    try {
      // Both reactions end authority; neither consumes the rejection returned to its owner. These
      // internal callbacks cannot throw and attach before the caller can await the returned promise.
      if (typeof observePromise !== 'function')
        throw new Error('native Promise observer unavailable');
      Reflect.apply(observePromise, raw, [onSettled, onSettled]);
    } catch {
      // A native Promise's constructor/species may throw during observer setup. That is not raw
      // settlement. Keep its exact promise, slot and authority; no safe completion was observed.
      // The sticky diagnosis lets integration explain why graceful joining remains pending without
      // retaining a caller's private cause. It must never turn an observation fault into a close ACK.
      this.#observationFailed = true;
    }
    return raw;
  }

  #finish(): void {
    this.#pending -= 1;
    this.#onChange();
    if (!this.isIdle) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
