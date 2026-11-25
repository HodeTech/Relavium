/**
 * Why a `Ctrl+Y` did not count, in words ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): the host disarms a confirmation line and says which of four guards refused the key (`ChordRefusal`, `popup-host.ts`); the popup that
 * owns the line adds what that means for it (`Nothing was sent: <phrase>. [d] asks again.`, `Nothing released: <phrase>. [r] asks again.`: the
 * sentence says what did not happen, why, and what asks again, in the room a notification has beside the way back). The phrases are written ONCE here, so a popup that has a line cannot word a guard differently from another. The host tells
 * apart a key that came before its frame was shown and one that came inside the dwell (`unseen`, `early`); the person is told one thing for
 * both, "pressed too soon", because both are answered the same way: ask again and wait. A line the page could no longer show whole (`cut`)
 * is said as what happened to it.
 */

import type { ChordRefusal } from './popup-host.js';

/**
 * What each refusal says, short enough that the sentence a popup builds around it fits the room a notification has in the legend row of a popup at
 * the smallest terminal (`POPUP_NOTICE_MAX_COLUMNS`, beside the way back), where it is drawn and never cut.
 */
export const CHORD_REFUSAL_PHRASE: Readonly<Record<ChordRefusal, string>> = {
  unseen: 'pressed too soon',
  early: 'pressed too soon',
  expired: 'time ran out',
  typed: 'a key was typed',
  cut: 'the line was cut',
};
