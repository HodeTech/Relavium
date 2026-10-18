import { CliError, toUserFacing } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import { createCliInvocation, type CliInvocation } from '../process/invocation.js';
import type { SessionOwner } from '../process/invocation-registry.js';
import { defaultSubscribeSignals } from '../process/signals.js';
import { subscribeWithSignalCustody } from '../process/signal-custody.js';
import { SessionWorkOwner } from './session-work-owner.js';

/**
 * The surface root includes preparation and the shared database's actual cleanup. Per-host
 * retirement alone cannot release this owner or end a signal path ahead of the database tail.
 */
export class SessionSurfaceLifetime {
  readonly invocation: CliInvocation;
  readonly work: SessionWorkOwner;
  readonly #removeSignals: () => void;

  constructor(
    invocation: CliInvocation | undefined,
    surface: SessionOwner['surface'],
    subscribeSignals = defaultSubscribeSignals,
    cleanup?: () => Promise<void>,
  ) {
    this.invocation = invocation ?? createCliInvocation();
    this.work = new SessionWorkOwner(this.invocation, surface, {
      cancel: () => undefined,
      cleanup: async () => {
        // Signal custody must survive a failed database release. A later signal still
        // belongs to the original finite authority while cleanup remains uncertain.
        await cleanup?.();
        if (this.work.hasCleanupUncertainty) await new Promise<never>(() => {});
        this.#removeSignals();
      },
    });
    try {
      this.#removeSignals = subscribeWithSignalCustody(
        this.invocation.signalCustody,
        subscribeSignals,
        (signo) => this.invocation.finiteExit.signal(signo),
      );
    } catch (cause) {
      this.work.cleanupUncertain(cause);
      throw cause;
    }
  }

  async execute(body: () => Promise<ExitCode>): Promise<ExitCode> {
    let result: ExitCode = EXIT_CODES.chatEnded;
    let failed: { readonly cause: unknown } | undefined;
    try {
      result = await this.work.enter(body);
      if (result === EXIT_CODES.infrastructureFailed)
        this.invocation.finiteExit.fail('cli_internal');
      else if (result === 5 || result === 7 || result === 8) {
        // Session surfaces do not possess workflow receipt/effect health authority.
        this.invocation.finiteExit.fail('cli_internal');
      } else this.invocation.registry.observations.observeOutcome(result);
    } catch (cause) {
      if (!this.work.isStoppedFailure(cause)) {
        failed = { cause };
        this.invocation.registry.observations.observeFailure(toUserFacing(cause).code);
      }
    } finally {
      await this.work.close();
    }
    const combined = this.invocation.registry.observations.exitCode();
    if (failed !== undefined) {
      if (combined === EXIT_CODES.infrastructureFailed && toUserFacing(failed.cause).exitCode !== 9)
        throw new CliError(
          this.invocation.registry.observations.infrastructureCode() ?? 'cli_internal',
          '',
          { cause: failed.cause },
        );
      throw failed.cause;
    }
    // Native signal exit is already owned by the common finite capability; do not manufacture a session outcome.
    return combined === EXIT_CODES.infrastructureFailed ? EXIT_CODES.infrastructureFailed : result;
  }
}
