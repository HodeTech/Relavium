import type { DOMElement } from 'ink';
import { measureElement } from 'ink';
import type { NativePromptSnapshot, NativePromptUi } from './native-prompt-channel.js';
import { reduceEditorMotion, type ChatKey } from './chat-input.js';

type Size = { readonly cols: number; readonly rows: number };
export function nativePromptFits(size: Size): boolean {
  return (
    Number.isSafeInteger(size.cols) &&
    Number.isSafeInteger(size.rows) &&
    size.cols >= 80 &&
    size.rows >= 24
  );
}
function fitsBounds(node: DOMElement, size: Size): boolean {
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
  const invalidateCard = (preservePickerEditor: boolean): void => {
    epoch++;
    observed = undefined;
    if (!preservePickerEditor) pickerEditor = undefined;
    notify();
  };
  const invalidate = (): void => invalidateCard(false);
  const sameCard = (a: NativePromptSnapshot, b: NativePromptSnapshot): boolean =>
    a.active === b.active &&
    a.kind === b.kind &&
    a.message === b.message &&
    a.note === b.note &&
    a.options === b.options &&
    a.selected === b.selected &&
    a.error === b.error;
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
      void flush().then(
        () => {
          if (
            disposed ||
            currentEpoch !== epoch ||
            ui.getSnapshot() !== snapshot ||
            !sameSize(size, getSize()) ||
            !fitsBounds(node, size)
          )
            return;
          observed = { snapshot, size, epoch: currentEpoch, node };
          pickerEditor = snapshot.kind === 'picker' ? observed : undefined;
          notify();
        },
        () => {
          /* the owning renderer's flush path reports output failure */
        },
      );
      return true;
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
      ui.bindVisibility(undefined);
      unsubscribe();
      notify();
      listeners.clear();
    },
  };
}
export type NativePromptAcknowledgement = ReturnType<typeof createNativePromptAcknowledgement>;
