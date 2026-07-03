import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ChatMode } from '../../chat/chat-mode.js';
import type { DoctorProbes } from '../../chat/doctor.js';
import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
} from './home-controller.js';

// The paste-boundary markers exactly as ink 6.8's input layer surfaces them (the leading ESC is stripped).
const PASTE_START = '[200~';
const PASTE_END = '[201~';

/** A no-op `/doctor` probe set — the fast-tier probes never throw, so a `/doctor` run reports all-ok. The
 *  `/doctor`-behavior tests below override individual probes; the rest just need a value for the required dep. */
const STUB_DOCTOR_PROBES: DoctorProbes = {
  keychain: () => {},
  config: () => {},
  toolHost: {},
};

/** A real chat store whose snapshot reports `running` — the controller reads `getSnapshot().state.status`. Built
 *  by overriding the live snapshot's status, so it satisfies {@link ChatStoreController} with no unsafe cast. */
const runningStore = (): ChatStoreController => {
  const store = createChatStore(false);
  const snapshot = store.getSnapshot();
  return {
    ...store,
    getSnapshot: () => ({ ...snapshot, state: { ...snapshot.state, status: 'running' } }),
  };
};

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  isEmpty: true,
};

/** A controllable {@link HomeChatSession} fake: records the lines it processes, exposes a teardown spy, and lets a
 *  test script `shouldStop` (the /exit·/cancel signal) and the turn outcome (resolve vs reject). */
function makeSession(
  opts: {
    onProcess?: () => Promise<void>;
    stop?: () => boolean;
    running?: boolean;
    store?: ReturnType<typeof createChatStore>;
    onAbort?: () => void;
    onModeChange?: (mode: ChatMode) => void;
  } = {},
): {
  session: HomeChatSession;
  teardown: ReturnType<typeof vi.fn>;
  lines: string[];
  store: ReturnType<typeof createChatStore>;
} {
  const lines: string[] = [];
  const teardown = vi.fn(() => Promise.resolve());
  // A custom store wins; else running ⇒ a status-running store, idle ⇒ a fresh one (the running-gate is false).
  const store = opts.store ?? (opts.running === true ? runningStore() : createChatStore(false));
  const session: HomeChatSession = {
    store,
    processLine: async (line) => {
      lines.push(line);
      if (opts.onProcess) await opts.onProcess();
    },
    shouldStop: opts.stop ?? (() => false),
    ...(opts.onAbort === undefined ? {} : { onAbort: opts.onAbort }),
    ...(opts.onModeChange === undefined ? {} : { onModeChange: opts.onModeChange }),
    teardown,
  };
  return { session, teardown, lines, store };
}

/** Flush the microtask + macrotask queue so the controller's async `startChat`/`processLine` chains settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Type a string into the controller one printable char at a time (each its own `useInput` event). */
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};
const ENTER = { return: true } as const;
const CTRL_C = { ctrl: true } as const;

describe('createHomeController (2.5.B lifecycle / ADR-0054)', () => {
  let homeStore: HomeStore;
  let reads: number;

  beforeEach(() => {
    reads = 0;
    homeStore = {
      read: () => {
        reads += 1;
        return EMPTY;
      },
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('types into the buffer and reflects it in the snapshot', () => {
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    // Assert the WHOLE EditorState (not just .text) so the Home surface's cursor migration is covered too — the
    // cursor tracks the end of the buffer in step 1 (the readline motions that move it off the end land in step 2).
    expect(c.getSnapshot().input).toEqual({ text: 'hi', cursor: 2 });
    c.handleKey('', { backspace: true });
    expect(c.getSnapshot().input).toEqual({ text: 'h', cursor: 1 });
  });

  it('the Home prompt is a first-class line editor: motions / newline / kill via handleKey (2.5.D step 2)', () => {
    // Exercise the shared editor through the CONTROLLER (handleHomeKey → applyEditorAction), not just the reducer,
    // so a dropped case in the grouped edit arm would fail here (ink surfaces have no render-test backstop).
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'abcd');
    c.handleKey('', { leftArrow: true }); // Left: 4 → 3
    c.handleKey('', { leftArrow: true }); // → 2
    expect(c.getSnapshot().input).toEqual({ text: 'abcd', cursor: 2 });
    c.handleKey('X', {}); // insert AT the cursor (mid-buffer), not append-at-end
    expect(c.getSnapshot().input).toEqual({ text: 'abXcd', cursor: 3 });
    c.handleKey('\n', {}); // Ctrl+J: a newline at the cursor
    expect(c.getSnapshot().input).toEqual({ text: 'abX\ncd', cursor: 4 });
    c.handleKey('k', { ctrl: true }); // Ctrl+K: kill to the end of the line (deletes 'cd')
    expect(c.getSnapshot().input).toEqual({ text: 'abX\n', cursor: 4 });
  });

  it('a non-empty submit builds a chat, transitions loading→chat, and sends the first message', async () => {
    const made = makeSession();
    const startChat = vi.fn(() => Promise.resolve(made.session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    type(c, 'hello');
    c.handleKey('', ENTER);
    expect(c.getSnapshot().mode).toBe('loading');
    expect(c.getSnapshot().pendingMessage).toBe('hello'); // echoed under "Starting chat…"
    expect(c.getSnapshot().input.text).toBe(''); // the buffer clears on submit

    await flush();
    expect(startChat).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().mode).toBe('chat');
    expect(made.lines).toEqual(['hello']); // the first turn streams in the chat region
  });

  it('an empty / whitespace submit stays on the Home and never builds a chat', () => {
    const startChat = vi.fn();
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, '   ');
    c.handleKey('', ENTER);
    expect(startChat).not.toHaveBeenCalled();
    expect(c.getSnapshot().mode).toBe('home');
    expect(c.getSnapshot().input.text).toBe('');
  });

  it('a build failure routes back to Home with the banner (no session)', async () => {
    const startChat = vi.fn(() => Promise.reject(new Error('no API key for provider')));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();
    expect(c.getSnapshot().mode).toBe('home');
    expect(c.getSnapshot().errorText).toBe('no API key for provider');
    expect(c.getSnapshot().session).toBeUndefined();
  });

  it('a turn that throws tears the session down BEFORE propagating onError (never orphans it)', async () => {
    const made = makeSession({ onProcess: () => Promise.reject(new Error('turn-core bug')) });
    const onError = vi.fn();
    const startChat = vi.fn(() => Promise.resolve(made.session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError,
    });

    type(c, 'go');
    c.handleKey('', ENTER);
    await flush();

    expect(made.teardown).toHaveBeenCalledTimes(1); // torn down on the error path
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('turn-core bug');
  });

  it('a turn that ends the session (/exit·/cancel) returns to a freshly-read Home', async () => {
    const made = makeSession({ stop: () => true }); // shouldStop ⇒ the turn ended the session
    const startChat = vi.fn(() => Promise.resolve(made.session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    type(c, 'bye');
    c.handleKey('', ENTER);
    await flush();

    expect(made.teardown).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().mode).toBe('home');
    expect(c.getSnapshot().session).toBeUndefined();
    expect(reads).toBeGreaterThanOrEqual(2); // the strip was re-read on return (initial + post-chat)
  });

  it('Ctrl-C on the Home exits cleanly (idempotent — never settles driveHome twice)', () => {
    const onExit = vi.fn();
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(),
      homeStore,
      onExit,
      onError: vi.fn(),
    });
    c.handleKey('c', CTRL_C);
    c.handleKey('c', CTRL_C); // a second Ctrl-C / a race must not re-fire
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('Ctrl-C inside a chat sends /cancel once (cancelFired guards a double)', async () => {
    const made = makeSession();
    const startChat = vi.fn(() => Promise.resolve(made.session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();
    made.lines.length = 0; // drop the first turn

    c.handleKey('c', CTRL_C);
    c.handleKey('c', CTRL_C); // guarded
    expect(made.lines).toEqual(['/cancel']);
  });

  it('exiting mid-build reclaims the just-built session instead of mounting it', async () => {
    let resolveBuild: (s: HomeChatSession) => void = () => undefined;
    const made = makeSession();
    const startChat = vi.fn(() => new Promise<HomeChatSession>((r) => (resolveBuild = r)));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    type(c, 'hi');
    c.handleKey('', ENTER); // → loading, build pending
    c.handleKey('c', CTRL_C); // user exits while the build is in flight
    resolveBuild(made.session); // the build resolves AFTER the exit
    await flush();

    expect(made.teardown).toHaveBeenCalledTimes(1); // reclaimed, not mounted
    expect(c.getSnapshot().mode).not.toBe('chat');
    expect(made.lines).toEqual([]); // no first message was ever sent
  });

  it('teardownActive tears a live chat down (for the signal handler) and is idempotent vs endChat', async () => {
    const made = makeSession();
    const startChat = vi.fn(() => Promise.resolve(made.session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();

    await c.teardownActive();
    await c.teardownActive(); // idempotent
    expect(made.teardown).toHaveBeenCalledTimes(1);
  });

  it('BOUNDS the endChat teardown — a never-resolving (hung MCP) close still returns to Home', async () => {
    const made = makeSession({ stop: () => true }); // the first turn ends the session ⇒ endChat fires
    made.teardown.mockImplementation(() => new Promise<void>(() => undefined)); // a graceful close that never settles
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(() => Promise.resolve(made.session)),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
      boundTeardown: () => Promise.resolve(), // an instant bound (no real timer) — the deadline "wins" the race
    });

    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush();

    expect(c.getSnapshot().mode).toBe('home'); // returned to Home despite the hung teardown — no freeze
    expect(c.getSnapshot().session).toBeUndefined();
  });

  it('teardownActive during a build-in-flight (a signal while loading) reaps the just-built session — no orphan', async () => {
    let resolveBuild: (s: HomeChatSession) => void = () => undefined;
    const made = makeSession();
    const startChat = vi.fn(() => new Promise<HomeChatSession>((r) => (resolveBuild = r)));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    type(c, 'hi');
    c.handleKey('', ENTER); // → loading, build pending, NO session yet
    const teardown = c.teardownActive(); // the signal handler runs while still loading
    resolveBuild(made.session); // the build resolves into the terminating controller
    await teardown;

    // The in-flight build's session is reaped, not orphaned. (teardownActive AND submit's exiting-arm may each
    // reap it — both call the SAME idempotent real teardown, so the second is a benign no-op; only the fake counts
    // both. The guarantee that matters is "reaped ≥1 / no orphan", and that the chat was never mounted.)
    expect(made.teardown).toHaveBeenCalled();
    expect(c.getSnapshot().mode).not.toBe('chat'); // and never mounted
    expect(made.lines).toEqual([]);
  });

  it('a signal during an in-flight endChat awaits the GRACEFUL teardown and skips the closed-db read', async () => {
    let releaseTeardown: () => void = () => undefined;
    const teardown = vi.fn(() => new Promise<void>((r) => (releaseTeardown = r))); // a slow (graceful MCP) close
    const session: HomeChatSession = {
      store: createChatStore(false),
      processLine: () => Promise.resolve(),
      shouldStop: () => true, // the first turn ends the session ⇒ endChat fires
      teardown,
    };
    const startChat = vi.fn(() => Promise.resolve(session));
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat,
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });

    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush(); // first turn settles ⇒ endChat starts the slow teardown (pending)
    const readsBefore = reads;

    const signal = c.teardownActive(); // tearingDown === session ⇒ it must AWAIT the in-flight teardown
    releaseTeardown(); // the graceful close completes
    await signal;

    expect(teardown).toHaveBeenCalledTimes(1); // a single graceful teardown, awaited by the signal path
    expect(reads).toBe(readsBefore); // endChat's deferred finally hit the `exiting` guard — no read on the closing db
  });

  it('ignores a keystroke that arrives while a chat session is tearing down (no sendMessage on a cancelled session)', async () => {
    let releaseTeardown: () => void = () => undefined;
    const lines: string[] = [];
    const session: HomeChatSession = {
      store: createChatStore(false),
      processLine: (line) => {
        lines.push(line);
        return Promise.resolve();
      },
      shouldStop: () => true,
      teardown: vi.fn(() => new Promise<void>((r) => (releaseTeardown = r))),
    };
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(() => Promise.resolve(session)),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    type(c, 'hi');
    c.handleKey('', ENTER);
    await flush(); // endChat in flight (teardown pending), mode still 'chat', session still mounted
    lines.length = 0;

    c.handleKey('x', {}); // a key arriving mid-teardown
    c.handleKey('', ENTER); // a submit arriving mid-teardown
    expect(lines).toEqual([]); // the tearingDown guard ignored both — no line driven onto the cancelled session

    releaseTeardown();
    await flush();
  });

  it('does not re-settle driveHome after a turn error (the shared `exiting` guard)', async () => {
    const made = makeSession({ onProcess: () => Promise.reject(new Error('boom')) });
    const onExit = vi.fn();
    const onError = vi.fn();
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(() => Promise.resolve(made.session)),
      homeStore,
      onExit,
      onError,
    });
    type(c, 'go');
    c.handleKey('', ENTER);
    await flush();
    expect(onError).toHaveBeenCalledTimes(1); // failHome fired once

    c.handleKey('c', CTRL_C); // a later Ctrl-C must NOT re-settle (exiting is already true)
    expect(onExit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('Ctrl-D (EOF) on an empty Home prompt exits; with text in the buffer it does not (no data loss)', () => {
    const onExit = vi.fn();
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: vi.fn(),
      homeStore,
      onExit,
      onError: vi.fn(),
    });
    type(c, 'draft');
    c.handleKey('d', { ctrl: true }); // Ctrl-D with a non-empty buffer → ignored
    expect(onExit).not.toHaveBeenCalled();
    expect(c.getSnapshot().input.text).toBe('draft'); // the buffer is preserved

    type(c, ''); // (no-op)
    c.handleKey('', { backspace: true });
    c.handleKey('', { backspace: true });
    c.handleKey('', { backspace: true });
    c.handleKey('', { backspace: true });
    c.handleKey('', { backspace: true }); // empty the buffer
    // Assert the WHOLE EditorState so repeated deleteBeforeCursor decrements the Home cursor back to 0 (not just
    // that .text emptied) — pins the primitive step 2's cursor motions build directly on top of.
    expect(c.getSnapshot().input).toEqual({ text: '', cursor: 0 });
    c.handleKey('d', { ctrl: true }); // Ctrl-D on the empty buffer → clean exit (EOF)
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  describe('bracketed paste (DECSET 2004)', () => {
    it('appends a multi-line paste literally (newlines kept) and does NOT submit early', () => {
      const startChat = vi.fn();
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey(PASTE_START, {});
      c.handleKey('line1\nline2\r\nline3', {}); // ink delivers the bracketed content as one event (with a CRLF)
      c.handleKey(PASTE_END, {});
      // The whole EditorState: insertAtCursor advances the cursor past the multi-char pasted block (18 units).
      // The pasted CRLF is normalized to a single LF (no stray '\r' reaches the model/transcript), so the block
      // is 17 units, not 18 — matching the reduceEditorMotion append path.
      expect(c.getSnapshot().input).toEqual({ text: 'line1\nline2\nline3', cursor: 17 });
      expect(startChat).not.toHaveBeenCalled(); // nothing submitted by the embedded newlines
      expect(c.getSnapshot().mode).toBe('home');
    });

    it('the markers themselves never reach the buffer', () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey(PASTE_START, {});
      c.handleKey(PASTE_END, {});
      expect(c.getSnapshot().input.text).toBe('');
    });

    it('a literal Enter still submits once the paste has ended', async () => {
      const made = makeSession();
      const startChat = vi.fn(() => Promise.resolve(made.session));
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey(PASTE_START, {});
      c.handleKey('deploy.yaml contents', {});
      c.handleKey(PASTE_END, {});
      c.handleKey('', ENTER); // a real key press AFTER the paste submits
      await flush();
      expect(startChat).toHaveBeenCalledTimes(1);
      expect(made.lines).toEqual(['deploy.yaml contents']);
    });

    it('reassembles a paste delivered across MULTIPLE chunks (none submits, order + newlines preserved)', () => {
      const startChat = vi.fn();
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey(PASTE_START, {});
      c.handleKey('first\n', {}); // ink can split a large paste across stdin reads
      c.handleKey('\r', { return: true }); // even a lone CR chunk INSIDE the paste is literal, not a submit
      c.handleKey('second', {});
      c.handleKey(PASTE_END, {});
      // The cursor advances across EVERY chunk's insert (6 + 1 + 6 = 13 units), not just the first.
      // The lone CR chunk between the two lines normalizes to LF (never a stray '\r'); length is unchanged (13).
      expect(c.getSnapshot().input).toEqual({ text: 'first\n\nsecond', cursor: 13 });
      expect(startChat).not.toHaveBeenCalled();
    });

    it('Ctrl-C ALWAYS escapes a stuck paste (a lost end-marker must never trap the user) — Home exits', () => {
      const onExit = vi.fn();
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit,
        onError: vi.fn(),
      });
      c.handleKey(PASTE_START, {});
      c.handleKey('half a paste', {}); // the [201~ end marker never arrives
      c.handleKey('c', CTRL_C); // the user bails out
      expect(onExit).toHaveBeenCalledTimes(1); // the latch is cleared and the Home exits cleanly
    });

    it('Ctrl-C escapes a stuck paste inside a chat as a /cancel (not swallowed)', async () => {
      const made = makeSession();
      const startChat = vi.fn(() => Promise.resolve(made.session));
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'hi');
      c.handleKey('', ENTER);
      await flush();
      made.lines.length = 0;

      c.handleKey(PASTE_START, {});
      c.handleKey('oops', {}); // end marker lost mid-chat
      c.handleKey('c', CTRL_C);
      expect(made.lines).toEqual(['/cancel']); // the chat cancels rather than wedging
    });

    it('drops paste content while a chat turn is running (matches the mid-turn keystroke gate)', async () => {
      const made = makeSession({ running: true });
      const startChat = vi.fn(() => Promise.resolve(made.session));
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'go');
      c.handleKey('', ENTER);
      await flush(); // mode 'chat', the (stubbed) store reports running

      c.handleKey(PASTE_START, {});
      c.handleKey('type-ahead block', {});
      c.handleKey(PASTE_END, {});
      expect(c.getSnapshot().input.text).toBe(''); // dropped mid-turn, like every other key
    });

    it('drops paste content during the `loading` build window, matching the keystroke gate (no leak into the chat prompt)', async () => {
      const made = makeSession();
      let resolveBuild: (s: HomeChatSession) => void = () => undefined;
      const startChat = vi.fn(() => new Promise<HomeChatSession>((r) => (resolveBuild = r)));
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'hi');
      c.handleKey('', ENTER); // → loading, build pending
      expect(c.getSnapshot().mode).toBe('loading');

      c.handleKey(PASTE_START, {});
      c.handleKey('pasted-while-loading', {}); // a key typed here is dropped — so must a paste be
      c.handleKey(PASTE_END, {});

      resolveBuild(made.session);
      await flush();
      expect(c.getSnapshot().mode).toBe('chat');
      expect(c.getSnapshot().input.text).toBe(''); // the paste did NOT leak into the freshly-mounted chat prompt
    });

    it('drops EVERY chunk of a multi-chunk paste while a turn runs', async () => {
      const made = makeSession({ running: true });
      const startChat = vi.fn(() => Promise.resolve(made.session));
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'go');
      c.handleKey('', ENTER);
      await flush(); // chat, running (stub)

      c.handleKey(PASTE_START, {});
      c.handleKey('chunk1\n', {});
      c.handleKey('chunk2', {});
      c.handleKey(PASTE_END, {});
      expect(c.getSnapshot().input.text).toBe(''); // all chunks dropped, not just the first
    });
  });

  describe('the / command palette (2.5.C S3b)', () => {
    const DOWN = { downArrow: true } as const;
    const ESC = { escape: true } as const;

    /** Build a controller, submit a first message so it is in `chat` mode at an empty prompt, ready for the palette. */
    const intoChat = async (
      made: ReturnType<typeof makeSession>,
    ): Promise<ReturnType<typeof createHomeController>> => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: () => Promise.resolve(made.session),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'hi');
      c.handleKey('', ENTER);
      await flush();
      return c;
    };

    it('opens on a literal "/" at an empty chat prompt', async () => {
      const c = await intoChat(makeSession());
      c.handleKey('/', {});
      expect(c.getSnapshot().palette).toEqual({ query: '', index: 0 });
    });

    it('filters as you type and Enter submits the highlighted command as a slash line', async () => {
      const made = makeSession();
      const c = await intoChat(made);
      c.handleKey('/', {});
      type(c, 'ex'); // filter → [exit, export]
      c.handleKey('', DOWN); // highlight export
      expect(c.getSnapshot().palette).toEqual({ query: 'ex', index: 1 });
      c.handleKey('', ENTER); // select → submit /export through the chat dispatch
      await flush();
      expect(made.lines).toEqual(['hi', '/export']);
      expect(c.getSnapshot().palette).toBeUndefined(); // closed after running
    });

    it('Esc closes the palette without submitting anything', async () => {
      const made = makeSession();
      const c = await intoChat(made);
      c.handleKey('/', {});
      c.handleKey('', ESC);
      expect(c.getSnapshot().palette).toBeUndefined();
      expect(made.lines).toEqual(['hi']); // nothing else submitted
    });

    it('Ctrl-C closes the palette (a gentle escape — it does not /cancel the chat)', async () => {
      const made = makeSession();
      const c = await intoChat(made);
      c.handleKey('/', {});
      c.handleKey('c', CTRL_C);
      expect(c.getSnapshot().palette).toBeUndefined();
      expect(made.lines).toEqual(['hi']); // no /cancel leaked
    });

    it('a "/" mid-message is a normal character — the palette only triggers at an empty prompt', async () => {
      const c = await intoChat(makeSession());
      type(c, 'ab');
      c.handleKey('/', {});
      expect(c.getSnapshot().palette).toBeUndefined();
      expect(c.getSnapshot().input.text).toBe('ab/');
    });

    it('does not open mid-turn — "/" while a turn streams is ignored, not a palette trigger', async () => {
      const c = await intoChat(makeSession({ running: true })); // the session store reports `running`
      c.handleKey('/', {});
      expect(c.getSnapshot().palette).toBeUndefined();
    });
  });

  describe('the / command palette in the bare Home (2.5.C S3c)', () => {
    const ESC = { escape: true } as const;

    it('opens on "/" at the Home prompt, and selecting /exit ends the Home', () => {
      const onExit = vi.fn();
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit,
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      expect(c.getSnapshot().palette).toEqual({ query: '', index: 0 }); // HOME_PALETTE_COMMANDS = [exit, doctor]; index 0 = /exit
      c.handleKey('', ENTER); // select the highlighted /exit → run over the Home context → exitHome
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(c.getSnapshot().palette).toBeUndefined();
    });

    it('Esc closes the Home palette without exiting', () => {
      const onExit = vi.fn();
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit,
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      c.handleKey('', ESC);
      expect(c.getSnapshot().palette).toBeUndefined();
      expect(onExit).not.toHaveBeenCalled();
    });

    it('Ctrl-C closes the Home palette (the always-escapes hatch — does not exit the Home)', () => {
      const onExit = vi.fn();
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit,
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      c.handleKey('c', CTRL_C);
      expect(c.getSnapshot().palette).toBeUndefined();
      expect(onExit).not.toHaveBeenCalled();
    });

    it('a "/" mid-message in the Home is a normal character (the palette only triggers at an empty prompt)', () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'ab');
      c.handleKey('/', {});
      expect(c.getSnapshot().palette).toBeUndefined();
      expect(c.getSnapshot().input.text).toBe('ab/');
    });

    it('does not open while a build is loading (the loading guard fires before the trigger)', () => {
      const startChat = vi.fn(() => new Promise<HomeChatSession>(() => undefined)); // never resolves
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat,
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'hello');
      c.handleKey('', ENTER); // → loading (the build is in flight)
      expect(c.getSnapshot().mode).toBe('loading');
      c.handleKey('/', {});
      expect(c.getSnapshot().palette).toBeUndefined();
    });

    it('typing in the Home palette updates the query (the filter state path runs in the Home too)', () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'ex'); // 'ex' filters [exit, doctor] → [exit]; the query updates
      expect(c.getSnapshot().palette).toEqual({ query: 'ex', index: 0 });
    });

    it('selecting /doctor runs the fast tier into the Home notice surface', async () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc'); // filter [exit, doctor] → [doctor]
      c.handleKey('', ENTER); // select /doctor → runDoctor(false) over the Home context
      expect(c.getSnapshot().palette).toBeUndefined();
      await flush(); // the async runDoctor settles
      // Assert the rendered ROWS, not just the heading — so a malformed/missing check row would fail the test.
      const notice = c.getSnapshot().notice;
      expect(notice).toContain('doctor: all checks passed');
      expect(notice).toContain('✓ OS keychain: reachable');
      expect(notice).toContain('✓ config: valid');
      expect(notice).toContain('✓ wired tools: none'); // the STUB toolHost wires no arms
    });

    it('the Home /doctor notice clears on the next keystroke', async () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc');
      c.handleKey('', ENTER);
      await flush();
      expect(c.getSnapshot().notice).toBeDefined();
      type(c, 'x'); // typing moves on — the report clears
      expect(c.getSnapshot().notice).toBeUndefined();
      expect(c.getSnapshot().input.text).toBe('x');
    });

    it('a NO-OP cursor motion does NOT clear the Home /doctor notice (only a real edit does)', async () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc');
      c.handleKey('', ENTER);
      await flush();
      expect(c.getSnapshot().notice).toBeDefined();
      // The prompt is empty, so every cursor motion is a no-op (applyEditorAction returns the SAME reference); a
      // boundary motion must NOT clear the report the user is reading (the widened edit arm was clearing it).
      c.handleKey('', { leftArrow: true });
      c.handleKey('a', { ctrl: true }); // Ctrl+A (line-start) on an empty buffer
      c.handleKey('', { end: true });
      expect(c.getSnapshot().notice).toBeDefined(); // preserved
      expect(c.getSnapshot().input).toEqual({ text: '', cursor: 0 }); // untouched
    });

    it('a faulting fast-tier probe surfaces as a failed check (secret-free), never a crash', async () => {
      const probes = {
        ...STUB_DOCTOR_PROBES,
        keychain: () => {
          throw new Error('keychain locked');
        },
      };
      const c = createHomeController({
        doctorProbes: probes,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc');
      c.handleKey('', ENTER);
      await flush();
      const notice = c.getSnapshot().notice;
      expect(notice).toContain('doctor: 1 check(s) failed');
      expect(notice).toContain('✗ OS keychain: keychain locked');
    });

    it('a report does NOT land if the prompt is edited during the run (the stale-run token guard)', async () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc');
      c.handleKey('', ENTER); // run /doctor: sets 'checking…' synchronously, then awaits
      type(c, 'x'); // edit the prompt BEFORE the run settles — bumps the run token + clears the notice
      await flush(); // the run resolves; its report is dropped (token mismatch), not re-shown over what's typed
      expect(c.getSnapshot().notice).toBeUndefined();
      expect(c.getSnapshot().input.text).toBe('x');
    });

    it('a report does NOT land if the palette is re-opened during the run (the palette branch of the guard)', async () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc');
      c.handleKey('', ENTER); // run /doctor (closes the palette, sets 'checking…'), then awaits
      c.handleKey('/', {}); // re-open the palette BEFORE the run settles (clears the notice; token is unchanged)
      await flush(); // the run resolves; the palette is open, so the report must NOT land over it
      expect(c.getSnapshot().palette).toBeDefined();
      expect(c.getSnapshot().notice).toBeUndefined();
    });

    it('a paste clears a stale /doctor notice (parity with typing)', async () => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: vi.fn(),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      c.handleKey('/', {});
      type(c, 'doc');
      c.handleKey('', ENTER);
      await flush();
      expect(c.getSnapshot().notice).toBeDefined();
      c.handleKey(PASTE_START, {});
      c.handleKey('pasted', {});
      c.handleKey(PASTE_END, {});
      expect(c.getSnapshot().notice).toBeUndefined();
      expect(c.getSnapshot().input.text).toBe('pasted');
    });
  });

  describe('in-chat mode / approval / abort keys (ADR-0057)', () => {
    const inChat = async (made: ReturnType<typeof makeSession>): Promise<HomeController> => {
      const c = createHomeController({
        doctorProbes: STUB_DOCTOR_PROBES,
        startChat: () => Promise.resolve(made.session),
        homeStore,
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      type(c, 'hi');
      c.handleKey('', ENTER);
      await flush(); // loading → chat, first line sent — now handleKey routes to handleChatKey
      return c;
    };
    const approvalReq = {
      toolId: 'write_file',
      action: 'fs_write',
      preview: { path: 'x' },
    } as const;

    it('Shift+Tab cycles the chat mode via onModeChange (ask → plan)', async () => {
      const onModeChange = vi.fn();
      const c = await inChat(makeSession({ onModeChange }));
      c.handleKey('', { tab: true, shift: true });
      expect(onModeChange).toHaveBeenCalledWith('plan'); // default ask → plan
    });

    it('Esc aborts the in-flight turn via onAbort (mid-turn; the session is not cancelled)', async () => {
      const onAbort = vi.fn();
      const made = makeSession({ onAbort, running: true });
      const c = await inChat(made);
      c.handleKey('', { escape: true });
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(made.lines).not.toContain('/cancel'); // abort ≠ /cancel — the session stays alive
    });

    it('Esc REJECTS a pending approval when onAbort is ABSENT — never a dead key / stuck prompt', async () => {
      // A session wired WITHOUT onAbort must still let Esc resolve a pending approval (reject) rather than leave
      // it hung — the home-controller abort fallback (a pending approval + no onAbort ⇒ answerApproval reject).
      const store = createChatStore(false);
      const c = await inChat(makeSession({ store })); // no onAbort
      const pending = store.requestApproval(approvalReq, true);
      c.handleKey('', { escape: true });
      await expect(pending).resolves.toEqual({ outcome: 'reject' });
    });

    it('Esc with onAbort PRESENT aborts the turn and does NOT also answer the approval (no double-settle)', async () => {
      // The `if onAbort` branch wins: the turn is aborted (its signal resolves the approval); the fallback
      // answerApproval must NOT also fire (a refactor to two independent `if`s would double-settle).
      const onAbort = vi.fn();
      const store = createChatStore(false);
      const c = await inChat(makeSession({ onAbort, store }));
      const pending = store.requestApproval(approvalReq, true);
      void pending.catch(() => undefined); // onAbort is a mock (doesn't fire the signal) — avoid an unhandled reject
      c.handleKey('', { escape: true });
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().approval).not.toBeUndefined(); // the fallback did NOT answer it — onAbort owns the abort
    });

    it('a pending approval intercepts keys: `/` stays closed and `[y]` approves-once', async () => {
      const store = createChatStore(false);
      const c = await inChat(makeSession({ store }));
      const pending = store.requestApproval(approvalReq, true);
      c.handleKey('/', {}); // the approval owns the keyboard — the palette must NOT open
      expect(c.getSnapshot().palette).toBeUndefined();
      c.handleKey('y', {});
      await expect(pending).resolves.toEqual({ outcome: 'approve', scope: 'once' });
    });

    it('a pending approval: `[a]` approves-always, `[n]` rejects', async () => {
      const alwaysStore = createChatStore(false);
      const ca = await inChat(makeSession({ store: alwaysStore }));
      const alwaysPending = alwaysStore.requestApproval(approvalReq, true);
      ca.handleKey('a', {});
      await expect(alwaysPending).resolves.toEqual({ outcome: 'approve', scope: 'always' });

      const rejectStore = createChatStore(false);
      const cr = await inChat(makeSession({ store: rejectStore }));
      const rejectPending = rejectStore.requestApproval(approvalReq, true);
      cr.handleKey('n', {});
      await expect(rejectPending).resolves.toEqual({ outcome: 'reject' });
    });
  });
});
