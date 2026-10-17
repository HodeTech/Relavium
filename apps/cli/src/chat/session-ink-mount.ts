import { CliError } from '../process/cli-error.js';
import type { CliInvocation } from '../process/invocation.js';
import type { SuspendAttachment, SuspendPort } from '../render/suspend.js';
import { SessionTerminalOwner } from './session-terminal-owner.js';
import type { SessionInkInput } from './session-ink-input.js';

/** The actual installed renderer's cleanup ports; acquisition never follows an ambient TTY fallback. */
export interface SessionInkHandle {
  readonly unmount: () => void;
  readonly waitUntilExit: () => Promise<unknown>;
}

/** One actual Ink mount, including its complete suspension continuations and native exit acknowledgement. */
export class SessionInkMount {
  readonly #owner: SessionTerminalOwner;
  readonly #attachment: SuspendAttachment;
  readonly #invocation: CliInvocation;
  readonly #failure: (cause: unknown) => void;
  readonly #stopInput: () => void;
  readonly #drainNative: () => Promise<void>;
  readonly #input: SessionInkInput | undefined;
  readonly #assertEntering: () => void;
  #sealed = false;
  #exited: Promise<unknown> | undefined;
  #suspensions: Promise<void> | undefined;
  #nativeDrain: Promise<void> | undefined;

  constructor(options: {
    readonly invocation: CliInvocation;
    readonly assertEntering: () => void;
    readonly failure: (cause: unknown) => void;
    readonly suspendPort: SuspendPort;
    /** Synchronous input/dispatch seal, without unmounting Ink beneath an entered suspension. */
    readonly stopInput: () => void;
    /** Finish already-entered job-control handoffs while Ink remains mounted. */
    readonly drainNative: () => Promise<void>;
    /** Present for native Ink; a handle-only embedding cannot assert captured native input release. */
    readonly input?: SessionInkInput;
  }) {
    this.#invocation = options.invocation;
    this.#failure = options.failure;
    this.#stopInput = options.stopInput;
    this.#drainNative = options.drainNative;
    this.#input = options.input;
    this.#assertEntering = options.assertEntering;
    this.#attachment = options.suspendPort.reserveAttachment();
    this.#owner = new SessionTerminalOwner(
      options.invocation,
      options.assertEntering,
      this.#report,
    );
  }

  get port(): SuspendPort {
    return this.#attachment.port;
  }

  get retired() {
    return this.#owner.retired;
  }

  /** Captured while the native handle is live, BEFORE unmount can change waitUntilExit's behaviour. */
  get exited(): Promise<unknown> {
    if (this.#exited === undefined) throw new CliError('cli_internal', '');
    return this.#exited;
  }

  readonly #report = (cause: unknown): void => {
    try {
      this.#failure(cause);
    } catch {
      this.#invocation.finiteExit.fail('cli_internal');
    }
  };

  acquire<T extends SessionInkHandle>(create: () => T): T {
    return this.#owner.acquire((creation) => {
      const native: { unmount: (() => void) | undefined } = { unmount: undefined };
      // Known seals exist BEFORE native entry, even when a partial render never returns a handle.
      // Adopting these ports is not a native release fact: release still requires that exact handle/exit.
      creation.adopt({
        seal: () => {
          this.#sealed = true;
          // Attempt independent seals even if an input adapter throws. No callback may leave
          // attachment authority live merely because a preceding native cleanup failed.
          try {
            this.#stopInput();
          } finally {
            this.#suspensions = this.#attachment.sealAndJoin();
            try {
              this.#nativeDrain = this.#drainNative();
            } catch (cause) {
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the exact native rejection; even undefined is an observed failure, never release acknowledgement.
              this.#nativeDrain = Promise.reject(cause);
            }
            void this.#nativeDrain.catch(this.#report);
          }
        },
        release: async () => {
          // finish() releases an entered SIGCONT waiter; both full native continuations must
          // actually settle before Ink is unmounted, since Ink resumes input in endSuspend().
          let failed: { readonly cause: unknown } | undefined;
          const drained = await Promise.allSettled([this.#suspensions, this.#nativeDrain]);
          for (const result of drained) {
            if (result.status === 'rejected') failed ??= { cause: result.reason };
          }
          if (this.#invocation.registry.budget.remainingMs() === 0)
            await new Promise<never>(() => {});
          try {
            if (native.unmount === undefined) throw new CliError('cli_internal', '');
            native.unmount();
          } catch (cause) {
            failed ??= { cause };
            this.#report(cause);
          }
          // Autonomous Ink exit already unmounted its tree; a later endSuspend can still
          // reattach raw input. Repeating unmount alone is a no-op in that native state.
          // Start finite input restoration independently of a held native exit/output ACK.
          const inputClosed = this.#input?.close();
          const released = await Promise.allSettled([
            this.#exited ?? Promise.reject(new CliError('cli_internal', '')),
            inputClosed,
          ]);
          for (const result of released) {
            if (result.status === 'rejected') {
              failed ??= { cause: result.reason };
              this.#report(result.reason);
            }
          }
          if (failed !== undefined) throw failed.cause;
        },
      });
      this.#input?.enter();
      this.#assertEntering();
      if (this.#sealed) throw new CliError('cli_internal', '');
      const handle = create();
      native.unmount = handle.unmount.bind(handle);
      this.#exited = handle.waitUntilExit();
      void this.#exited.catch(this.#report);
      return handle;
    });
  }

  readonly close = (): Promise<void> => this.#owner.close();
}
