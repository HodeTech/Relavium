import { useApp, useInput, usePaste, useStdout } from 'ink';
import type { SuspendPort } from '../suspend.js';
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import type { NoticeFlush } from '../../engine/effect-retention.js';
import { useVisibleRenderFlush } from './render-acknowledgement.js';
import type { NativePromptUi } from './native-prompt-channel.js';
import { NativePromptView } from './native-prompt-view.js';
import { createNativePromptAcknowledgement } from './native-prompt-acknowledgement.js';

/** One input owner for setup before standalone chat mounts. Native lifecycle belongs to its caller. */
export function NativePromptHost({
  ui,
  color,
  inputEnabled,
  onSuspend,
  suspendPort,
  onRendererReady,
  onRendererError,
}: Readonly<{
  ui: NativePromptUi;
  color: boolean;
  inputEnabled?: () => boolean;
  onSuspend?: () => void;
  suspendPort?: SuspendPort | undefined;
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
  const [acknowledgement] = useState(() =>
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
  useEffect(() => {
    const resized = (): void => {
      acknowledgement.invalidate();
      setSize(getSize());
    };
    stdout.on('resize', resized);
    return () => {
      stdout.removeListener('resize', resized);
      acknowledgement.dispose();
    };
  }, [stdout, acknowledgement]);
  useEffect(() => {
    if (suspendPort === undefined) return;
    suspendPort.attach((callback) => app.suspendTerminal(callback));
    return () => suspendPort.attach(undefined);
  }, [app, suspendPort]);
  useInput((input, key) => {
    if (inputEnabled?.() === false) return;
    if (input === '\x1a' || (key.ctrl && !key.meta && input.toLowerCase() === 'z')) {
      onSuspend?.();
      return;
    }
    if (!acknowledgement.inputVisible()) {
      if (
        key.escape ||
        key.meta ||
        (key.ctrl && input.toLowerCase() === 'c') ||
        input.includes('\x1b') ||
        input.includes('\x03')
      )
        ui.input('\x1b', key);
      return;
    }
    ui.input(input, key);
  });
  usePaste((text) => {
    if (inputEnabled?.() !== false && acknowledgement.inputVisible()) ui.paste(text);
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
