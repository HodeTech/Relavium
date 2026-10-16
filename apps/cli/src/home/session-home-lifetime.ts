import type { CliInvocation } from '../process/invocation.js';
import type { ExitCode } from '../process/exit-codes.js';
import { defaultSubscribeSignals } from '../process/signals.js';
import { createSuspendPort } from '../render/suspend.js';
import { SessionHosts } from '../chat/session-hosts.js';
import { SessionSurfaceLifetime } from '../chat/session-surface-lifetime.js';
import { SessionViewLifetime } from '../chat/session-view-lifetime.js';
import type { SessionWorkOwner } from '../chat/session-work-owner.js';
import { CliError } from '../process/cli-error.js';

/** The actual Home invocation owns pending, late and superseded chats and their shared database tail. */
export class SessionHomeLifetime {
  readonly surface: SessionSurfaceLifetime;
  readonly hosts: SessionHosts;
  readonly suspendPort = createSuspendPort();
  readonly #views = new Set<SessionViewLifetime>();
  #store: { readonly close: () => void } | undefined;

  constructor(invocation: CliInvocation, subscribe = defaultSubscribeSignals) {
    this.surface = new SessionSurfaceLifetime(
      invocation,
      'home',
      (signal) =>
        subscribe((signo) => {
          if (signo === 2 && this.suspendPort.isSuspended()) return;
          signal(signo);
        }),
      async () => {
        this.#store?.close();
        await Promise.resolve();
      },
    );
    this.hosts = new SessionHosts(this.surface, 'home');
  }

  adoptStore(store: { readonly close: () => void }): void {
    if (this.#store !== undefined) throw new CliError('cli_internal', '');
    this.#store = store;
    try {
      this.#store = { close: store.close.bind(store) };
    } catch (cause) {
      this.surface.work.cleanupUncertain(cause);
      throw cause;
    }
  }

  view(owner: SessionWorkOwner): SessionViewLifetime {
    const view = new SessionViewLifetime(owner);
    this.#views.add(view);
    void view.done.then(() => {
      this.#views.delete(view);
    });
    return view;
  }

  releaseViews(): void {
    for (const view of this.#views) view.release();
  }

  execute(body: () => Promise<ExitCode>): Promise<ExitCode> {
    return this.surface.execute(async () => {
      try {
        return await body();
      } catch (cause) {
        this.surface.work.failure(cause);
        throw cause;
      } finally {
        this.releaseViews();
        await this.hosts.close();
      }
    });
  }
}
