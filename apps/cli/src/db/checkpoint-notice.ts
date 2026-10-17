import { CliError } from '../process/cli-error.js';
import type { CliInvocation } from '../process/invocation.js';
import { InvocationWorkOwner } from '../process/invocation-work-owner.js';
import type { CliIo } from '../process/io.js';

/** Captured invocation and delivery sink; opening a database never borrows a later process sink. */
export interface LocalDbNoticeContext {
  readonly io: Pick<CliIo, 'writeErrAcknowledged'>;
  readonly invocation: CliInvocation | undefined;
}

/**
 * A privacy notice is best effort for the opened database, but its actual delivery still belongs to
 * the original invocation. A database close, rejection or stop request cannot acknowledge the writer.
 */
export function deliverCheckpointNotice(
  write: (text: string) => void | Promise<void>,
  text: string,
  invocation: CliInvocation | undefined,
): void | Promise<void> {
  if (invocation === undefined) return write(text);
  const owner = new InvocationWorkOwner(
    invocation,
    { kind: 'command' },
    { cancel: () => undefined, cleanup: () => Promise.resolve() },
  );
  let raw: Promise<void>;
  try {
    raw = owner.enter(async () => {
      try {
        await write(text);
      } catch (cause) {
        const failure = new CliError('output_unavailable', '', { cause });
        // A synchronous writer fault must seal admission before the opener returns to its caller.
        owner.failure(failure);
        throw failure;
      }
    });
  } catch (cause) {
    void owner.close().catch(owner.cleanupUncertain);
    throw cause;
  }
  // Both arms wait for the actual write. The failed arm is already observed by owner.enter before
  // openLocalDb's best-effort catch; this cleanup chain never treats rejection as an unknown join.
  void raw.then(owner.close, owner.close).catch(owner.cleanupUncertain);
  return raw;
}
