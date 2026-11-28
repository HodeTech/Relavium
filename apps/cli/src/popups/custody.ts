/**
 * What a host does when a popup takes the keyboard over a card ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2 "One overlay-active predicate").
 *
 * A popup opens only when no card or sheet exists, so a card that holds custody under a popup can only arise through a race (a card that
 * arrives as the popup opens, a popup a command opens a moment after a card did). The one record of overlay flags already REVOKES that card's
 * custody while the popup is open (`popup` closes `revokesCustody`, `overlay-flags.ts`), so its measured-frame evidence answers nothing. That is
 * not enough on its own: a card whose acknowledged frame was never invalidated while it was covered would, the moment the popup closed, be
 * answerable on the frame it had BEFORE the popup (no new dwell, no new measurement). So the moment a popup becomes the top of the stack, the
 * host RESETS every card's acknowledgement and dwell origin: the card must be measured and flushed on a new frame, and its dwell counted from
 * that frame, before any answer counts.
 *
 * The reset runs synchronously in the popup host's own publication (not in a React effect a frame later), so no key can be routed between the
 * popup opening and the reset.
 */

import type { PopupHost } from './popup-host.js';

/**
 * Watch `host`, and call `revoke` synchronously whenever a NEW popup becomes the top of its stack (it opened, or a child opened over it).
 * Returns the unsubscribe.
 */
export function revokeCardCustodyOnPopup(host: PopupHost, revoke: () => void): () => void {
  // Run ids only grow: a popup that becomes the top with a run id above every one seen is NEW. An opener the person returns to from its child
  // is not new (its run id is older), and a popup closing is not either.
  let newest: number | undefined = host.getSnapshot().frame?.runId;
  if (newest !== undefined) revoke();
  return host.subscribe(() => {
    const top = host.getSnapshot().frame?.runId;
    if (top !== undefined && (newest === undefined || top > newest)) {
      newest = top;
      revoke();
    }
  });
}
