/**
 * The measured-frame evidence of the Home's gate and budget card
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4): the card takes an affirmative chord only
 * while its exact snapshot is on screen, measured and flushed at 80×24, and its dwell counts from the first frame that was.
 *
 * It wraps the one measured-frame acknowledgement the Home's other cards use, and adds the one thing a card needs on top: `shown` is told
 * ONCE per new frame. Every React commit of the view reports its box again, and a dwell that restarted on each of them would never end, so
 * a re-commit of a frame that was already acknowledged (the same snapshot, the same box, custody kept) is not new.
 */

import type { DOMElement } from 'ink';

import {
  createMeasuredFrameAcknowledgement,
  type TerminalFrameSize,
} from './measured-frame-acknowledgement.js';
import type { RunCardSnapshot } from './run-card-model.js';

export interface GateCardFrameOptions {
  /** The snapshot the card holds now, or `undefined` with no card open. */
  readonly current: () => RunCardSnapshot | undefined;
  readonly getSize: () => TerminalFrameSize;
  /** The Home holds the terminal: input is enabled, not suspended, no native prompt is open and stdout is writable. */
  readonly hasCustody: () => boolean;
  /** A new frame of `snapshot` was measured and flushed: the card's dwell counts from here. */
  readonly shown: (snapshot: RunCardSnapshot) => void;
}

export interface GateCardFrame {
  /** Whether this exact snapshot is on screen now (the card's `painted`). */
  readonly visible: (snapshot: RunCardSnapshot) => boolean;
  /** A resize, a suspension or anything else that voids what was measured. */
  readonly invalidate: () => void;
  /** The view committed `snapshot` into `node`: measure it, flush, and acknowledge it. Returns whether a measurement began. */
  readonly commit: (
    snapshot: RunCardSnapshot,
    node: DOMElement | null,
    flush: () => Promise<void>,
  ) => boolean;
  readonly dispose: () => void;
}

export function createGateCardFrame(options: GateCardFrameOptions): GateCardFrame {
  const frame = createMeasuredFrameAcknowledgement<RunCardSnapshot | undefined>({
    current: options.current,
    getSize: options.getSize,
    hasCustody: options.hasCustody,
  });
  let acknowledgedNode: DOMElement | null = null;
  return {
    visible: (snapshot) => frame.visible(snapshot),
    invalidate: () => {
      acknowledgedNode = null;
      frame.invalidate();
    },
    commit: (snapshot, node, flush) => {
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
