/**
 * How a popup starts its work ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2, §5): off the render, on the owner, and never as an unhandled rejection. One starter for the `/doctor` popup's quick tier and for the
 * report popups that read something (`/cost`, `/workflows` and the release's refreshed total).
 *
 * A popup's reads are synchronous queries (a database, a directory scan, a keychain), so "off the render" means: not while a frame is being
 * drawn, and not before the event loop has given the frame back. Each is started after one macrotask, entered on the work owner (so the
 * session's database stays open until it has settled and an exit waits for it), and its fault goes to the owner and to the popup as a state by
 * CODE, never by message (a database error can carry a path).
 */

import { tryCall } from '../process/attempt.js';
import { CliError } from '../process/errors.js';
import type { InvocationWorkOwner } from '../process/invocation-work-owner.js';
import type { PopupCopyPort } from './popup-copy.js';

/**
 * The owner a popup's work is entered on (`enter`: the session's database stays open until the read has settled) and a fault of it goes to
 * (`failure`), never to an unhandled rejection. The one owner type of every popup's port: the doctor's and the four reports'.
 */
export type PopupWorkOwner = Pick<InvocationWorkOwner, 'enter' | 'failure'>;

/**
 * What every popup's port holds in common, written once for the two ports (`DoctorPort`, `ReportsPort`) to extend: the owner its work starts on
 * ({@link startPopupWork}) and what its `[c]` needs (the host's clipboard and the glyph form, `PopupCopyPort`).
 */
export interface PopupPortBase extends PopupCopyPort {
  readonly workOwner?: PopupWorkOwner | undefined;
}

/** A macrotask: the event loop renders and reads keys before the next read. */
export const macrotask = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** What is said of a fault: its code when it has one, a fixed word otherwise. Never its message, which can carry a path. */
export function faultCode(cause: unknown): string {
  return cause instanceof CliError ? cause.code : 'unexpected error';
}

/**
 * Start `operation` as the popup's work: entered on `owner` when there is one, its fault reported to the owner and given to `failed` (which
 * puts the state in the popup). An owner that no longer admits work (the host is closing) throws on entry: that is a fault of the same kind.
 */
export function startPopupWork(
  owner: PopupWorkOwner | undefined,
  operation: () => Promise<void>,
  failed: (cause: unknown) => void,
): void {
  const report = (cause: unknown): void => {
    owner?.failure(cause);
    try {
      failed(cause);
    } catch (inner) {
      // A listener of the popup that throws again is the owner's fault too, never an unhandled rejection.
      owner?.failure(inner);
    }
  };
  const started = tryCall(() => (owner === undefined ? operation() : owner.enter(operation)));
  if (!started.ok) {
    report(started.cause);
    return;
  }
  started.value.catch(report);
}
