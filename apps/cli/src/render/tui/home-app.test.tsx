import type { SessionStreamHandleEvent, ToolApprovalRequest } from '@relavium/core';
import type { ModelCatalogEntry } from '@relavium/llm';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReseatTarget } from '../../commands/chat.js';
import type { ApprovalAnswer } from '../../chat/chat-mode.js';
import type { DoctorProbes } from '../../chat/doctor.js';
import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { bracketed, flush, waitFor } from './harness-util.js';
import { RootApp } from './home-app.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeModelsPort,
} from './home-controller.js';

/**
 * Mounted-Home component tests (2.6.F Step 3, ADR-0068 part f) — the second surface (after `chat-app.test.tsx`)
 * with an ink-7 `usePaste` channel AND its own live-turn timer + resize wiring. The Step-2 migration wired
 * `RootApp`'s native paste to `controller.handlePaste`; this pins that wiring END-TO-END through a mounted `RootApp`
 * + a real stdin write, complementing `home-controller.test.ts` (which drives `handlePaste` directly) and
 * `chat-input.test.ts` (the pure `pasteIsEditable` predicate).
 *
 * Load-bearing pins, one per surface-specific mechanism:
 *   • SECURITY (ADR-0057) — a bracketed paste can neither answer the per-tool approval floor nor leak into the
 *     buffer. As in the standalone chat, the payload is a LONE 'y': ink routes it to `usePaste` (dropped behind the
 *     gate), never to `useInput`; were the handler removed, the no-listener fallback would re-emit 'y' to `useInput`
 *     and answer the floor — so the test fails iff the wiring regresses.
 *   • 2.5.H frozen-clock — the Home renders the live timer through a DIFFERENT path than `ChatApp`: a `now()`
 *     FUNCTION prop read per-frame inside `ChatRegion` (home-app.tsx warns a frozen number prop would stick the
 *     elapsed at 0s). That distinct mechanism gets its own pin here.
 *   • RESIZE — `RootApp`'s `subscribeResize` → `setSize(getSize())` re-measure wiring (Home substrate, not
 *     Step-4/5-gated) is exercised by firing the captured resize callback.
 *
 * `afterEach(cleanup)` unmounts every mounted instance even when an assertion throws. Frame assertions poll via
 * {@link waitFor} (never a fixed single yield) because React 19's commit can be deferred under load.
 */

afterEach(cleanup);

const STUB_DOCTOR_PROBES: DoctorProbes = { keychain: () => {}, config: () => {}, toolHost: {} };

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  isEmpty: true,
};
const homeStore: HomeStore = { read: () => EMPTY };

const approvalReq: ToolApprovalRequest = {
  toolId: 'write_file',
  action: 'fs_write',
  preview: { path: 'notes.md' },
};

const turnStarted = (timestamp: string): SessionStreamHandleEvent => ({
  type: 'session:turn_started',
  sessionId: 'sess-1',
  sequenceNumber: 1,
  timestamp,
});

/** A minimal in-Home chat session fake — only the fields the controller reads on the paste / timer paths. The
 *  `sessionId` is parameterized so a `/models` reseat fake can hand back a DIFFERENT session object that keeps the
 *  SAME id (the reseat invariant the scroll-reset test discriminates against). */
function makeSession(store: ChatStoreController, sessionId = 'sess-fake'): HomeChatSession {
  return {
    store,
    sessionId,
    processLine: async () => {},
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
}

/** A single-entry {@link HomeModelsPort} fake — just enough to open the in-Home `/models` picker and accept the one
 *  model (which triggers a live reseat when `reseatChat` is wired). Mirrors the fuller fake in home-controller.test.ts. */
function makeModelsPort(
  modelId: string,
  provider: ModelCatalogEntry['provider'] = 'anthropic',
): HomeModelsPort {
  const entry: ModelCatalogEntry = {
    modelId,
    provider,
    displayName: modelId,
    pricingSource: 'registry',
    priceKnown: true,
    available: true,
    deprecated: false,
    supportsReasoning: false,
  };
  let written: string | undefined;
  return {
    load: () => ({ entries: [entry], refreshedAt: undefined }),
    refreshIfStale: () => Promise.resolve(undefined),
    refresh: () => Promise.resolve({ providers: [] }),
    currentDefault: () => written,
    currentEffort: () => undefined,
    writeDefault: (id) => {
      written = id;
    },
  };
}

interface MountedHome {
  readonly c: HomeController;
  readonly harness: ReturnType<typeof render>;
  /** Invoke the resize callback `RootApp` registered via `subscribeResize` (the terminal-resize signal). */
  readonly fireResize: () => void;
  /** Mutate the size `getSize()` returns, so a subsequent `fireResize()` re-measures to it. */
  readonly setSize: (size: { cols: number; rows: number }) => void;
}

/** Build a controller whose `startChat` yields a session over the given store, then mount `RootApp` on the harness.
 *  `nowMs` is `() => Date.now()` so a `Date`-only fake clock drives the Home's per-frame timer; the resize
 *  subscription is captured (not stubbed inert) so the re-measure wiring can be exercised. */
function mountHome(
  store: ChatStoreController,
  opts: {
    alternateScreen?: boolean;
    startChat?: () => Promise<HomeChatSession>;
    reseatChat?: (sessionId: string, target: ReseatTarget) => Promise<HomeChatSession>;
    models?: HomeModelsPort;
  } = {},
): MountedHome {
  let onResize: () => void = () => {};
  let size = { cols: 100, rows: 30 };
  const c = createHomeController({
    doctorProbes: STUB_DOCTOR_PROBES,
    startChat: opts.startChat ?? (() => Promise.resolve(makeSession(store))),
    ...(opts.reseatChat !== undefined ? { reseatChat: opts.reseatChat } : {}),
    ...(opts.models !== undefined ? { models: opts.models } : {}),
    homeStore,
    onExit: vi.fn(),
    onError: vi.fn(),
  });
  const harness = render(
    <RootApp
      controller={c}
      nowMs={() => Date.now()}
      color={false}
      getSize={() => size}
      subscribeResize={(cb) => {
        onResize = cb;
        return () => {};
      }}
      {...(opts.alternateScreen === true ? { alternateScreen: true } : {})}
    />,
  );
  return {
    c,
    harness,
    fireResize: () => onResize(),
    setSize: (next) => {
      size = next;
    },
  };
}

/** Drive the mounted controller from the bare Home into an in-Home chat (type a first message + Enter). The chat is
 *  entered via the controller directly (deterministic) — the STDIN path is reserved for the paste under test. */
async function enterChat(c: HomeController): Promise<void> {
  c.handleKey('h', {});
  c.handleKey('i', {});
  c.handleKey('', { return: true });
  await waitFor(() => c.getSnapshot().mode === 'chat'); // startChat resolves on a microtask
}

describe('RootApp (Home) bracketed paste — usePaste → controller.handlePaste wiring (ADR-0068)', () => {
  it('inserts an idle paste into the in-Home chat buffer', async () => {
    const store = createChatStore(false);
    const { c, harness } = mountHome(store);
    await enterChat(c);
    expect(c.getSnapshot().mode).toBe('chat');

    harness.stdin.write(bracketed('hello world'));
    await waitFor(() => c.getSnapshot().input.text.includes('hello world'));
    expect(c.getSnapshot().input.text).toContain('hello world');
  });

  it('normalizes CRLF/CR in a pasted block to LF exactly (a\\r\\nb\\rc → a\\nb\\nc)', async () => {
    const store = createChatStore(false);
    const { c, harness } = mountHome(store);
    await enterChat(c);

    harness.stdin.write(bracketed('a\r\nb\rc'));
    // The Home exposes the raw compose buffer, so pin the normalization EXACTLY — this distinguishes real `\r\n?`→
    // `\n` from CR-stripping ('abc'), CR-preserving ('a\r\nb\rc'), and a dropped paste ('').
    await waitFor(() => c.getSnapshot().input.text === 'a\nb\nc');
    expect(c.getSnapshot().input.text).toBe('a\nb\nc');
  });

  it('SECURITY: a pasted approval token cannot answer the fail-closed floor nor leak into the buffer (ADR-0057)', async () => {
    const store = createChatStore(false);
    const { c, harness } = mountHome(store);
    await enterChat(c);
    let answered: ApprovalAnswer | undefined;
    void store.requestApproval(approvalReq, true).then((a) => {
      answered = a;
    });
    await waitFor(() => store.getSnapshot().approval !== undefined);
    expect(store.getSnapshot().approval).toBeDefined(); // the prompt owns the keyboard

    // A LONE 'y' — the char that answers the floor via `useInput` if the paste wiring regressed. `usePaste` →
    // `handlePaste` drops it behind the approval gate (`pasteEditable` refuses it). Give any regression a bounded
    // window to manifest (an answer, a cleared approval, or a leaked buffer), then confirm none did.
    harness.stdin.write(bracketed('y'));
    await waitFor(
      () =>
        answered !== undefined ||
        store.getSnapshot().approval === undefined ||
        c.getSnapshot().input.text !== '',
      12,
    );
    expect(store.getSnapshot().approval).toBeDefined(); // still pending — the floor was untouched
    expect(answered).toBeUndefined(); // the awaiting dispatch never resolved
    expect(c.getSnapshot().input.text).toBe(''); // and nothing leaked into the compose buffer
  });
});

describe('RootApp (Home) live-turn timer — 2.5.H frozen-clock regression (function-prop path)', () => {
  it('advances the elapsed counter as the wall clock moves across ticks', async () => {
    // Fake ONLY `Date`; `ChatRegion` reads `now()` (→ RootApp's `nowMs` → `Date.now()`) per frame, so the counter
    // must move when the wall clock does. A frozen number prop (the documented failure mode) would stick it at 0s.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-07-09T10:00:00.000Z'));
      const store = createChatStore(false);
      const { c, harness } = mountHome(store);
      const frame = (): string => harness.lastFrame() ?? '';
      await enterChat(c);
      expect(c.getSnapshot().mode).toBe('chat');

      store.apply(turnStarted('2026-07-09T10:00:00.000Z')); // turnStartedAtMs = T0
      store.tick();
      await waitFor(() => frame().includes('Working… 0s'));
      expect(frame()).toContain('Working… 0s');

      vi.setSystemTime(new Date('2026-07-09T10:00:03.000Z'));
      store.tick(); // running turn → ChatRegion re-renders → re-reads now()
      await waitFor(() => frame().includes('Working… 3s'));
      expect(frame()).toContain('Working… 3s');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RootApp (Home) terminal resize — subscribeResize → setSize re-measure wiring', () => {
  it('re-renders on a resize signal without throwing (the useEffect re-measure path)', async () => {
    const store = createChatStore(false);
    const { harness, fireResize, setSize } = mountHome(store);
    const frame = (): string => harness.lastFrame() ?? '';
    await waitFor(() => frame().length > 0);
    const baseline = harness.frames.length;

    // The terminal shrank below the 80×24 degrade threshold — mutate the measured size, then fire the resize the
    // production `useEffect(() => subscribeResize(() => setSize(getSize())))` registered. A new size object triggers
    // a re-render (a new committed frame), exercising the re-measure wiring the other tests stub inert.
    setSize({ cols: 60, rows: 20 });
    fireResize();
    await waitFor(() => harness.frames.length > baseline);
    expect(harness.frames.length).toBeGreaterThan(baseline);
  });
});

describe('RootApp (Home) alt-screen transcript viewport (2.6.F Step 4b, ADR-0068 §c)', () => {
  it('renders the in-Home chat transcript through the viewport, following the tail + bounded to the terminal', async () => {
    // The Home threads the viewport DIFFERENTLY from ChatApp ({rows,cols} from the resize-tracked size; the height
    // bound on ChatRegion's container), so it gets its own mounted pin — a regression that dropped it back to
    // `<Static>` (unscrollable in the alt buffer) or passed the wrong rows would be caught by nothing otherwise.
    const store = createChatStore(false);
    for (let i = 0; i < 40; i += 1) store.appendUser(`HMSG${i}`);
    const { c, harness } = mountHome(store, { alternateScreen: true });
    await enterChat(c);
    const frame = (): string => harness.lastFrame() ?? '';
    await waitFor(() => frame().includes('HMSG39'));
    expect(frame()).toContain('HMSG39'); // the newest entry (tail) is shown
    expect(frame()).not.toContain('HMSG0'); // the oldest scrolled off the top — the alt buffer has no scrollback
    expect(frame().split('\n').length).toBeLessThanOrEqual(30); // bounded to the size's rows (getSize ⇒ 30)
  });

  it('SCROLLS the in-Home transcript: PgUp leaves the tail, PgDn resumes it (RootApp keymap path, Step 4b-2)', async () => {
    const store = createChatStore(false);
    for (let i = 0; i < 60; i += 1) store.appendUser(`HMSG${i}`);
    const { c, harness } = mountHome(store, { alternateScreen: true });
    await enterChat(c);
    const frame = (): string => harness.lastFrame() ?? '';
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 4; i += 1) await flush();
    };
    const press = async (seq: string): Promise<void> => {
      harness.stdin.write(seq);
      await settle();
    };
    await waitFor(() => frame().includes('HMSG59'));
    await settle();
    expect(frame()).toContain('HMSG59'); // following the tail

    await press('\x1b[5~'); // PgUp
    await press('\x1b[5~');
    expect(frame()).not.toContain('HMSG59'); // scrolled up off the tail (the RootApp keymap paused follow)

    await press('\x1b[6~'); // PgDn once — moves down a page but NOT yet to the tail
    expect(frame()).not.toContain('HMSG59'); // STILL paused mid-page: a partial page-down must not resume follow

    await press('\x1b[6~'); // PgDn
    await press('\x1b[6~');
    expect(frame()).toContain('HMSG59'); // back at the tail (following resumed on reaching the bottom)
  });

  it('does NOT scroll the transcript while a keyboard-owning overlay is open (the noOverlay gate, Step 4b-2)', async () => {
    // The scroll interception is gated on `noOverlay` so a PgUp/PgDn while the `/` palette (or any overlay) owns the
    // keyboard reaches the OVERLAY, never the transcript scroll reducer — else opening the palette and paging would
    // silently pause tail-follow behind the overlay. Following the tail, open the palette, then PgUp: the tail must
    // STAY put (the key went to the palette, not the viewport) and the palette must still be open.
    const store = createChatStore(false);
    for (let i = 0; i < 60; i += 1) store.appendUser(`HMSG${i}`);
    const { c, harness } = mountHome(store, { alternateScreen: true });
    await enterChat(c);
    const frame = (): string => harness.lastFrame() ?? '';
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 4; i += 1) await flush();
    };
    await waitFor(() => frame().includes('HMSG59'));
    await settle();
    expect(frame()).toContain('HMSG59'); // following the tail

    c.handleKey('/', {}); // open the `/` command palette — it now owns the keyboard
    await settle();
    expect(c.getSnapshot().palette).toBeDefined();

    harness.stdin.write('\x1b[5~'); // PgUp — must be consumed by the palette, NOT the transcript scroll keymap
    await settle();
    expect(c.getSnapshot().palette).toBeDefined(); // the palette still owns the keyboard
    expect(frame()).toContain('HMSG59'); // the transcript did NOT scroll (follow was never paused behind the overlay)
  });

  it('CONSUMES a mouse report on the BARE Home (no chat viewport) — its raw bytes never type into the prompt (Step 5)', async () => {
    // `driveHome` enables mouse reporting for the whole alt-screen Home, so a wheel/click arrives in `home` mode too.
    // Nothing to scroll there, but the report must still be swallowed rather than routed to `controller.handleKey`.
    const store = createChatStore(false);
    const { c, harness } = mountHome(store, { alternateScreen: true });
    await waitFor(() => (harness.lastFrame() ?? '').length > 0);
    expect(c.getSnapshot().mode).toBe('home');

    harness.stdin.write('\x1b[<64;10;5M'); // wheel up
    harness.stdin.write('\x1b[<0;10;5M'); // a left click
    for (let i = 0; i < 4; i += 1) await flush();

    expect(c.getSnapshot().input.text).toBe(''); // no raw mouse bytes typed into the Home prompt
    expect(c.getSnapshot().mode).toBe('home'); // …and nothing else was triggered
  });

  it('CONSUMES a mouse report while an overlay owns the keyboard — never types into the palette filter (Step 5)', async () => {
    const store = createChatStore(false);
    for (let i = 0; i < 60; i += 1) store.appendUser(`HMSG${i}`);
    const { c, harness } = mountHome(store, { alternateScreen: true });
    await enterChat(c);
    const frame = (): string => harness.lastFrame() ?? '';
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 4; i += 1) await flush();
    };
    await waitFor(() => frame().includes('HMSG59'));
    await settle();

    c.handleKey('/', {}); // the `/` palette owns the keyboard
    await settle();
    harness.stdin.write('\x1b[<64;10;5M'); // a wheel notch behind the overlay
    await settle();

    expect(c.getSnapshot().palette?.query).toBe(''); // the mouse bytes did NOT enter the palette filter
    expect(frame()).toContain('HMSG59'); // …and the transcript did not scroll behind the overlay
  });

  it('re-follows the tail across a /models reseat that PRESERVES the sessionId (object-identity reset, Step 4b-2 Sonnet)', async () => {
    // A `/models` reseat keeps the SAME sessionId across the swap (the reseated session adopts the durable row) but
    // hands back a NEW session OBJECT. The scroll-reset effect must key on that object identity, NOT the durable id —
    // else a scrolled-away transcript stays frozen after a live model switch. Scroll up off the tail, reseat, and the
    // view must re-follow. (A sessionId-keyed effect would MISS this — same id in, same id out — so this discriminates.)
    const store = createChatStore(false);
    for (let i = 0; i < 60; i += 1) store.appendUser(`HMSG${i}`);
    const sessionA = makeSession(store, 'sess-A');
    const sessionB = makeSession(store, 'sess-A'); // reseat: DIFFERENT object, SAME sessionId, SAME transcript store
    const reseatChat = vi.fn(() => Promise.resolve(sessionB));
    const { c, harness } = mountHome(store, {
      alternateScreen: true,
      startChat: () => Promise.resolve(sessionA),
      reseatChat,
      models: makeModelsPort('claude-opus-4-8'),
    });
    await enterChat(c);
    const frame = (): string => harness.lastFrame() ?? '';
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 4; i += 1) await flush();
    };
    await waitFor(() => frame().includes('HMSG59'));
    await settle();

    harness.stdin.write('\x1b[5~'); // PgUp
    await settle();
    harness.stdin.write('\x1b[5~');
    await settle();
    expect(frame()).not.toContain('HMSG59'); // scrolled up off the tail (follow paused)

    // Drive the in-Home /models reseat via the controller (deterministic): `/` → filter `models` → run → accept.
    c.handleKey('/', {});
    for (const ch of 'models') c.handleKey(ch, {});
    c.handleKey('', { return: true });
    await settle();
    expect(c.getSnapshot().modelPicker).toBeDefined(); // the picker opened in-chat
    c.handleKey('', { return: true }); // accept the only model → live reseat
    await waitFor(() => c.getSnapshot().session === sessionB);
    await settle();

    expect(reseatChat).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().session?.sessionId).toBe('sess-A'); // the reseat PRESERVED the id (the trap the fix survives)
    expect(frame()).toContain('HMSG59'); // the view RE-FOLLOWED the tail after the swap (object-identity reset fired)
  });
});
