import { acquireNativeResource } from '../process/acquire-native-resource.js';
import type { CliInvocation } from '../process/invocation.js';
import type { ExitCode } from '../process/exit-codes.js';
import { CliError } from '../process/cli-error.js';
import { defaultSubscribeSignals } from '../process/signals.js';
import { createSuspendPort } from '../render/suspend.js';
import { SessionHosts } from './session-hosts.js';
import { SessionSurfaceLifetime } from './session-surface-lifetime.js';

interface ChatSignalLifecycle {
  readonly onInterrupt: (callback: () => void) => () => void;
  readonly onTerminationSignal: (callback: (signo: number) => void) => () => void;
}

/** One invocation across fresh/resume/clear/reseat; the shared database follows every actual host. */
export class SessionChatLifetime {
  readonly surface: SessionSurfaceLifetime;
  readonly hosts: SessionHosts;
  readonly suspendPort = createSuspendPort();
  #interrupt: (() => void) | undefined;
  #cooperativeRequested = false;
  #store: { readonly close: () => void } | undefined;

  constructor(invocation: CliInvocation, lifecycle?: ChatSignalLifecycle) {
    this.surface = new SessionSurfaceLifetime(
      invocation,
      'chat',
      (terminate) => {
        const signal = (signo: number): void => {
          if (signo === 2) {
            if (this.suspendPort.isSuspended()) return;
            if (this.#cooperativeRequested) {
              invocation.finiteExit.cooperativeCancel(4);
              return;
            }
            if (this.#interrupt !== undefined) {
              this.#cooperativeRequested = true;
              try {
                this.#interrupt();
              } catch {
                invocation.finiteExit.fail('cli_internal');
              }
              return;
            }
          }
          terminate(signo);
        };
        if (lifecycle === undefined) return defaultSubscribeSignals(signal);
        const removeInterrupt = lifecycle.onInterrupt(() => signal(2));
        let removeTermination: () => void;
        try {
          removeTermination = lifecycle.onTerminationSignal(signal);
        } catch (cause) {
          removeInterrupt();
          throw cause;
        }
        return () => {
          try {
            removeInterrupt();
          } finally {
            removeTermination();
          }
        };
      },
      async () => {
        // This stage runs after both surface roots and transferred warning/control tails join.
        this.#store?.close();
        await Promise.resolve();
      },
    );
    this.hosts = new SessionHosts(this.surface, 'chat');
  }

  get interrupted(): boolean {
    return this.#cooperativeRequested;
  }

  /** The driver consumes cooperative SIGINT; all other signals still use the one finite authority. */
  readonly subscribeInterrupt = (listener: () => void): (() => void) => {
    this.surface.work.assertAdmitting();
    if (this.#interrupt !== undefined) throw new CliError('cli_internal', '');
    this.#interrupt = listener;
    return () => {
      if (this.#interrupt === listener) this.#interrupt = undefined;
    };
  };

  /** Capture the shared connection before native setup; release remains after every original host/tail. */
  acquireStore<Resource extends { readonly close: () => void }>(
    factory: (captureClose: (close: () => void) => void) => Resource,
  ): Resource {
    if (this.#store !== undefined) throw new CliError('cli_internal', '');
    return acquireNativeResource(factory, {
      assertAdmitting: this.surface.work.assertAdmitting,
      captureClose: (close) => {
        if (this.#store !== undefined) throw new CliError('cli_internal', '');
        this.#store = { close };
      },
      cleanupUncertain: this.surface.work.cleanupUncertain,
      isStoppedFailure: this.surface.work.isStoppedFailure,
    });
  }

  adoptStore(store: { readonly close: () => void }): void {
    if (this.#store !== undefined) throw new CliError('cli_internal', '');
    this.#store = store;
    try {
      this.#store = Object.freeze({ close: store.close.bind(store) });
    } catch (cause) {
      this.surface.work.cleanupUncertain(cause);
      throw cause;
    }
  }

  execute(body: () => Promise<ExitCode>): Promise<ExitCode> {
    return this.surface.execute(async () => {
      try {
        return await body();
      } catch (cause) {
        this.surface.work.failure(cause);
        throw cause;
      } finally {
        await this.hosts.close();
      }
    });
  }
}
