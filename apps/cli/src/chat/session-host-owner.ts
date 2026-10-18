import type { CliInvocation } from '../process/invocation.js';
import type { SessionOwner } from '../process/invocation-registry.js';
import type { SessionPersister } from './persister.js';
import type { BuiltChatSession } from './session-host.js';
import { SessionWorkOwner } from './session-work-owner.js';

/** One reservation per actual builder invocation, including late and superseded Home instances. */
export class SessionHostOwner {
  readonly work: SessionWorkOwner;
  #built: BuiltChatSession | undefined;
  #cancelled: BuiltChatSession | undefined;
  #persister: SessionPersister | undefined;
  #constructionEntered = false;
  #mcpClosing: Promise<void> | undefined;

  constructor(invocation: CliInvocation, surface: SessionOwner['surface']) {
    this.work = new SessionWorkOwner(invocation, surface, {
      cancel: () => this.#cancel(),
      beforeWorkJoin: () => this.#closeMcp(),
      cleanup: () => this.#cleanup(),
    });
  }

  /** The retained root includes adoption, so raw builder settlement cannot retire a late resource first. */
  build<T extends BuiltChatSession>(factory: (owner: SessionWorkOwner) => Promise<T>): Promise<T> {
    this.work.assertAdmitting();
    if (this.#constructionEntered) throw new Error('Session construction is already owned.');
    this.#constructionEntered = true;
    return this.work.enter(async () => {
      const built = await factory(this.work);
      this.#built = built;
      if (this.work.signal.aborted) {
        try {
          this.#cancel();
        } catch (cause) {
          this.work.cleanupUncertain(cause);
        }
      }
      this.work.assertAdmitting();
      return { ...built, workOwner: this.work, hostOwner: this };
    });
  }

  /** Adopt before the caller starts the persister or any session event can require it. */
  createPersister(factory: () => SessionPersister): SessionPersister {
    this.work.assertAdmitting();
    if (this.#persister !== undefined) throw new Error('Session persistence is already attached.');
    const persister = factory();
    this.#persister = persister;
    this.work.assertAdmitting();
    return persister;
  }

  /** Cooperative end publishes its real terminal before sealing output; fatal stop stays sealed. */
  cancel(): void {
    try {
      this.#cancel();
    } catch (cause) {
      this.work.cleanupUncertain(cause);
    } finally {
      this.work.stop();
    }
  }

  #cancel(): void {
    const built = this.#built;
    if (built === undefined || this.#cancelled === built) return;
    this.#cancelled = built;
    try {
      built.session.cancel();
    } finally {
      // The terminal write is synchronous and its bus listener retains refusal without throwing
      // through cancel(). Observe that owned failure before a held provider can delay cleanup.
      const failure = this.#persister?.durabilityFailure;
      if (failure !== undefined) this.work.cleanupUncertain(failure);
    }
  }

  #closeMcp(): Promise<void> {
    if (this.#mcpClosing !== undefined) return this.#mcpClosing;
    const built = this.#built;
    if (built === undefined || built.closeMcp === undefined) return Promise.resolve();
    // Publish the exact retained operation before entering callbacks. The SDK's native-close
    // receipt is itself transferred work, so its close request must precede that work's join.
    // Entered roots are already settled; the core barrier additionally joins actual provider,
    // tool and accounting work before an otherwise idle MCP connection can close.
    const close = built.closeMcp;
    const raw = Promise.resolve().then(async () => {
      try {
        await built.whenHostSafeToClose();
      } catch (cause) {
        this.work.cleanupUncertain(cause);
      }
      if (this.work.invocation.registry.budget.remainingMs() === 0)
        await new Promise<never>(() => {});
      try {
        await close.call(built, (_id, cause) => this.work.cleanupUncertain(cause));
      } catch (cause) {
        this.work.cleanupUncertain(cause);
      }
    });
    this.#mcpClosing = this.work.work.retainWork(() => raw);
    return this.#mcpClosing;
  }

  async #cleanup(): Promise<void> {
    const built = this.#built;
    if (built === undefined) return;
    // Every root and transferred child has actually settled before this callback enters. The
    // runtime additionally joins accounting/host work. A rejected barrier is retained uncertainty,
    // never DB-close permission; sibling teardown is still attempted within the same budget.
    try {
      await built.whenHostSafeToClose();
    } catch (cause) {
      this.work.cleanupUncertain(cause);
    }
    const persister = this.#persister;
    if (persister !== undefined) {
      if (persister.durabilityFailure !== undefined)
        this.work.cleanupUncertain(persister.durabilityFailure);
      try {
        persister.close();
      } catch (cause) {
        this.work.cleanupUncertain(cause);
      }
    }
    await this.#mcpClosing;
  }
}
