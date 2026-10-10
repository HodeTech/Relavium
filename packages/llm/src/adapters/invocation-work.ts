import type { AbortSignalLike } from '@relavium/shared';
import type { LlmInvocationOptions } from '../types.js';

const observePromise: unknown = Object.getOwnPropertyDescriptor(Promise.prototype, 'then')?.value;
const cancellations = new WeakSet<object>();

class ProviderInvocationCancelledError extends Error {
  constructor() {
    super('provider invocation cancelled');
    this.name = 'ProviderInvocationCancelledError';
    cancellations.add(this);
  }
}

/** Identity-only local classification; it never inspects a foreign thrown value. */
export function isProviderInvocationCancelled(error: unknown): boolean {
  return (
    ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
    cancellations.has(error)
  );
}

/** Host-only fetch options: never part of RequestInit, SDK data, quotes or history. */
export interface ProviderFetchWorkOptions extends LlmInvocationOptions {
  readonly signal: AbortSignal;
}

export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
  options?: ProviderFetchWorkOptions,
) => Promise<Response>;

/** Capture behavioral authority synchronously, preserving its receiver across a lazy stream. */
export function captureInvocationOptions(
  options: LlmInvocationOptions | undefined,
): LlmInvocationOptions | undefined {
  return options === undefined
    ? undefined
    : Object.freeze({ retainWork: options.retainWork.bind(options) });
}

/** One invocation's admitted SDK work and transitive transport children, never ambient state. */
export class ProviderInvocationWork {
  readonly #done: Promise<void>;
  readonly #controller = new AbortController();
  readonly #caller: AbortSignalLike | undefined;
  #acknowledge: () => void = () => {};
  #pending = 0;
  #sealed = false;
  #complete = false;
  #callerAttached = false;

  constructor(options: LlmInvocationOptions | undefined, caller: AbortSignalLike | undefined) {
    this.#caller = caller;
    this.#done = new Promise<void>((resolve) => {
      this.#acknowledge = resolve;
    });
    // The parent transfer precedes SDK construction and lies outside SDK classifiers. Nothing
    // capable of reflecting a host's opaque thrown value has entered if this transfer refuses.
    try {
      void options?.retainWork(() => this.#done);
      if (caller !== undefined) {
        // Registration can throw after installing the listener; retirement still owns removal.
        this.#callerAttached = true;
        caller.addEventListener('abort', this.#onAbort);
        if (caller.aborted) this.#onAbort();
      }
    } catch (error) {
      try {
        this.retire();
      } catch {
        // The original entry failure stays primary; retirement has still aborted and joined quiet work.
      }
      throw error;
    }
  }

  readonly #onAbort = (): void => {
    this.#controller.abort();
  };

  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  get done(): Promise<void> {
    return this.#done;
  }

  assertActive(): void {
    if (this.#sealed || this.signal.aborted) {
      throw new ProviderInvocationCancelledError();
    }
  }

  readonly retainWork = <T>(factory: () => Promise<T>): Promise<T> => {
    this.assertActive();
    this.#pending += 1;
    let raw: Promise<T>;
    try {
      raw = factory();
    } catch (error) {
      this.#finish();
      throw error;
    }
    try {
      if (typeof observePromise !== 'function') throw new Error('native observer unavailable');
      Reflect.apply(observePromise, raw, [() => this.#finish(), () => this.#finish()]);
    } catch {
      // No observable native settlement means no positive completion ACK. Keep this slot owed.
    }
    return raw;
  };

  /** Closure-bound to exactly one SDK client/invocation, including delayed request preparation. */
  bindFetch(fetcher: ProviderFetch): ProviderFetch {
    return (input, init) => {
      this.assertActive();
      return this.retainWork(() => fetcher(input, init, this));
    };
  }

  /** An admitted SDK iterator keeps its pending reads and actual return independently owed. */
  ownIterator<T>(source: AsyncIterable<T>): AsyncIterable<T> {
    return new ProviderIteratorWork(this, source);
  }

  retire(): void {
    if (this.#sealed) return;
    this.#sealed = true;
    try {
      if (this.#callerAttached) this.#caller?.removeEventListener('abort', this.#onAbort);
    } finally {
      try {
        this.#controller.abort();
      } finally {
        // A foreign listener-removal fault cannot strand an otherwise positively completed scope.
        this.#acknowledgeIfQuiet();
      }
    }
  }

  #finish(): void {
    this.#pending -= 1;
    this.#acknowledgeIfQuiet();
  }
  #acknowledgeIfQuiet(): void {
    if (this.#complete || !this.#sealed || this.#pending !== 0) return;
    this.#complete = true;
    this.#acknowledge();
  }
}

/** The cleanup right was admitted before exposure; retiring new work never revokes it. */
class ProviderIteratorWork<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #parent: ProviderInvocationWork;
  readonly #iterator: AsyncIterator<T>;
  #acknowledge: () => void = () => {};
  #pending = 0;
  #ended = false;
  #closed: Promise<IteratorResult<T>> | undefined;

  constructor(parent: ProviderInvocationWork, source: AsyncIterable<T>) {
    this.#parent = parent;
    const done = new Promise<void>((resolve) => {
      this.#acknowledge = resolve;
    });
    void parent.retainWork(() => done);
    try {
      this.#iterator = source[Symbol.asyncIterator]();
    } catch (error) {
      this.#ended = true;
      this.#quiet();
      throw error;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.#ended) return { done: true, value: undefined };
    try {
      this.#parent.assertActive();
      const result = await this.#hold(() => this.#iterator.next());
      if (result.done === true) {
        this.#ended = true;
        this.#quiet();
      }
      return result;
    } catch (error) {
      try {
        void this.return();
      } catch {
        /* Cleanup cannot replace the established SDK read fault. */
      }
      throw error;
    }
  }

  return(): Promise<IteratorResult<T>> {
    if (this.#closed !== undefined) return this.#closed;
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    try {
      this.#closed = this.#hold(() =>
        this.#iterator.return === undefined
          ? Promise.resolve({ done: true, value: undefined })
          : this.#iterator.return(),
      );
    } finally {
      this.#ended = true;
      this.#quiet();
    }
    return this.#closed;
  }

  #hold(factory: () => Promise<IteratorResult<T>>): Promise<IteratorResult<T>> {
    this.#pending += 1;
    let raw: Promise<IteratorResult<T>>;
    try {
      raw = factory();
    } catch (error) {
      this.#finish();
      throw error;
    }
    try {
      if (typeof observePromise !== 'function') throw new Error('native observer unavailable');
      Reflect.apply(observePromise, raw, [() => this.#finish(), () => this.#finish()]);
    } catch {
      /* Unobservable raw work still holds its admitted slot. */
    }
    return raw;
  }

  #finish(): void {
    this.#pending -= 1;
    this.#quiet();
  }
  #quiet(): void {
    if (this.#ended && this.#pending === 0) this.#acknowledge();
  }
}

/** Request retirement synchronously even if the async generator queues return behind a raw next. */
export function retiringStream<T>(
  open: (setWork: (work: ProviderInvocationWork) => void) => AsyncGenerator<T, void, unknown>,
): AsyncIterable<T> {
  let work: ProviderInvocationWork | undefined;
  const iterator = open((admitted) => {
    work = admitted;
  });
  const close = async (
    operation: () => Promise<IteratorResult<T, void>>,
    establishedFailure: boolean,
  ): Promise<IteratorResult<T, void>> => {
    let retirementFailure: { readonly error: unknown } | undefined;
    try {
      work?.retire();
    } catch (error) {
      retirementFailure = { error };
    }
    // Immediate retirement must never prevent the generator from entering its own cleanup.
    // A consumer throw is already the primary failure; normal generator propagation owns it.
    let result: IteratorResult<T, void>;
    try {
      result = await operation();
    } catch (error) {
      throw !establishedFailure && retirementFailure !== undefined
        ? retirementFailure.error
        : error;
    }
    if (!establishedFailure && retirementFailure !== undefined) throw retirementFailure.error;
    return result;
  };
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => iterator.next(),
        return: () => close(() => iterator.return(), false),
        throw: (error: unknown) => close(() => iterator.throw(error), true),
      };
    },
  };
}
