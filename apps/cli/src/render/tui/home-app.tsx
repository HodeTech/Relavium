import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';

import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import { ChatView } from './chat-ink.js';
import { sanitizeInline } from './chat-projection.js';
import { applyChatEdit, reduceChatKey } from './chat-input.js';
import type { ChatStoreController } from './chat-store.js';
import { reduceHomeKey } from './home-input.js';
import { HomeView } from './home-view.js';
import { colorProps, dimProps } from './projection.js';

/**
 * The single-ink-tree shell for the bare-invocation Home (2.5.B / ADR-0054): ONE `useInput` owner over a
 * `home | loading | chat` mode machine. The Home strip and the chat region render conditionally in the SAME tree
 * (never two mounted apps), so the raw-mode owner never conflicts. On a Home submit it asks `driveHome` to build
 * a chat session AFTER the mount (an explicit "Starting…" loading state that echoes the pending message); a build
 * failure routes back to Home with a banner; a chat that ends returns to a freshly-read Home. The clock + terminal
 * size are injected so the strip degrade (<80×24) and the relative times are testable.
 *
 * Lifecycle invariants this shell upholds (each closes a reviewed defect):
 * - A turn that throws tears its session down BEFORE propagating, so the spawned MCP child / frame loop / session
 *   row are never orphaned on the error path (`driveHome` itself holds no session handle).
 * - `endChat` is single-shot per session, and its deferred state-reset is skipped once the Home is `exiting`, so a
 *   teardown that completes after the db has closed (an error racing a `/cancel`) cannot read a closed db.
 * - Ctrl-C escapes the `loading` state, so a hung build is never an unkillable hang; and a `startChat` that
 *   resolves after the user has exited reclaims (tears down) the just-built session instead of mounting it.
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
  /** Best-effort, IDEMPOTENT teardown of THIS chat (persister + frame loop + subscription + MCP), never the shared db. */
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
  const { subscribeResize, getSize, onExit, onError } = props;
  const [mode, setMode] = useState<Mode>('home');
  const [snapshot, setSnapshot] = useState<HomeSnapshot>(() => props.homeStore.read());
  const [session, setSession] = useState<HomeChatSession | undefined>();
  const [errorText, setErrorText] = useState<string | undefined>();
  const [pendingMessage, setPendingMessage] = useState('');
  const [size, setSize] = useState(getSize);
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
  // True once the Home is going away — set on BOTH the clean-exit and the error path, so a deferred `endChat`
  // teardown that completes after `driveHome` has closed the shared db skips its state-reset / db-read.
  const exiting = useRef(false);
  // The session currently being torn down — makes `endChat` single-shot so two settled turn promises (a `/cancel`
  // racing the turn it aborts) cannot double-tear-down or clobber a freshly-started session.
  const tearingDown = useRef<HomeChatSession | undefined>(undefined);

  // Re-measure on a terminal resize so the <80×24 degrade (and the strip width) tracks the live size.
  useEffect(() => subscribeResize(() => setSize(getSize())), [subscribeResize, getSize]);

  const exitHome = (): void => {
    if (exiting.current) return; // idempotent — a second Ctrl-C (or a race) must not settle `driveHome` twice
    exiting.current = true;
    onExit();
  };

  const failHome = (err: unknown): void => {
    if (exiting.current) return; // an exit/error already settled `driveHome` — drop this late failure
    exiting.current = true;
    onError(err);
  };

  const endChat = (ended: HomeChatSession): void => {
    if (tearingDown.current === ended) return; // already ending this session (the two-pending-promise race)
    tearingDown.current = ended;
    void ended.teardown().finally(() => {
      tearingDown.current = undefined;
      cancelFired.current = false;
      if (exiting.current) return; // an error/exit closed the db while we awaited teardown — do not read it
      setSession(undefined);
      setInput(() => '');
      setErrorText(undefined); // a stale build-failure banner must not haunt a clean return from a good chat
      setPendingMessage('');
      setSnapshot(props.homeStore.read()); // the just-finished chat now shows in the refreshed strip
      setMode('home');
    });
  };

  // Drive one chat turn from a submitted line; on success end the chat if `/exit`/`/cancel` ran, on an escaping
  // error tear the session down BEFORE propagating so its MCP child / frame loop / row are never orphaned.
  const sendChatLine = (active: HomeChatSession, line: string): void => {
    void active.processLine(line).then(
      () => {
        if (active.shouldStop()) endChat(active);
      },
      (err: unknown) => {
        tearingDown.current = active; // align with endChat's single-shot guard (the session closure is idempotent)
        void active.teardown().finally(() => failHome(err));
      },
    );
  };

  const submitHome = (message: string): void => {
    const trimmed = message.trim();
    setInput(() => '');
    if (trimmed.length === 0) return; // an empty prompt stays on the Home (no chat)
    setErrorText(undefined);
    setPendingMessage(trimmed); // echoed under "Starting chat…" so the typed message never visually vanishes
    setMode('loading');
    void props.startChat().then(
      (built) => {
        if (exiting.current) {
          void built.teardown().catch(() => undefined); // exited mid-build ⇒ reclaim the just-built session
          return;
        }
        setSession(built);
        setMode('chat');
        sendChatLine(built, trimmed); // the first turn streams in the chat region
      },
      (err: unknown) => {
        if (exiting.current) return;
        setErrorText(err instanceof Error ? err.message : String(err));
        setPendingMessage('');
        setMode('home'); // route a build failure back to Home with the banner
      },
    );
  };

  useInput((char, key) => {
    // Chat mode: delegate to the chat reducer (which knows the running state) — Ctrl-C maps to /cancel there.
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
      return; // separate the chat key domain from the Home reducer below (never fall through)
    }

    // Home + loading modes share the Home reducer. Ctrl-C always exits (so a hung build is never unkillable);
    // while loading, every OTHER key is ignored (the session is still building — Step 3 adds an in-build abort).
    const action = reduceHomeKey(char, key);
    if (action.kind === 'exit') {
      exitHome();
      return;
    }
    if (mode === 'loading') return;
    switch (action.kind) {
      case 'submit':
        submitHome(inputRef.current);
        return;
      case 'append':
        setInput((current) => current + action.char);
        return;
      case 'backspace':
        setInput((current) => current.slice(0, -1));
        return;
      case 'none':
        return;
    }
  });

  if (mode === 'chat' && session !== undefined) {
    return <ChatRegion store={session.store} input={input} />;
  }
  if (mode === 'loading') {
    return (
      <Box flexDirection="column">
        <Text {...colorProps(props.color, 'cyan')} wrap="truncate-end">
          {'> '}
          {sanitizeInline(pendingMessage)}
        </Text>
        <Text {...dimProps(props.color)} wrap="truncate-end">
          Starting chat…
        </Text>
      </Box>
    );
  }
  return (
    <HomeView
      snapshot={snapshot}
      input={input}
      errorText={errorText}
      nowMs={props.nowMs()}
      cols={size.cols}
      rows={size.rows}
      color={props.color}
    />
  );
}

export { FRAME_MS };
