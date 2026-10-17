import { CliError } from '../process/cli-error.js';
import type { SessionWorkOwner } from './session-work-owner.js';

/** A chat view's actual subscription/timer releases, retained independently of the selected UI pointer. */
export class SessionViewLifetime {
  readonly #owner: SessionWorkOwner;
  readonly #removers: Array<() => void> = [];
  readonly done: Promise<void>;
  #complete: () => void = () => undefined;
  #constructing = 0;
  #sealed = false;
  #uncertain = false;
  #released = false;

  constructor(owner: SessionWorkOwner, releaseOnStop = true) {
    owner.assertAdmitting(); // A refused, unreturned view must not transfer an unreachable empty lifetime.
    this.#owner = owner;
    this.done = new Promise<void>((resolve) => {
      this.#complete = resolve;
    });
    void owner.work.retainWork(() => this.done);
    if (releaseOnStop) {
      this.#removers.push(() => owner.signal.removeEventListener('abort', this.release));
      this.acquire(() => {
        owner.signal.addEventListener('abort', this.release, { once: true });
        return () => undefined;
      });
      if (owner.signal.aborted) this.release();
    }
  }

  /** Publish construction custody before entering registration; a throw never proves no acquisition. */
  acquire(factory: () => () => void): void {
    this.#owner.assertAdmitting();
    if (this.#sealed) throw new CliError('cli_internal', '');
    this.#constructing += 1;
    try {
      this.#removers.push(factory());
    } catch (cause) {
      this.#uncertain = true;
      this.#owner.cleanupUncertain(cause);
      throw cause;
    } finally {
      this.#constructing -= 1;
      if (this.#sealed) this.#finish();
    }
    this.#owner.assertAdmitting();
  }

  readonly release = (): void => {
    this.#sealed = true;
    this.#finish();
  };

  #finish(): void {
    if (this.#constructing !== 0 || this.#released) return;
    this.#released = true; // Removers may reenter release().
    for (const remove of this.#removers) {
      try {
        remove();
      } catch (cause) {
        this.#uncertain = true;
        this.#owner.cleanupUncertain(cause);
      }
    }
    if (!this.#uncertain) this.#complete();
  }
}
