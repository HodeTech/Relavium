import type { SessionStreamHandleEvent, ToolApprovalRequest } from '@relavium/core';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { ApprovalAnswer } from '../../chat/chat-mode.js';
import { ChatApp } from './chat-ink.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';

/**
 * Mounted-`ChatApp` component tests (2.6.F Step 3, ADR-0068 part f) — the harness's first end-to-end renders of a
 * REAL surface component through ink-testing-library. Where `chat-input.test.ts` unit-tests the pure reducers and
 * `home-controller.test.ts` drives the ink-free controller, this file exercises the parts that ONLY exist once the
 * component is mounted under ink 7: the `usePaste` bracketed-paste channel (separate from `useInput`), the
 * `Date.now()`-per-render live timer, and the store→`useSyncExternalStore` repaint economy.
 *
 * The two load-bearing pins here:
 *   • SECURITY (ADR-0057) — a bracketed paste can never answer the fail-closed per-tool approval floor, because ink 7
 *     routes the whole DECSET-2004 block to `usePaste` (dropped behind the approval gate), never to `useInput`.
 *   • 2.5.H frozen-clock — the live-turn elapsed counter tracks WALL time (re-read each render), not a value frozen
 *     at turn start.
 */

/** Yield until ink's React-19 reconciler has committed the frame scheduled by the preceding stdin/store change. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Mount `ChatApp` with the minimal REQUIRED props (no optional ports) — the surface under test is the ink
 *  lifecycle + the raw-mode input/paste handlers, so the driver callbacks are inert stubs. */
function mountChat(store: ChatStoreController): ReturnType<typeof render> {
  return render(
    <ChatApp
      store={store}
      onSubmit={async () => {}}
      shouldStop={() => false}
      onExit={() => {}}
      onError={() => {}}
      onModeChange={() => {}}
    />,
  );
}

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

/** Wrap a payload in the DECSET-2004 markers ink 7's input parser recognizes → a single `usePaste` event. */
const bracketed = (body: string): string => `\x1b[200~${body}\x1b[201~`;

describe('ChatApp bracketed paste — ink-7 usePaste channel (ADR-0068)', () => {
  it('inserts an idle paste into the compose buffer', async () => {
    const store = createChatStore(false);
    const { lastFrame, stdin, unmount } = mountChat(store);
    await flush();
    stdin.write(bracketed('hello world'));
    await flush();
    expect(lastFrame()).toContain('hello world');
    unmount();
  });

  it('collapses CRLF/CR in a pasted block to LF (byte-normalized, no stray carriage returns)', async () => {
    const store = createChatStore(false);
    const { lastFrame, stdin, unmount } = mountChat(store);
    await flush();
    stdin.write(bracketed('a\r\nb\rc'));
    await flush();
    // The normalized buffer is three lines (a / b / c) — no CR survives to corrupt the terminal render.
    expect(lastFrame()).not.toContain('\r');
    unmount();
  });

  it('SECURITY: a paste during a pending approval neither answers the floor nor leaks into the buffer (ADR-0057)', async () => {
    const store = createChatStore(false);
    const { lastFrame, stdin, unmount } = mountChat(store);
    await flush();
    let answered: ApprovalAnswer | undefined;
    void store.requestApproval(approvalReq, false).then((a) => {
      answered = a;
    });
    await flush();
    expect(store.getSnapshot().approval).toBeDefined(); // the prompt is up and owns the keyboard

    // Paste a string whose characters, AS KEYSTROKES, would answer the fail-closed floor ('y' = approve-once,
    // 'a' = approve-always). ink 7 delivers the whole block to `usePaste`, which drops it behind the approval gate.
    stdin.write(bracketed('yaya'));
    await flush();
    await flush();

    // The floor is untouched: the approval is still pending and the awaiting promise has NOT resolved.
    expect(store.getSnapshot().approval).toBeDefined();
    expect(answered).toBeUndefined();
    // …and the pasted token did not leak into the (still-rendered) idle compose buffer either.
    expect(lastFrame()).not.toContain('yaya');
    unmount();
  });

  it('a REAL "y" keystroke DOES answer the pending approval (the floor is answerable — just not by paste)', async () => {
    const store = createChatStore(false);
    const { stdin, unmount } = mountChat(store);
    await flush();
    let answered: ApprovalAnswer | undefined;
    void store.requestApproval(approvalReq, false).then((a) => {
      answered = a;
    });
    await flush();
    stdin.write('y'); // a genuine keystroke on the `useInput` channel — NOT wrapped as a paste
    await flush();
    expect(answered).toEqual({ outcome: 'approve', scope: 'once' });
    expect(store.getSnapshot().approval).toBeUndefined();
    unmount();
  });
});

describe('ChatApp live-turn timer — 2.5.H frozen-clock regression', () => {
  it('advances the elapsed counter as the wall clock moves across ticks', async () => {
    // Fake ONLY `Date` so `Date.now()` is deterministic while `setImmediate` (our `flush()`) and ink's own internals
    // stay on real timers. The owner (`ChatApp`) reads `Date.now()` FRESH on every render — this pins that the live
    // counter tracks wall time, not a value frozen at turn start (the 2.5.H regression).
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-07-09T10:00:00.000Z'));
      const store = createChatStore(false);
      const { lastFrame, unmount } = mountChat(store);
      await flush();
      store.apply(turnStarted('2026-07-09T10:00:00.000Z')); // turnStartedAtMs = T0
      store.tick();
      await flush();
      expect(lastFrame()).toContain('Working… 0s');

      // Advance the wall clock 3s and repaint. The store state is unchanged, so `tick()` (a running turn) is what
      // forces the re-render — and the owner must re-read `Date.now()` for the counter to move.
      vi.setSystemTime(new Date('2026-07-09T10:00:03.000Z'));
      store.tick();
      await flush();
      expect(lastFrame()).toContain('Working… 3s');
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChatApp render economy — perf guard', () => {
  it('a burst of idle ticks does not repaint (the store skips clean frames)', async () => {
    const store = createChatStore(false);
    const { frames, unmount } = mountChat(store);
    await flush();
    const baseline = frames.length;
    for (let i = 0; i < 20; i += 1) store.tick(); // 20 idle ticks — no dirty state, no running turn
    await flush();
    // `tick()` repaints ONLY when dirty or streaming; at idle it must not emit a frame per tick (else the frame loop
    // would thrash the terminal). Allow a single slack frame for a coalesced initial paint.
    expect(frames.length - baseline).toBeLessThanOrEqual(1);
    unmount();
  });
});
