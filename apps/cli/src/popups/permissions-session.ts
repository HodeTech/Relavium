/**
 * The `/permissions` popup's state machine in a chat ([ADR-0137](../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §2, [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §6, §10): what is read when,
 * what each key does and what a confirmed withdrawal does. Loaded with the settings popups (`settings-session.ts`); its words are
 * `permissions-popup.ts`.
 *
 * **Reading.** The lists are read when the popup opens and again after each withdrawal, synchronously (the grants file and the session's
 * approvals are both in this process, as they were for the sheet), through the chat's own port (`createPermissionsPort`, which never throws and
 * says what it could not read in a sentence). A port that throws anyway is a defect: the step says so and offers nothing; it never shows a list
 * it could not read.
 *
 * **A withdrawal is two keys, and the second is answered by the host.** `[d]` (or `Del`) on a row arms its line: the line names the row and what
 * withdrawing it changes, and is answered by `Enter` through the popup host's guard and by nothing else (`chord.key: 'enter'`: its frame seen
 * at least 800 ms before, at most 10 s before, no key typed since `[d]`, nothing typed before `[d]` since the last arrow key; the guard's numbers
 * and rules are the host's, not this module's). At the answer, and only then, this module withdraws the row it armed, by its identity (a
 * remembered grant's id, a session approval's exact argv), reads the lists again, goes back to them and announces the result on the HOST's
 * channel (`SettingsPort.announce`), which outlives the popup. Nothing is written into the transcript or a Home notice.
 *
 * **Narrowing only.** A withdrawal removes a remembered grant or a session approval; it can make the chat ask more, never less. The one write
 * is the project's grants file, through the port's store (`revokeById`); a failed write says so on the host channel, and a port that threw
 * says its code only.
 */

import type {
  PermissionEntry,
  PermissionsSnapshot,
  WithdrawAnswer,
} from '../permissions/chat-permissions.js';
import {
  entryOfRow,
  PERMISSIONS_STEP,
  PERMISSIONS_UNREADABLE_AGAIN_CONTENT,
  PERMISSIONS_UNREADABLE_CONTENT,
  homePermissionsContent,
  homePermissionText,
  permissionText,
  permissionsContent,
  permissionsControls,
  permissionsSpec,
  WITHDRAW_CONTROL,
  withdrawLineContent,
  withdrawnAnnouncement,
  withdrawRefusedText,
} from './permissions-popup.js';
import type { PopupContext, PopupHandlers, PopupOpenResult } from './popup-host.js';
import { faultCode } from './popup-work.js';
import type { SettingsOpenRequest } from './settings-port.js';

/** The answer a withdrawal gets when the port itself throws: nothing is known to have changed. */
const WITHDRAW_FAULT: WithdrawAnswer = {
  tone: 'failed',
  text: 'Could not withdraw that row; nothing changed.',
};

/** Open the `/permissions` popup over `request.host` with the chat's port; see the module header. */
export function openPermissionsPopup(request: SettingsOpenRequest): PopupOpenResult {
  const { host, port, origin } = request;
  const permissions = port.permissions;
  if (permissions === undefined) return { opened: false, reason: 'closed' };
  /** The lists as last read: what the rows on screen were built from, so a row's id names its entry. */
  let snapshot: PermissionsSnapshot | undefined;
  /** The entry the line was armed for, while it is up. */
  let armed: PermissionEntry | undefined;
  /** The bare Home has no chat: a `project` port draws the Home's lists, with the Home's row scrub for every stored word on them and on its line. */
  const forHome = permissions.port.surface === 'project';
  const draw = forHome ? homePermissionText : permissionText;

  /** The lists read now, or `undefined` when the port threw (a defect: nothing it could not read is shown). */
  const read = (): PermissionsSnapshot | undefined => {
    try {
      return permissions.port.load();
    } catch {
      return undefined;
    }
  };

  /** Read the lists and put them in the first step, with what the last withdrawal said; `[d]` only while there is a row. */
  const land = (context: PopupContext, result?: WithdrawAnswer): void => {
    snapshot = read();
    if (snapshot === undefined) {
      context.setContent(
        PERMISSIONS_STEP.list,
        result === undefined
          ? PERMISSIONS_UNREADABLE_CONTENT
          : PERMISSIONS_UNREADABLE_AGAIN_CONTENT,
        [],
      );
      return;
    }
    context.setContent(
      PERMISSIONS_STEP.list,
      // The bare Home has no chat: a `project` port (the remembered commands and the repository's allowlist, no session) draws the Home's
      // lists, which name no mode; a chat's port draws the chat's, as it always did.
      forHome
        ? homePermissionsContent(snapshot, result)
        : permissionsContent(snapshot, permissions.mode?.() ?? 'ask', result),
      permissionsControls(snapshot),
    );
  };

  const handlers: PopupHandlers = {
    control: (context, key, row) => {
      if (key !== WITHDRAW_CONTROL.key || context.stepIndex() !== PERMISSIONS_STEP.list) return;
      const entry = snapshot === undefined ? undefined : entryOfRow(snapshot, row);
      if (entry === undefined) return;
      armed = entry;
      context.setContent(PERMISSIONS_STEP.withdraw, withdrawLineContent(entry, draw));
      context.goToStep(PERMISSIONS_STEP.withdraw);
    },
    chord: (context) => {
      const entry = armed;
      armed = undefined;
      if (entry === undefined) return;
      let answer: WithdrawAnswer;
      let code: string | undefined;
      try {
        answer = permissions.port.withdraw(entry);
      } catch (cause) {
        answer = WITHDRAW_FAULT;
        code = faultCode(cause);
      }
      // The lists read again, then back to them, then the result: on the host's channel, once the line (which holds it) is gone.
      land(context, answer);
      context.goToStep(PERMISSIONS_STEP.list);
      port.announce(withdrawnAnnouncement(entry, answer, code, draw));
    },
    // However it closed (never an answer): a bare `relavium permissions` ends with it, which is the opener's to know.
    closed: () => {
      request.closed?.();
    },
    // Not an answer: the host disarmed the line, or refused the `[d]` that would have armed it. Nothing was withdrawn, and the person is told
    // why. (`armed` is read only by the line's answer, which the host gives only on a line `[d]` armed afresh, so a disarmed one needs no reset.)
    chordRefused: (context, reason) => {
      context.notify(withdrawRefusedText(reason));
    },
  };

  const opened = host.openForUser(
    permissionsSpec(origin, { kind: 'loading', what: 'Reading the permissions' }, []),
    handlers,
  );
  if (!opened.opened) return opened;
  land(opened.context);
  return opened;
}
