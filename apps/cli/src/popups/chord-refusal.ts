/**
 * Why a `Ctrl+Y` did not count, in words ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): the host disarms a confirmation line and says which of four guards refused the key (`ChordRefusal`, `popup-host.ts`); the popup that
 * owns the line adds what that means for it (`Nothing was sent: <phrase>. [d] asks again.`, `Nothing released: <phrase>. [r] asks again.`: the
 * sentence says what did not happen, why, and what asks again, in the room a notification has beside the way back). The phrases are written ONCE here, so a popup that has a line cannot word a guard differently from another. The host tells
 * apart a key that came before its frame was shown and one that came inside the dwell (`unseen`, `early`); the person is told one thing for
 * both, "too soon", because both are answered the same way: wait, then ask again. It names NO time (MVP-11 unit 6 round 2, CO-2): a refused key
 * restarts the lockout (`APPROVAL_LOCKOUT_MS`), but the line asked for again has a dwell of its own from the moment it is drawn, so how long
 * the next answer must wait depends on when the person asks again, and a number would be untrue on some of those paths (a person who waits
 * the lockout out and only then asks again is refused by the new line's dwell). Where a lockout holds a line, its legend says so where the key
 * is named (`[Ctrl+Y] send (wait)`, ADR-0145 §3). A line the page could no longer show whole (`cut`) is said as what happened to it.
 */

import type { ChordRefusal } from './popup-host.js';

/** What a key that came too soon is told: no time, because no one time is the wait the host enforces (see the module header). */
const TOO_SOON = 'too soon';

/**
 * What each refusal says, short enough that the sentence a popup builds around it fits the room a notification has in the legend row of a popup at
 * the smallest terminal (`POPUP_NOTICE_MAX_COLUMNS`, beside the way back), where it is drawn and never cut.
 */
export const CHORD_REFUSAL_PHRASE: Readonly<Record<ChordRefusal, string>> = {
  unseen: TOO_SOON,
  early: TOO_SOON,
  expired: 'time ran out',
  typed: 'a key was typed',
  cut: 'the line was cut',
};
