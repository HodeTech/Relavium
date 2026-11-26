import type { DOMElement } from 'ink';
import { measureElement } from 'ink';

export type TerminalFrameSize = { readonly cols: number; readonly rows: number };
/** The smallest terminal a card (an approval, a question, a checkpoint, a native prompt) is drawn on. */
const CARD_FLOOR_COLS = 80;
const CARD_FLOOR_ROWS = 24;
/**
 * What a card says in place of itself on a terminal below that floor: one sentence for every card, naming the size it needs, short enough that
 * it and the keys that leave still read on the floor's own width (a longer sentence wrapped between a key and its effect).
 */
export const TERMINAL_TOO_SMALL_TEXT = `Terminal too small: enlarge to ${String(CARD_FLOOR_COLS)}×${String(CARD_FLOOR_ROWS)}`;
export function reviewTerminalFits(size: TerminalFrameSize): boolean {
  return (
    Number.isSafeInteger(size.cols) &&
    Number.isSafeInteger(size.rows) &&
    size.cols >= CARD_FLOOR_COLS &&
    size.rows >= CARD_FLOOR_ROWS
  );
}
export function fitsTerminalBounds(node: DOMElement, size: TerminalFrameSize): boolean {
  if (node.yogaNode === undefined) return false;
  const measured = measureElement(node);
  if (
    !Number.isFinite(measured.width) ||
    !Number.isFinite(measured.height) ||
    measured.width < 1 ||
    measured.height < 1
  )
    return false;
  let top = 0;
  let left = 0;
  let current: DOMElement | undefined = node;
  let relativeTop = 0;
  let relativeLeft = 0;
  while (current !== undefined) {
    const y = current.yogaNode?.getComputedTop() ?? 0;
    const x = current.yogaNode?.getComputedLeft() ?? 0;
    top += y;
    left += x;
    relativeTop += y;
    relativeLeft += x;
    const parent = current.parentNode;
    if (parent?.yogaNode !== undefined) {
      const bounds = measureElement(parent);
      if (
        relativeTop < 0 ||
        relativeLeft < 0 ||
        relativeTop + measured.height > bounds.height ||
        relativeLeft + measured.width > bounds.width
      )
        return false;
    }
    current = current.parentNode;
  }
  return (
    top >= 0 &&
    left >= 0 &&
    top + measured.height <= size.rows &&
    left + measured.width <= size.cols
  );
}

/** One exact measured frame. A React commit alone is never evidence of visible delivery. */
export function createMeasuredFrameAcknowledgement<Snapshot>(options: {
  readonly current: () => Snapshot;
  readonly getSize: () => TerminalFrameSize;
  readonly hasCustody: () => boolean;
  readonly onAcknowledge?: (snapshot: Snapshot) => void;
}) {
  let epoch = 0;
  let disposed = false;
  let observed:
    | {
        snapshot: Snapshot;
        node: DOMElement;
        size: TerminalFrameSize;
        epoch: number;
      }
    | undefined;
  const sameSize = (a: TerminalFrameSize, b: TerminalFrameSize): boolean =>
    a.cols === b.cols && a.rows === b.rows;
  return {
    invalidate: (): void => {
      epoch++;
      observed = undefined;
    },
    visible: (snapshot: Snapshot): boolean => {
      if (!options.hasCustody()) {
        epoch++;
        observed = undefined;
        return false;
      }
      return (
        !disposed &&
        options.current() === snapshot &&
        observed?.snapshot === snapshot &&
        observed.epoch === epoch &&
        reviewTerminalFits(options.getSize()) &&
        sameSize(observed.size, options.getSize()) &&
        fitsTerminalBounds(observed.node, options.getSize())
      );
    },
    commit: (
      snapshot: Snapshot,
      node: DOMElement | null,
      flush: () => Promise<void>,
      acknowledged?: () => void,
    ): boolean => {
      const size = options.getSize();
      const committedEpoch = epoch;
      if (disposed || node === null || !reviewTerminalFits(size) || !fitsTerminalBounds(node, size))
        return false;
      void flush().then(
        () => {
          if (!options.hasCustody()) {
            epoch++;
            observed = undefined;
            return;
          }
          if (
            disposed ||
            epoch !== committedEpoch ||
            options.current() !== snapshot ||
            !sameSize(size, options.getSize()) ||
            !fitsTerminalBounds(node, options.getSize())
          )
            return;
          observed = { snapshot, node, size, epoch: committedEpoch };
          options.onAcknowledge?.(snapshot);
          acknowledged?.();
        },
        () => {
          observed = undefined;
        },
      );
      return true;
    },
    dispose: (): void => {
      disposed = true;
      epoch++;
      observed = undefined;
    },
  };
}
