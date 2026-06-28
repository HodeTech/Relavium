import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';

import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import { ChatView } from './chat-ink.js';
import { applyChatEdit, reduceChatKey } from './chat-input.js';
import type { ChatStoreController } from './chat-store.js';
import { colorProps, dimProps } from './projection.js';
import { HomeView } from './home-view.js';

/**
 * The single-ink-tree shell for the bare-invocation Home (2.5.B / ADR-0054): ONE `useInput` owner over a
 * `home | loading | chat` mode machine. The Home strip and the chat region render conditionally in the SAME tree
 * (never two mounted apps), so the raw-mode owner never conflicts. On a Home submit it asks `driveHome` to build
 * a chat session AFTER the mount (an explicit "Starting…" loading state); a build failure routes back to Home
 * with a banner; a chat that ends returns to a freshly-read Home. The clock + terminal size are injected so the
 * strip degrade (<80×24) and the relative times are testable.
 */

const FRAME_MS = 80;

/** The chat session the Home builds + drives on a submit — the imperative pieces `driveHome` wires + tears down. */
export interface HomeChatSession {
  /** The chat view store the {@link ChatView} projects (already subscribed to the live stream by `driveHome`). */
  readonly store: ChatStoreController;
  /** Handle one line (a slash command or a message) — the shared `createChatLineHandler` semantics. */
  readonly processLine: (line: string) => Promise<void>;
  /** `true` once `/exit` or `/cancel` has run — the chat ends and the Home returns. */
  readonly shouldStop: () => boolean;
  /** Best-effort teardown of THIS chat (persister + frame loop + subscription + MCP), never the shared db. */
  readonly teardown: () => Promise<void>;
}

export interface RootAppProps {
  readonly homeStore: HomeStore;
  /** Build + wire + START a fresh chat session (no first message — the Home sends it on transition). May reject. */
  readonly startChat: () => Promise<HomeChatSession>;
  readonly nowMs: () => number;
  readonly color: boolean;
  readonly getSize: () => { cols: number; rows: number };
  /** Subscribe to terminal resizes; returns an unsubscribe. */
  readonly subscribeResize: (onResize: () => void) => () => void;
  /** The Home exited cleanly (Ctrl-C / EOF in Home mode) → `driveHome` resolves with exit 0. */
  readonly onExit: () => void;
  /** An unexpected error escaping a chat turn (a re-thrown turn-core bug) — `driveHome` tears down + propagates. */
  readonly onError: (err: unknown) => void;
}

type Mode = 'home' | 'loading' | 'chat';

/** The chat region: subscribes to the chat store (re-render on stream events) and renders the pure {@link ChatView}.
 *  It owns NO `useInput` — {@link RootApp} is the single raw-mode owner and dispatches keys to `processLine`. */
function ChatRegion(props: Readonly<{ store: ChatStoreController; input: string }>): ReactElement {
  const { state, tick, color } = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
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
  const [mode, setMode] = useState<Mode>('home');
  const [snapshot, setSnapshot] = useState<HomeSnapshot>(() => props.homeStore.read());
  const [session, setSession] = useState<HomeChatSession | undefined>();
  const [errorText, setErrorText] = useState<string | undefined>();
  const [size, setSize] = useState(props.getSize);
  // The prompt buffer with a ref shadow (see ChatApp): a coalesced stdin chunk dispatches synchronously with no
  // render flush, so reading `inputRef.current` keeps edits + a same-chunk submit on the latest committed value.
  const [input, setInputState] = useState('');
  const inputRef = useRef('');
  const setInput = (next: (current: string) => string): void => {
    setInputState((prev) => {
      const value = next(prev);
      inputRef.current = value;
      return value;
    });
  };
  const cancelFired = useRef(false);

  // Re-measure on a terminal resize so the <80×24 degrade (and the strip width) tracks the live size.
  useEffect(() => props.subscribeResize(() => setSize(props.getSize())), [props]);

  const endChat = (ended: HomeChatSession): void => {
    void ended.teardown().finally(() => {
      cancelFired.current = false;
      setSession(undefined);
      setInput(() => '');
      setSnapshot(props.homeStore.read()); // the just-finished chat now shows in the refreshed strip
      setMode('home');
    });
  };

  // Drive one chat turn from a submitted line; when it settles, end the chat if `/exit`/`/cancel` ran.
  const sendChatLine = (active: HomeChatSession, line: string): void => {
    void active.processLine(line).then(() => {
      if (active.shouldStop()) endChat(active);
    }, props.onError);
  };

  const submitHome = (message: string): void => {
    const trimmed = message.trim();
    setInput(() => '');
    if (trimmed.length === 0) return; // an empty prompt stays on the Home (no chat)
    setErrorText(undefined);
    setMode('loading');
    void props.startChat().then(
      (built) => {
        setSession(built);
        setMode('chat');
        sendChatLine(built, trimmed); // the first turn streams in the chat region
      },
      (err: unknown) => {
        setErrorText(err instanceof Error ? err.message : String(err));
        setMode('home'); // route a build failure back to Home with the banner
      },
    );
  };

  useInput((char, key) => {
    if (mode === 'loading') return; // ignore typing while the session builds (Step 3 adds an abort)

    if (mode === 'chat' && session !== undefined) {
      const running = session.store.getSnapshot().state.status === 'running';
      const action = reduceChatKey(char, key, inputRef.current, running);
      switch (action.kind) {
        case 'cancel':
          if (!cancelFired.current) {
            cancelFired.current = true;
            sendChatLine(session, '/cancel'); // /cancel ends the (resumable) session → back to Home
          }
          return;
        case 'append':
        case 'backspace':
          setInput((current) => applyChatEdit(current, action));
          return;
        case 'submit':
          setInput(() => '');
          sendChatLine(session, action.line);
          return;
        case 'none':
          return;
      }
    }

    // Home mode: Ctrl-C exits the Home (clean → exit 0); Return starts a chat; else edit the prompt buffer.
    if (key.ctrl && char === 'c') {
      props.onExit();
      return;
    }
    if (key.return) {
      submitHome(inputRef.current);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (char.length > 0 && !key.ctrl && !key.meta) {
      setInput((current) => current + char);
    }
  });

  if (mode === 'chat' && session !== undefined) {
    return <ChatRegion store={session.store} input={input} />;
  }
  return (
    <Box flexDirection="column">
      {errorText !== undefined && (
        <Box marginBottom={1}>
          <Text {...colorProps(props.color, 'red')} wrap="truncate-end">
            couldn’t start the chat: {errorText}
          </Text>
        </Box>
      )}
      {mode === 'loading' ? (
        <Text {...dimProps(props.color)}>Starting chat…</Text>
      ) : (
        <HomeView
          snapshot={snapshot}
          input={input}
          nowMs={props.nowMs()}
          cols={size.cols}
          rows={size.rows}
          color={props.color}
        />
      )}
    </Box>
  );
}

export { FRAME_MS };
