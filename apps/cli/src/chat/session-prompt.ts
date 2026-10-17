import type { CliInvocation } from '../process/invocation.js';
import type { CliIo } from '../process/io.js';
import { SHOW_CURSOR } from '../render/alt-screen.js';
import { SessionTerminalOwner } from './session-terminal-owner.js';

/** Fulfilment of a bound Clack prompt is its input-release contract; rejection/cancellation alone is not. */
export async function runSessionPrompt<T>(
  invocation: CliInvocation,
  io: CliIo,
  assertEntering: () => void,
  failure: (cause: unknown) => void,
  factory: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const cancel = new AbortController();
  const owner = new SessionTerminalOwner(invocation, assertEntering, failure);
  let raw: Promise<T> | undefined;
  let fulfilled = false;
  let promptEntered = false;
  const parentAborted = (): void => {
    if (!fulfilled) cancel.abort(parent?.reason);
  };
  try {
    owner.acquire((acquisition) => {
      acquisition.adopt({
        // Installed Clack retains its abort listener after submission. Aborting a fulfilled
        // prompt would run close a second time and write to a terminal it already released.
        seal: () => {
          if (!fulfilled) cancel.abort();
        },
        release: async () => {
          parent?.removeEventListener('abort', parentAborted);
          if (!promptEntered) return; // Trusted fact: the native prompt factory was never entered.
          if (raw === undefined) throw new Error('Prompt acquisition was not acknowledged.');
          await raw;
          if (io.stdoutIsTty) {
            if (invocation.registry.budget.remainingMs() === 0) await new Promise<never>(() => {});
            await io.writeOutAcknowledged(SHOW_CURSOR);
          }
        },
      });
      parent?.addEventListener('abort', parentAborted, { once: true });
      if (parent?.aborted === true) parentAborted();
      raw = owner.enter(() => {
        if (cancel.signal.aborted) cancel.signal.throwIfAborted();
        promptEntered = true;
        return factory(cancel.signal);
      });
    });
    if (raw === undefined) throw new Error('Prompt acquisition was not acknowledged.');
    const answer = await raw;
    fulfilled = true;
    return answer;
  } finally {
    await owner.close();
  }
}
