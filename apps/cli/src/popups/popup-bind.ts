/**
 * How a terminal host binds its popup host ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2: "the Home controller and the chat host route keys to a popup and open it, and hold no popup logic"). The stand-alone chat (`chat-ink.tsx`)
 * and the Home (`home-app.tsx`) bind the same five things in the same order, and both call {@link bindPopupHost} with what is theirs alone:
 *
 * 1. **The acknowledgement**: the popup's measured-frame evidence is what the popup host asks whether a frame is on screen (`bindVisibility`).
 * 2. **The open gate**: the host's own reading of the opening rules (`popup-refusal.ts`), asked at every open (`bindOpenGate`).
 * 3. **Custody**: a popup that becomes the top over a card (only a race can do it) resets that card's acknowledgement and dwell origin,
 *    synchronously, in the popup host's own publication (`custody.ts`); `onRevoke` is what the host resets.
 * 4. **A sheet that arrives wins**: when a kind of sheet that was not on screen a moment before is (a card, a native card, and on the Home the
 *    exit guard and a gate card), the open popup closes unanswered and says so (`sheetArrived`). A sheet that was already there when the popup
 *    opened does not close it (its custody is revoked instead). Which kinds count, and how their sources are followed, is the host's.
 * 5. **The cleanup**, in the reverse order: stop watching, stop revoking, unbind the gate (so the host refuses every open as `closed`) and the
 *    visibility check (so no frame counts as seen), and dispose of the acknowledgement. It runs its work once, however often it is called.
 */

import { revokeCardCustodyOnPopup } from './custody.js';
import type { PopupAcknowledgement } from './popup-acknowledgement.js';
import type { PopupHost, PopupHostSnapshot, PopupRefusal } from './popup-host.js';

/** Where a host's sheets come from: which kinds are on screen now, and how to hear that any of them may have changed. */
export interface PopupSheetSources<Kind extends string> {
  /** Whether each kind of sheet is on screen now, read at the call. */
  readonly present: () => Readonly<Record<Kind, boolean>>;
  /** Call `onChange` whenever a source of a sheet may have changed; returns the unsubscribe. */
  readonly subscribe: (onChange: () => void) => () => void;
}

export interface PopupHostBinding<Kind extends string> {
  readonly popups: PopupHost;
  readonly acknowledgement: Pick<PopupAcknowledgement<PopupHostSnapshot>, 'visible' | 'dispose'>;
  /** The host's open gate: why a popup may not open now, or `undefined`. */
  readonly gate: () => PopupRefusal | undefined;
  /** Reset the host's cards' acknowledgement and dwell origin: a popup became the top of the stack. */
  readonly onRevoke: () => void;
  readonly watchSheets: PopupSheetSources<Kind>;
}

/**
 * Close the open popup of `popups` unanswered whenever a kind of sheet ARRIVES: one that is on screen now and was not at the last change.
 * Returns the unsubscribe.
 */
export function watchSheetArrivals<Kind extends string>(
  popups: Pick<PopupHost, 'getSnapshot' | 'sheetArrived'>,
  sources: PopupSheetSources<Kind>,
): () => void {
  let before = sources.present();
  return sources.subscribe(() => {
    const now = sources.present();
    let arrived = false;
    for (const kind in now) if (now[kind] && !before[kind]) arrived = true;
    before = now;
    if (arrived && popups.getSnapshot().open) popups.sheetArrived();
  });
}

/** Bind `binding.popups` to its host (the five steps of the module header) and return the cleanup, which does its work once. */
export function bindPopupHost<Kind extends string>(binding: PopupHostBinding<Kind>): () => void {
  const { popups, acknowledgement } = binding;
  popups.bindVisibility(acknowledgement.visible);
  popups.bindOpenGate(binding.gate);
  const stopRevoking = revokeCardCustodyOnPopup(popups, binding.onRevoke);
  const stopWatching = watchSheetArrivals(popups, binding.watchSheets);
  let bound = true;
  return () => {
    if (!bound) return;
    bound = false;
    stopWatching();
    stopRevoking();
    popups.bindOpenGate(undefined);
    popups.bindVisibility(undefined);
    acknowledgement.dispose();
  };
}
