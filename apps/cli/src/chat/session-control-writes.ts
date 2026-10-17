import type { EgressWorkOptions } from '@relavium/db';
import { EgressWorkScope } from '../engine/egress-work.js';
import { CliError } from '../process/cli-error.js';
import type { CliInvocation } from '../process/invocation.js';

/** Actual captured control deliveries, including native reclaim entered before the terminal seals. */
export class SessionControlWrites {
  readonly #scope: EgressWorkScope;
  readonly #active = new Set<Promise<void>>();
  readonly #invocation: CliInvocation;
  readonly #write: (text: string) => Promise<void>;
  readonly #failure: (cause: unknown) => void;

  constructor(options: {
    readonly invocation: CliInvocation;
    readonly write: (text: string) => Promise<void>;
    readonly failure: (cause: unknown) => void;
    readonly parent?: EgressWorkOptions;
  }) {
    this.#scope = new EgressWorkScope(options.parent);
    this.#invocation = options.invocation;
    this.#write = options.write;
    this.#failure = options.failure;
  }

  readonly write = (text: string): Promise<void> => {
    if (this.#invocation.registry.budget.remainingMs() === 0) {
      const cause = new CliError('cli_internal', '');
      this.#report(cause);
      throw cause;
    }
    try {
      const raw = this.#scope.retainWork(() => this.#write(text));
      if (this.#scope.observationFailed) this.#report(new CliError('cli_internal', ''));
      this.#active.add(raw);
      void raw.then(
        () => {
          this.#active.delete(raw);
        },
        (cause: unknown) => {
          this.#active.delete(raw);
          this.#report(cause);
        },
      );
      return raw;
    } catch (cause) {
      this.#report(cause);
      throw cause;
    }
  };

  #report(cause: unknown): void {
    try {
      this.#failure(cause);
    } catch {
      this.#invocation.finiteExit.fail('cli_internal');
    }
  }

  /** Snapshot only already-entered delivery; this grants no new input/publication authority. */
  readonly joinEntered = (): Promise<void> => Promise.all([...this.#active]).then(() => undefined);

  readonly close = (): Promise<void> => {
    this.#scope.seal();
    return this.#scope.done;
  };
}
