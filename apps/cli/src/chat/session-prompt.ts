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
): Promise<T> {
  const cancel = new AbortController();
  const owner = new SessionTerminalOwner(invocation, assertEntering, failure);
  let raw: Promise<T> | undefined;
  let fulfilled = false;
  try {
    owner.acquire((acquisition) => {
      acquisition.adopt({
        // Installed Clack retains its abort listener after submission. Aborting a fulfilled
        // prompt would run close a second time and write to a terminal it already released.
        seal: () => {
          if (!fulfilled) cancel.abort();
        },
        release: async () => {
          if (raw === undefined) throw new Error('Prompt acquisition was not acknowledged.');
          await raw;
          if (io.stdoutIsTty) {
            if (invocation.registry.budget.remainingMs() === 0) await new Promise<never>(() => {});
            await io.writeOutAcknowledged(SHOW_CURSOR);
          }
        },
      });
      raw = owner.enter(() => factory(cancel.signal));
    });
    if (raw === undefined) throw new Error('Prompt acquisition was not acknowledged.');
    const answer = await raw;
    fulfilled = true;
    return answer;
  } finally {
    await owner.close();
  }
}
