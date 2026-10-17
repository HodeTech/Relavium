import { Readable } from 'node:stream';
import { CliError } from './cli-error.js';

interface InputLifecycle {
  readonly signal: AbortSignal;
  readonly onFailure: (cause: unknown) => void;
}

/** One close-delivery authority for a consumed native input; generic iterables owe their own return. */
export class CapturedNativeInput {
  readonly cancelled: Error;
  readonly #native: Readable | undefined;
  readonly #lifecycle: InputLifecycle | undefined;
  readonly #closed: Promise<void> | undefined;
  #acknowledgeClose: () => void = () => {};
  #started = false;
  #destroyEntered = false;
  #cleanupFailed = false;
  #joining: Promise<void> | undefined;

  constructor(input: unknown, lifecycle: InputLifecycle | undefined, cancellationMessage: string) {
    this.#native = input instanceof Readable ? input : undefined;
    this.#lifecycle = lifecycle;
    this.cancelled = new Error(cancellationMessage);
    this.#closed =
      this.#native === undefined
        ? undefined
        : new Promise<void>((resolve) => {
            this.#acknowledgeClose = resolve;
          });
  }

  readonly #onClose = (): void => this.#acknowledgeClose();
  // Cancellation can enter before the iterator installs its own error observer. Read classification
  // still belongs to the caller; this guard prevents an unobserved error during partial acquisition.
  readonly #onError = (): void => {};
  readonly #stop = (): void => this.requestClose(this.cancelled);

  #cleanupFailure(cause: unknown): void {
    this.#cleanupFailed = true;
    this.#lifecycle?.onFailure(new CliError('cli_internal', '', { cause }));
  }

  /** Reserve native observation before the caller enters any iterator factory or first next. */
  open(): void {
    this.#lifecycle?.signal.throwIfAborted();
    this.#started = true;
    try {
      this.#native?.on('error', this.#onError);
      this.#native?.once('close', this.#onClose);
      // Socket.closed (including internal closeEmitted/finished) is not an owned delivery receipt.
      if (this.#native?.closed === true) throw new CliError('cli_internal', '');
    } catch (cause) {
      this.#cleanupFailure(cause);
      throw cause;
    }
    this.#lifecycle?.signal.addEventListener('abort', this.#stop, { once: true });
    if (this.#lifecycle?.signal.aborted === true) this.#stop();
  }

  /** Independent, finite cancellation request. Set the latch before native entry/reentry. */
  requestClose(reason?: Error): void {
    if (!this.#started || this.#native === undefined || this.#destroyEntered) return;
    this.#destroyEntered = true;
    try {
      this.#native.destroy(reason);
    } catch (cause) {
      this.#cleanupFailure(cause);
    }
  }

  /** Publish one join before callbacks; destruction/EOF/iterator return/deadline never grants ACK. */
  close(): Promise<void> {
    this.#joining ??= Promise.resolve().then(() => this.#finish());
    return this.#joining;
  }

  async #finish(): Promise<void> {
    if (!this.#started) return;
    this.requestClose();
    try {
      this.#lifecycle?.signal.removeEventListener('abort', this.#stop);
    } catch (cause) {
      this.#cleanupFailure(cause);
    }
    await this.#closed;
    for (const [event, callback] of [
      ['close', this.#onClose],
      ['error', this.#onError],
    ] as const) {
      try {
        this.#native?.removeListener(event, callback);
      } catch (cause) {
        this.#cleanupFailure(cause);
      }
    }
    // The original owner's physical exit still bounds uncertainty; no second timer fabricates ACK.
    if (this.#cleanupFailed) await new Promise<never>(() => {});
  }
}
