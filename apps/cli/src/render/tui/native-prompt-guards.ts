/**
 * The input guards the native prompt channel gained for its flows drawn as popups (MVP-11 unit 6; [ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3), out of the channel's closure so each is one small thing with its own tests:
 *
 * - **The opening admission** ({@link createOpeningAdmission}, {@link nativeOpeningKey}): a framed flow's opening guard (`popups/opening-guard.ts`),
 *   reset per FLOW, and what a key is as that guard counts it (leave, navigate, answer, type).
 * - **The guarded option** ({@link createGuardedSelect}): the `Enter` on the affirmative of a consent answered by `Enter` (the first-run
 *   environment key's `Use it`) counts only when the approval card's layers pass: the confirmation dwell from the acknowledged frame, the quiet
 *   gap, the typing window and the lockout. **The lockout runs from the moment the guarded select opened**, not only from the answer before it:
 *   a select reached with no resolution just before it (a flow opened by the composer's `Enter`, which the landing stamps as a key and never as a
 *   resolution; a select reached after a wait with the key held through it) would otherwise let a held `Enter` answer it on its first repeat
 *   after the dwell. So a deliberate `Enter` on a guarded option needs about two seconds after the select appeared, and a key held at any
 *   repeat rate never gets there: each refused repeat inside the lockout restarts it (`createChordGuard`'s strict rule).
 * - **The chord card** ({@link createChordCardGuard}): the same rule for a card answered by `Ctrl+Y`, framed or not. Its lockout runs from the
 *   moment the card opened, so a card that is the FIRST prompt of a flow (`/init`, the `/workflows` export, `/run` started on a workflow with no
 *   inputs) and a card that appears after a wait with the key held through it (the MCP consent card a `/run` start or a gate's resume raises,
 *   the repeats of the `Ctrl+Y` that answered the card before landing on the wait as typing) are locked against a held `Ctrl+Y` as a card
 *   right after an answer always was. A deliberate `Ctrl+Y` needs about two seconds after the card appeared; `Ctrl+N` is never delayed by the
 *   guards (it is dropped before the card's first painted frame).
 *
 * Pure but for the clock and the shared key history they are handed.
 */

import type { Key } from 'ink';

import {
  createOpeningGuard,
  type OpeningGuard,
  type OpeningKey,
} from '../../popups/opening-guard.js';
import {
  chordOf,
  createChordGuard,
  type ChordAnswer,
  type ChordGuard,
  type ChordHistory,
  type ChordStamp,
} from './chord-guard.js';
import type { NativePromptSnapshot } from './native-prompt-channel.js';
import {
  APPROVAL_CONFIRM_MIN_MS,
  APPROVAL_LOCKOUT_MS,
  APPROVAL_QUIET_MS,
  APPROVAL_TYPEAHEAD_MS,
  type ApprovalGuard,
} from './tool-review-model.js';

/**
 * The approval card's layers behind the `Enter` on a guarded option: the dwell is the confirmation constant (800 ms) counted from the select's
 * acknowledged frame, then the quiet gap, the typing window (keys typed at the prompt, a paste, and the keys the host dropped before the prompt's
 * frame was on screen) and the lockout, counted from the later of the answer before it and the select's opening, which an `Enter` inside it
 * RESTARTS. Always these numbers: a channel's injected guard is the chord card's only, so a guarded option never loses its dwell to it.
 */
export const GUARDED_SELECT_GUARD: ApprovalGuard = Object.freeze({
  settleMs: APPROVAL_CONFIRM_MIN_MS,
  quietMs: APPROVAL_QUIET_MS,
  typeaheadMs: APPROVAL_TYPEAHEAD_MS,
  lockoutMs: APPROVAL_LOCKOUT_MS,
});

/** Index of the first byte that ends or cancels an edit (a return, a newline, an escape or an ETX); `-1` when there is none. */
export function firstBoundary(input: string): number {
  let boundary = -1;
  for (const marker of ['\r', '\n', '\x1b', '\x03']) {
    const index = input.indexOf(marker);
    if (index >= 0 && (boundary < 0 || index < boundary)) boundary = index;
  }
  return boundary;
}

/** `Esc`, any meta chord, or `Ctrl+C`: the keys that leave a prompt. */
export function cancelsPrompt(input: string, key: Key): boolean {
  return key.escape || key.meta || (key.ctrl && input.toLowerCase() === 'c');
}

/** Whether a key moves the highlight or pages: what a list does with no answer in it. */
export function navigates(key: Key): boolean {
  return key.upArrow || key.downArrow || key.pageUp || key.pageDown;
}

/**
 * A chord card's key: its `Ctrl+N` refuses, as `Esc` does, and is never delayed by the guards (dropped before the first painted frame); its
 * `Ctrl+Y` answers; anything else is typing.
 */
function chordOpeningKey(input: string, key: Key, boundary: number): OpeningKey {
  const answer = boundary >= 0 ? undefined : chordOf(input, key);
  if (answer === 'deny') return 'leave';
  return answer === 'allow' ? 'answer' : 'type';
}

/** A key on any other open prompt: a submitting key answers, the arrows, the pages and the picker's `Tab` navigate, the rest is typing. */
function promptOpeningKey(snapshot: NativePromptSnapshot, key: Key, boundary: number): OpeningKey {
  if (key.return || boundary >= 0) return 'answer';
  if (navigates(key) || (snapshot.kind === 'picker' && key.tab)) return 'navigate';
  return 'type';
}

/**
 * What a key is as a framed flow's opening guard counts it (`popups/opening-guard.ts`): leave (`Esc`, `Ctrl+C`, a meta chord, a cancelling byte,
 * and a chord card's `Ctrl+N`), answer (`Enter`, a chunk that holds a return or a newline, a chord card's `Ctrl+Y`), navigate (the arrows, the
 * pages, the picker's `Tab`), or type. A key while no prompt is open (`open` false) or on a wait is typing.
 */
export function nativeOpeningKey(
  snapshot: NativePromptSnapshot,
  open: boolean,
  input: string,
  key: Key,
): OpeningKey {
  const boundary = firstBoundary(input);
  const marker = boundary >= 0 ? input[boundary] : undefined;
  if (marker === '\x1b' || marker === '\x03' || cancelsPrompt(input, key)) return 'leave';
  if (snapshot.kind === 'chord') return chordOpeningKey(input, key, boundary);
  if (snapshot.kind === 'busy' || !open) return 'type';
  return promptOpeningKey(snapshot, key, boundary);
}

/** A flow's opening guard, reset per flow. */
export interface OpeningAdmission {
  /** A new flow began: its guard starts again at its own first framed frame. */
  readonly begin: () => void;
  /** A framed frame of the flow was measured and flushed (only the first counts). */
  readonly shown: () => void;
  /** Whether a key of `kind` that arrived at `arrivedAt` may act (see `OpeningGuard.admits`). */
  readonly admits: (kind: OpeningKey, arrivedAt: number) => boolean;
  /**
   * Whether a key that arrived at `arrivedAt` came AFTER the flow's first framed frame appeared (rule 3: one that arrived at the very moment it
   * appeared was already on its way). A key that leaves is admitted either way; this says whether it may also be an answer (a step back that
   * writes, ADR-0146 §6).
   */
  readonly appeared: (arrivedAt: number) => boolean;
}

export function createOpeningAdmission(options: {
  readonly now: () => number;
  readonly settleMs?: number | undefined;
}): OpeningAdmission {
  const make = (): OpeningGuard =>
    createOpeningGuard({ now: options.now, settleMs: options.settleMs });
  let guard = make();
  return {
    begin: () => {
      guard = make();
    },
    shown: () => guard.shown(),
    admits: (kind, arrivedAt) => guard.admits(kind, arrivedAt),
    appeared: (arrivedAt) => {
      const at = guard.shownAt();
      return at !== undefined && arrivedAt > at;
    },
  };
}

/**
 * The key's evidence with a prompt's OPENING (`openedAt`) counted as an answer just before it: the lockout then runs from whichever came later,
 * the last answer or the opening. `-Infinity` (a prompt that carries no such lockout) leaves the evidence as it is.
 */
function openedAsAnswer(stamp: ChordStamp, openedAt: number): ChordStamp {
  return { ...stamp, lastResolvedAt: Math.max(stamp.lastResolvedAt, openedAt) };
}

/**
 * Until when `guard`'s lockout refuses the affirmative of a prompt opened at `openedAt`, its opening counted as an answer just before the next
 * key as {@link openedAsAnswer} counts it for `decide` (the later of the two ends: the lockout is monotone in its origin); `-Infinity` for no
 * prompt that carries it. What the channel draws the affirmative as locked by (`(wait)`, ADR-0145 §3).
 */
function lockedFromOpening(guard: ChordGuard, openedAt: number): number {
  if (openedAt === Number.NEGATIVE_INFINITY) return Number.NEGATIVE_INFINITY;
  return Math.max(guard.lockedUntil(), guard.lockedUntil({ lastResolvedAt: openedAt }));
}

/** The `Ctrl+Y` of a chord card (see the module header). */
export interface ChordCardGuard {
  /** A prompt opened: a chord card starts its lockout now; any other prompt carries none. */
  readonly open: (chord: boolean) => void;
  /**
   * Whether `answer`, stamped `stamp`, answers the open chord card on a frame that is (`painted`) or is not on screen: the channel's chord guard
   * decides, with the card's opening counted as an answer just before the key. A refused `Ctrl+Y` inside that lockout restarts it on the shared
   * history (`createChordGuard`'s strict rule), so a key held at any repeat rate keeps the card locked; `Ctrl+N` is never delayed by the guards
   * (dropped before the first painted frame).
   */
  readonly decide: (
    stamp: ChordStamp,
    answer: ChordAnswer,
    painted: boolean,
  ) => ChordAnswer | undefined;
  /**
   * Until when the open card's `Ctrl+Y` is refused by its lockout (from the card's opening or the last resolution, whichever is later, a refused
   * press inside it having moved it on): the rule `decide` applies, read without a key. `-Infinity` when no chord card is open.
   */
  readonly lockedUntil: () => number;
}

export function createChordCardGuard(options: {
  readonly now: () => number;
  /** The channel's chord guard: its numbers, its dwell and the shared history are the card's. */
  readonly chord: ChordGuard;
}): ChordCardGuard {
  let openedAt = Number.NEGATIVE_INFINITY;
  return {
    open: (chord) => {
      openedAt = chord ? options.now() : Number.NEGATIVE_INFINITY;
    },
    decide: (stamp, answer, painted) =>
      options.chord.decide(openedAsAnswer(stamp, openedAt), answer, painted),
    lockedUntil: () => lockedFromOpening(options.chord, openedAt),
  };
}

/** The `Enter` of a guarded option (see the module header). */
export interface GuardedSelect {
  /** A prompt opened: a select with a guarded option starts its lockout now; any other prompt carries none. Its dwell has not started. */
  readonly open: (guarded: boolean) => void;
  /** The select's current frame was just measured and flushed (a new frame restarts the dwell). */
  readonly shown: () => void;
  /** Whether an `Enter` on the guarded option, stamped `stamp`, answers now, on a frame that is (`painted`) or is not on screen. */
  readonly decide: (stamp: ChordStamp, painted: boolean) => boolean;
  /** An `Enter` that would have answered it and was refused before it reached it: inside the lockout it restarts it, as any refusal does. */
  readonly refuse: (stamp: ChordStamp) => void;
  /** Until when an `Enter` on the guarded option is refused by its lockout (the rule `decide` applies); `-Infinity` when no such select is open. */
  readonly lockedUntil: () => number;
}

export function createGuardedSelect(options: {
  readonly now: () => number;
  readonly history: ChordHistory;
}): GuardedSelect {
  const confirm = createChordGuard({
    now: options.now,
    guard: GUARDED_SELECT_GUARD,
    history: options.history,
  });
  let openedAt = Number.NEGATIVE_INFINITY;
  /** The key's evidence with the select's opening counted as an answer just before it: the lockout runs from whichever came later. */
  const fromOpening = (stamp: ChordStamp): ChordStamp => openedAsAnswer(stamp, openedAt);
  return {
    open: (guarded) => {
      confirm.begin();
      openedAt = guarded ? options.now() : Number.NEGATIVE_INFINITY;
    },
    shown: () => confirm.shown(),
    decide: (stamp, painted) => confirm.decide(fromOpening(stamp), 'allow', painted) !== undefined,
    refuse: (stamp) => {
      confirm.decide(fromOpening(stamp), 'allow', false);
    },
    lockedUntil: () => lockedFromOpening(confirm, openedAt),
  };
}
