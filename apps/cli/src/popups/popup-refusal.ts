/**
 * Why a popup may not open now ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2 "The
 * rules of opening"), as ONE pure function over the facts a host reads off its own state. Both hosts' open gates call it (`chat-ink.tsx`
 * `chatPopupRefusal`, `home-app.tsx` `homePopupRefusal`), so the reasons and their order are written once: a chat is being built; a card waits
 * for an answer; a sheet is open; a turn, a submit, a `!` command or a native action is in flight; a two-step is armed; another overlay owns
 * the keyboard. The first that holds is the reason the one notification names. The stack's own reasons (`popup-open`, `depth`, `closed`) are
 * the popup host's, upstream of the gate.
 */

import type { PopupRefusal } from './popup-host.js';
import { turnInFlight, type TurnFacts } from './turn-in-flight.js';

/** What a host knows when it is asked whether a popup may open. */
export interface PopupRefusalFacts {
  /** A chat is being built (the Home's `loading`): nothing it will show is on screen yet. A stand-alone chat is never starting. */
  readonly starting?: boolean | undefined;
  /** A card of the chat waits for an answer: an approval or its review, a question, a continue checkpoint. */
  readonly cards: boolean;
  /** A sheet is open: a native card, and on the Home the exit guard or a gate card. */
  readonly sheet: boolean;
  /** What is in flight (`turn-in-flight.ts`, the one predicate the `/cost` release asks again at its answer). */
  readonly turn: TurnFacts;
  /** The interrupt keymap is armed (a two-step). */
  readonly armed: boolean;
  /** Another overlay owns the keyboard (a palette, a picker, a docked sheet, a screen). */
  readonly overlay: boolean;
}

/** The first reason a popup may not open, in the one order, or `undefined` when it may. */
export function popupRefusal(facts: PopupRefusalFacts): PopupRefusal | undefined {
  if (facts.starting === true) return 'starting';
  if (facts.cards) return 'card-open';
  if (facts.sheet) return 'sheet-open';
  if (turnInFlight(facts.turn)) return 'turn-running';
  if (facts.armed) return 'armed';
  if (facts.overlay) return 'overlay-open';
  return undefined;
}
