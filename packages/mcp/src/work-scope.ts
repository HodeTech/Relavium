import type { ToolHostCallOptions } from '@relavium/core';
import { McpError } from './errors.js';

type McpLifetimeErrorCode =
  | 'closed'
  | 'retired'
  | 'unowned'
  | 'ambiguous'
  | 'unreadable'
  | 'duplicate_entry'
  | 'observer_unavailable'
  | 'unavailable';

/** Package-internal, content-free refusal at a producer ownership boundary. */
export class McpLifetimeError extends McpError {
  readonly code: McpLifetimeErrorCode;
  constructor(code: McpLifetimeErrorCode) {
    super(`MCP producer lifetime refused (${code})`);
    this.name = 'McpLifetimeError';
    this.code = code;
  }
}

const observePromise: unknown = Object.getOwnPropertyDescriptor(Promise.prototype, 'then')?.value;
const entryFailures = new WeakMap<object, { readonly error: unknown }>();

/** An inert marker for the host's own entry classifier, never a wire or durable value. */
class McpWorkEntryError extends Error {
  constructor(original: unknown) {
    super('MCP work entry refused');
    this.name = 'McpWorkEntryError';
    entryFailures.set(this, { error: original });
  }
}

export function mcpWorkEntryFailure(error: unknown): { readonly error: unknown } | undefined {
  return (typeof error === 'object' && error !== null) || typeof error === 'function'
    ? entryFailures.get(error)
    : undefined;
}

/**
 * One independently transferred producer lifetime. Seal stops future admission, while actual
 * admitted operations and children remain owed. Completion is a positive lifetime ACK only;
 * the owner of each exact Promise retains its rejection and semantic disposition.
 */
export class McpWorkScope {
  readonly #done: Promise<void>;
  #acknowledge: () => void = () => {};
  #pending = 0;
  #sealed = false;
  #complete = false;
  #observationFailed = false;

  constructor(parent?: ToolHostCallOptions) {
    this.#done = new Promise<void>((resolve) => {
      this.#acknowledge = resolve;
    });
    try {
      const retain = parent?.retainWork;
      if (retain === undefined) return;
      // The only parent transfer is synchronous and precedes producer entry. Descendants then
      // use their own retained scope; the old executor context need not remain open for pulls.
      void retain.call(parent, () => this.#done);
    } catch (error) {
      // No producer has entered yet. A parent which invoked this factory and then refused still
      // receives an honest completion of the empty transferred lifetime, with its fault intact.
      this.seal();
      throw new McpWorkEntryError(error);
    }
  }

  get done(): Promise<void> {
    return this.#done;
  }

  get isComplete(): boolean {
    return this.#complete;
  }

  get observationFailed(): boolean {
    return this.#observationFailed;
  }

  assertActive(): void {
    if (this.#sealed) throw new McpLifetimeError('retired');
  }

  /** Register before the factory can enter native work; return the exact raw Promise. */
  readonly retainWork = <T>(factory: () => Promise<T>): Promise<T> => {
    this.assertActive();
    this.#pending += 1;
    let raw: Promise<T>;
    try /* NOSONAR — S4822: sync factory refusal; the intrinsic two-arm observer below owns raw settlement. */ {
      raw = factory();
    } catch (error) {
      this.#finish();
      throw error;
    }
    try {
      if (typeof observePromise !== 'function') throw new McpLifetimeError('observer_unavailable');
      Reflect.apply(observePromise, raw, [() => this.#finish(), () => this.#finish()]);
    } catch {
      // A broken native Promise observer is not actual settlement. Preserve the slot and make
      // host-safe joining stay pending rather than inventing a close acknowledgement.
      this.#observationFailed = true;
    }
    return raw;
  };

  /** Transfer an independently admitted child BEFORE the parent producer seals. */
  fork(): McpWorkScope {
    return new McpWorkScope(this);
  }

  seal(): void {
    this.#sealed = true;
    this.#acknowledgeIfQuiet();
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
