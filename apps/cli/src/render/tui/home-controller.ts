import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import { applyChatEdit, reduceChatKey, type ChatKey } from './chat-input.js';
import type { ChatStoreController } from './chat-store.js';
import { isPasteEnd, isPasteStart, reduceHomeKey, type HomeKey } from './home-input.js';

/**
 * The Home session state machine, extracted from the ink view as a plain external store (2.5.B / ADR-0054) so the
 * lifecycle — submit → build → chat → end, the build/turn error paths, the exit/close-race guards, and bracketed
 * paste — is unit-testable WITHOUT mounting ink (the repo does not render-test ink). `RootApp` is a thin view that
 * `useSyncExternalStore`s this controller and forwards the single `useInput` to {@link HomeController.handleKey};
 * `driveHome` owns the process lifetime and calls {@link HomeController.teardownActive} from its signal handler so
 * an external SIGINT/SIGTERM reaps a live chat's MCP child + frame loop before the process exits.
 *
 * The prompt buffer lives HERE as a plain field mutated synchronously inside `handleKey`, so a coalesced stdin
 * chunk (ink dispatches every parsed event from one chunk back-to-back) keeps every edit + a same-chunk submit on
 * the latest value with no React-batching race — the ref-shadow the inline view needed is gone.
 */

/** The chat session the Home builds + drives on a submit — the imperative pieces `driveHome` wires + tears down. */
export interface HomeChatSession {
  /** The chat view store the chat region projects (already subscribed to the live stream by `driveHome`). */
  readonly store: ChatStoreController;
  /** Handle one line (a slash command or a message) — the shared `createChatLineHandler` semantics. */
  readonly processLine: (line: string) => Promise<void>;
  /** `true` once `/exit` or `/cancel` has run — the chat ends and the Home returns. */
  readonly shouldStop: () => boolean;
  /** Best-effort, IDEMPOTENT teardown of THIS chat (persister + frame loop + subscription + MCP), never the shared db. */
  readonly teardown: () => Promise<void>;
}

export type HomeMode = 'home' | 'loading' | 'chat';

/** The immutable view state the {@link HomeController} publishes to `RootApp` (a new object per change). */
export interface HomeControllerState {
  readonly mode: HomeMode;
  readonly snapshot: HomeSnapshot;
  readonly errorText: string | undefined;
  readonly pendingMessage: string;
  readonly input: string;
  readonly session: HomeChatSession | undefined;
}

export interface HomeControllerDeps {
  /** Build + wire + START a fresh chat session (no first message — the controller sends it on transition). May reject. */
  readonly startChat: () => Promise<HomeChatSession>;
  readonly homeStore: HomeStore;
  /** The Home exited cleanly (Ctrl-C / EOF in Home mode) → `driveHome` resolves with exit 0. */
  readonly onExit: () => void;
  /** An unexpected error escaping a chat turn (a re-thrown turn-core bug) — `driveHome` tears down + propagates. */
  readonly onError: (err: unknown) => void;
}

export interface HomeController {
  // Declared as function PROPERTIES (not methods) so a `useSyncExternalStore(c.subscribe, c.getSnapshot)`
  // unbound reference is sound (no `this`) — matching the chat store's read surface.
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => HomeControllerState;
  /** Dispatch one `useInput` event (the single raw-mode owner forwards every key here). */
  readonly handleKey: (input: string, key: HomeKey & ChatKey) => void;
  /** Tear down a live chat session (if any), for the signal handler — idempotent, never the shared db. */
  readonly teardownActive: () => Promise<void>;
}

export function createHomeController(deps: HomeControllerDeps): HomeController {
  const listeners = new Set<() => void>();
  let state: HomeControllerState = {
    mode: 'home',
    snapshot: deps.homeStore.read(),
    errorText: undefined,
    pendingMessage: '',
    input: '',
    session: undefined,
  };
  let cancelFired = false;
  let exiting = false; // set on the clean-exit / error / signal paths — guards deferred reads of a closed db
  let tearingDown: HomeChatSession | undefined;
  let pasting = false; // inside a bracketed paste (DECSET 2004) — content is buffered literally, never submitted
  let buildInFlight: Promise<HomeChatSession> | undefined; // a `loading`-state build, so a signal can reap it

  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  /** Whether a chat turn is streaming — paste content (like every other key) is gated mid-turn. */
  const chatRunning = (): boolean =>
    state.mode === 'chat' &&
    state.session !== undefined &&
    state.session.store.getSnapshot().state.status === 'running';
  const set = (patch: Partial<HomeControllerState>): void => {
    state = { ...state, ...patch };
    notify();
  };

  const exitHome = (): void => {
    if (exiting) return; // idempotent — a second Ctrl-C (or a race) must not settle `driveHome` twice
    exiting = true;
    deps.onExit();
  };

  const failHome = (err: unknown): void => {
    if (exiting) return; // an exit/error already settled `driveHome` — drop this late failure
    exiting = true;
    deps.onError(err);
  };

  const endChat = (ended: HomeChatSession): void => {
    if (tearingDown === ended) return; // already ending this session (the two-pending-promise race)
    tearingDown = ended;
    void ended.teardown().finally(() => {
      tearingDown = undefined;
      cancelFired = false;
      if (exiting) return; // an error/exit closed the db while we awaited teardown — do not read it
      set({
        session: undefined,
        input: '',
        errorText: undefined, // a stale build-failure banner must not haunt a clean return from a good chat
        pendingMessage: '',
        snapshot: deps.homeStore.read(), // the just-finished chat now shows in the refreshed strip
        mode: 'home',
      });
    });
  };

  // Drive one chat turn; on success end the chat if `/exit`/`/cancel` ran, on an escaping error tear the session
  // down BEFORE propagating so its MCP child / frame loop / row are never orphaned.
  const sendChatLine = (active: HomeChatSession, line: string): void => {
    void active.processLine(line).then(
      () => {
        if (active.shouldStop()) endChat(active);
      },
      (err: unknown) => {
        tearingDown = active; // align with endChat's single-shot guard (the session closure is idempotent)
        void active.teardown().finally(() => {
          tearingDown = undefined; // clear for symmetry with endChat (failHome is terminal, but stay consistent)
          failHome(err);
        });
      },
    );
  };

  const submit = (): void => {
    const trimmed = state.input.trim();
    if (trimmed.length === 0) {
      set({ input: '' }); // an empty prompt stays on the Home (no chat)
      return;
    }
    set({ input: '', errorText: undefined, pendingMessage: trimmed, mode: 'loading' });
    // Track the in-flight build so a signal (or a mid-build exit) during `loading` can reclaim its just-spawned
    // session — its MCP child / frame loop — rather than orphan it (see teardownActive).
    const build = deps.startChat();
    buildInFlight = build;
    void build.then(
      (built) => {
        if (buildInFlight === build) buildInFlight = undefined;
        if (exiting) {
          void built.teardown().catch(() => undefined); // exited mid-build ⇒ reclaim the just-built session
          return;
        }
        set({ session: built, mode: 'chat' });
        sendChatLine(built, trimmed); // the first turn streams in the chat region
      },
      (err: unknown) => {
        if (buildInFlight === build) buildInFlight = undefined;
        if (exiting) return;
        set({
          errorText: err instanceof Error ? err.message : String(err),
          pendingMessage: '',
          mode: 'home', // route a build failure back to Home with the banner
        });
      },
    );
  };

  const handleChatKey = (active: HomeChatSession, input: string, key: ChatKey): void => {
    if (tearingDown === active) return; // a key arriving mid-teardown must not drive sendMessage on a cancelled session
    const running = active.store.getSnapshot().state.status === 'running';
    const action = reduceChatKey(input, key, state.input, running);
    switch (action.kind) {
      case 'cancel':
        if (!cancelFired) {
          cancelFired = true;
          sendChatLine(active, '/cancel'); // /cancel ends the (resumable) session → back to Home
        }
        return;
      case 'append':
      case 'backspace':
        set({ input: applyChatEdit(state.input, action) });
        return;
      case 'submit':
        set({ input: '' });
        sendChatLine(active, action.line);
        return;
      case 'none':
        return;
    }
  };

  const handleHomeKey = (input: string, key: HomeKey): void => {
    const action = reduceHomeKey(input, key);
    if (action.kind === 'exit') {
      exitHome();
      return;
    }
    if (state.mode === 'loading') return; // ignore edits/submit while a session builds (Ctrl-C above still bails)
    switch (action.kind) {
      case 'submit':
        submit();
        return;
      case 'append':
        set({ input: state.input + action.char });
        return;
      case 'backspace':
        set({ input: state.input.slice(0, -1) });
        return;
      case 'none':
        return;
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return state;
    },
    handleKey(input, key) {
      // Bracketed paste (DECSET 2004): the markers bound a literal block, so a pasted multi-line YAML appends
      // verbatim (newlines kept) instead of an embedded newline submitting early. The markers themselves never
      // reach the buffer; content between them is appended literally with no key interpretation.
      if (isPasteStart(input)) {
        pasting = true;
        return;
      }
      if (isPasteEnd(input)) {
        pasting = false;
        return;
      }
      if (pasting) {
        // Escape hatch: Ctrl-C ALWAYS breaks out (a lost paste-end marker must never trap the user with no way
        // to exit/submit) — clear the latch and fall through to the normal dispatch (Home → exit, chat → /cancel).
        if (!(key.ctrl === true && input === 'c')) {
          // Literal content. Drop it mid-turn to match the keystroke gate (type-ahead is deferred, 2.5.B); else
          // append verbatim so a multi-line block keeps its newlines and never submits early.
          if (input.length > 0 && !chatRunning()) set({ input: state.input + input });
          return;
        }
        pasting = false;
      }
      if (state.mode === 'chat' && state.session !== undefined) {
        handleChatKey(state.session, input, key);
        return;
      }
      handleHomeKey(input, key);
    },
    async teardownActive() {
      exiting = true; // terminating: a deferred endChat skips the (about-to-close) db; an in-flight build reclaims itself
      const active = state.session;
      if (active !== undefined && tearingDown !== active) {
        tearingDown = active; // idempotent vs a concurrent endChat (the session closure is itself idempotent)
        await active.teardown().catch(() => undefined);
        return;
      }
      // No live session yet — a signal during the `loading` build window. Await + reap the in-flight build so its
      // spawned MCP child / frame loop is never orphaned (bounded by driveHome's force-teardown race). submit's
      // exiting-arm may also reap it once it resolves; both call the SAME idempotent teardown, so the overlap is
      // harmless — awaiting here guarantees the reap completes within the bound.
      const pending = buildInFlight;
      if (pending !== undefined) {
        const built = await pending.catch(() => undefined);
        if (built !== undefined) await built.teardown().catch(() => undefined);
      }
    },
  };
}
