import type { SessionStreamHandleEvent, ToolApprovalRequest } from '@relavium/core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalAnswer } from '../../chat/chat-mode.js';
import { ChatApp } from './chat-ink.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { bracketed, waitFor } from './harness-util.js';

/**
 * Mounted-`ChatApp` component tests (2.6.F Step 3, ADR-0068 part f) — the harness's first end-to-end renders of a
 * REAL surface component through ink-testing-library. Where `chat-input.test.ts` unit-tests the pure reducers and
 * `home-controller.test.ts` drives the ink-free controller, this file exercises the parts that ONLY exist once the
 * component is mounted under ink 7: the `usePaste` bracketed-paste channel (separate from `useInput`), the
 * `Date.now()`-per-render live timer, and the store→`useSyncExternalStore` repaint economy.
 *
 * The two load-bearing pins here:
 *   • SECURITY (ADR-0057) — a bracketed paste can neither ANSWER the fail-closed per-tool approval floor nor LEAK
 *     into the compose buffer. Two facets, two independent discriminators: (1) a LONE 'y' pasted during a pending
 *     approval — ink routes it to `usePaste` (dropped), never `useInput`; were the handler removed, ink's
 *     no-listener fallback re-emits 'y' to `useInput` and a lone 'y' WOULD answer the floor, so facet 1 fails iff
 *     the CHANNEL wiring regresses. (2) a distinctive token pasted during the same approval must not appear in the
 *     frame; were `ChatApp`'s own `approvalPending` gate regressed, the paste would insert and render, so facet 2
 *     fails iff the GATE regresses (independent of the channel).
 *   • 2.5.H frozen-clock — the live-turn elapsed counter tracks WALL time (re-read each render), not a value frozen
 *     at turn start.
 *
 * `afterEach(cleanup)` unmounts every mounted instance even when an assertion throws, so a failing test cannot leak
 * a live ink tree (with its store + stdin listeners) into the rest of the run. Frame assertions poll via
 * {@link waitFor} (never a fixed single yield) because React 19's commit can be deferred under load.
 */

afterEach(cleanup);

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

describe('ChatApp bracketed paste — ink-7 usePaste channel (ADR-0068)', () => {
  it('inserts an idle paste into the compose buffer', async () => {
    const store = createChatStore(false);
    const { lastFrame, stdin } = mountChat(store);
    const frame = (): string => lastFrame() ?? '';
    await waitFor(() => frame().length > 0);
    stdin.write(bracketed('hello world'));
    await waitFor(() => frame().includes('hello world'));
    expect(lastFrame()).toContain('hello world');
  });

  it('collapses CRLF/CR in a pasted block to LF (three lines survive, no stray carriage returns)', async () => {
    const store = createChatStore(false);
    const { lastFrame, stdin } = mountChat(store);
    const frame = (): string => lastFrame() ?? '';
    await waitFor(() => frame().length > 0);
    // Distinctive per-line tokens so the POSITIVE assertion is meaningful: `X1\r\nY2\rZ3` must normalize to
    // `X1\nY2\nZ3` — three rendered lines. Asserting each token is present rules out a dropped paste, and asserting
    // no CR survives rules out a no-op; together they distinguish real CR→LF from CR-stripping (which would join
    // the tokens onto fewer lines) and from an inserted-nothing regression (which the no-CR check alone would miss).
    stdin.write(bracketed('X1\r\nY2\rZ3'));
    await waitFor(() => frame().includes('Z3'));
    const shown = frame();
    expect(shown).toContain('X1');
    expect(shown).toContain('Y2');
    expect(shown).toContain('Z3');
    expect(shown).not.toContain('\r');
  });

  it('SECURITY: a pasted approval token cannot answer the fail-closed floor nor leak into the buffer (ADR-0057)', async () => {
    const store = createChatStore(false);
    const { lastFrame, stdin } = mountChat(store);
    const frame = (): string => lastFrame() ?? '';
    await waitFor(() => frame().length > 0);
    let answered: ApprovalAnswer | undefined;
    void store.requestApproval(approvalReq, false).then((a) => {
      answered = a;
    });
    await waitFor(() => store.getSnapshot().approval !== undefined);
    expect(store.getSnapshot().approval).toBeDefined(); // the prompt is up and owns the keyboard

    // Facet 1 — a LONE 'y' (the exact char that answers the floor via `useInput`) cannot ANSWER it: ink delivers it
    // to `usePaste`, dropped behind the gate. Give any erroneous answer a bounded window to manifest, then confirm.
    stdin.write(bracketed('y'));
    await waitFor(() => answered !== undefined || store.getSnapshot().approval === undefined, 12);
    expect(store.getSnapshot().approval).toBeDefined();
    expect(answered).toBeUndefined();

    // Facet 2 — a distinctive token cannot LEAK into the (still-rendered) compose buffer: the `approvalPending` gate
    // drops it. Give a leak a bounded window to render, then confirm it never appears.
    stdin.write(bracketed('zLEAKz'));
    await waitFor(() => frame().includes('zLEAKz'), 12);
    expect(lastFrame()).not.toContain('zLEAKz');
  });

  it('a REAL "y" keystroke DOES answer the pending approval (the floor is answerable — just not by paste)', async () => {
    const store = createChatStore(false);
    const { lastFrame, stdin } = mountChat(store);
    const frame = (): string => lastFrame() ?? '';
    await waitFor(() => frame().length > 0);
    let answered: ApprovalAnswer | undefined;
    void store.requestApproval(approvalReq, false).then((a) => {
      answered = a;
    });
    await waitFor(() => store.getSnapshot().approval !== undefined);
    stdin.write('y'); // a genuine keystroke on the `useInput` channel — NOT wrapped as a paste
    await waitFor(() => answered !== undefined);
    expect(answered).toEqual({ outcome: 'approve', scope: 'once' });
    expect(store.getSnapshot().approval).toBeUndefined();
  });
});

describe('ChatApp live-turn timer — 2.5.H frozen-clock regression', () => {
  it('advances the elapsed counter as the wall clock moves across ticks', async () => {
    // Fake ONLY `Date` so `Date.now()` is deterministic while `setImmediate` (the `waitFor` poll) and ink's own
    // internals stay on real timers. The owner (`ChatApp`) reads `Date.now()` FRESH on every render — this pins that
    // the live counter tracks wall time, not a value frozen at turn start (the 2.5.H regression).
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-07-09T10:00:00.000Z'));
      const store = createChatStore(false);
      const { lastFrame } = mountChat(store);
      const frame = (): string => lastFrame() ?? '';
      await waitFor(() => frame().length > 0);
      store.apply(turnStarted('2026-07-09T10:00:00.000Z')); // turnStartedAtMs = T0
      store.tick();
      await waitFor(() => frame().includes('Working… 0s'));
      expect(lastFrame()).toContain('Working… 0s');

      // Advance the wall clock 3s and repaint. The store state is unchanged, so `tick()` (a running turn) is what
      // forces the re-render — and the owner must re-read `Date.now()` for the counter to move.
      vi.setSystemTime(new Date('2026-07-09T10:00:03.000Z'));
      store.tick();
      await waitFor(() => frame().includes('Working… 3s'));
      expect(lastFrame()).toContain('Working… 3s');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChatApp render economy — perf guard', () => {
  it('idle ticks do not repaint — each tick is flushed separately so a per-tick over-flush would show', async () => {
    const store = createChatStore(false);
    const { frames } = mountChat(store);
    await waitFor(() => frames.length > 0);
    const baseline = frames.length;
    // Poll AFTER EACH tick (not one trailing yield) so every would-be repaint commits its OWN frame — mirroring the
    // real setInterval frame loop. A correct store `tick()`s at idle WITHOUT flushing (no dirty state, no running
    // turn), so React never schedules a commit and `frames` cannot grow — the equality is robust under any load. A
    // regressed store that flushed on every tick would add ~20 frames and fail here. `frames.length` is the
    // ink-testing-library debug-mode React-commit count (un-deduped), so it is an exact repaint counter. (The
    // synchronous-burst shape this replaces coalesced all 20 ticks into one commit, which masked the regression —
    // Step-3 Opus review.)
    for (let i = 0; i < 20; i += 1) {
      store.tick();
      await waitFor(() => frames.length > baseline, 3);
    }
    expect(frames.length).toBe(baseline);
  });
});
