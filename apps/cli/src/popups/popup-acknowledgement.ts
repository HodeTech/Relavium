/**
 * The measured-frame proof of a popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2 and §4): an answer counts only for a frame that is on the terminal, measured and flushed, and that is the frame the geometry says it is.
 *
 * **Measure the content, not the box.** The acknowledgement is handed the popup's CONTENT node, which has no fixed size: a row that is one
 * cell too wide makes it one cell wider, a row that wraps or one row too many makes it taller, and either refuses the acknowledgement here.
 * A fixed-size outer box would measure its own size however much spilled out of it (the design review measured a 78×23 box over 78×31 of
 * content), which is why nothing here sets a size. The check is EXACT: the measured width and height must equal the one geometry function's
 * (`geometry.ts`), and in the overlay the node must sit at the geometry's place, so a page fitted to one geometry and drawn in another can
 * never be acknowledged.
 *
 * It wraps the repository's one measured-frame acknowledgement (`measured-frame-acknowledgement.ts`: the terminal's bounds, the custody, the
 * flush) and adds what a popup needs on top: the exact geometry, and `shown` told ONCE per new frame (a re-commit of a frame already acknowledged
 * is not new, so a tick or a re-render never restarts the opening guard).
 */

import { measureElement, type DOMElement } from 'ink';

import {
  createMeasuredFrameAcknowledgement,
  fitsTerminalBounds,
  type TerminalFrameSize,
} from '../render/tui/measured-frame-acknowledgement.js';
import type { PopupPlacement } from './geometry.js';

/** What the frame must measure: its size always, and its place in the overlay. */
export interface ExpectedPopupFrame {
  readonly placement: PopupPlacement;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
}

/** Where `node` sits in the frame: the sum of its own and its ancestors' computed offsets. */
function screenOffset(node: DOMElement): { readonly left: number; readonly top: number } {
  let left = 0;
  let top = 0;
  for (
    let current: DOMElement | undefined = node;
    current !== undefined;
    current = current.parentNode
  ) {
    left += current.yogaNode?.getComputedLeft() ?? 0;
    top += current.yogaNode?.getComputedTop() ?? 0;
  }
  return { left, top };
}

/**
 * Whether the content node is exactly the frame the geometry describes: inside the terminal (the repository's bounds check), exactly as wide
 * and as tall as the geometry says, and, in the overlay, exactly where it says. Any difference refuses.
 */
export function popupFrameMatches(
  node: DOMElement,
  expected: ExpectedPopupFrame,
  size: TerminalFrameSize,
): boolean {
  if (!fitsTerminalBounds(node, size)) return false;
  const measured = measureElement(node);
  if (measured.width !== expected.width || measured.height !== expected.height) return false;
  if (expected.placement === 'replace') return true;
  const at = screenOffset(node);
  return at.left === expected.left && at.top === expected.top;
}

export interface PopupAcknowledgement<Snapshot> {
  /** Whether this exact snapshot is measured, flushed and on screen now, with custody. */
  readonly visible: (snapshot: Snapshot) => boolean;
  /** A resize, a suspension, a custody change or a frame that no longer matches: what was measured is void. */
  readonly invalidate: () => void;
  /** The view committed `snapshot` into `node`: check it against `expected`, flush, and acknowledge it. `false` when it was refused. */
  readonly commit: (
    snapshot: Snapshot,
    node: DOMElement | null,
    expected: ExpectedPopupFrame,
    flush: () => Promise<void>,
  ) => boolean;
  readonly dispose: () => void;
}

export function createPopupAcknowledgement<Snapshot>(options: {
  readonly current: () => Snapshot;
  readonly getSize: () => TerminalFrameSize;
  /** The popup holds the terminal: input enabled, not suspended, writable, and no card or native prompt over it. */
  readonly hasCustody: () => boolean;
  /** A NEW frame of `snapshot` was measured and flushed. */
  readonly shown: (snapshot: Snapshot) => void;
}): PopupAcknowledgement<Snapshot> {
  const frame = createMeasuredFrameAcknowledgement<Snapshot>({
    current: options.current,
    getSize: options.getSize,
    hasCustody: options.hasCustody,
  });
  let acknowledgedNode: DOMElement | null = null;
  const invalidate = (): void => {
    acknowledgedNode = null;
    frame.invalidate();
  };
  return {
    visible: (snapshot) => frame.visible(snapshot),
    invalidate,
    commit: (snapshot, node, expected, flush) => {
      if (node === null || !popupFrameMatches(node, expected, options.getSize())) {
        // A frame that is not the geometry's is never evidence, and what was acknowledged before it is void too.
        invalidate();
        return false;
      }
      // Taken before the commit: was this very frame already acknowledged, and is it still exactly on screen?
      const fresh = !(frame.visible(snapshot) && acknowledgedNode === node);
      return frame.commit(snapshot, node, flush, () => {
        acknowledgedNode = node;
        if (fresh) options.shown(snapshot);
      });
    },
    dispose: () => {
      acknowledgedNode = null;
      frame.dispose();
    },
  };
}
