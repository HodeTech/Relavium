import type { SessionStreamHandleEvent } from '@relavium/core';

import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import type { SessionWorkOwner } from './session-work-owner.js';

/** Observe before passive bus isolation; seal before cancellation can synchronously emit again. */
export function ownSessionSubscriber(
  owner: SessionWorkOwner | undefined,
  consume: (event: SessionStreamHandleEvent) => void,
): (event: SessionStreamHandleEvent) => void {
  return ownSessionNotification(owner, consume);
}

/** Observe a notification's own failure before an advisory producer can recover from it. */
export function ownSessionNotification<Value>(
  owner: SessionWorkOwner | undefined,
  consume: (value: Value) => void,
): (value: Value) => void {
  if (owner === undefined) return consume;
  let stopped = false;
  return (value) => {
    if (stopped || owner.signal.aborted) return;
    try {
      owner.assertAdmitting();
      consume(value);
    } catch (cause) {
      stopped = true;
      owner.failure(cause);
    }
  };
}

/** Business output only. Entered terminal restoration retains the original captured capabilities. */
export function ownSessionOutput(io: CliIo, owner: SessionWorkOwner | undefined): CliIo {
  if (owner === undefined) return io;
  const failed = (cause: unknown): CliError => {
    const failure = new CliError('output_unavailable', '', { cause });
    owner.failure(failure);
    return failure;
  };
  const write = (operation: () => void): void => {
    owner.assertAdmitting();
    try {
      operation();
    } catch (cause) {
      throw failed(cause);
    }
  };
  const deliver = (operation: () => Promise<void>): Promise<void> => {
    owner.assertAdmitting();
    return owner.work.retainWork(async () => {
      try {
        await operation();
      } catch (cause) {
        throw failed(cause);
      }
    });
  };
  return {
    ...io,
    writeOut: (text) => write(() => io.writeOut(text)),
    writeErr: (text) => write(() => io.writeErr(text)),
    writeOutAcknowledged: (text) => deliver(() => io.writeOutAcknowledged(text)),
    writeErrAcknowledged: (text) => deliver(() => io.writeErrAcknowledged(text)),
  };
}
