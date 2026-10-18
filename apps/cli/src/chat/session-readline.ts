import { createInterface, type Interface } from 'node:readline';
import { CliError } from '../process/cli-error.js';
import type { SessionWorkOwner } from './session-work-owner.js';
import { SessionTerminalOwner } from './session-terminal-owner.js';

/** Native terminal:false readline acquires input callbacks even when its constructor throws. */
class CapturedReadline {
  readonly #input: NodeJS.ReadableStream;
  readonly #work: SessionWorkOwner | undefined;
  readonly #remove: NodeJS.ReadableStream['removeListener'];
  readonly #listeners: (event: string | symbol) => readonly unknown[];
  readonly #events: () => Array<string | symbol>;
  readonly #pause: () => void;
  readonly #owner: SessionTerminalOwner | undefined;
  readonly #baseline = new Map<string | symbol, Map<unknown, number>>();
  readonly #introduced = new Map<string | symbol, Set<unknown>>();
  #readline: Interface | undefined;
  #nativeClose: (() => void) | undefined;
  #sealed = false;
  #closed = false;
  #failure: { cause: unknown } | undefined;
  #started = false;
  #constructed = false;
  #finishConstructing: () => void = () => {};
  readonly #construction = new Promise<void>((resolve) => {
    this.#finishConstructing = resolve;
  });
  #closing: Promise<void> | undefined;

  constructor(input: NodeJS.ReadableStream, work: SessionWorkOwner | undefined) {
    this.#input = input;
    this.#work = work;
    this.#owner =
      work === undefined
        ? undefined
        : new SessionTerminalOwner(work.invocation, work.assertAdmitting, work.failure);
    this.#remove = input.removeListener.bind(input);
    this.#listeners = input.listeners.bind(input);
    this.#events = input.eventNames.bind(input);
    this.#pause = input.pause.bind(input);
  }

  readonly #added = (event: string | symbol, listener: unknown): void => {
    const callbacks = this.#introduced.get(event) ?? new Set<unknown>();
    callbacks.add(listener);
    this.#introduced.set(event, callbacks);
  };

  #remember(cause: unknown): void {
    this.#failure ??= { cause };
    this.#work?.failure(cause);
  }

  readonly stop = (): void => {
    this.#sealed = true;
    if (this.#nativeClose === undefined || this.#closed) return;
    try {
      this.#nativeClose();
      this.#closed = true; // Actual synchronous native close returned; a request alone sets no ACK.
    } catch (cause) {
      this.#remember(cause);
    }
  };

  open(): Interface {
    const construct = (): Interface => {
      this.#started = true;
      try {
        for (const event of this.#events()) {
          const counts = new Map<unknown, number>();
          for (const listener of this.#listeners(event))
            counts.set(listener, (counts.get(listener) ?? 0) + 1);
          this.#baseline.set(event, counts);
        }
        this.#input.on('newListener', this.#added);
        this.#readline = createInterface({ input: this.#input, terminal: false });
        this.#nativeClose = this.#readline.close.bind(this.#readline);
        if (this.#sealed) this.stop();
        return this.#readline;
      } finally {
        this.#constructed = true;
        this.#finishConstructing();
      }
    };
    if (this.#owner === undefined) return construct();
    return this.#owner.acquire((acquisition) => {
      // Fixed native construction profile: no output/raw-mode acquisition, only this captured input.
      // Declare its cleanup BEFORE observer/constructor/iterator entry, including partial creation.
      acquisition.adopt({ seal: this.stop, release: () => this.#release() });
      return construct();
    });
  }

  enter<T>(body: () => Promise<T>): Promise<T> {
    return this.#owner?.enter(body) ?? body();
  }

  async #release(): Promise<void> {
    if (!this.#started) return;
    if (!this.#constructed) await this.#construction;
    const attempt = (body: () => void): void => {
      try {
        body();
      } catch (cause) {
        this.#remember(cause);
      }
    };
    this.stop();
    // Preserve prior occurrences even when native removal reenters and consumes a sibling.
    for (let pass = 0; pass < 2; pass++) {
      for (const [event, listeners] of [...this.#introduced]) {
        for (const listener of [...listeners]) {
          const baseline = this.#baseline.get(event)?.get(listener) ?? 0;
          const surplus =
            this.#listeners(event).filter((value) => value === listener).length - baseline;
          for (let remaining = surplus; remaining > 0; remaining--) {
            if (this.#listeners(event).filter((value) => value === listener).length <= baseline)
              break;
            attempt(() => {
              Reflect.apply(this.#remove, this.#input, [event, listener]);
            });
          }
        }
      }
      attempt(() => {
        this.#pause();
      });
    }
    attempt(() => {
      this.#remove('newListener', this.#added);
    });
    attempt(() => {
      for (const event of this.#events()) {
        const counts = new Map<unknown, number>();
        for (const listener of this.#listeners(event))
          counts.set(listener, (counts.get(listener) ?? 0) + 1);
        if (
          [...counts].some(
            ([listener, count]) => count > (this.#baseline.get(event)?.get(listener) ?? 0),
          )
        )
          throw new CliError('cli_internal', '');
      }
    });
    if (this.#failure !== undefined) throw this.#failure.cause;
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closing = Promise.resolve().then(() => this.#owner?.close() ?? this.#release());
    return this.#closing;
  }
}

/** Cover subscription and native construction/iterator entry with one independently owed input release. */
export async function withSessionReadline<T>(
  input: NodeJS.ReadableStream,
  work: SessionWorkOwner | undefined,
  subscribe: () => () => void,
  body: (readline: Interface, stop: () => void) => Promise<T>,
): Promise<T> {
  const captured = new CapturedReadline(input, work);
  let unsubscribe: () => void = () => {};
  let result: { value: T } | undefined;
  let primary: { cause: unknown } | undefined;
  let secondary: { cause: unknown } | undefined;
  try {
    unsubscribe = subscribe();
    const readline = captured.open();
    // Iterator/driver continuations can resume input. Final release follows their actual settlement.
    result = { value: await captured.enter(() => body(readline, captured.stop)) };
  } catch (cause) {
    primary = { cause };
    work?.failure(cause);
  } finally {
    try {
      unsubscribe();
    } catch (cause) {
      secondary = { cause };
      work?.failure(cause);
    }
    try {
      await captured.close();
    } catch (cause) {
      secondary ??= { cause };
      work?.failure(cause);
    }
  }
  if (primary !== undefined) throw primary.cause;
  if (secondary !== undefined) throw secondary.cause;
  if (result === undefined) throw new CliError('cli_internal', '');
  return result.value;
}
