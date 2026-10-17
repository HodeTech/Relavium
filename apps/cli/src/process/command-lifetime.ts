import type { DispatchContext } from '../commands/input.js';
import { CliError, toUserFacing } from './errors.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import type { CliInvocation } from './invocation.js';
import type { CliIo } from './io.js';
import { InvocationWorkOwner } from './invocation-work-owner.js';
import { defaultSubscribeSignals } from './signals.js';
import { subscribeWithSignalCustody } from './signal-custody.js';
import { acquireNativeResource } from './acquire-native-resource.js';

/** One management operation, with no AgentSession label or workflow receipt authority. */
export class CommandLifetime {
  readonly work: InvocationWorkOwner;
  readonly io: CliIo;
  /** Captured restoration capability; business admission must not block an entered prompt's cleanup. */
  readonly terminalIo: CliIo;
  readonly #cleanups: (() => void | Promise<void>)[] = [];
  readonly #removeSignals: () => void;
  #cleaning = false;

  constructor(
    readonly invocation: CliInvocation,
    io: CliIo,
    subscribeSignals = defaultSubscribeSignals,
  ) {
    this.terminalIo = io;
    this.work = new InvocationWorkOwner(
      invocation,
      { kind: 'command' },
      {
        cancel: () => undefined,
        cleanup: async () => {
          this.#cleaning = true;
          // Enter all independent releases before awaiting any. An uncertain release never retires this owner.
          const releases = this.#cleanups.splice(0).map((close) =>
            Promise.resolve()
              .then(close)
              .catch((cause: unknown) => {
                this.work.cleanupUncertain(cause);
              }),
          );
          await Promise.all(releases);
          if (this.#cleanupFailed) await new Promise<never>(() => {});
          this.#removeSignals();
        },
      },
    );
    this.io = {
      ...io,
      writeOut: (text) => this.#write(() => io.writeOut(text)),
      writeErr: (text) => this.#write(() => io.writeErr(text)),
      writeOutAcknowledged: (text) => this.#deliver(() => io.writeOutAcknowledged(text)),
      writeErrAcknowledged: (text) => this.#deliver(() => io.writeErrAcknowledged(text)),
    };
    try {
      this.#removeSignals = subscribeWithSignalCustody(
        invocation.signalCustody,
        subscribeSignals,
        (signo) => invocation.finiteExit.signal(signo),
      );
    } catch (cause) {
      this.work.cleanupUncertain(cause);
      throw cause;
    }
  }

  #cleanupFailed = false;

  /** Adopt an already-entered acquisition even if stop raced its return; roots still hold cleanup open. */
  readonly adoptCleanup = (close: () => void | Promise<void>): void => {
    if (this.#cleaning) {
      const cause = new CliError('cli_internal', '');
      this.work.cleanupUncertain(cause);
      throw cause;
    }
    this.#cleanups.push(() => {
      try {
        const raw = close();
        return Promise.resolve(raw).catch((cause: unknown) => {
          this.#cleanupFailed = true;
          throw cause;
        });
      } catch (cause) {
        this.#cleanupFailed = true;
        throw cause;
      }
    });
  };

  /** Capture partial native resources before setup can fail; legacy injected openers adopt on return. */
  acquire<Resource extends { readonly close: () => void }>(
    factory: (captureClose: (close: () => void) => void) => Resource,
  ): Resource {
    return acquireNativeResource(factory, {
      assertAdmitting: () => this.work.assertAdmitting(),
      captureClose: this.adoptCleanup,
      isStoppedFailure: this.work.isStoppedFailure,
      cleanupUncertain: (cause) => {
        this.#cleanupFailed = true;
        this.work.cleanupUncertain(cause);
      },
    });
  }

  async execute(body: () => Promise<ExitCode>): Promise<ExitCode> {
    let result: ExitCode = EXIT_CODES.success;
    let failure: { readonly cause: unknown } | undefined;
    try {
      result = await this.work.enter(body);
      if (result === 9 || result === 5 || result === 7 || result === 8)
        this.invocation.finiteExit.fail('cli_internal');
      else this.invocation.registry.observations.observeOutcome(result);
    } catch (cause) {
      if (!this.work.isStoppedFailure(cause)) {
        failure = { cause };
        this.invocation.registry.observations.observeFailure(toUserFacing(cause).code);
      }
    } finally {
      await this.work.close();
    }
    if (this.invocation.registry.observations.hasInfrastructureFailure())
      throw new CliError(
        this.invocation.registry.observations.infrastructureCode() ?? 'cli_internal',
        '',
        failure === undefined ? undefined : { cause: failure.cause },
      );
    if (failure !== undefined) throw failure.cause;
    return result;
  }

  #write(factory: () => void): void {
    this.work.assertAdmitting();
    try {
      factory();
    } catch (cause) {
      const failure = new CliError('output_unavailable', '', { cause });
      this.work.failure(failure);
      throw failure;
    }
  }

  #deliver(factory: () => Promise<void>): Promise<void> {
    this.work.assertAdmitting();
    return this.work.work.retainWork(async () => {
      try {
        await factory();
      } catch (cause) {
        const failure = new CliError('output_unavailable', '', { cause });
        this.work.failure(failure);
        throw failure;
      }
    });
  }
}

/** Existing workflow/session drivers own themselves; this helper covers management and maintenance only. */
export function withCommandLifetime(
  ctx: DispatchContext,
  body: (owned: DispatchContext) => Promise<ExitCode>,
): Promise<ExitCode> {
  if (ctx.invocation === undefined || ctx.commandLifetime !== undefined) return body(ctx);
  const lifetime = new CommandLifetime(ctx.invocation, ctx.io);
  return lifetime.execute(() => body({ ...ctx, io: lifetime.io, commandLifetime: lifetime }));
}

/** No opener selection/classification policy here; this only transfers exact acquisition custody. */
export function acquireCommandResource<Resource extends { readonly close: () => void }>(
  lifetime: CommandLifetime | undefined,
  factory: (captureClose: (close: () => void) => void) => Resource,
): Resource {
  return lifetime === undefined ? factory(() => {}) : lifetime.acquire(factory);
}
