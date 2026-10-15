import { MediaAdmissionError } from './media-admission.js';

interface CloseState {
  readonly native: boolean;
  readonly invoke?: () => unknown;
  acknowledgement?: Promise<void>;
}

// Exact private identity, scoped to this loaded shared module. Not a pending-work scheduler.
const closes = new WeakMap<object, CloseState>();
const promiseThen: unknown = Reflect.get(Promise.prototype, 'then');
const resolvePromise = Promise.resolve.bind(Promise);

/**
 * Adopt the exact public iterator before exposure/first pull (ADR-0109). A trusted constructor
 * must join native retirement on both return and natural EOF. Arbitrary execution state cannot
 * be inspected here; wrappers and separately loaded shared copies do not inherit ownership.
 */
export function registerNativeMediaIterator<T extends AsyncIterator<Uint8Array>>(iterator: T): T {
  try {
    if (closes.has(iterator)) throw new MediaAdmissionError('source_failed');
    const operation: unknown = Reflect.get(iterator, 'return');
    if (typeof operation !== 'function') throw new MediaAdmissionError('source_failed');
    // Reflection can run trusted caller code; it cannot promote an iterator closed during capture.
    if (closes.has(iterator)) throw new MediaAdmissionError('source_failed');
    closes.set(iterator, {
      native: true,
      invoke: (): unknown => Reflect.apply(operation, iterator, []),
    });
    return iterator;
  } catch {
    throw new MediaAdmissionError('source_failed');
  }
}

/**
 * Initiate once, synchronously cache and return the owed acknowledgement without awaiting it.
 * Foreign returns are observed but never joined; native returns are joined by the consumer
 * AFTER its own cleanup. Cache before invoking caller code so re-entry sees the same promise.
 */
export function closeMediaIterator(iterator: AsyncIterator<Uint8Array>): Promise<void> {
  let state: CloseState;
  try {
    state = closes.get(iterator) ?? { native: false };
    if (state.acknowledgement !== undefined) return state.acknowledgement;
    closes.set(iterator, state);
  } catch {
    return Promise.reject(new MediaAdmissionError('source_failed'));
  }
  let complete: () => void = () => undefined;
  let refuse: (error: MediaAdmissionError) => void = () => undefined;
  const acknowledgement = new Promise<void>((resolve, reject) => {
    complete = resolve;
    refuse = reject;
  });
  state.acknowledgement = acknowledgement;
  if (!state.native) complete();
  const failed = (): void => {
    // Foreign diagnostics are deliberately observed and discarded, never reflected or logged.
    if (state.native) refuse(new MediaAdmissionError('source_failed'));
  };
  try {
    if (typeof promiseThen !== 'function') throw new MediaAdmissionError('source_failed');
    let returned: unknown;
    if (state.native) {
      if (state.invoke === undefined) throw new MediaAdmissionError('source_failed');
      returned = state.invoke();
    } else {
      const operation: unknown = Reflect.get(iterator, 'return');
      if (typeof operation !== 'function') return acknowledgement;
      returned = Reflect.apply(operation, iterator, []);
    }
    try {
      // Native Promise branding crosses realms. Its own replaceable `then` cannot hide a
      // rejection; normal constructor/species behaviour remains a trusted JS precondition.
      void Reflect.apply(promiseThen, returned, [complete, failed]);
    } catch {
      // Non-Promise thenables still use normal assimilation, including fixed getter failures.
      void Reflect.apply(promiseThen, resolvePromise(returned), [complete, failed]);
    }
  } catch {
    failed();
  }
  return acknowledgement;
}
