import { SessionControlWrites } from './session-control-writes.js';
import { CliError } from '../process/cli-error.js';
import type { CliIo } from '../process/io.js';
import {
  createAltScreenController,
  DISABLE_MOUSE,
  EXIT_ALT_SCREEN,
  SHOW_CURSOR,
} from '../render/alt-screen.js';
import { DISABLE_BRACKETED_PASTE } from '../render/tui/home-input.js';
import type { JobControlBinding } from '../render/suspend.js';
import type { SessionInkMount } from './session-ink-mount.js';
import type { SessionChatLifetime } from './session-chat-lifetime.js';
import { SessionTerminalOwner } from './session-terminal-owner.js';

/** One persistent chat buffer; child mounts and reversible handoffs retire before final control delivery. */
export class SessionChatTerminal {
  readonly #lifetime: SessionChatLifetime;
  readonly #io: CliIo;
  readonly #owner: SessionTerminalOwner;
  readonly #writes: SessionControlWrites;
  readonly #mounts = new Set<SessionInkMount>();
  readonly #jobs = new Set<JobControlBinding>();
  readonly alt: ReturnType<typeof createAltScreenController>;
  #removeExit: (() => void) | undefined;
  #exitRegistrationUnknown = false;
  #sealed = false;
  #failed: { readonly cause: unknown } | undefined;

  constructor(options: {
    readonly lifetime: SessionChatLifetime;
    readonly io: CliIo;
    readonly active: boolean;
    readonly mouse: boolean;
  }) {
    this.#lifetime = options.lifetime;
    this.#io = options.io;
    this.#writes = new SessionControlWrites({
      invocation: options.lifetime.surface.invocation,
      write: (text) => options.io.writeOutAcknowledged(text),
      failure: this.#report,
    });
    this.alt = createAltScreenController({
      active: options.active,
      mouse: options.mouse,
      write: (sequence) => {
        void this.writeControl(sequence);
      },
    });
    this.#owner = new SessionTerminalOwner(
      options.lifetime.surface.invocation,
      options.lifetime.surface.work.assertAdmitting,
      this.#report,
    );
    this.#owner.acquire((creation) =>
      creation.adopt({
        seal: () => {
          this.#sealed = true;
          for (const job of this.#jobs) {
            try {
              job.dispose();
            } catch (cause) {
              this.#report(cause);
            }
          }
          for (const mount of this.#mounts) {
            try {
              void mount.close();
            } catch (cause) {
              this.#report(cause);
            }
          }
        },
        release: async () => {
          // Finish releases an entered SIGCONT waiter while its exact Ink tree is still mounted.
          const closing: Promise<void>[] = [];
          for (const job of this.#jobs) {
            try {
              closing.push(job.finish());
            } catch (cause) {
              this.#report(cause);
            }
          }
          for (const mount of this.#mounts) {
            try {
              closing.push(mount.close());
            } catch (cause) {
              this.#report(cause);
            }
          }
          const joined = await Promise.allSettled(closing);
          for (const result of joined)
            if (result.status === 'rejected') this.#report(result.reason);
          if (this.#lifetime.surface.invocation.registry.budget.remainingMs() === 0)
            await new Promise<never>(() => {});
          this.alt.restore(); // Enqueue is not ACK: all actual delivery promises remain in #writes.
          await this.#writes.close();
          try {
            this.#removeExit?.();
          } catch (cause) {
            this.#report(cause);
          }
          if (this.#exitRegistrationUnknown) throw new CliError('cli_internal', '');
          if (this.#failed !== undefined) throw this.#failed.cause;
        },
      }),
    );
  }

  readonly #report = (cause: unknown): void => {
    this.#failed ??= { cause };
    this.#lifetime.surface.work.failure(cause); // Preserve classified output failure before a held sibling join.
    this.#lifetime.surface.work.cleanupUncertain(cause);
  };

  #assertPublication(): void {
    if (this.#lifetime.surface.invocation.registry.budget.remainingMs() === 0)
      throw new CliError('cli_internal', '');
    this.#lifetime.surface.work.assertAdmitting();
  }

  readonly publishOut = (text: string): Promise<void> => {
    this.#assertPublication();
    return this.#io.writeOutAcknowledged(text);
  };

  readonly publishErr = (text: string): Promise<void> => {
    this.#assertPublication();
    return this.#io.writeErrAcknowledged(text);
  };

  /** Ordinary call sites retain their own admission; already-entered native reclaim can finish after sealing. */
  readonly writeControl = (sequence: string): Promise<void> => this.#writes.write(sequence);

  readonly releaseForSuspend = async (): Promise<boolean> => {
    const released = this.alt.releaseForSuspend();
    await this.#writes.joinEntered();
    return released;
  };

  readonly reclaimAfterSuspend = async (): Promise<void> => {
    this.alt.reclaimAfterSuspend();
    await this.#writes.joinEntered();
  };

  enter(onProcessExit: (callback: () => void) => () => void): void {
    this.#lifetime.surface.work.assertAdmitting();
    if (this.#sealed) throw new CliError('cli_internal', '');
    try {
      this.alt.enter();
      this.#exitRegistrationUnknown = true;
      this.#removeExit = onProcessExit(() => {
        // Process death cannot join asynchronous work. This finite captured fallback grants no ACK.
        try {
          this.#io.nativeStdin?.setRawMode(false);
          this.#io.nativeStdout?.write(
            DISABLE_MOUSE +
              DISABLE_BRACKETED_PASTE +
              (this.alt.isEntered() ? EXIT_ALT_SCREEN : '') +
              SHOW_CURSOR,
          );
        } catch {
          /* The process is already exiting; no asynchronous recovery or retirement is inferred. */
        }
      });
      this.#exitRegistrationUnknown = false;
    } catch (cause) {
      this.#report(cause);
      throw cause;
    }
  }

  readonly adoptMount = (mount: SessionInkMount): void => {
    this.#mounts.add(mount);
    void mount.retired.then(() => {
      this.#mounts.delete(mount);
    });
    if (this.#sealed) void mount.close();
  };

  readonly adoptJob = (job: JobControlBinding): void => {
    this.#jobs.add(job);
    void job.released.then(() => {
      this.#jobs.delete(job);
    }, this.#report);
    if (this.#sealed) {
      try {
        job.dispose();
      } catch (cause) {
        this.#report(cause);
      }
    }
  };

  readonly close = (): Promise<void> => this.#owner.close();
}
