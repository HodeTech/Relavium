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
 * - a REJECTION (`Ctrl+N`) is never delayed and needs no guard: refusing is the safe answer;
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
 * Which answer this key is, or `undefined` for every key that is not a chord. Exactly `Ctrl+Y` and `Ctrl+N`: the letter must be the
 * whole input (a pasted run that contains one is not a key), `ctrl` must be set (a bare letter is typing) and `meta` must not be (a
 * different chord). Nothing else answers.
 */
export function reduceChordKey(input: string, key: ChatKey): ChordAnswer | undefined {
  if (key.ctrl !== true || key.meta === true) return undefined;
  if (input === 'y') return 'allow';
  if (input === 'n') return 'deny';
  return undefined;
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
  /**
   * Whether this chord answers. A rejection always does. An affirmative one needs every layer clear AND `painted`; when it does not
   * count and a card was resolved by a key a moment ago, the lockout restarts, so a key that stays down keeps the card locked
   * until it has been released for the whole window.
   */
  readonly decide: (
    stamp: ChordStamp,
    chord: ChordAnswer,
    painted: boolean,
  ) => ChordAnswer | undefined;
}

export function createChordGuard(options: {
  readonly now: () => number;
  readonly guard?: ApprovalGuard | undefined;
}): ChordGuard {
  const numbers = resolveApprovalGuard(options.guard);
  let previousKeyAt = Number.NEGATIVE_INFINITY;
  let lastForeignKeyAt = Number.NEGATIVE_INFINITY;
  let lastResolvedAt = Number.NEGATIVE_INFINITY;
  let shownAt: number | undefined;
  return {
    stamp: () => {
      const now = options.now();
      const before: ChordStamp = { now, previousKeyAt, lastForeignKeyAt, lastResolvedAt };
      previousKeyAt = now;
      return before;
    },
    foreign: (stamp) => {
      lastForeignKeyAt = stamp.now;
    },
    resolved: (stamp) => {
      lastResolvedAt = stamp.now;
    },
    begin: () => {
      shownAt = undefined;
    },
    shown: () => {
      shownAt = options.now();
    },
    decide: (stamp, chord, painted) => {
      if (chord === 'deny') {
        lastResolvedAt = stamp.now;
        return 'deny';
      }
      const refusal = approvalKeyRefusal(numbers, {
        now: stamp.now,
        shownAt,
        previousKeyAt: stamp.previousKeyAt,
        lastForeignKeyAt: stamp.lastForeignKeyAt,
        lastResolvedAt: stamp.lastResolvedAt,
      });
      if (refusal === undefined && painted) {
        lastResolvedAt = stamp.now;
        return 'allow';
      }
      if (numbers.lockoutMs > 0 && stamp.now - stamp.lastResolvedAt < numbers.lockoutMs)
        lastResolvedAt = stamp.now;
      return undefined;
    },
  };
}
