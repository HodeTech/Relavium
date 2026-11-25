import type { DOMElement } from 'ink';
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
 * {@link NATIVE_PROMPT_IDENTITY_EXCLUDED}, the popup descriptor field by field (its title, origin, steps, exit label, placement and depth). The
 * lists and the picker's state are compared by reference: the channel publishes a new one exactly when it changes.
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
    samePopupDescriptor(a.popup, b.popup)
  );
}

function samePopupDescriptor(
  a: NativePromptSnapshot['popup'],
  b: NativePromptSnapshot['popup'],
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.placement === b.placement &&
    a.title === b.title &&
    a.origin === b.origin &&
    a.stepIndex === b.stepIndex &&
    a.stepCount === b.stepCount &&
    a.exitLabel === b.exitLabel &&
    a.depth === b.depth
  );
}

/** Evidence is bound to one exact card, geometry and committed/actually flushed Ink frame. */
export function createNativePromptAcknowledgement(
  ui: NativePromptUi,
  getSize: () => Size,
  hasCustody: () => boolean = () => true,
) {
  let epoch = 0;
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
  const invalidate = (): void => invalidateCard(false);
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
  ui.bindPageRows(() => selectPageRows(ui.getSnapshot(), getSize()));
  return {
    invalidate,
    visible,
    current: () => ui.getSnapshot(),
    inputVisible: (input?: string, key?: ChatKey): boolean =>
      (editsPicker(input, key) && pickerEditorVisible()) || inputCardVisible(),
    pasteVisible: (): boolean => pickerEditorVisible() || inputCardVisible(),
    commit: (
      snapshot: NativePromptSnapshot,
      node: DOMElement | null,
      flush: () => Promise<void>,
    ): boolean => {
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
