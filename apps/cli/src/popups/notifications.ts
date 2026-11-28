/**
 * The ONE notification channel of a host ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2 "Notifications" and §6; [ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §1): how a closed popup, a refused
 * open and an instant command report, without leaving anything behind.
 *
 * - **Transient.** One notification is shown at a time, for {@link NOTIFICATION_MS}, on the HINT ROW (the last row of the prompt block), in
 *   place of the hint, or, while a popup is open, in the popup's own legend row (the popup covers the hint row in the alternate screen and
 *   replaces it inline, so that is where it is read; `frame-model.ts` draws it beside the popup's way back, `<notice> · Esc close`, and every
 *   text a popup composes fits `POPUP_NOTICE_MAX_COLUMNS` of `geometry.ts`, the room beside that way back at the floor).
 *   It is never an absolutely positioned layer: the overlay slot is the popup's alone.
 * - **Queued, in order.** What arrives while one is shown waits its turn; a text already shown or waiting is not queued twice.
 * - **Held while a chord or secret surface is shown** (a card, a sheet, a chord or secret step) and while the row it is drawn on is not drawn:
 *   nothing is shown then, so nothing paints over a decision's rows, and a notification the person could not see is not spent. The one that was
 *   showing goes back to the front of the queue and is shown again, whole, when the hold ends, UNLESS it was seen: a notification a popup drew
 *   in a frame the host measured and flushed ({@link NotificationChannel.seen}) has been read, and is dropped rather than replayed over a later
 *   step it no longer describes. The host says whether its hint row is held ({@link NotificationChannel.hold}); while a popup is open the popup
 *   host says it instead ({@link NotificationChannel.popupHold}), because the popup's legend row is then where the notification is drawn.
 * - **What a popup says belongs to it.** A notification a popup raised (`from`) is about that popup and its keys (`[d] asks again`), so it is
 *   discarded, shown or waiting, when that popup closes ({@link NotificationChannel.discard}); the host's own words (a refused open, a popup
 *   closed by the system) are about the host and stay. And a popup's latest word on itself is the only true one: a word a popup says through
 *   {@link NotificationChannel.notifyFromPopup} replaces the word the SAME popup said before when that one is showing and was seen
 *   ({@link NotificationChannel.seen}): `Nothing was written.` and a second later `Pinned x`: the row says the second, at once, not the first
 *   for three seconds while the title already says `pinned`. Nothing else is ever replaced: a word that has not been drawn yet is never
 *   dropped for a newer one (both wait their turn, in order), and the host's own words, the Home's announcements
 *   (`notify(text, source)`) and those of other popups queue in order, whatever the source: the person reads every one of them.
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

/** Who raised a notification, when it was a popup: what {@link NotificationChannel.discard} is given when that popup closes. */
export type NotificationSource = object;

/**
 * What a notification is about, when a newer one of the same subject makes the older one wrong: a mode change (`Shift+Tab` three times in a row
 * must show the effect of the mode the chat is in, not of the one it passed through). Only a subject whose latest word is the only true one
 * has a topic; everything else queues in order.
 */
export type NotificationTopic = 'mode';

/**
 * What a session announces on its host's channel: the text, and (for a subject whose latest word replaces the earlier) its topic. An EMPTY
 * text with a topic announces nothing and withdraws what the topic still has on the channel, showing or waiting: a subject that changed to
 * a state with no word of its own (a mode that narrowed) must not leave the word of the state it left on the row.
 */
export type Announce = (text: string, topic?: NotificationTopic) => void;

export interface Notification {
  readonly text: string;
  /** The popup that raised it; absent ⇒ the host (it outlives every popup). */
  readonly from?: NotificationSource | undefined;
  /** What it is about ({@link NotificationTopic}): a newer notification of the same topic replaces it, shown or waiting. */
  readonly topic?: NotificationTopic | undefined;
  /**
   * It was said by a popup about itself ({@link NotificationChannel.notifyFromPopup}); only such a word is replaced by a newer word of the same
   * popup. The host's own words, even those with a source to be discarded by, never are.
   */
  readonly popup?: true | undefined;
}

export interface NotificationSnapshot {
  /** What the hint row shows now, or `undefined` for the hint. */
  readonly current: Notification | undefined;
  /** How many are waiting. */
  readonly queued: number;
  /**
   * Whether the channel is held (a chord or secret surface is shown, or the hint row is not drawn). No host draws it (a host draws `current`
   * alone); it is the observable fact the tests of the hold read.
   */
  readonly held: boolean;
}

export interface NotificationChannel {
  /**
   * Report one line, raised by the host or (`from`) by a popup. Through {@link notificationText}; an empty text is ignored; a text shown or
   * waiting is not queued again. One with a `topic` replaces every earlier one of that topic, the one showing included (it takes its place at
   * once, for its own three seconds): the latest word on a subject is the only true one. An empty text with a topic withdraws that topic's.
   * A `from` here only says who {@link discard} drops it for (the Home's own announcements have one): it never makes a word replaceable.
   */
  readonly notify: (text: string, from?: NotificationSource, topic?: NotificationTopic) => void;
  /**
   * Report one line a popup (`from`) says about itself: as {@link notify} with `from`, and its latest word replaces its earlier one: when the
   * word that popup said before is SHOWING and was drawn in a frame the host measured and flushed ({@link seen}), the newer word takes its
   * place at once, for its own three seconds, ahead of what was waiting. A word that was never drawn is never dropped, so a refusal waiting
   * behind another notification is shown before a newer word; and when a word of the same popup is still waiting the newer one waits behind it
   * (the order the person would have read them in is kept). Called only by the popup host, for `PopupContext.notify`.
   */
  readonly notifyFromPopup: (text: string, from: NotificationSource) => void;
  /**
   * The notification showing now, whose text is `text`, was drawn in a frame the host measured and flushed (the popup host tells it of a popup
   * frame it acknowledged): a hold that begins after this drops it instead of showing it again.
   */
  readonly seen: (text: string) => void;
  /** The popup `from` closed: every notification it raised, the one showing included, is dropped. */
  readonly discard: (from: NotificationSource) => void;
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
}): NotificationChannel {
  const schedule = options?.schedule ?? unrefTimer;
  const listeners = new Set<() => void>();
  const queue: Notification[] = [];
  let current: Notification | undefined;
  /** Whether {@link current} was seen ({@link NotificationChannel.seen}): a hold then drops it rather than putting it back. */
  let currentSeen = false;
  let cancelExpiry: (() => void) | undefined;
  /** The host's hold and the popup's (which, while set, decides alone), and the hold in force. */
  let hostHeld = false;
  let popupHeld: boolean | undefined;
  let held = false;
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
    currentSeen = false;
    const shown = next;
    cancelExpiry = schedule(() => {
      if (current !== shown) return;
      cancelExpiry = undefined;
      current = undefined;
      pump();
      publish();
    }, NOTIFICATION_MS);
  };

  /** Put the hold in force: the popup's while it is set, else the host's. */
  const applyHold = (): void => {
    const next = popupHeld ?? hostHeld;
    if (disposed || next === held) return;
    held = next;
    if (held && current !== undefined) {
      // It is not shown to its end. One nobody saw goes back to the front and is shown again, whole, when the hold ends; one a frame the host
      // measured showed has been read, and it is spent (replayed later it would speak of a step that is gone).
      stopTimer();
      if (!currentSeen) queue.unshift(current);
      current = undefined;
    }
    pump();
    publish();
  };

  /** Drop every notification of `topic`, the one showing included (the next one waiting is shown). */
  const withdraw = (topic: NotificationTopic): void => {
    const before = queue.length;
    for (let index = queue.length - 1; index >= 0; index -= 1)
      if (queue[index]?.topic === topic) queue.splice(index, 1);
    const showing = current?.topic === topic;
    if (showing) {
      stopTimer();
      current = undefined;
      pump();
    }
    if (showing || queue.length !== before) publish();
  };

  /** Raise one notification: `popup` says it is a popup's word about itself ({@link NotificationChannel.notifyFromPopup}). */
  const raise = (
    text: string,
    from: NotificationSource | undefined,
    topic: NotificationTopic | undefined,
    popup: boolean,
  ): void => {
    if (disposed) return;
    const clean = notificationText(text);
    if (clean.length === 0) {
      if (topic !== undefined) withdraw(topic);
      return;
    }
    if (current?.text === clean || queue.some((waiting) => waiting.text === clean)) return;
    const next: Notification = {
      text: clean,
      ...(from === undefined ? {} : { from }),
      ...(topic === undefined ? {} : { topic }),
      ...(popup ? { popup: true as const } : {}),
    };
    if (topic !== undefined) {
      for (let index = queue.length - 1; index >= 0; index -= 1)
        if (queue[index]?.topic === topic) queue.splice(index, 1);
      if (current?.topic === topic) {
        // The one showing is about the same subject and is no longer true: the newer takes its place at once.
        stopTimer();
        current = undefined;
        queue.unshift(next);
      } else queue.push(next);
    } else if (
      popup &&
      from !== undefined &&
      current?.popup === true &&
      current.from === from &&
      currentSeen &&
      !queue.some((waiting) => waiting.popup === true && waiting.from === from)
    ) {
      // The popup's newer word on itself, and the older one was read: it takes the older one's place at once. A word that was not drawn yet is
      // never dropped for it, and one of this popup that still waits keeps its turn ahead of it (the order they were said in).
      stopTimer();
      current = undefined;
      queue.unshift(next);
    } else queue.push(next);
    pump();
    publish();
  };

  return {
    notify: (text, from, topic) => {
      raise(text, from, topic, false);
    },
    notifyFromPopup: (text, from) => {
      raise(text, from, undefined, true);
    },
    seen: (text) => {
      if (current !== undefined && current.text === text) currentSeen = true;
    },
    discard: (from) => {
      if (disposed) return;
      const before = queue.length;
      for (let index = queue.length - 1; index >= 0; index -= 1)
        if (queue[index]?.from === from) queue.splice(index, 1);
      const showing = current?.from === from;
      if (showing) {
        stopTimer();
        current = undefined;
        pump();
      }
      if (showing || queue.length !== before) publish();
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
