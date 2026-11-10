import './force-color.js';
import { cleanup, render } from 'ink-testing-library';
import { useApp } from 'ink';
import { useLayoutEffect, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatView } from './chat-ink.js';
import { emptyEditor } from './chat-input.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { waitFor } from './harness-util.js';
import { RootApp } from './home-app.js';
import { createHomeController } from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND, type TranscriptEntry } from './session-view-model.js';

afterEach(cleanup);

function FlushBarrier(props: Readonly<{ ready: (flush: () => Promise<void>) => void }>): null {
  const app = useApp();
  useLayoutEffect(() => props.ready(() => app.waitUntilRenderFlush()), [app, props.ready]);
  return null;
}

/** Await the installed Ink renderer's real flush instead of guessing scheduler timing. */
function mount(tree: ReactElement) {
  let flush: (() => Promise<void>) | undefined;
  const wrap = (element: ReactElement): ReactElement => (
    <>
      {element}
      <FlushBarrier
        ready={(next) => {
          flush = next;
        }}
      />
    </>
  );
  const capture = render(wrap(tree));
  return {
    output: (): string => capture.lastFrame() ?? '',
    rerender: (element: ReactElement): void => capture.rerender(wrap(element)),
    flush: async (): Promise<void> => {
      await waitFor(() => flush !== undefined);
      if (flush === undefined) throw new Error('Renderer did not mount.');
      await flush();
    },
  };
}

const assistant: TranscriptEntry = {
  role: 'assistant',
  text: '**PAUSEDASSISTANT**',
  summary: { stopReason: 'stop', tokensUsed: { input: 1, output: 1 } },
};
const notice: TranscriptEntry = { role: 'notice', text: 'PAUSEDNOTICE' };

function completeAnswer(store: ChatStoreController): void {
  const base = { sessionId: 'width-session', timestamp: '2026-11-10T00:00:00Z' };
  store.apply({ ...base, sequenceNumber: 1, type: 'session:turn_started' });
  store.apply({
    ...base,
    sequenceNumber: 2,
    type: 'agent:token',
    nodeId: 'chat',
    model: 'test-model',
    token: assistant.text,
  });
  store.apply({
    ...base,
    sequenceNumber: 3,
    type: 'session:turn_completed',
    stopReason: 'stop',
    tokensUsed: { input: 1, output: 1 },
  });
}

describe.each([false, true])('inline transcript suspension (color %s)', (color) => {
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'retains pending entries without reprinting the admitted prefix at width %s',
    async (columns) => {
      const store = createChatStore(color, undefined, INLINE_TRANSCRIPT_BOUND);
      store.notice('OLDSHOWN');
      const initial = store.getSnapshot().state;
      const pending = { ...initial, transcript: [...initial.transcript, assistant, notice] };
      const view = (width: number, state = initial) => (
        <ChatView
          state={state}
          columns={width}
          color={color}
          tick={0}
          nowMs={0}
          editor={emptyEditor()}
          running={false}
          mode="ask"
          reasoningVisible={false}
        />
      );
      const capture = mount(view(80));
      const output = capture.output;
      await capture.flush();
      expect(output().split('OLDSHOWN')).toHaveLength(2);
      capture.rerender(view(columns));
      await capture.flush();
      capture.rerender(view(columns, pending));
      await capture.flush();
      expect(output()).not.toContain('PAUSEDASSISTANT');
      expect(output()).not.toContain('PAUSEDNOTICE');
      capture.rerender(view(80, pending));
      await capture.flush();
      expect(output().split('OLDSHOWN')).toHaveLength(2);
      expect(output().split('PAUSEDASSISTANT')).toHaveLength(2);
      expect(output().split('PAUSEDNOTICE')).toHaveLength(2);
      capture.rerender(view(80, pending));
      await capture.flush();
      expect(output().split('PAUSEDNOTICE')).toHaveLength(2);
    },
  );

  it('recovers actual Home chat answers, user echoes and notices after a zero-width resize', async () => {
    const store = createChatStore(color, undefined, INLINE_TRANSCRIPT_BOUND);
    store.notice('OLDSHOWN');
    const controller = createHomeController({
      startChat: () =>
        Promise.resolve({
          store,
          sessionId: 'width-session',
          processLine: () => Promise.resolve(),
          shouldStop: () => false,
          stopReason: () => 'exit',
          teardown: () => Promise.resolve(),
        }),
      homeStore: {
        read: () => ({
          attention: { gates: [], failedRuns: [] },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: [],
          isEmpty: true,
        }),
      },
      doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
      onExit: () => {},
      onError: () => {
        throw new Error('Unexpected Home controller failure.');
      },
    });
    let size = { cols: 80, rows: 24 };
    let resize = (): void => {};
    const capture = mount(
      <RootApp
        controller={controller}
        color={color}
        nowMs={() => 0}
        getSize={() => size}
        subscribeResize={(listener) => {
          resize = listener;
          return () => {};
        }}
      />,
    );
    const output = capture.output;
    await capture.flush();
    controller.handleKey('hi', {});
    controller.handleKey('', { return: true });
    await capture.flush();
    expect(controller.getSnapshot().mode).toBe('chat');
    size = { cols: 0, rows: 24 };
    resize();
    await capture.flush();
    store.appendUser('PAUSEDUSER');
    completeAnswer(store);
    store.notice(notice.text);
    await capture.flush();
    expect(output()).not.toContain('PAUSEDNOTICE');
    size = { cols: 80, rows: 24 };
    resize();
    await capture.flush();
    for (const text of ['OLDSHOWN', 'PAUSEDUSER', 'PAUSEDASSISTANT', 'PAUSEDNOTICE'])
      expect(output().split(text)).toHaveLength(2);
  });
});
