import type { DOMElement } from 'ink';
import { nativeFramed } from '../../popups/native-popup-body.js';
import type { NativePromptSnapshot, NativePromptUi } from './native-prompt-channel.js';
import { reduceEditorMotion, type ChatKey } from './chat-input.js';
import { selectPageRows } from './native-select-window.js';
import {
  createMeasuredFrameAcknowledgement,
  fitsTerminalBounds as fitsBounds,
  reviewTerminalFits as nativePromptFits,
  type TerminalFrameSize as Size,
} from './measured-frame-acknowledgement.js';
export { reviewTerminalFits as nativePromptFits } from './measured-frame-acknowledgement.js';

/**
 * The fields of a snapshot that are NOT part of what the person was shown as one card, each with the reason. Every other field of
 * {@link NativePromptSnapshot} is identity ({@link sameNativePromptFrame}): a change to it is a new card that must be measured, flushed and
 * dwelt on again before anything on it counts ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2). `native-prompt-identity.test.ts` enumerates the snapshot's keys against this list and the comparison, so a field added without a
 * decision fails there. The clock and any spinner are not fields at all (ADR-0147 §2).
 */
export const NATIVE_PROMPT_IDENTITY_EXCLUDED: Readonly<
  Partial<Record<keyof NativePromptSnapshot, string>>
> = {
  display:
    'what is typed into the open field: the card stays the card the person is typing into, and a keystroke must not restart its dwell (a secret would never be answerable)',
};

/**
 * Whether two snapshots are the same card as far as the measured-frame proof goes: every field but the ones of
 * {@link NATIVE_PROMPT_IDENTITY_EXCLUDED}, the popup descriptor field by field (its title, origin, steps and their names, exit label,
 * the verbs of `Enter` and `Esc`, the steps it skipped, and depth). The lists and the picker's state are compared by reference: the channel publishes a new one exactly when it changes.
 */
export function sameNativePromptFrame(a: NativePromptSnapshot, b: NativePromptSnapshot): boolean {
  return (
    a.active === b.active &&
    a.kind === b.kind &&
    a.picker === b.picker &&
    a.message === b.message &&
    a.note === b.note &&
    a.options === b.options &&
    a.selected === b.selected &&
    a.error === b.error &&
    a.escape === b.escape &&
    a.details === b.details &&
    a.final === b.final &&
    samePopupDescriptor(a.popup, b.popup)
  );
}

/** Two lists of step names, name by name (the setter builds a new list each time, so a reference would always differ). */
function sameList<T extends string | number>(
  a: readonly T[] | undefined,
  b: readonly T[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function samePopupDescriptor(
  a: NativePromptSnapshot['popup'],
  b: NativePromptSnapshot['popup'],
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.title === b.title &&
    a.origin === b.origin &&
    a.stepIndex === b.stepIndex &&
    a.stepCount === b.stepCount &&
    sameList(a.stepNames, b.stepNames) &&
    a.exitLabel === b.exitLabel &&
    a.enterVerb === b.enterVerb &&
    a.escapeVerb === b.escapeVerb &&
    sameList(a.skipped, b.skipped) &&
    a.depth === b.depth
  );
}

/** Two sizes are one when every number is the same number (a size that is not a number is the same as itself: no resize is seen in it). */
function sameNotedSize(a: Size, b: Size): boolean {
  return Object.is(a.cols, b.cols) && Object.is(a.rows, b.rows);
}

/** Evidence is bound to one exact card, geometry and committed/actually flushed Ink frame. */
export function createNativePromptAcknowledgement(
  ui: NativePromptUi,
  getSize: () => Size,
  hasCustody: () => boolean = () => true,
) {
  let epoch = 0;
  /**
   * The size the terminal had the last time this acknowledgement looked ({@link noteSize}): a different one is a RESIZE, which the channel is
   * told at once, so a masked field is emptied before any frame is drawn at the new size (ADR-0148 §4).
   */
  let notedSize = getSize();
  /** The page a framed select's `PgUp`/`PgDn` move by, bound by the popup slot that draws it (its window); `undefined` while none is. */
  let framedPage: (() => number | undefined) | undefined;
  let observed:
    | {
        readonly snapshot: NativePromptSnapshot;
        readonly size: Size;
        readonly epoch: number;
        readonly node: DOMElement;
      }
    | undefined;
  let disposed = false;
  // A visible picker editor keeps accepting edits while its read-only results repaint.
  // Choosing/navigating results still requires the current card's exact acknowledgement.
  let pickerEditor: typeof observed;
  let previous = ui.getSnapshot();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const sharedFrame = createMeasuredFrameAcknowledgement({
    current: ui.getSnapshot,
    getSize,
    hasCustody,
  });
  const invalidateCard = (preservePickerEditor: boolean): void => {
    sharedFrame.invalidate();
    epoch++;
    observed = undefined;
    if (!preservePickerEditor) pickerEditor = undefined;
    notify();
  };
  /**
   * Look at the terminal's size: one this acknowledgement has not seen is a resize, and the channel clears a masked field for it. Every host
   * invalidates the acknowledgement from its resize listener, before it re-renders at the new size (the Home's root, the native prompt host),
   * so this runs there; the commit of a frame is the backstop for a host that would not.
   */
  const noteSize = (): void => {
    const size = getSize();
    if (sameNotedSize(size, notedSize)) return;
    notedSize = size;
    if (!disposed) ui.resized();
  };
  const invalidate = (): void => {
    noteSize();
    invalidateCard(false);
  };
  const sameCard = sameNativePromptFrame;
  const samePickerPrompt = (a: NativePromptSnapshot, b: NativePromptSnapshot): boolean =>
    a.active &&
    b.active &&
    a.kind === 'picker' &&
    b.kind === 'picker' &&
    a.message === b.message &&
    a.note === b.note;
  const unsubscribe = ui.subscribe(() => {
    const current = ui.getSnapshot();
    if (!sameCard(previous, current)) invalidateCard(samePickerPrompt(previous, current));
    previous = current;
  });
  const sameSize = (a: Size, b: Size): boolean => a.cols === b.cols && a.rows === b.rows;
  const visible = (snapshot: NativePromptSnapshot): boolean => {
    const size = getSize();
    return (
      !disposed &&
      hasCustody() &&
      snapshot.active &&
      ui.getSnapshot() === snapshot &&
      nativePromptFits(size) &&
      observed?.snapshot === snapshot &&
      observed.epoch === epoch &&
      sameSize(observed.size, size) &&
      fitsBounds(observed.node, size)
    );
  };
  const pickerEditorVisible = (): boolean => {
    const snapshot = ui.getSnapshot();
    const size = getSize();
    return (
      !disposed &&
      hasCustody() &&
      nativePromptFits(size) &&
      pickerEditor !== undefined &&
      samePickerPrompt(pickerEditor.snapshot, snapshot) &&
      sameSize(pickerEditor.size, size) &&
      fitsBounds(pickerEditor.node, size)
    );
  };
  const editsPicker = (input: string | undefined, key: ChatKey | undefined): boolean =>
    input !== undefined &&
    key !== undefined &&
    !key.return &&
    !key.tab &&
    !key.pageUp &&
    !key.pageDown &&
    !key.upArrow &&
    !key.downArrow &&
    !key.escape &&
    !key.meta &&
    // eslint-disable-next-line no-control-regex -- Raw submission/cancellation bytes never use editing-only custody.
    !/[\r\n\x1b\x03]/u.test(input) &&
    reduceEditorMotion(input, key) !== undefined;
  const inputCardVisible = (): boolean => {
    const snapshot = ui.getSnapshot();
    const size = getSize();
    return (
      !disposed &&
      hasCustody() &&
      snapshot.active &&
      nativePromptFits(size) &&
      observed !== undefined &&
      sameCard(observed.snapshot, snapshot) &&
      observed.epoch === epoch &&
      sameSize(observed.size, size) &&
      fitsBounds(observed.node, size)
    );
  };
  ui.bindVisibility(visible);
  // A card pages by the window it draws itself; a prompt drawn in the popup frame by the window the slot draws it in.
  ui.bindPageRows(() => {
    const snapshot = ui.getSnapshot();
    return nativeFramed(snapshot) ? framedPage?.() : selectPageRows(snapshot, getSize());
  });
  return {
    invalidate,
    /**
     * Look at the terminal's size now and, if it is one this acknowledgement has not seen, tell the channel (a masked field is emptied). For a
     * resize listener that must run BEFORE the renderer's own: the renderer redraws the tree it has on a resize, and a tree that still holds
     * the field's bullets would be written once more at the new size (`native-prompt-view.tsx`, `native-prompt-host.tsx`).
     */
    noticeSize: noteSize,
    visible,
    /**
     * Installed by the popup slot that draws the channel's prompt in the popup frame: how far `PgUp`/`PgDn` move the cursor of a select drawn
     * in a window there (`undefined` when it is drawn whole). Unbound (`undefined`) when the slot is gone.
     */
    bindFramedPage: (page: (() => number | undefined) | undefined): void => {
      framedPage = page;
    },
    current: () => ui.getSnapshot(),
    /**
     * Whether the open prompt's affirmative is locked now (`NativePromptUi.lock`): what the card and the popup slot draw its legend part by
     * (dim, `(wait)`). A display value, not part of the frame: a change to it re-renders the same snapshot, which this acknowledgement does
     * not take for a new frame (`commit` tells `shown` only for a new snapshot, epoch, node or size).
     */
    lock: ui.lock,
    inputVisible: (input?: string, key?: ChatKey): boolean =>
      (editsPicker(input, key) && pickerEditorVisible()) || inputCardVisible(),
    pasteVisible: (): boolean => pickerEditorVisible() || inputCardVisible(),
    commit: (
      snapshot: NativePromptSnapshot,
      node: DOMElement | null,
      flush: () => Promise<void>,
    ): boolean => {
      noteSize();
      const currentEpoch = epoch;
      const size = getSize();
      if (!snapshot.active || node === null || !nativePromptFits(size) || !fitsBounds(node, size))
        return false;
      return sharedFrame.commit(snapshot, node, flush, () => {
        if (disposed || currentEpoch !== epoch) return;
        const prior = observed;
        observed = { snapshot, size, epoch: currentEpoch, node };
        pickerEditor = snapshot.kind === 'picker' ? observed : undefined;
        // Every render commits again; only a frame that was not already acknowledged is a NEW one the person has had no time to
        // read (a card's dwell restarts for it, and only for it).
        if (
          prior?.snapshot !== snapshot ||
          prior.epoch !== currentEpoch ||
          prior.node !== node ||
          !sameSize(prior.size, size)
        )
          ui.shown(snapshot);
        notify();
      });
    },
    wait: async (snapshot: NativePromptSnapshot): Promise<void> => {
      const signal = ui.signal();
      if (signal === undefined) throw new Error('Native prompt is not active.');
      if (signal.aborted) signal.throwIfAborted();
      if (visible(snapshot)) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          listeners.delete(check);
          signal.removeEventListener('abort', cancelled);
        };
        const cancelled = (): void => {
          cleanup();
          reject(
            signal.reason instanceof Error ? signal.reason : new Error('Native prompt cancelled.'),
          );
        };
        const check = (): void => {
          if (signal.aborted) {
            cancelled();
            return;
          }
          if (disposed || ui.getSnapshot() !== snapshot) {
            cleanup();
            reject(new Error('Native prompt changed before it was visible.'));
            return;
          }
          if (visible(snapshot)) {
            cleanup();
            resolve();
          }
        };
        listeners.add(check);
        signal.addEventListener('abort', cancelled, { once: true });
        check();
      });
    },
    dispose: (): void => {
      disposed = true;
      sharedFrame.dispose();
      ui.bindVisibility(undefined);
      ui.bindPageRows(undefined);
      unsubscribe();
      notify();
      listeners.clear();
    },
  };
}
export type NativePromptAcknowledgement = ReturnType<typeof createNativePromptAcknowledgement>;
