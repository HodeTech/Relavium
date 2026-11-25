/**
 * Why a `Ctrl+Y` did not count, in words ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): the host disarms a confirmation line and says which of four guards refused the key (`ChordRefusal`, `popup-host.ts`); the popup that
 * owns the line adds what that means for it (`Not confirmed: <phrase>. Nothing was sent; [d] asks again.`, `Not released: <phrase>.`). The
 * phrases are written ONCE here, so a popup that has a line cannot word a guard differently from another.
 */

import type { ChordRefusal } from './popup-host.js';

/**
 * What each refusal says, short enough that the sentence a popup builds around it fits the inner width of a popup at the smallest terminal
 * (66 columns), where it is drawn in the legend row and never cut.
 */
export const CHORD_REFUSAL_PHRASE: Readonly<Record<ChordRefusal, string>> = {
  unseen: 'not yet shown',
  early: 'pressed too soon',
  expired: 'time ran out',
  typed: 'a key was typed',
};
