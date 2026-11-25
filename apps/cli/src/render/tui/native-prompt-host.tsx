import { useApp, useInput, usePaste, useStdout } from 'ink';
import type { SuspendPort } from '../suspend.js';
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import type { NoticeFlush } from '../../engine/effect-retention.js';
import { pressesOnly } from './chord-guard.js';
import { useVisibleRenderFlush } from './render-acknowledgement.js';
import type { NativePromptUi } from './native-prompt-channel.js';
import { NativePromptView } from './native-prompt-view.js';
import {
  createNativePromptAcknowledgement,
  type NativePromptAcknowledgement,
} from './native-prompt-acknowledgement.js';

/** One input owner for native cards before chat or inside its idle prompt. Lifecycle belongs to its caller. */
export function NativePromptHost({
  ui,
  color,
  inputEnabled,
  onSuspend,
  suspendPort,
  ownsSuspendAttachment = true,
  onRendererReady,
  onRendererError,
  acknowledgement: given,
}: Readonly<{
  ui: NativePromptUi;
  /**
   * The acknowledgement, when the enclosing host holds it (a stand-alone chat shares it with the overlay slot, which draws a prompt a flow set
   * as a popup: ADR-0148 §2). The host then owns its lifetime; absent ⇒ this host makes and disposes its own.
   */
  acknowledgement?: NativePromptAcknowledgement | undefined;
  color: boolean;
  inputEnabled?: () => boolean;
  onSuspend?: () => void;
  suspendPort?: SuspendPort | undefined;
  /** An enclosing live chat already owns the same mount's suspend attachment. */
  ownsSuspendAttachment?: boolean;
  onRendererReady?: (flush: NoticeFlush) => void;
  onRendererError?: (error: Error) => void;
}>): ReactElement {
  const snapshot = useSyncExternalStore(ui.subscribe, ui.getSnapshot);
  const app = useApp();
  const { stdout } = useStdout();
  const getSize = (): { cols: number; rows: number } => ({
    cols: stdout.columns,
    rows: stdout.rows,
  });
  const [size, setSize] = useState(getSize);
  const [acknowledgement] = useState(
    () =>
      given ??
      createNativePromptAcknowledgement(
        ui,
        getSize,
        () =>
          inputEnabled?.() !== false &&
          suspendPort?.isSuspended() !== true &&
          stdout.writable !== false &&
          !stdout.destroyed &&
          !stdout.writableEnded,
      ),
  );
  const owned = given === undefined;
  useEffect(() => {
    // The acknowledgement looks at the new size as it is invalidated: a masked field is emptied before the frame at that size is drawn
    // (ADR-0148 §4: any resize clears a key typed so far). Prepended: the renderer's own listener came first and redraws the tree it has.
    const resized = (): void => {
      acknowledgement.invalidate();
      setSize(getSize());
    };
    stdout.prependListener('resize', resized);
    return () => {
      stdout.removeListener('resize', resized);
      if (owned) acknowledgement.dispose();
    };
  }, [stdout, acknowledgement, owned]);
  useEffect(() => {
    if (suspendPort === undefined || !ownsSuspendAttachment) return;
    suspendPort.attach((callback) => app.suspendTerminal(callback));
    return () => suspendPort.attach(undefined);
  }, [app, suspendPort, ownsSuspendAttachment]);
  // This host's one reader never hears a key's release (`pressesOnly`, as the chat's and the Home's): a terminal left in the kitty protocol's
  // event-type mode reports a release after every press, and the release of the Enter that answered one card would answer the next with its
  // preset (a select's cursor, a confirmation's default), or type a letter twice.
  useInput(
    pressesOnly((input, key) => {
      if (inputEnabled?.() === false) return;
      if (input === '\x1a' || (key.ctrl && !key.meta && input.toLowerCase() === 'z')) {
        onSuspend?.();
        return;
      }
      if (!acknowledgement.inputVisible(input, key)) {
        if (
          key.escape ||
          key.meta ||
          (key.ctrl && input.toLowerCase() === 'c') ||
          input.includes('\x1b') ||
          input.includes('\x03')
        )
          ui.input('\x1b', key);
        else ui.unseenInput(input, key); // not delivered (the card is not visible), but still typing for the chord guard
        return;
      }
      ui.input(input, key);
    }),
  );
  usePaste((text) => {
    if (inputEnabled?.() === false) return;
    if (acknowledgement.pasteVisible()) ui.paste(text);
    else ui.unseenInput();
  });
  const flushVisible = useVisibleRenderFlush(
    onRendererError,
    suspendPort,
    undefined,
    acknowledgement,
  );
  useEffect(() => {
    onRendererReady?.(flushVisible);
  }, [onRendererReady, flushVisible]);
  return (
    <NativePromptView
      snapshot={snapshot}
      color={color}
      acknowledgement={acknowledgement}
      size={size}
    />
  );
}
