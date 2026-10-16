import type { CliInvocation } from '../process/invocation.js';
import { CliError } from '../process/cli-error.js';
import { SHOW_CURSOR } from '../render/alt-screen.js';
import { DISABLE_BRACKETED_PASTE } from '../render/tui/home-input.js';

/**
 * Exact captured input for one exclusive native mount. Ink 7.1 can reattach its readable
 * callback after autonomous unmount; the last native release must therefore remain ours.
 */
export class SessionInkInput {
  readonly #input: NodeJS.ReadStream;
  readonly #invocation: CliInvocation;
  readonly #acknowledge: (text: string) => Promise<void>;
  readonly #failure: (cause: unknown) => void;
  readonly #listeners = new Set<unknown>();
  #baseline = new Map<unknown, number>();
  readonly #remove: NodeJS.ReadStream['removeListener'];
  readonly #readable: () => readonly unknown[];
  #entered = false;
  #finishEntering: () => void = () => undefined;
  readonly #enteredReady = new Promise<void>((resolve) => {
    this.#finishEntering = resolve;
  });
  #closing: Promise<void> | undefined;

  constructor(options: {
    readonly input: NodeJS.ReadStream;
    readonly invocation: CliInvocation;
    readonly acknowledge: (text: string) => Promise<void>;
    readonly failure: (cause: unknown) => void;
  }) {
    this.#input = options.input;
    this.#invocation = options.invocation;
    this.#acknowledge = options.acknowledge;
    this.#failure = options.failure;
    this.#remove = options.input.removeListener.bind(options.input);
    this.#readable = () => options.input.listeners('readable');
  }

  readonly #added = (event: string | symbol, listener: unknown): void => {
    if (event === 'readable' && typeof listener === 'function') this.#listeners.add(listener);
  };

  /** Enter before render, retain the exact callbacks introduced by this exclusive mount. */
  enter(): void {
    if (this.#entered || this.#closing !== undefined) throw new CliError('cli_internal', '');
    this.#entered = true;
    try {
      for (const listener of this.#readable())
        this.#baseline.set(listener, (this.#baseline.get(listener) ?? 0) + 1);
      this.#input.on('newListener', this.#added);
    } finally {
      this.#finishEntering();
    }
  }

  #report(cause: unknown): void {
    try {
      this.#failure(cause);
    } catch {
      this.#invocation.finiteExit.fail('cli_internal');
    }
  }

  /** Invoked only AFTER full entered native continuations and the last unmount attempt. */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    let resolve: () => void = () => undefined;
    let reject: (cause: unknown) => void = () => undefined;
    this.#closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void this.#close().then(resolve, reject);
    return this.#closing;
  }

  async #close(): Promise<void> {
    if (!this.#entered) return;
    await this.#enteredReady;
    let failed: { readonly cause: unknown } | undefined;
    const attempt = (body: () => void): void => {
      try {
        body();
      } catch (cause) {
        failed ??= { cause };
        this.#report(cause);
      }
    };
    // Keep the observer through native cleanup so reentrant additions are retained too. Two
    // bounded passes tolerate a late native reattachment without an unbounded callback loop.
    for (let pass = 0; pass < 2; pass++) {
      for (const listener of [...this.#listeners]) {
        const introduced =
          this.#readable().filter((value) => value === listener).length -
          (this.#baseline.get(listener) ?? 0);
        for (let remaining = introduced; remaining > 0; remaining--) {
          // A native removal hook may have consumed a sibling occurrence. Never spend
          // the preserved baseline using a surplus measured before that reentry.
          if (
            this.#readable().filter((value) => value === listener).length <=
            (this.#baseline.get(listener) ?? 0)
          )
            break;
          attempt(() => {
            Reflect.apply(this.#remove, this.#input, ['readable', listener]);
          });
        }
      }
      attempt(() => {
        this.#input.pause();
      });
      attempt(() => {
        if (this.#input.isRaw) this.#input.setRawMode(false);
      });
      attempt(() => {
        this.#input.unref();
      });
    }
    attempt(() => {
      Reflect.apply(this.#remove, this.#input, ['newListener', this.#added]);
    });
    attempt(() => {
      const remaining = new Map<unknown, number>();
      for (const listener of this.#readable())
        remaining.set(listener, (remaining.get(listener) ?? 0) + 1);
      if (
        this.#input.isRaw ||
        [...remaining].some(([listener, count]) => count > (this.#baseline.get(listener) ?? 0))
      )
        throw new CliError('cli_internal', '');
    });
    if (this.#invocation.registry.budget.remainingMs() === 0) await new Promise<never>(() => {});
    try {
      await this.#acknowledge(DISABLE_BRACKETED_PASTE + SHOW_CURSOR);
    } catch (cause) {
      failed ??= { cause };
      this.#report(cause);
    }
    if (failed !== undefined) throw failed.cause;
  }
}
