import { Box, Text, useInput } from 'ink';
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';

import { ChatView } from './chat-ink.js';
import { sanitizeInline } from './chat-projection.js';
import type { ChatStoreController } from './chat-store.js';
import type { HomeController } from './home-controller.js';
import { HomeView } from './home-view.js';
import { colorProps, dimProps } from './projection.js';

/**
 * The single-ink-tree shell for the bare-invocation Home (2.5.B / ADR-0054): ONE `useInput` owner over a
 * `home | loading | chat` mode machine. The session state machine lives in {@link HomeController} (a plain
 * external store, unit-tested without ink); `RootApp` is a thin view that subscribes to it, forwards every key to
 * `controller.handleKey`, and renders the Home strip, the loading echo, or the chat region from the published
 * state. The clock + terminal size are injected so the strip degrade (<80×24) and the relative times are testable.
 */

export type { HomeChatSession } from './home-controller.js';

export interface RootAppProps {
  readonly controller: HomeController;
  readonly nowMs: () => number;
  readonly color: boolean;
  readonly getSize: () => { cols: number; rows: number };
  /** Subscribe to terminal resizes; returns an unsubscribe. */
  readonly subscribeResize: (onResize: () => void) => () => void;
}

/** The chat region: subscribes to the chat store (re-render on stream events) and renders the pure {@link ChatView}.
 *  It owns NO `useInput` — {@link RootApp} is the single raw-mode owner and forwards keys to the controller. */
function ChatRegion(props: Readonly<{ store: ChatStoreController; input: string }>): ReactElement {
  const { state, tick, color } = useSyncExternalStore(
    props.store.subscribe,
    props.store.getSnapshot,
  );
  return (
    <ChatView
      state={state}
      tick={tick}
      color={color}
      input={props.input}
      running={state.status === 'running'}
    />
  );
}

export function RootApp(props: Readonly<RootAppProps>): ReactElement {
  const { controller, getSize, subscribeResize, color } = props;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [size, setSize] = useState(getSize);

  // Re-measure on a terminal resize so the <80×24 degrade (and the strip width) tracks the live size.
  useEffect(() => subscribeResize(() => setSize(getSize())), [subscribeResize, getSize]);

  useInput((input, key) => controller.handleKey(input, key));

  if (state.mode === 'chat' && state.session !== undefined) {
    return <ChatRegion store={state.session.store} input={state.input} />;
  }
  if (state.mode === 'loading') {
    return (
      <Box flexDirection="column">
        <Text {...colorProps(color, 'cyan')} wrap="truncate-end">
          {'> '}
          {sanitizeInline(state.pendingMessage)}
        </Text>
        <Text {...dimProps(color)} wrap="truncate-end">
          Starting chat… · Ctrl-C to cancel
        </Text>
      </Box>
    );
  }
  return (
    <HomeView
      snapshot={state.snapshot}
      input={state.input}
      errorText={state.errorText}
      nowMs={props.nowMs()}
      cols={size.cols}
      rows={size.rows}
      color={color}
    />
  );
}
