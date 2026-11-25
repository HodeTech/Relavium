/**
 * The ONE notification channel of a host ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2 "Notifications" and §6; [ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §1): how a closed popup, a refused
 * open and an instant command report, without leaving anything behind.
 *
 * - **Transient.** One notification is shown at a time, for {@link NOTIFICATION_MS}, on the HINT ROW (the last row of the prompt block), in
 *   place of the hint, or, while a popup is open, in the popup's own legend row (the popup covers the hint row in the alternate screen and
 *   replaces it inline, so that is where it is read; `frame-model.ts` fits it to the popup's inner width, and every text a popup composes fits
 *   `POPUP_NOTICE_MAX_COLUMNS` of `geometry.ts`, that width at the floor).
 *   It is never an absolutely positioned layer: the overlay slot is the popup's alone.
 * - **Queued, in order.** What arrives while one is shown waits its turn; a text already shown or waiting is not queued twice.
 * - **Held while a chord or secret surface is shown** (a card, a sheet, a chord or secret step) and while the row it is drawn on is not drawn:
 *   nothing is shown then, so nothing paints over a decision's rows, and a notification the person could not see is not spent. The one that was
 *   showing goes back to the front of the queue and is shown again, whole, when the hold ends. The host says whether its hint row is held
 *   ({@link NotificationChannel.hold}); while a popup is open the popup host says it instead ({@link NotificationChannel.popupHold}), because the
 *   popup's legend row is then where the notification is drawn.
 * - **No residue.** It writes nothing into the conversation's transcript and nothing into the Home's notice area: those are the person's
 *   record, and a setting or a closed report is not part of it (§6). The host draws {@link NotificationSnapshot.current} and nothing else.
 *
 * **The floor** ({@link notificationText}). Every text is passed through the author-text scrub of the run cards (`authorLine`: secrets scrubbed,
 * control, bidirectional and invisible characters removed, compatibility forms folded, host glyphs blanked, an answer chord such as `Ctrl+Y`
 * replaced) and the line separators folded to a space, so nothing that reaches this channel can carry a key, a control sequence or a host
 * glyph onto the row. It does NOT make key tokens or the legend separator inert: the product writes them on purpose (`[d] asks again`,
 * `Resized · key cleared`), and only the product writes here. That is the contract: **a call site scrubs every UNTRUSTED fragment it puts in a
 * notification itself** (a name a project, a provider or a model wrote goes through the full scrub of its surface first); this channel is the
 * floor under that, not the scrub of it.
 *
 * The clock and the timer are injected (production passes `performance.now` and an unref'd `setTimeout`).
 */

import { authorLine } from '../render/tui/run-card-model.js';
import { foldLineSeparators } from './frame-model.js';

/** How long a notification stays on the hint row (ADR-0145 §1: about three seconds). */
export const NOTIFICATION_MS = 3000;

export interface Notification {
  /** Increases with every notification, so two of the same text at different times are told apart. */
  readonly id: number;
  readonly text: string;
}

export interface NotificationSnapshot {
  /** What the hint row shows now, or `undefined` for the hint. */
  readonly current: Notification | undefined;
  /** How many are waiting. */
  readonly queued: number;
  /** Whether the channel is held (a chord or secret surface is shown, or the hint row is not drawn). */
  readonly held: boolean;
}

export interface NotificationChannel {
  /** Report one line. Through {@link notificationText}; an empty text is ignored; a text shown or waiting is not queued again. */
  readonly notify: (text: string) => void;
  /** The HOST's hold: `true` while a chord or secret surface is shown or the hint row is not drawn, `false` to release it. */
  readonly hold: (held: boolean) => void;
  /**
   * The POPUP's hold, set by the popup host while a popup is open: `true` while its step holds a chord or a secret or its frame is not drawn
   * (below the floor), `false` while its legend row draws the notification, `undefined` once no popup is open. While it is set it decides
   * alone: the host's hold is about the hint row, which an open popup covers (the alternate screen) or replaces (inline).
   */
  readonly popupHold: (held: boolean | undefined) => void;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reference-stable until something the host draws changes. */
  readonly getSnapshot: () => NotificationSnapshot;
  readonly dispose: () => void;
}

/** A timer: run `callback` after `ms`, and return how to cancel it. */
export type Schedule = (callback: () => void, ms: number) => () => void;

/** The production timer: unref'd, so a notification never keeps the process alive. */
export const unrefTimer: Schedule = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

/**
 * The floor of every notification (see the module header): the run cards' author-text scrub, then the line separators folded to a space, then
 * trimmed. Key tokens (`[d]`) and the legend separator (` · `) are kept as the product wrote them.
 */
export function notificationText(text: string): string {
  return foldLineSeparators(authorLine(text)).trim();
}

export function createNotificationChannel(options?: {
  readonly schedule?: Schedule | undefined;
  readonly durationMs?: number | undefined;
}): NotificationChannel {
  const schedule = options?.schedule ?? unrefTimer;
  const durationMs = options?.durationMs ?? NOTIFICATION_MS;
  const listeners = new Set<() => void>();
  const queue: Notification[] = [];
  let current: Notification | undefined;
  let cancelExpiry: (() => void) | undefined;
  /** The host's hold and the popup's (which, while set, decides alone), and the hold in force. */
  let hostHeld = false;
  let popupHeld: boolean | undefined;
  let held = false;
  let nextId = 1;
  let disposed = false;
  let snapshot: NotificationSnapshot = { current: undefined, queued: 0, held: false };

  const publish = (): void => {
    if (snapshot.current === current && snapshot.queued === queue.length && snapshot.held === held)
      return;
    snapshot = { current, queued: queue.length, held };
    for (const listener of listeners) listener();
  };
  const stopTimer = (): void => {
    cancelExpiry?.();
    cancelExpiry = undefined;
  };
  /** Show the next one, if nothing is shown and the channel is not held. */
  const pump = (): void => {
    if (disposed || held || current !== undefined) return;
    const next = queue.shift();
    if (next === undefined) return;
    current = next;
    const shown = next;
    cancelExpiry = schedule(() => {
      if (current !== shown) return;
      cancelExpiry = undefined;
      current = undefined;
      pump();
      publish();
    }, durationMs);
  };

  /** Put the hold in force: the popup's while it is set, else the host's. */
  const applyHold = (): void => {
    const next = popupHeld ?? hostHeld;
    if (disposed || next === held) return;
    held = next;
    if (held && current !== undefined) {
      // It was not seen to its end: it goes back to the front and is shown again, whole, when the hold ends.
      stopTimer();
      queue.unshift(current);
      current = undefined;
    }
    pump();
    publish();
  };

  return {
    notify: (text) => {
      if (disposed) return;
      const clean = notificationText(text);
      if (clean.length === 0) return;
      if (current?.text === clean || queue.some((waiting) => waiting.text === clean)) return;
      queue.push({ id: nextId, text: clean });
      nextId += 1;
      pump();
      publish();
    },
    hold: (next) => {
      hostHeld = next;
      applyHold();
    },
    popupHold: (next) => {
      popupHeld = next;
      applyHold();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    dispose: () => {
      disposed = true;
      stopTimer();
      queue.length = 0;
      current = undefined;
      publish();
      listeners.clear();
    },
  };
}
