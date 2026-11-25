/**
 * The ONE notification channel of a host ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2 "Notifications" and §6; [ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §1): how a closed popup, a refused
 * open and an instant command report, without leaving anything behind.
 *
 * - **Transient.** One notification is shown at a time, for {@link NOTIFICATION_MS}, on the HINT ROW (the last row of the prompt block), in
 *   place of the hint. It is never an absolutely positioned layer: the overlay slot is the popup's alone.
 * - **Queued, in order.** What arrives while one is shown waits its turn; a text already shown or waiting is not queued twice.
 * - **Held while a chord or secret surface is shown** (a card, a sheet, a chord or secret step) and while the hint row is not drawn: nothing is
 *   shown then, so nothing paints over a decision's rows, and a notification the person could not see is not spent. The one that was showing
 *   goes back to the front of the queue and is shown again, whole, when the hold ends.
 * - **No residue.** It writes nothing into the conversation's transcript and nothing into the Home's notice area: those are the person's
 *   record, and a setting or a closed report is not part of it (§6). The host draws {@link NotificationSnapshot.current} and nothing else.
 *
 * Every text is passed through the inline sanitiser here, so a name a project or a provider wrote cannot carry a control sequence onto the
 * hint row. The clock and the timer are injected (production passes `performance.now` and an unref'd `setTimeout`).
 */

import { sanitizeInline } from '../render/sanitize.js';
import { inertLegendText } from '../render/tui/legend.js';

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
  /** Report one line. Sanitised; an empty text is ignored; a text shown or waiting is not queued again. */
  readonly notify: (text: string) => void;
  /** Hold the channel (`true`) while a chord or secret surface is shown or the hint row is not drawn, and release it (`false`). */
  readonly hold: (held: boolean) => void;
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

  return {
    notify: (text) => {
      if (disposed) return;
      // The hint row is a legend's row: a name cannot forge a key item or a separator there (ADR-0145 §5).
      const clean = inertLegendText(sanitizeInline(text)).trim();
      if (clean.length === 0) return;
      if (current?.text === clean || queue.some((waiting) => waiting.text === clean)) return;
      queue.push({ id: nextId, text: clean });
      nextId += 1;
      pump();
      publish();
    },
    hold: (next) => {
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
