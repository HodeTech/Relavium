/**
 * What makes a native card's `Ctrl+Y` a DELIBERATE answer
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4).
 *
 * The Home's cards (a human gate, a budget gate, an MCP consent) answer with a Ctrl chord only: a bare letter and a pasted block
 * answer nothing, because neither can be told from typing. Behind the chord sit the layers the approval card and the continue
 * checkpoint already use, and they are not restated here: {@link approvalKeyRefusal} is the one decision, called with the same
 * numbers ({@link resolveApprovalGuard}), and this module only keeps the times that function compares a key against. It is the
 * channel's equivalent of the chat store's `lastKeyAt`, `lastForeignKeyAt` and `lastResolvedAt`.
 *
 * - an AFFIRMATIVE chord (`Ctrl+Y`) must clear dwell, quiet gap, typeahead and lockout, and the card's exact frame must be on
 *   screen right now (measured and flushed, at 80x24);
 * - a REJECTION (`Ctrl+N`) is never delayed and needs no guard where refusing is the safe answer (an MCP consent card, a budget
 *   abort). A human gate's rejection is not that: it CONTINUES the run, because the author routes on it, so the card asks for it to
 *   pass the same layers as an approval (`strict`);
 * - `Esc` and `Ctrl+C` are the channel's own keys and answer nothing, here or anywhere.
 *
 * Every time is on ONE monotonic clock, so a wall-clock step changes nothing (PR #99 security sitting G3).
 */

import type { ChatKey } from './chat-input.js';
import {
  approvalKeyRefusal,
  resolveApprovalGuard,
  type ApprovalGuard,
} from './tool-review-model.js';

/** What a card's chord means. */
export type ChordAnswer = 'allow' | 'deny';

/**
 * A key as a chord surface reads it: the chat's key fields and, from a terminal that reports key events (the kitty keyboard protocol's
 * "report event types", which Ink 7 parses: `ESC[121;5:2u` is a held `Ctrl+Y`'s repeat, `ESC[121;5:3u` its release), which event it was.
 * The CLI never enables that mode, but a terminal another program left in it sends the repeat and the release as keys of their own.
 */
export interface ChordKey extends ChatKey {
  readonly eventType?: 'press' | 'repeat' | 'release' | undefined;
}

/**
 * Which chord this key is, whatever its event (a press, a held key's repeat, its release), or `undefined` for every key that is not one.
 * Exactly `Ctrl+Y` and `Ctrl+N`: the letter must be the whole input (a pasted run that contains one is not a key), `ctrl` must be set (a
 * bare letter is typing) and `meta` must not be (a different chord). What a surface uses to RECOGNISE the key (a held `Ctrl+Y` is still a
 * refused affirmative on a step that is no line); never what answers: that is {@link reduceChordKey}.
 */
export function chordOf(input: string, key: ChordKey): ChordAnswer | undefined {
  if (key.ctrl !== true || key.meta === true) return undefined;
  if (input === 'y') return 'allow';
  if (input === 'n') return 'deny';
  return undefined;
}

/**
 * A host's key reader that never hears a key's RELEASE (a terminal left in the kitty protocol's event-type mode reports one after every
 * press). A release is not a key: read, it would type a letter twice into a composer and give a card or a popup line a second `Ctrl+Y`.
 * Nothing in the CLI acts on one, so each host's one reader is wrapped in this. A held key's repeat IS a key, as a legacy terminal's
 * auto-repeat is, and goes through; the chord surfaces refuse it as an answer ({@link reduceChordKey}).
 */
export function pressesOnly<Key extends { readonly eventType?: ChordKey['eventType'] }>(
  read: (input: string, key: Key) => void,
): (input: string, key: Key) => void {
  return (input, key) => {
    if (key.eventType === 'release') return;
    read(input, key);
  };
}

/**
 * Which answer this key is, or `undefined` for every key that is not a chord PRESS ({@link chordOf}). A key's repeat is never a first
 * press and its release is not a press at all: neither answers anything, on any surface that reads its answer here.
 */
export function reduceChordKey(input: string, key: ChordKey): ChordAnswer | undefined {
  if (key.eventType === 'repeat' || key.eventType === 'release') return undefined;
  return chordOf(input, key);
}

/**
 * The three times that say what the person's hands have been doing, shared by every chord surface of one Home: the MCP consent card (the
 * native prompt channel), the gate and budget cards, and the exit guard. One history means a key that answered one of them also locks the
 * next, so a key held down on a gate card cannot answer the consent card the answer opened, on auto-repeat. What is NOT shared is a
 * card's own `shownAt` (its dwell), which belongs to the frame it measures.
 */
export interface ChordHistory {
  previousKeyAt: number;
  lastForeignKeyAt: number;
  lastResolvedAt: number;
}

export function createChordHistory(): ChordHistory {
  return {
    previousKeyAt: Number.NEGATIVE_INFINITY,
    lastForeignKeyAt: Number.NEGATIVE_INFINITY,
    lastResolvedAt: Number.NEGATIVE_INFINITY,
  };
}

/** What was true just BEFORE one key arrived: the evidence that key is judged against. */
export interface ChordStamp {
  readonly now: number;
  readonly previousKeyAt: number;
  readonly lastForeignKeyAt: number;
  readonly lastResolvedAt: number;
}

export interface ChordGuard {
  /** A key (or a paste) reached the channel. Call once per key, first: it records the arrival and returns the evidence before it. */
  readonly stamp: () => ChordStamp;
  /** The key was typing, a paste, or something the card has no use for: an affirmative chord soon after it is refused. */
  readonly foreign: (stamp: ChordStamp) => void;
  /** A card was resolved by this key: the next card is locked against a held or double-tapped key. */
  readonly resolved: (stamp: ChordStamp) => void;
  /** A card is new: its frame has not been acknowledged yet. */
  readonly begin: () => void;
  /** The card's exact frame was just measured and flushed (a new frame restarts the dwell). */
  readonly shown: () => void;
  /** When the card's current frame was acknowledged (the dwell origin), or `undefined` while it has not been. Read only, never a second clock. */
  readonly shownAt: () => number | undefined;
  /**
   * Whether this chord answers. An affirmative one needs every layer clear AND `painted`; a rejection answers at once unless `strict`
   * says it is as consequential as an approval (default: only an affirmative chord is strict). When a strict chord does not count and
   * a card was resolved by a key a moment ago, the lockout restarts, so a key that stays down keeps the card locked until it has been
   * released for the whole window.
   */
  readonly decide: (
    stamp: ChordStamp,
    chord: ChordAnswer,
    painted: boolean,
    strict?: boolean,
  ) => ChordAnswer | undefined;
  /**
   * Until when, on this guard's clock, an affirmative chord judged on `evidence` (default: the history as the next key's stamp would carry it)
   * is refused by the LOCKOUT, the layer {@link decide} restarts with every refused press inside it: `lockoutMs` after `evidence.lastResolvedAt`,
   * or `-Infinity` when the guard has no lockout. The lockout rule read without a key, for a surface that draws its affirmative as locked while
   * it holds (`(wait)` in its legend, ADR-0145 §3): never a second copy of the rule. The other layers (the dwell, the quiet gap, the typing
   * window) are not in it: they are shorter and follow from the person's own keys.
   */
  readonly lockedUntil: (evidence?: Pick<ChordStamp, 'lastResolvedAt'>) => number;
}

/**
 * What a surface DRAWS of a lockout: whether its affirmative is locked now, so its legend part reads dim with `(wait)` (the maintainer's ruling
 * of 2026-11-26 on ADR-0145 §3), and the ONE timer that says when it opens. `until` asks the guard that decides
 * ({@link ChordGuard.lockedUntil}); nothing here answers anything. A display value, never a frame's field: a view reads it beside its snapshot
 * (as the popup host's loading clock), so it changes no identity and restarts no guard.
 */
export interface LockDisplay {
  /**
   * Read the lock again (a prompt or a step opened, settled or went; a refused press inside the lockout moved its end): listeners hear only a
   * change, and one timer is kept at the unlock instant while it holds (moved when its end moved, none otherwise). Never periodic.
   */
  readonly sync: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly read: () => boolean;
  /** The surface is gone: the timer is cleared, nobody is told again, and a later `sync` does nothing. */
  readonly dispose: () => void;
}

export function createLockDisplay(options: {
  /** The guard's clock. */
  readonly now: () => number;
  /** A one-shot timer (`setTimeout`-shaped) returning its cancel; production passes an unref'd one. */
  readonly schedule: (callback: () => void, ms: number) => () => void;
  /** Until when the affirmative is locked, on that clock: the deciding guard's `lockedUntil`, `-Infinity` when nothing is held. */
  readonly until: () => number;
}): LockDisplay {
  const listeners = new Set<() => void>();
  let locked = false;
  let disposed = false;
  let unlockAt = Number.NEGATIVE_INFINITY;
  let cancel: (() => void) | undefined;
  const stopTimer = (): void => {
    cancel?.();
    cancel = undefined;
  };
  const sync = (): void => {
    if (disposed) return;
    const until = options.until();
    const next = options.now() < until;
    if (!next || until !== unlockAt) stopTimer();
    if (next && cancel === undefined) {
      unlockAt = until;
      cancel = options.schedule(
        () => {
          cancel = undefined;
          sync();
        },
        // Never before the instant (a timer cannot fire early on the guard's clock and leave the part dim with no timer left).
        Math.max(1, Math.ceil(until - options.now())),
      );
    }
    if (next === locked) return;
    locked = next;
    for (const listener of listeners) listener();
  };
  return {
    sync,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: () => locked,
    dispose: () => {
      disposed = true;
      stopTimer();
      listeners.clear();
    },
  };
}

export function createChordGuard(options: {
  readonly now: () => number;
  readonly guard?: ApprovalGuard | undefined;
  /** The Home's shared history; a guard without one keeps its own (a surface that stands alone). */
  readonly history?: ChordHistory | undefined;
}): ChordGuard {
  const numbers = resolveApprovalGuard(options.guard);
  const history = options.history ?? createChordHistory();
  let shownAt: number | undefined;
  return {
    stamp: () => {
      const now = options.now();
      const before: ChordStamp = {
        now,
        previousKeyAt: history.previousKeyAt,
        lastForeignKeyAt: history.lastForeignKeyAt,
        lastResolvedAt: history.lastResolvedAt,
      };
      history.previousKeyAt = now;
      return before;
    },
    foreign: (stamp) => {
      history.lastForeignKeyAt = stamp.now;
    },
    resolved: (stamp) => {
      history.lastResolvedAt = stamp.now;
    },
    begin: () => {
      shownAt = undefined;
    },
    shown: () => {
      shownAt = options.now();
    },
    shownAt: () => shownAt,
    decide: (stamp, chord, painted, strict = chord === 'allow') => {
      if (!strict) {
        history.lastResolvedAt = stamp.now;
        return chord;
      }
      const refusal = approvalKeyRefusal(numbers, {
        now: stamp.now,
        shownAt,
        previousKeyAt: stamp.previousKeyAt,
        lastForeignKeyAt: stamp.lastForeignKeyAt,
        lastResolvedAt: stamp.lastResolvedAt,
      });
      if (refusal === undefined && painted) {
        history.lastResolvedAt = stamp.now;
        return chord;
      }
      if (numbers.lockoutMs > 0 && stamp.now - stamp.lastResolvedAt < numbers.lockoutMs)
        history.lastResolvedAt = stamp.now;
      return undefined;
    },
    lockedUntil: (evidence = { lastResolvedAt: history.lastResolvedAt }) =>
      numbers.lockoutMs > 0
        ? evidence.lastResolvedAt + numbers.lockoutMs
        : Number.NEGATIVE_INFINITY,
  };
}
