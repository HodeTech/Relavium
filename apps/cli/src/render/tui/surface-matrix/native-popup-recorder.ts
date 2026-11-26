import { livePin } from '../../../popups/native-popup-body.js';
import {
  nativePopupFrameLines,
  nativePopupGeometry,
  nativePopupPinAfter,
} from '../../../popups/popup-slot.js';
import type { NativePromptSnapshot } from '../native-prompt-channel.js';
import type { NativePromptChannel } from './home-host.js';
import type { PopupBox } from './properties.js';
import type { Variant } from './variants.js';

/**
 * The expected box of a flow's popup on the matrix, for a step that is NOT the flow's first (MVP-11 unit 6, round 1, O5; ADR-0148 §4): the
 * slot keeps a flow's popup at the tallest height and the first row its prompts have had (`NativePopupPin`), so a later step is drawn where
 * the steps before it left it, and its expected box cannot be the step's own geometry alone. This records every snapshot a channel publishes
 * and folds them as the slot does render by render (`nativePopupPinAfter`), so the expected box and the drawn one come from the same rule but
 * are computed apart: the drawn one by the real slot over the real renderer, this one by the pure fold over what the channel said.
 */
const PUBLISHED = new WeakMap<NativePromptChannel['ui'], NativePromptSnapshot[]>();

/** Start recording what `channel` publishes (idempotent): call it when the cell takes the channel, before its flow opens anything. */
export function recordNativePopups(channel: NativePromptChannel): void {
  if (PUBLISHED.has(channel.ui)) return;
  const seen: NativePromptSnapshot[] = [channel.ui.getSnapshot()];
  PUBLISHED.set(channel.ui, seen);
  channel.ui.subscribe(() => {
    seen.push(channel.ui.getSnapshot());
  });
}

/** Where `snapshot` of `channel` is drawn in a cell, and its rows: the slot's geometry and frame lines, pinned as the flow's earlier steps left it. */
export function pinnedNativePopupBox(
  channel: NativePromptChannel,
  snapshot: NativePromptSnapshot,
  variant: Variant,
): PopupBox {
  const placement = variant.renderer === 'alt' ? 'overlay' : 'replace';
  const published = PUBLISHED.get(channel.ui) ?? [];
  // Everything up to the snapshot asked about: the slot never saw a later one when it drew this one.
  const upTo = published.lastIndexOf(snapshot);
  const before = upTo < 0 ? published : published.slice(0, upTo);
  const held = nativePopupPinAfter(before, placement, variant.size, variant.color);
  const pin = livePin(held, snapshot, placement, variant.size);
  const { geometry, layout } = nativePopupGeometry(
    snapshot,
    placement,
    variant.size,
    variant.color,
    pin,
  );
  if (!geometry.fits || layout === undefined || !layout.fits)
    throw new Error('the framed prompt does not fit this cell');
  return {
    placement,
    top: geometry.top,
    left: geometry.left,
    width: geometry.width,
    height: geometry.height,
    // With the channel's lock as it is now, as the slot draws it (a waiting part reads `(wait)`).
    rows: nativePopupFrameLines(
      snapshot,
      geometry,
      layout,
      variant.color,
      channel.ui.lock.read(),
    ).map((line) => line.text),
  };
}
