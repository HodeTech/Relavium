import type { ReactElement } from 'react';
import { useStdout } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import type { ModelCatalogEntry } from '@relavium/llm';
import { afterEach, expect, it } from 'vitest';
import type { ChatModelsPort } from '../../commands/chat.js';
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

/**
 * A stand-alone chat's model picker, on a model whose provider has no key (MVP-11 Step 2.4, N7): the row and the hint name the provider the
 * way a person reads it (`Anthropic`, not `anthropic`), and the remedy is the one this surface has: it has neither `/providers` nor a shell
 * command to offer, and opens provider setup when it starts, so it says to start it again.
 */
const KEYLESS_ENTRY: ModelCatalogEntry = {
  modelId: 'claude-haiku-4-5',
  displayName: 'Claude Haiku 4.5',
  provider: 'anthropic',
  pricingSource: 'catalog',
  priceKnown: true,
  available: false,
  unavailableReason: 'no-key',
  deprecated: false,
};

it('names the provider by its display name in the row and in the hint, with the remedy this chat has', async () => {
  const modelPicker: ChatModelsPort = {
    boundModel: 'offline-model',
    load: () => ({ entries: [KEYLESS_ENTRY], refreshedAt: undefined }),
    refresh: () => Promise.resolve({ providers: [] }),
    refreshIfStale: () => Promise.resolve(undefined),
  };
  const view = render(
    <WritableCapture>
      <ChatApp
        store={createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND)}
        onSubmit={async () => {}}
        shouldStop={() => false}
        onExit={() => {}}
        onError={() => {}}
        onModeChange={() => {}}
        modelPicker={modelPicker}
      />
    </WritableCapture>,
  );
  view.stdin.write('/models');
  view.stdin.write('\r');
  await waitFor(() => view.lastFrame()?.includes('Claude Haiku 4.5') === true);
  expect(view.lastFrame()).toContain('no key for Anthropic');
  expect(view.lastFrame()).not.toContain('no key for anthropic');
  view.stdin.write('\r'); // the dimmed row cannot be chosen: its hint says why
  await waitFor(() => view.lastFrame()?.includes('restart this chat') === true);
  const frame = view.lastFrame() ?? '';
  expect(frame).toContain(
    'Claude Haiku 4.5: no key for Anthropic — restart this chat to open provider setup',
  );
  expect(frame).not.toContain('set-key');
  expect(frame).not.toContain('relavium');
});
