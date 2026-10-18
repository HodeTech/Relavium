import type { ReactElement } from 'react';
import { useStdout } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatModelsPort } from '../../commands/chat.js';
import type { RefreshReport } from '../../engine/model-refresh.js';
import { ChatApp } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { waitFor } from './harness-util.js';

function WritableCapture(props: { readonly children: ReactElement }): ReactElement {
  const { stdout } = useStdout();
  Object.defineProperty(stdout, 'writable', { value: true });
  return props.children;
}
afterEach(cleanup);

it('does not publish a picker refresh refusal after chat input admission seals', async () => {
  let rejectRefresh: (cause: Error) => void = () => undefined;
  const pending = new Promise<RefreshReport>((_resolve, reject) => {
    rejectRefresh = reject;
  });
  const load = vi.fn(() => ({ entries: [], refreshedAt: undefined }));
  const modelPicker: ChatModelsPort = {
    boundModel: 'offline-model',
    load,
    refresh: () => pending,
    refreshIfStale: () => pending,
  };
  let admitted = true;
  const view = render(
    <WritableCapture>
      <ChatApp
        store={createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND)}
        onSubmit={async () => {}}
        shouldStop={() => false}
        onExit={() => {}}
        onError={() => {}}
        onModeChange={() => {}}
        inputEnabled={() => admitted}
        modelPicker={modelPicker}
      />
    </WritableCapture>,
  );
  view.stdin.write('/models');
  view.stdin.write('\r');
  await waitFor(() => view.lastFrame()?.includes('refreshing') === true);
  expect(load, 'PICKER_REFRESH_ACTUALLY_ENTERED').toHaveBeenCalledOnce();
  expect(view.lastFrame()).toContain('refreshing');
  admitted = false;
  const frames = view.frames.length;
  rejectRefresh(new Error('owner stopped'));
  await waitFor(() => view.frames.length !== frames, 20);
  expect(view.frames.length, 'CHAT_REFRESH_REFUSAL_AFTER_SEAL').toBe(frames);
  expect(view.lastFrame()).toContain('refreshing');
});
