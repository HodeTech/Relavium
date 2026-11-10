import { useApp, useInput, usePaste } from 'ink';
import type { SuspendPort } from '../suspend.js';
import { useEffect, useSyncExternalStore, type ReactElement } from 'react';
import type { NoticeFlush } from '../../engine/effect-retention.js';
import { useVisibleRenderFlush } from './render-acknowledgement.js';
import type { NativePromptUi } from './native-prompt-channel.js';
import { NativePromptView } from './native-prompt-view.js';

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
    ui.input(input, key);
  });
  usePaste((text) => {
    if (inputEnabled?.() !== false) ui.paste(text);
  });
  const flushVisible = useVisibleRenderFlush(onRendererError, suspendPort);
  useEffect(() => {
    onRendererReady?.(flushVisible);
  }, [onRendererReady, flushVisible]);
  return <NativePromptView snapshot={snapshot} color={color} />;
}
