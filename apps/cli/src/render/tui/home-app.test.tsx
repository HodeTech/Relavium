import type { SessionStreamHandleEvent, ToolApprovalRequest } from '@relavium/core';
import type { ModelCatalogEntry } from '@relavium/llm';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReseatTarget } from '../../commands/chat.js';
import type { ApprovalAnswer } from '../../chat/chat-mode.js';
import type { DoctorProbes } from '../../chat/doctor.js';
import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import { createSuspendPort } from '../suspend.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import {
  FULLSCREEN_TRANSCRIPT_BOUND,
  INLINE_TRANSCRIPT_BOUND,
  assertRenderStoreAgree,
  type TranscriptEntry,
} from './session-view-model.js';
import { bracketed, settleFrames, waitFor } from './harness-util.js';
import { RootApp } from './home-app.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeModelsPort,
} from './home-controller.js';
import { COPIED_TOAST_MS } from './tui-constants.js';

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
    reseatChat?: (
      sessionId: string,
      target: ReseatTarget,
      carriedTranscript: readonly TranscriptEntry[],
    ) => Promise<HomeChatSession>;
    models?: HomeModelsPort;
    /** Capture what copy-on-select would put on the clipboard (2.6.F Step 6). */
    clipboard?: (text: string) => { kind: 'written'; characters: number };
    /** `[preferences].show_banner` (2.6.F Step 5g). */
    showBanner?: boolean;
    /** A non-empty Home strip, so `isEmpty` is false (2.6.F Step 5g). */
    snapshot?: HomeSnapshot;
    /** The initial terminal size (`rows` decides whether the banner fits). */
    size?: { cols: number; rows: number };
    /** `false` ⇒ the `NO_COLOR` / `--no-color` path (plain-ASCII banner). */
    color?: boolean;
    /** Record the mouse-capture toggles `RootApp` requests (2.6.F Step 6g). */
    setMouseCapture?: (enabled: boolean) => void;
  } = {},
): MountedHome {
  let onResize: () => void = () => {};
  let size = opts.size ?? { cols: 100, rows: 30 };
  const snapshot = opts.snapshot; // captured so `read: () => snapshot` narrows without an `as` cast
  const c = createHomeController({
    doctorProbes: STUB_DOCTOR_PROBES,
    startChat: opts.startChat ?? (() => Promise.resolve(makeSession(store))),
    ...(opts.reseatChat !== undefined ? { reseatChat: opts.reseatChat } : {}),
    ...(opts.models !== undefined ? { models: opts.models } : {}),
    homeStore: snapshot === undefined ? homeStore : { read: () => snapshot },
    onExit: vi.fn(),
    onError: vi.fn(),
  });
  // The fixture must be one production could build: an alt-screen Home gets a FULL-SCREEN store, an inline Home an
  // INLINE one (drive-home derives both from the same `altScreenActive`). Asserted HERE — ordinary code, not a React
  // render — so a divergent fixture fails loudly. Inside a component it would be swallowed by ink's no-op error
  // callbacks and the test would pass on a DEAD TREE, which is exactly how two of these fixtures used to "pass".
  assertRenderStoreAgree(opts.alternateScreen === true, store.getSnapshot().state.transcriptBound);
  const harness = render(
    <RootApp
      controller={c}
      nowMs={() => Date.now()}
      color={opts.color ?? false}
      getSize={() => size}
      subscribeResize={(cb) => {
        onResize = cb;
        return () => {};
      }}
      {...(opts.alternateScreen === true ? { alternateScreen: true } : {})}
      {...(opts.clipboard === undefined ? {} : { clipboard: opts.clipboard })}
      {...(opts.showBanner === undefined ? {} : { showBanner: opts.showBanner })}
      {...(opts.setMouseCapture === undefined ? {} : { setMouseCapture: opts.setMouseCapture })}
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
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const { c, harness } = mountHome(store);
    await enterChat(c);
    expect(c.getSnapshot().mode).toBe('chat');

    harness.stdin.write(bracketed('hello world'));
    await waitFor(() => c.getSnapshot().input.text.includes('hello world'));
    expect(c.getSnapshot().input.text).toContain('hello world');
  });

  it('normalizes CRLF/CR in a pasted block to LF exactly (a\\r\\nb\\rc → a\\nb\\nc)', async () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const { c, harness } = mountHome(store);
    await enterChat(c);

    harness.stdin.write(bracketed('a\r\nb\rc'));
    // The Home exposes the raw compose buffer, so pin the normalization EXACTLY — this distinguishes real `\r\n?`→
    // `\n` from CR-stripping ('abc'), CR-preserving ('a\r\nb\rc'), and a dropped paste ('').
    await waitFor(() => c.getSnapshot().input.text === 'a\nb\nc');
    expect(c.getSnapshot().input.text).toBe('a\nb\nc');
  });

  it('SECURITY: a pasted approval token cannot answer the fail-closed floor nor leak into the buffer (ADR-0057)', async () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
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
      const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
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
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
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
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
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
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    for (let i = 0; i < 60; i += 1) store.appendUser(`HMSG${i}`);
    const { c, harness } = mountHome(store, { alternateScreen: true });
    await enterChat(c);
    const frame = (): string => harness.lastFrame() ?? '';
    const press = async (seq: string): Promise<void> => {
      harness.stdin.write(seq);
      await settleFrames();
    };
    await waitFor(() => frame().includes('HMSG59'));
    await settleFrames();
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
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    for (let i = 0; i < 60; i += 1) store.appendUser(`HMSG${i}`);
    const { c, harness } = mountHome(store, { alternateScreen: true });
    await enterChat(c);
    const frame = (): string => harness.lastFrame() ?? '';
    await waitFor(() => frame().includes('HMSG59'));
    await settleFrames();
    expect(frame()).toContain('HMSG59'); // following the tail

    c.handleKey('/', {}); // open the `/` command palette — it now owns the keyboard
    await settleFrames();
    expect(c.getSnapshot().palette).toBeDefined();

    harness.stdin.write('\x1b[5~'); // PgUp — must be consumed by the palette, NOT the transcript scroll keymap
    await settleFrames();
    expect(c.getSnapshot().palette).toBeDefined(); // the palette still owns the keyboard
    expect(frame()).toContain('HMSG59'); // the transcript did NOT scroll (follow was never paused behind the overlay)
  });

  it('CONSUMES a mouse report on the BARE Home (no chat viewport) — its raw bytes never type into the prompt (Step 5)', async () => {
    // `driveHome` enables mouse reporting for the whole alt-screen Home, so a wheel/click arrives in `home` mode too.
    // Nothing to scroll there, but the report must still be swallowed rather than routed to `controller.handleKey`.
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    const { c, harness } = mountHome(store, { alternateScreen: true });
    await waitFor(() => (harness.lastFrame() ?? '').length > 0);
    expect(c.getSnapshot().mode).toBe('home');

    harness.stdin.write('\x1b[<64;10;5M'); // wheel up
    harness.stdin.write('\x1b[<0;10;5M'); // a left click
    await settleFrames();

    expect(c.getSnapshot().input.text).toBe(''); // no raw mouse bytes typed into the Home prompt
    expect(c.getSnapshot().mode).toBe('home'); // …and nothing else was triggered
  });

  it('CONSUMES a mouse report while an overlay owns the keyboard — never types into the palette filter (Step 5)', async () => {
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    for (let i = 0; i < 60; i += 1) store.appendUser(`HMSG${i}`);
    const { c, harness } = mountHome(store, { alternateScreen: true });
    await enterChat(c);
    const frame = (): string => harness.lastFrame() ?? '';
    await waitFor(() => frame().includes('HMSG59'));
    await settleFrames();

    c.handleKey('/', {}); // the `/` palette owns the keyboard
    await settleFrames();
    harness.stdin.write('\x1b[<64;10;5M'); // a wheel notch behind the overlay
    await settleFrames();

    expect(c.getSnapshot().palette?.query).toBe(''); // the mouse bytes did NOT enter the palette filter
    expect(frame()).toContain('HMSG59'); // …and the transcript did not scroll behind the overlay
  });

  it('re-follows the tail across a /models reseat that PRESERVES the sessionId (object-identity reset, Step 4b-2 Sonnet)', async () => {
    // A `/models` reseat keeps the SAME sessionId across the swap (the reseated session adopts the durable row) but
    // hands back a NEW session OBJECT. The scroll-reset effect must key on that object identity, NOT the durable id —
    // else a scrolled-away transcript stays frozen after a live model switch. Scroll up off the tail, reseat, and the
    // view must re-follow. (A sessionId-keyed effect would MISS this — same id in, same id out — so this discriminates.)
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
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
    await waitFor(() => frame().includes('HMSG59'));
    await settleFrames();

    harness.stdin.write('\x1b[5~'); // PgUp
    await settleFrames();
    harness.stdin.write('\x1b[5~');
    await settleFrames();
    expect(frame()).not.toContain('HMSG59'); // scrolled up off the tail (follow paused)

    // Drive the in-Home /models reseat via the controller (deterministic): `/` → filter `models` → run → accept.
    c.handleKey('/', {});
    for (const ch of 'models') c.handleKey(ch, {});
    c.handleKey('', { return: true });
    await settleFrames();
    expect(c.getSnapshot().modelPicker).toBeDefined(); // the picker opened in-chat
    c.handleKey('', { return: true }); // accept the only model → live reseat
    await waitFor(() => c.getSnapshot().session === sessionB);
    await settleFrames();

    expect(reseatChat).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().session?.sessionId).toBe('sess-A'); // the reseat PRESERVED the id (the trap the fix survives)
    expect(frame()).toContain('HMSG59'); // the view RE-FOLLOWED the tail after the swap (object-identity reset fired)
  });
});

/**
 * The ADR-0068 §e suspend PORT on the HOME surface (2.6.F Step 5d). Unlike `relavium chat`, `createHomeController` is
 * built BEFORE this tree mounts and every existing Home port flows core→React — so this bridge is the inversion, and
 * the in-Home chat's `/scrollback` and `/edit` depend entirely on it.
 */
describe('RootApp — the suspend port (ADR-0068 §e)', () => {
  it('attaches a WORKING suspendTerminal while mounted, and detaches on unmount', async () => {
    const port = createSuspendPort();
    const c = createHomeController({
      doctorProbes: STUB_DOCTOR_PROBES,
      startChat: () =>
        Promise.resolve(
          makeSession(createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND)),
        ),
      homeStore,
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    const harness = render(
      <RootApp
        controller={c}
        nowMs={() => Date.now()}
        color={false}
        getSize={() => ({ cols: 80, rows: 24 })}
        subscribeResize={() => () => {}}
        suspendPort={port}
      />,
    );
    await waitFor(() => port.current() !== undefined);

    let ran = false;
    await port.current()?.(() => {
      ran = true;
      return Promise.resolve();
    });
    expect(ran).toBe(true); // ink's REAL suspendTerminal, driven through the port

    harness.unmount();
    await settleFrames();
    expect(port.current()).toBeUndefined();
  });
});

/**
 * Mouse SELECTION on the HOME surface (2.6.F Step 6). The in-Home chat and `relavium chat` share `reduceSelection`,
 * `cellAt` and the highlight split, so what needs pinning here is the WIRING: that the Home's own `useInput` routes
 * press/drag/release into the reducer with its own viewport geometry, and that the release reaches the clipboard.
 */
describe('RootApp — mouse selection in the in-Home chat', () => {
  const seedThree = (): ChatStoreController => {
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    store.notice('AAAA');
    store.notice('BBBB');
    store.notice('CCCC');
    return store;
  };

  it('a DRAG in the in-Home chat copies exactly the cells it covered', async () => {
    const copied: string[] = [];
    const store = seedThree();
    const m = mountHome(store, {
      alternateScreen: true,
      clipboard: (text) => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    await enterChat(m.c);
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('AAAA'));

    m.harness.stdin.write('\x1b[<0;1;1M'); // press line 0, column 0
    await settleFrames();
    m.harness.stdin.write('\x1b[<32;3;1M'); // drag to column 2 (inclusive)
    await settleFrames();
    m.harness.stdin.write('\x1b[<0;3;1m'); // release ⇒ copy
    await settleFrames();

    expect(copied).toEqual(['AAA']);
  });

  it('the BARE Home (no chat) consumes a mouse report and copies nothing — there is no transcript', async () => {
    const copied: string[] = [];
    const m = mountHome(seedThree(), {
      alternateScreen: true,
      clipboard: (text) => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    await settleFrames();

    m.harness.stdin.write('\x1b[<0;1;1M');
    m.harness.stdin.write('\x1b[<32;5;1M');
    m.harness.stdin.write('\x1b[<0;5;1m');
    await settleFrames();

    expect(copied).toEqual([]);
    expect(m.c.getSnapshot().input.text).toBe(''); // …and no raw bytes typed into the Home prompt
  });

  it('a plain CLICK copies nothing; the WHEEL still scrolls and never copies', async () => {
    const copied: string[] = [];
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    for (let i = 0; i < 60; i += 1) store.notice(`row-${String(i).padStart(2, '0')}`);
    const m = mountHome(store, {
      alternateScreen: true,
      clipboard: (text) => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    await enterChat(m.c);
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('row-59'));

    m.harness.stdin.write('\x1b[<0;2;2M');
    await settleFrames();
    m.harness.stdin.write('\x1b[<0;2;2m'); // release at the same cell ⇒ a click
    await settleFrames();
    expect(copied).toEqual([]);

    m.harness.stdin.write('\x1b[<64;5;5M'); // wheel up
    await settleFrames();
    expect(m.harness.lastFrame() ?? '').not.toContain('row-59');
    expect(copied).toEqual([]);
  });

  it('after SCROLLING, a drag copies the line now shown on that row — not line 0', async () => {
    // The Home builds its own viewport facts, so `chat-app.test.tsx`'s equivalent proves nothing here: an `offset: 0`
    // break in `home-app.tsx` alone would ship green (Step-6 Opus review).
    const copied: string[] = [];
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    for (let i = 0; i < 60; i += 1) store.notice(`row-${String(i).padStart(2, '0')}`);
    const m = mountHome(store, {
      alternateScreen: true,
      clipboard: (text) => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    await enterChat(m.c);
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('row-59'));

    for (let i = 0; i < 4; i += 1) {
      m.harness.stdin.write('\x1b[<64;5;5M'); // wheel up: leave the tail
      await settleFrames();
    }
    const thirdRow = (m.harness.lastFrame() ?? '').split('\n')[2]?.trim();
    expect(thirdRow).toMatch(/^row-\d\d$/);
    expect(thirdRow).not.toBe('row-02');

    m.harness.stdin.write('\x1b[<0;1;3M'); // press the third row (an INNER row: row 1 is the edge-scroll zone)
    await settleFrames();
    m.harness.stdin.write('\x1b[<32;99;3M'); // drag past its right edge ⇒ the whole row
    await settleFrames();
    m.harness.stdin.write('\x1b[<0;99;3m');
    await settleFrames();

    expect(copied).toEqual([thirdRow]);
  });

  it('a drag in the SAME tick as an append reduces against the LIVE wrap, not the last measured one', async () => {
    // `onMeasure` fires after a render; a mouse report that arrives before the next one sees a stale `totalLines`,
    // and while following the tail that shifts `effectiveOffset` by exactly the number of new lines. Substituting the
    // measured count for the live one is invisible to every test that settles a frame in between (break-verified).
    const copied: string[] = [];
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    for (let i = 0; i < 60; i += 1) store.notice(`row-${String(i).padStart(2, '0')}`);
    const m = mountHome(store, {
      alternateScreen: true,
      clipboard: (text) => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    await enterChat(m.c);
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('row-59'));

    // No `settleFrames` between the append and the gesture: `scrollGeomRef` still says 60 lines.
    store.notice('row-60');
    m.harness.stdin.write('\x1b[<0;1;3M');
    m.harness.stdin.write('\x1b[<32;99;3M');
    m.harness.stdin.write('\x1b[<0;99;3m');
    await settleFrames();

    const thirdRow = (m.harness.lastFrame() ?? '').split('\n')[2]?.trim();
    expect(copied).toEqual([thirdRow]); // the row the append pushed there, not the one that was there before
  });

  it('a WRAPPED entry copies the VISUAL row under the pointer, not the whole logical line', async () => {
    // The transcript the selection indexes is the WRAPPED one. Copying raw entries instead of wrapped rows stays green
    // for as long as no line is wider than the terminal — so make one that is.
    const copied: string[] = [];
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    store.notice('A'.repeat(140)); // at 100 columns this wraps into two display rows
    const m = mountHome(store, {
      alternateScreen: true,
      clipboard: (text) => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    await enterChat(m.c);
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('AAAA'));

    const frame = (m.harness.lastFrame() ?? '').split('\n');
    const firstRow = frame.findIndex((l) => l.startsWith('AAAA'));
    expect(firstRow).toBeGreaterThanOrEqual(0);
    expect(frame[firstRow + 1]?.startsWith('AAAA')).toBe(true); // it really wrapped

    // Drag the SECOND visual row only. Terminal rows are 1-based.
    const row = String(firstRow + 2);
    m.harness.stdin.write(`\x1b[<0;1;${row}M`);
    await settleFrames();
    m.harness.stdin.write(`\x1b[<32;200;${row}M`);
    await settleFrames();
    m.harness.stdin.write(`\x1b[<0;200;${row}m`);
    await settleFrames();

    expect(copied).toHaveLength(1);
    expect(copied[0]).toBe('A'.repeat(40)); // the 40-char remainder, not all 140
  });

  it('a RESIZE drops the live selection — re-wrapping moves every display-line index it holds', async () => {
    const copied: string[] = [];
    const store = seedThree();
    const m = mountHome(store, {
      alternateScreen: true,
      clipboard: (text) => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    await enterChat(m.c);
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('AAAA'));

    m.harness.stdin.write('\x1b[<0;1;1M'); // press…
    await settleFrames();
    m.harness.stdin.write('\x1b[<32;3;1M'); // …drag…
    await settleFrames();

    m.setSize({ cols: 60, rows: 30 });
    m.fireResize();
    await settleFrames();

    m.harness.stdin.write('\x1b[<0;3;1m'); // …release AFTER the resize
    await settleFrames();
    expect(copied).toEqual([]); // the anchor was dropped, so there is nothing to copy
  });
});

/**
 * THE COPY-ON-SELECT CONFIRMATION TOAST on the HOME surface (2.6.F Step 6i). The in-Home chat threads its OWN
 * `useCopiedToast` through `ChatRegion` (a separate mount from `relavium chat`'s `ChatApp`), so `chat-app.test.tsx`'s
 * toast tests prove nothing here — a `copied` prop dropped between `RootApp` and `ChatRegion`, or a `flashCopied()`
 * left off the Home's `copySelection`, would ship green there and dark here. Colour is off by default (`mountHome`),
 * so the toast renders as the plain `[Copied]` pill — `.toContain('Copied')` matches either rendering.
 */
describe('RootApp — the copy-on-select "Copied" toast', () => {
  const seedThree = (): ChatStoreController => {
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    store.notice('AAAA');
    store.notice('BBBB');
    store.notice('CCCC');
    return store;
  };

  /** Enter the in-Home chat, then drive a press-drag-release that copies one row. */
  const copyOnce = async (m: MountedHome): Promise<void> => {
    await enterChat(m.c);
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('AAAA'));
    m.harness.stdin.write('\x1b[<0;1;1M'); // press line 0, column 0
    await settleFrames();
    m.harness.stdin.write('\x1b[<32;3;1M'); // drag to column 2 (inclusive)
    await settleFrames();
    m.harness.stdin.write('\x1b[<0;3;1m'); // release ⇒ copy
    await settleFrames();
  };

  it('appears after a copy, ABOVE the footer, and leaves the transcript intact', async () => {
    const copied: string[] = [];
    const m = mountHome(seedThree(), {
      alternateScreen: true,
      clipboard: (text) => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    await copyOnce(m);
    expect(copied).toEqual(['AAA']); // the write happened
    const rows = (m.harness.lastFrame() ?? '').split('\n');
    const toastRow = rows.findIndex((r) => r.includes('Copied'));
    const footerRow = rows.findIndex((r) => r.includes('turns'));
    expect(toastRow).toBeGreaterThanOrEqual(0);
    expect(toastRow).toBeLessThan(footerRow); // the toast sits just above the status footer
    expect(rows.some((r) => r.includes('AAAA'))).toBe(true); // the transcript is untouched — the toast is not a line
  });

  it('auto-dismisses after COPIED_TOAST_MS', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const copied: string[] = [];
      const m = mountHome(seedThree(), {
        alternateScreen: true,
        clipboard: (text) => {
          copied.push(text);
          return { kind: 'written', characters: text.length };
        },
      });
      await copyOnce(m);
      expect(m.harness.lastFrame() ?? '').toContain('Copied');
      await vi.advanceTimersByTimeAsync(COPIED_TOAST_MS + 50);
      await settleFrames();
      expect(m.harness.lastFrame() ?? '').not.toContain('Copied');
    } finally {
      vi.useRealTimers();
    }
  });

  it('WITHOUT a clipboard port (copy-on-select off) there is no toast', async () => {
    const m = mountHome(seedThree(), { alternateScreen: true }); // no `clipboard` ⇒ copy is inert
    await copyOnce(m);
    expect(m.harness.lastFrame() ?? '').not.toContain('Copied');
  });
});

/**
 * The branded Home banner ON SCREEN (2.6.F Step 5g). `banner.test.ts` pins the plaque itself; this pins that it
 * REPLACES the plain heading, obeys `[preferences].show_banner`, and never pushes the prompt off an 80x24 terminal.
 */
describe('RootApp — the branded Home banner', () => {
  const BUSY: HomeSnapshot = {
    attention: { gates: [], failedRuns: [] },
    recentSessions: [
      {
        sessionId: 'sess-9',
        title: 'a chat',
        agentSlug: 'default',
        modelId: 'anthropic/claude-opus-4-8',
        status: 'active',
        updatedAt: '2026-07-10T00:00:00.000Z',
        totalCostMicrocents: 0,
      },
    ],
    recentRuns: [],
    recentAgents: [],
    isEmpty: false,
  };

  const frameOf = async (opts: Parameters<typeof mountHome>[1]): Promise<string> => {
    const m = mountHome(createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND), opts);
    await settleFrames();
    return m.harness.lastFrame() ?? '';
  };

  /** The frame's lines, trimmed — so "is the plain heading anywhere on screen" is one question, not a position. */
  const rows = (frame: string): string[] => frame.split('\n').map((l) => l.trim());

  it('an EMPTY Home shows the plaque, and the plain heading is GONE (it is replaced, not stacked)', async () => {
    const frame = await frameOf({});
    expect(frame).toContain('R E L A V I U M');
    expect(frame).toContain('Own every run.');
    // Checking only row 0 would pass while the heading sat just BELOW the plaque (break-verified).
    expect(rows(frame)).not.toContain('relavium');
  });

  it('a BUSY Home falls back to the plain heading — the banner auto-dismisses', async () => {
    const frame = await frameOf({ snapshot: BUSY });
    expect(frame).not.toContain('R E L A V I U M');
    expect(rows(frame)).toContain('relavium');
  });

  it('`show_banner = false` hides it even on an empty Home', async () => {
    const frame = await frameOf({ showBanner: false });
    expect(frame).not.toContain('R E L A V I U M');
  });

  it('`show_banner = true` brings it back on a busy Home', async () => {
    const frame = await frameOf({ showBanner: true, snapshot: BUSY });
    expect(frame).toContain('R E L A V I U M');
  });

  it('on an 80x24 terminal the plaque never obscures the prompt', async () => {
    const frame = await frameOf({ size: { cols: 80, rows: 24 } });
    expect(frame).toContain('R E L A V I U M');
    // The prompt marker still renders, and no line wrapped past 80 columns.
    expect(frame).toContain('>');
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('renders WITHOUT a React duplicate-key error under NO_COLOR — the two ASCII borders are byte-identical', async () => {
    // The Home mounts ink with `patchConsole: false`, so a React runtime error goes straight to stderr — printed onto
    // the alt buffer, over the frame. Keying the plaque's rows by their TEXT did exactly that (whole-phase review).
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const m = mountHome(createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND), {
        color: false,
      });
      await settleFrames();
      expect(m.harness.lastFrame() ?? '').toContain('R E L A V I U M');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('a FORCED banner on a busy 80x24 Home stands down rather than crowd the strip', async () => {
    const frame = await frameOf({ showBanner: true, snapshot: BUSY, size: { cols: 80, rows: 24 } });
    expect(frame).not.toContain('R E L A V I U M');
    expect(frame).toContain('a chat'); // the strip the banner would have pushed away
  });
});

/**
 * MOUSE CAPTURE FOLLOWS THE CHAT (2.6.F Step 6g, whole-phase Opus review). Capturing the mouse for the whole Home was
 * a regression: the landing has no viewport to wheel-scroll and no in-app selection, so a user lost the emulator's own
 * click-drag there and got nothing back — they could not even copy a session id off the strip.
 */
describe('RootApp — mouse capture follows the in-Home chat', () => {
  it('the bare Home does NOT capture; entering the chat does', async () => {
    // The release side (`setMouseCapture(false)` ⇒ DISABLE_MOUSE) is pinned at the port, in `drive-home.test.ts`.
    // Here the claim is that the effect tracks `state.mode`: hardcoding `alternateScreen` would capture the landing.
    const toggles: boolean[] = [];
    const m = mountHome(createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND), {
      alternateScreen: true,
      setMouseCapture: (enabled) => toggles.push(enabled),
    });
    await settleFrames();
    expect(toggles).toEqual([false]); // the landing keeps the emulator's own click-drag selection

    await enterChat(m.c);
    await settleFrames();
    expect(toggles.at(-1)).toBe(true);
  });

  it('an OVERLAY over the chat does not release the mouse — that would be DECSET churn', async () => {
    const toggles: boolean[] = [];
    const m = mountHome(createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND), {
      alternateScreen: true,
      setMouseCapture: (enabled) => toggles.push(enabled),
    });
    await enterChat(m.c);
    await settleFrames();
    const before = toggles.length;

    m.harness.stdin.write('/'); // open the palette over the chat
    await settleFrames();
    expect(toggles).toHaveLength(before); // no new toggle
  });

  it('the INLINE Home does not CONSUME mouse-report bytes either — nothing enables the mouse there', async () => {
    // The `alternateScreen` guard in `consumeMouseReport` is what keeps the reader (and its partial-report buffer)
    // out of a renderer that never receives a report. Without it, a user typing `[<0;1;1M` would have it swallowed.
    const m = mountHome(createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND), {}); // no `alternateScreen` ⇒ INLINE store
    await settleFrames();
    m.harness.stdin.write('[<0;1;1M');
    await settleFrames();
    expect(m.c.getSnapshot().input.text).toBe('[<0;1;1M'); // typed, not eaten
  });

  it('the INLINE Home never captures, whatever the mode', async () => {
    const toggles: boolean[] = [];
    const m = mountHome(createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND), {
      setMouseCapture: (enabled) => toggles.push(enabled),
    });
    await settleFrames();
    await enterChat(m.c);
    await settleFrames();
    expect(toggles.every((t) => t === false)).toBe(true);
  });
});

/**
 * F1 ON SCREEN (2.6.C) — the mounted proof. `drive-home.test.ts` pins the reseated STORE's transcript through the
 * real builder; this pins what the USER sees: after a `/models` switch on the full-screen renderer, the prior
 * conversation is still rendered, with the switch marker beneath it.
 *
 * The fake must model what production DOES: a reseat builds a BRAND-NEW view store, seeded with the outgoing store's
 * rendered transcript (`drive-home.tsx` → `createChatStore(color, { …, transcript }, transcriptBoundFor(alt))`). A
 * fake that hands back a session over the SAME store object would keep the conversation on screen for free and could
 * never fail against the un-fixed code — the precise shape of false confidence that let F1 ship past the existing
 * reseat tests in the first place.
 */
describe('RootApp — a /models reseat keeps the conversation on screen (F1)', () => {
  it('the alt-screen viewport re-renders the prior turns FROM THE SWAPPED STORE, with the switch marker last', async () => {
    // The outgoing store must carry its MODEL, or the marker degrades to `(unknown) → …` and the assertions below
    // cannot tell a correct marker from a broken one. Production seeds it; so must the fixture.
    const store = createChatStore(
      false,
      { model: 'claude-sonnet-4-6', transcript: [] },
      FULLSCREEN_TRANSCRIPT_BOUND,
    );
    store.appendUser('what is 2+2');
    store.notice('assistant: four');
    // A NON-notice tail, deliberately: the switch marker is a `notice`, so a conversation ending in one would let
    // `at(-1).role === 'notice'` pass even if the marker were never appended. The last entry must only be able to be
    // the marker.
    store.appendUser('and 3+3');

    const m = mountHome(store, {
      alternateScreen: true,
      models: makeModelsPort('claude-opus-4-8'),
      // Production's shape: a NEW store, seeded with the carried transcript, at the full-screen bound.
      reseatChat: (sessionId, _target, carriedTranscript) =>
        Promise.resolve(
          makeSession(
            createChatStore(
              false,
              { model: 'claude-opus-4-8', transcript: carriedTranscript },
              FULLSCREEN_TRANSCRIPT_BOUND,
            ),
            sessionId,
          ),
        ),
    });
    await enterChat(m.c);
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('what is 2+2'));

    // Open the reseat picker from the chat palette (`/` → filter `models` → run), then accept the one model.
    m.c.handleKey('/', {});
    for (const ch of 'models') m.c.handleKey(ch, {});
    m.c.handleKey('', { return: true });
    await settleFrames();
    expect(m.c.getSnapshot().modelPicker).toBeDefined(); // the picker opened IN the chat
    m.c.handleKey('', { return: true }); // accept ⇒ a LIVE reseat
    await waitFor(
      () => m.c.getSnapshot().session?.store.getSnapshot().state.model === 'claude-opus-4-8',
    );
    await settleFrames();

    // THE FRAME — the assertion only a mounted test can make, and the one this test exists for. `ChatRegion`
    // subscribes to the session's store (`useSyncExternalStore`), so after the swap the viewport must re-render from
    // the NEW store. Before the fix that store opened empty and the alt buffer (which has no native scrollback
    // behind it) showed nothing but the switch notice. Asserting the STORE alone would only repeat what
    // `home-controller.test.ts` and the gate unit tests already pin, and would stay green if the viewport failed to
    // repaint from the swapped store at all.
    const frame = m.harness.lastFrame() ?? '';
    expect(frame).toContain('what is 2+2');
    expect(frame).toContain('and 3+3');
    // The MODEL'S output, not just the user's. Asserting only the two `user` entries would leave a carry that kept
    // `role === 'user'` and dropped everything else fully green — the marker is appended after the swap, so it would
    // still be on screen — while the half of the conversation the user actually paid for silently vanished.
    expect(frame).toContain('assistant: four');
    // The marker names BOTH ends, IN ORDER. `toContain('claude-opus-4-8')` alone would pass a REVERSED marker.
    expect(frame).toContain('claude-sonnet-4-6 → claude-opus-4-8');

    // …and the marker lands BENEATH the conversation, not in place of it.
    const carried = m.c.getSnapshot().session?.store.getSnapshot().state.transcript ?? [];
    expect(carried.at(-1)?.role).toBe('notice');
    expect(carried.at(-1)?.text).toContain('claude-sonnet-4-6 → claude-opus-4-8'); // the marker, in order
    expect(carried.at(-1)?.text).toContain('@-attached file contents included'); // ADR-0059's bound disclosure
  });
});
