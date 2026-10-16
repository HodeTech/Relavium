import { EgressWorkScope } from '../engine/egress-work.js';
import { CliError } from '../process/cli-error.js';
import { toUserFacing } from '../process/errors.js';
import type { CliInvocation } from '../process/invocation.js';
import type { OwnerRetirement } from '../process/invocation-registry.js';

const nativeThen: unknown = Object.getOwnPropertyDescriptor(Promise.prototype, 'then')?.value;

export interface SessionTerminalLease {
  /** Seal future input/acquisition synchronously, without unmounting an entered suspension. */
  readonly seal: () => void;
  /** Join entered native work, unmount once, then acknowledge actual exit/control delivery. */
  readonly release: () => Promise<void>;
}

export interface SessionTerminalAcquisition {
  readonly adopt: (lease: SessionTerminalLease) => void;
  /** Trusted constructor fact, never inferred from a missing handle or a thrown error. */
  readonly acknowledgeNoAcquisition: () => void;
}

/** One actual mount/prompt/control lifetime; independent from the controller's current UI pointer. */
export class SessionTerminalOwner {
  readonly #invocation: CliInvocation;
  readonly #assertEntering: () => void;
  readonly #failure: (cause: unknown) => void;
  readonly #work = new EgressWorkScope();
  readonly #retired: Promise<OwnerRetirement>;
  #resolveRetired: (value: OwnerRetirement) => void = () => undefined;
  #lease: SessionTerminalLease | undefined;
  #acquisition: 'not_entered' | 'unknown' | 'acknowledged' = 'not_entered';
  #sealed = false;
  #cleanupUncertain = false;
  #closing: Promise<void> | undefined;

  constructor(
    invocation: CliInvocation,
    assertEntering: () => void,
    failure: (cause: unknown) => void,
  ) {
    this.#invocation = invocation;
    this.#assertEntering = assertEntering;
    this.#failure = failure;
    invocation.finiteExit.activateFallback();
    this.#retired = new Promise((resolve) => {
      this.#resolveRetired = resolve;
    });
    invocation.registry.register({
      kind: 'terminal',
      retired: this.#retired,
      stop: this.seal,
      join: this.close,
      restore: this.close,
      classifyFailure: () => 'cli_internal',
    });
  }

  #assertAdmitting(): void {
    this.#assertEntering();
    if (this.#sealed) throw new CliError('cli_internal', '');
  }

  #acquisitionAcknowledged(): boolean {
    return this.#acquisition === 'acknowledged';
  }

  acquire<T>(factory: (acquisition: SessionTerminalAcquisition) => T): T {
    this.#assertAdmitting();
    if (this.#acquisition !== 'not_entered') throw new CliError('cli_internal', '');
    this.#acquisition = 'unknown';
    const declare = (): void => {
      if (this.#acquisition !== 'unknown') throw new CliError('cli_internal', '');
      this.#acquisition = 'acknowledged';
    };
    try {
      const value = factory(
        Object.freeze({
          adopt: (lease: SessionTerminalLease) => {
            // Capturing native cleanup callbacks can itself throw. Until that completes the
            // creation remains unknown, rather than an acknowledged lease with no release port.
            const captured = Object.freeze({ ...lease });
            declare();
            this.#lease = captured;
            if (this.#sealed) {
              try {
                this.#lease.seal();
              } catch (cause) {
                this.#uncertain(cause);
                throw cause;
              }
            }
          },
          acknowledgeNoAcquisition: declare,
        }),
      );
      if (!this.#acquisitionAcknowledged()) throw new CliError('cli_internal', '');
      return value;
    } catch (cause) {
      this.#failure(cause);
      throw cause;
    }
  }

  /** Exact raw operations include the full installed Ink suspension/publication continuation. */
  enter<T>(factory: () => Promise<T>): Promise<T> {
    this.#assertAdmitting();
    try {
      const raw = this.#work.retainWork(factory);
      if (this.#work.observationFailed) this.#uncertain(new CliError('cli_internal', ''));
      if (typeof nativeThen !== 'function') throw new CliError('cli_internal', '');
      Reflect.apply(nativeThen, raw, [undefined, this.#failure]);
      return raw;
    } catch (cause) {
      this.#failure(cause);
      throw cause;
    }
  }

  readonly seal = (): void => {
    if (this.#sealed) return;
    this.#sealed = true;
    this.#work.seal();
    try {
      this.#lease?.seal();
    } catch (cause) {
      this.#uncertain(cause);
    }
  };

  #uncertain(cause: unknown): void {
    this.#cleanupUncertain = true;
    const code =
      toUserFacing(cause).code === 'output_unavailable' ? 'output_unavailable' : 'cli_internal';
    this.#invocation.finiteExit.fail(code);
    this.#failure(new CliError(code, '', { cause }));
  }

  readonly close = (): Promise<void> => {
    if (this.#closing !== undefined) return this.#closing;
    let complete: () => void = () => undefined;
    this.#closing = new Promise((resolve) => {
      complete = resolve;
    });
    this.seal();
    void Promise.resolve()
      .then(async () => {
        // Ink resumes captured input when its suspension resolves, even after unmount. Only an
        // actual join BEFORE final release can prevent that continuation from reactivating input.
        await this.#work.done;
        if (this.#acquisition === 'unknown' || this.#invocation.registry.budget.remainingMs() === 0)
          return;
        await this.#lease?.release();
        if (this.#cleanupUncertain) return;
        this.#resolveRetired({ kind: 'settled' });
        complete();
      })
      .catch((cause: unknown) => this.#uncertain(cause));
    return this.#closing;
  };
}
