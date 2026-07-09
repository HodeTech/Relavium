import type { SessionStreamHandleEvent, ToolApprovalRequest } from '@relavium/core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalAnswer } from '../../chat/chat-mode.js';
import type { DoctorProbes } from '../../chat/doctor.js';
import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { bracketed, waitFor } from './harness-util.js';
import { RootApp } from './home-app.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
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

/** A minimal in-Home chat session fake — only the fields the controller reads on the paste / timer paths. */
function makeSession(store: ChatStoreController): HomeChatSession {
  return {
    store,
    sessionId: 'sess-fake',
    processLine: async () => {},
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
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
function mountHome(store: ChatStoreController): MountedHome {
  let onResize: () => void = () => {};
  let size = { cols: 100, rows: 30 };
  const c = createHomeController({
    doctorProbes: STUB_DOCTOR_PROBES,
    startChat: () => Promise.resolve(makeSession(store)),
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
