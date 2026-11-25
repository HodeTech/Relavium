import type { PermissionsPort, WithdrawAnswer } from '../../permissions/chat-permissions.js';
import type { ChatKey } from './chat-input.js';
import {
  foldPermissionsSheetKey,
  initialPermissionsSheetState,
  reloadPermissionsSheet,
  type PermissionsSheetState,
} from './permissions-sheet.js';
import type { ChatMode } from '../../chat/chat-mode.js';

/**
 * What every host of the `/permissions` sheet does with one key and the port it holds ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §2, §3): the bare Home's Permissions tab and a bare `relavium permissions` fold the key with {@link foldPermissionsSheetKey}, carry a
 * withdrawal out through the port and reload the sheet with the answer (a chat's `/permissions` is a popup now, MVP-11 step 5c:
 * `popups/permissions-session.ts`). It is one function so they cannot drift on the two things a host must get right: a port that throws must
 * not leave the keyboard owned by a frozen sheet, and a list that cannot be read again after a withdrawal must close the sheet rather than
 * leave it armed on a stale row.
 *
 * Pure but for the port: the clock and whether the frame can show the question are the host's to say.
 */

/** What the sheet becomes after a key, and a sentence the host shows elsewhere when the sheet closed because of a fault. */
export interface PermissionsSheetHostResult {
  /** The open sheet after the key; `undefined` when it closed. */
  readonly sheet: PermissionsSheetState | undefined;
  /** Said where the host says things (the chat's notice line), only when the list could not be read again after a withdrawal. */
  readonly note?: string;
}

/** The answer a withdrawal gets when the port itself throws: nothing is known to have changed. */
export const WITHDRAW_FAULT: WithdrawAnswer = {
  tone: 'failed',
  text: 'Could not withdraw that row; nothing changed.',
};

export function foldPermissionsSheetThroughPort(
  port: PermissionsPort,
  open: PermissionsSheetState,
  input: string,
  key: ChatKey,
  canArm: boolean,
  now: number,
): PermissionsSheetHostResult {
  const step = foldPermissionsSheetKey(input, key, open, canArm, now);
  switch (step.kind) {
    case 'close':
      return { sheet: undefined };
    case 'state':
      return { sheet: step.state };
    case 'withdraw': {
      let answer: WithdrawAnswer;
      try {
        answer = port.withdraw(step.entry);
      } catch {
        answer = WITHDRAW_FAULT;
      }
      try {
        return { sheet: reloadPermissionsSheet(step.state, port.load(), answer) };
      } catch {
        // The sheet would otherwise stay armed on a stale list that still shows the row: close it and say what happened.
        return { sheet: undefined, note: `${answer.text} Could not read the permissions again.` };
      }
    }
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
}

/** What opening the sheet gives: the sheet, or a sentence for the host to say when the port could not be read (nothing opens). */
export type OpenPermissionsSheetResult =
  | { readonly sheet: PermissionsSheetState }
  | { readonly sheet?: undefined; readonly note: string };

/** The sentence a host says when the port cannot be read at all and the sheet therefore does not open. */
export const PERMISSIONS_UNREADABLE = 'Could not read the permissions.';

/** Open the sheet on the data read now. The port promises not to throw, but a defect in it must not take the prompt down with it. */
export function openPermissionsSheetThroughPort(
  port: PermissionsPort,
  mode: ChatMode | undefined,
  now: number,
): OpenPermissionsSheetResult {
  try {
    return { sheet: initialPermissionsSheetState(port.load(), port.surface, mode, now) };
  } catch {
    return { note: PERMISSIONS_UNREADABLE };
  }
}
