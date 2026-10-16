import { CliError } from '../process/cli-error.js';
import type { SessionOwner } from '../process/invocation-registry.js';
import { SessionHostOwner } from './session-host-owner.js';
import type { SessionSurfaceLifetime } from './session-surface-lifetime.js';

/** All actual instances, including pending/late/superseded builds; UI pointers confer no close authority. */
export class SessionHosts {
  readonly #surface: SessionSurfaceLifetime;
  readonly #kind: SessionOwner['surface'];
  readonly #hosts = new Set<SessionHostOwner>();
  #closing: Promise<void> | undefined;

  constructor(surface: SessionSurfaceLifetime, kind: SessionOwner['surface']) {
    this.#surface = surface;
    this.#kind = kind;
  }

  /** Includes post-build persistence/seeding/publication. Failure cleanup runs OUTSIDE this retained root. */
  async construct<T>(factory: (host: SessionHostOwner) => Promise<T>): Promise<T> {
    this.#surface.work.assertAdmitting();
    if (this.#closing !== undefined) throw new CliError('cli_internal', '');
    const host = new SessionHostOwner(this.#surface.invocation, this.#kind);
    this.#hosts.add(host);
    void host.work.retired.then(() => {
      this.#hosts.delete(host);
    });
    try {
      return await host.work.enter(async () => {
        const value = await factory(host);
        host.work.assertAdmitting();
        return value;
      });
    } catch (cause) {
      // Observe before waiting on any held MCP/producer close. Never close from inside the same root.
      host.work.failure(cause);
      await host.work.close();
      if (host.work.isStoppedFailure(cause)) this.#surface.work.assertAdmitting();
      throw cause;
    }
  }

  /** Attempt every finite stop before awaiting any real host close. No new construction can enter afterward. */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    let complete: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.#closing = pending;
    const hosts = [...this.#hosts];
    for (const host of hosts) {
      try {
        host.work.stop();
      } catch (cause) {
        host.work.cleanupUncertain(cause);
      }
    }
    void Promise.all(hosts.map((host) => host.work.close())).then(complete, (cause: unknown) => {
      this.#surface.work.cleanupUncertain(cause);
    });
    return pending;
  }
}
