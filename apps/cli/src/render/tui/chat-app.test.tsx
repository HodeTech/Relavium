import type { SessionStreamHandleEvent, ToolApprovalRequest } from '@relavium/core';
import { cleanup, render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalAnswer } from '../../chat/chat-mode.js';
import { createSuspendPort } from '../suspend.js';
import { ChatApp } from './chat-ink.js';
import { liveAnswerRowBudget } from './chat-projection.js';
import { COPIED_TOAST_MS } from './tui-constants.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { bracketed, settleFrames, waitFor } from './harness-util.js';

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
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const { lastFrame, stdin } = mountChat(store);
    const frame = (): string => lastFrame() ?? '';
    await waitFor(() => frame().length > 0);
    stdin.write(bracketed('hello world'));
    await waitFor(() => frame().includes('hello world'));
    expect(lastFrame()).toContain('hello world');
  });

  it('collapses CRLF/CR in a pasted block to LF (three lines survive, no stray carriage returns)', async () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
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
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
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
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
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
      const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
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
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
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
    expect(frames).toHaveLength(baseline);
  });
});

describe('ChatApp alt-screen transcript viewport (2.6.F Step 4b, ADR-0068 §c)', () => {
  // FULL-SCREEN bound, matching what production builds for an alt-screen store (`transcriptBoundFor(true)`). A store
  // built with the INLINE bound and then mounted with `alternateScreen` is a fixture that does not exist in
  // production — and it silently mis-tests the viewport (which is bound-sensitive, ADR-0068 (c)). The ChatView
  // tripwire now rejects that combination outright.
  const seed = (n: number): ChatStoreController => {
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    for (let i = 0; i < n; i += 1) store.appendUser(`MSG${i}`);
    return store;
  };

  const chatApp = (store: ChatStoreController): ReactElement => (
    <ChatApp
      store={store}
      alternateScreen
      onSubmit={async () => {}}
      shouldStop={() => false}
      onExit={() => {}}
      onError={() => {}}
      onModeChange={() => {}}
    />
  );

  /** Force the harness's (otherwise environment-derived) window size to a DETERMINISTIC value + fire ink 7's resize
   *  path, so `useWindowSize()` re-reads it — the harness `Stdout` has a hardcoded `columns` getter and NO `rows`
   *  (ink would otherwise fall through to `terminal-size` → the real `/dev/tty`, making a row-count assertion
   *  environment-dependent). Used to pin BOTH a stable size and the resize re-wrap/re-measure. */
  const setWindowSize = (
    stdout: ReturnType<typeof render>['stdout'],
    cols: number,
    rows: number,
  ): void => {
    Object.defineProperty(stdout, 'columns', { value: cols, configurable: true });
    Object.defineProperty(stdout, 'rows', { value: rows, configurable: true });
    stdout.emit('resize');
  };

  it('follows the tail: shows recent entries, drops the overflow off the top, bounded to the terminal rows', async () => {
    const h = render(chatApp(seed(40)));
    const frame = (): string => h.lastFrame() ?? '';
    setWindowSize(h.stdout, 80, 24); // a deterministic 24-row terminal
    await waitFor(() => frame().includes('MSG39')); // the viewport measures + windows to the tail
    expect(frame()).toContain('MSG39'); // the newest entry is shown (following the tail)
    expect(frame()).not.toContain('MSG0'); // the oldest scrolled off the top — the alt buffer has no scrollback
    expect(frame().split('\n').length).toBeLessThanOrEqual(24); // virtualized — bounded to the terminal rows
  });

  it('SCROLLS the transcript: PgUp leaves the tail (pauses follow), PgDn back to the bottom resumes it (Step 4b-2)', async () => {
    const h = render(chatApp(seed(60)));
    const frame = (): string => h.lastFrame() ?? '';
    // Each keypress is its own stdin event, as a real terminal delivers them — a concatenated escape burst in one
    // chunk is a harness artifact, not how PgUp/PgDn arrive, so settle between presses.
    const press = async (seq: string): Promise<void> => {
      h.stdin.write(seq);
      await settleFrames();
    };
    const PG_UP = '\x1b[5~';
    const PG_DOWN = '\x1b[6~';

    setWindowSize(h.stdout, 80, 12);
    await waitFor(() => frame().includes('MSG59')); // following the tail
    await settleFrames();
    expect(frame()).toContain('MSG59');

    // PgUp twice — scroll up off the tail; the newest entry leaves the window (following paused).
    await press(PG_UP);
    await press(PG_UP);
    expect(frame()).not.toContain('MSG59'); // scrolled up past the tail — the newest entry is off-screen

    // PgDn once — down a page but NOT yet to the bottom: a partial page-down must NOT resume follow.
    await press(PG_DOWN);
    expect(frame()).not.toContain('MSG59'); // still paused mid-page (the following↔paused boundary at the mount)

    // PgDn back down to the bottom — RESUMES following, so the tail is pinned again.
    await press(PG_DOWN);
    await press(PG_DOWN);
    expect(frame()).toContain('MSG59'); // back at the tail (following resumed on reaching the bottom)
  });

  it('does NOT scroll the transcript while the `/` palette owns the keyboard (overlay gate parity, Step 4b-2)', async () => {
    // Parity with the Home `noOverlay` gate: in `ChatApp` the overlays `return` ABOVE the scroll interception, so a
    // PgUp while the `/` palette is open reaches the PALETTE, never the transcript scroll reducer — else opening the
    // palette and paging would silently pause tail-follow behind the overlay. Following the tail, open the palette
    // (filtered to no match so it stays short), then PgUp: the tail must STAY put and the palette must stay open.
    const h = render(chatApp(seed(60)));
    const frame = (): string => h.lastFrame() ?? '';
    setWindowSize(h.stdout, 80, 24);
    await waitFor(() => frame().includes('MSG59'));
    await settleFrames();
    expect(frame()).toContain('MSG59'); // following the tail

    h.stdin.write('/'); // open the `/` command palette
    await settleFrames();
    for (const ch of 'zzz') {
      h.stdin.write(ch); // filter to NO match → the palette stays open but short (leaves the viewport tall)
      await settleFrames();
    }
    expect(frame()).toContain('Enter run'); // the palette overlay is open (its nav hint is on-screen)
    expect(frame()).toContain('MSG59'); // still following the tail

    h.stdin.write('\x1b[5~'); // PgUp — must be consumed by the palette, NOT the transcript scroll keymap
    await settleFrames();
    expect(frame()).toContain('Enter run'); // the palette still owns the keyboard
    expect(frame()).toContain('MSG59'); // the transcript did NOT scroll (follow was never paused behind the overlay)
  });

  it('Ctrl+Home jumps to the TOP (pauses follow), Ctrl+End resumes the tail (Step 4b-2)', async () => {
    const h = render(chatApp(seed(60)));
    const frame = (): string => h.lastFrame() ?? '';
    setWindowSize(h.stdout, 80, 12);
    await waitFor(() => frame().includes('MSG59'));
    await settleFrames();

    h.stdin.write('\x1b[1;5H'); // Ctrl+Home → jump to the very top (ink parses this to key.home + key.ctrl)
    await settleFrames();
    expect(frame()).toContain('MSG0'); // the oldest entry is now at the top
    expect(frame()).not.toContain('MSG59'); // the tail scrolled off the bottom (following paused)

    h.stdin.write('\x1b[1;5F'); // Ctrl+End → jump back to the tail (resume following)
    await settleFrames();
    expect(frame()).toContain('MSG59'); // back at the tail
    expect(frame()).not.toContain('MSG0'); // the top scrolled off
  });

  it('re-wraps + re-bounds the viewport on a terminal RESIZE (ink 7 useWindowSize — the Step-4b-1 Opus fix)', async () => {
    const h = render(chatApp(seed(40)));
    const frame = (): string => h.lastFrame() ?? '';
    setWindowSize(h.stdout, 80, 24);
    await waitFor(() => frame().split('\n').length === 24); // settled at 24 rows
    // Shrink the terminal: useWindowSize re-renders → the container re-bounds + the viewport re-measures to 10 rows.
    setWindowSize(h.stdout, 80, 10);
    await waitFor(() => frame().split('\n').length <= 10);
    expect(frame().split('\n').length).toBeLessThanOrEqual(10); // re-bounded to the NEW rows (was 24)
    expect(frame()).toContain('MSG39'); // still tail-following after the resize
    expect(frame()).not.toContain('MSG0');
  });

  it('RE-CLAMPS a PAUSED (non-tail) scroll offset when the terminal SHRINKS — no blank/garbled frame (Step 4b-3)', async () => {
    // A frozen offset valid at 24 rows can exceed maxOffset once the terminal shrinks. effectiveOffset/windowLines
    // clamp on every render, so a paused scroll must re-settle to a valid contiguous window (never a blank slice past
    // the end) and Ctrl+End must still resume the tail. Pins the resize re-clamp of a paused offset at the mount.
    const h = render(chatApp(seed(60)));
    const frame = (): string => h.lastFrame() ?? '';
    setWindowSize(h.stdout, 80, 24);
    await waitFor(() => frame().includes('MSG59'));
    await settleFrames();

    // Pause well up the transcript at the tall size (a large frozen offset), then shrink hard.
    h.stdin.write('\x1b[1;5H'); // Ctrl+Home → top (following paused, offset 0)
    await settleFrames();
    h.stdin.write('\x1b[6~'); // PgDn a page → a mid, non-tail frozen offset that was valid at 24 rows
    await settleFrames();
    expect(frame()).not.toContain('MSG59'); // paused, not at the tail

    setWindowSize(h.stdout, 80, 8); // shrink: maxOffset drops — the frozen offset must re-clamp, not blank out
    await waitFor(() => frame().split('\n').length <= 8);
    const shrunk = frame();
    expect(shrunk.split('\n').length).toBeLessThanOrEqual(8); // re-bounded to the new rows
    expect(shrunk).toMatch(/MSG\d+/); // a VALID contiguous slice is shown (not a blank past-the-end window)

    h.stdin.write('\x1b[1;5F'); // Ctrl+End still reaches the tail after the shrink+re-clamp
    await settleFrames();
    expect(frame()).toContain('MSG59');
  });

  it('MOUSE-WHEEL scrolls the transcript: wheel-up leaves the tail, wheel-down returns to it (Step 5)', async () => {
    const h = render(chatApp(seed(60)));
    const frame = (): string => h.lastFrame() ?? '';
    const wheel = async (button: number): Promise<void> => {
      h.stdin.write(`\x1b[<${button};10;5M`); // SGR mouse: 64 = wheel up, 65 = wheel down
      await settleFrames();
    };
    setWindowSize(h.stdout, 80, 12);
    await waitFor(() => frame().includes('MSG59'));
    await settleFrames();
    expect(frame()).toContain('MSG59'); // following the tail

    await wheel(64); // wheel up (WHEEL_LINES per notch)
    await wheel(64);
    expect(frame()).not.toContain('MSG59'); // scrolled up off the tail

    await wheel(65); // wheel down back toward the tail
    await wheel(65);
    await wheel(65);
    expect(frame()).toContain('MSG59'); // back at the tail (following resumed)
  });

  it('a mouse report behind an OPEN OVERLAY is consumed — never types into the palette filter, never scrolls (Step 5)', async () => {
    // The overlays `return` above the old mouse intercept, so a wheel used to reach `foldPaletteKey` and type into the
    // filter. It must be swallowed at the top of the handler; the wheel also must not scroll behind the overlay.
    const h = render(chatApp(seed(60)));
    const frame = (): string => h.lastFrame() ?? '';
    setWindowSize(h.stdout, 80, 24);
    await waitFor(() => frame().includes('MSG59'));
    await settleFrames();
    h.stdin.write('/'); // open the `/` palette
    await settleFrames();
    for (const ch of 'zzz') {
      h.stdin.write(ch); // filter to no match ⇒ the palette stays open but short
      await settleFrames();
    }
    expect(frame()).toContain('Enter run'); // the palette owns the keyboard

    h.stdin.write('\x1b[<64;10;5M'); // a wheel notch behind the overlay
    h.stdin.write('\x1b[<0;10;5M'); // …and a click
    await settleFrames();

    expect(frame()).toContain('Enter run'); // the palette is still open
    expect(frame()).not.toContain('<64;10'); // the mouse bytes did NOT enter the filter
    expect(frame()).not.toContain('<0;10');
    expect(frame()).toContain('MSG59'); // …and the transcript did not scroll behind the overlay
  });

  it('a MOUSE CLICK report is CONSUMED — its raw bytes never type into the prompt (Step 5)', async () => {
    const h = render(chatApp(seed(5)));
    const frame = (): string => h.lastFrame() ?? '';
    setWindowSize(h.stdout, 80, 24);
    await waitFor(() => frame().includes('MSG4'));
    h.stdin.write('\x1b[<0;10;5M'); // a left-click report (button 0) — must be swallowed, not typed
    await settleFrames();
    h.stdin.write('hi'); // a normal edit still works
    await settleFrames();
    expect(frame()).toContain('hi'); // the typed text landed…
    expect(frame()).not.toContain('[<0;10;5M'); // …and the click's raw bytes did NOT leak into the prompt
    expect(frame()).not.toContain('<0;10'); // (defensive: no fragment of the SGR report either)
  });

  it('the INLINE renderer (no alternateScreen) keeps EVERY entry via <Static> — the mode discriminator', async () => {
    // This one mounts INLINE on purpose (it is the mode discriminator), so it needs an INLINE-bound store — the
    // describe's `seed()` builds FULL-SCREEN ones for the alt-screen mounts around it.
    const inlineSeed = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    for (let i = 0; i < 40; i += 1) inlineSeed.appendUser(`MSG${i}`);
    const { lastFrame } = mountChat(inlineSeed); // inline: no alternateScreen prop
    const frame = (): string => lastFrame() ?? '';
    await waitFor(() => frame().includes('MSG39'));
    expect(frame()).toContain('MSG0'); // `<Static>` prints ALL entries (native scrollback) — the oldest survives
    expect(frame()).toContain('MSG39');
  });

  it('renders without crashing on an EMPTY transcript (the viewport has no rows, only the live region)', async () => {
    const h = render(chatApp(createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND)));
    const frame = (): string => h.lastFrame() ?? '';
    setWindowSize(h.stdout, 80, 24);
    await waitFor(() => frame().includes('/ for commands')); // the idle hint (live region) renders
    expect(frame()).toContain('/ for commands'); // no crash; the prompt/footer are shown below the empty viewport
  });

  it('a SINGLE entry taller than the window shows its BOTTOM rows (tail), bounded to the terminal', async () => {
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    const big = ['FIRSTLINE', ...Array.from({ length: 58 }, (_, i) => `mid${i}`), 'LASTLINE'].join(
      '\n',
    );
    store.appendUser(big); // one user entry of 60 logical lines — taller than the ~20-row viewport
    const h = render(chatApp(store));
    const frame = (): string => h.lastFrame() ?? '';
    setWindowSize(h.stdout, 80, 24);
    await waitFor(() => frame().includes('LASTLINE'));
    expect(frame()).toContain('LASTLINE'); // the bottom of the over-tall entry (the tail)
    expect(frame()).not.toContain('FIRSTLINE'); // the top of the entry scrolled off — no scrollback
    expect(frame().split('\n').length).toBeLessThanOrEqual(24);
  });

  /**
   * THE STREAMING ANSWER MUST NOT OVERFLOW THE FIXED-HEIGHT FRAME (2.6.F Step 6h, Sonnet review).
   *
   * The alt screen's root Box is `height: rows`, and ink clips the frame there. An unbounded busy line therefore does
   * not scroll — it COLLIDES with its siblings inside the box. Reproduced at 80x24 with a 900-character answer, well
   * under `MAX_LIVE_TOKEN_CHARS = 4000`, i.e. an ordinary response: the "Esc to stop" hint and the streamed text landed
   * on the SAME frame row, overwriting each other.
   */
  describe('ChatApp (alt screen) — the live streaming region is bounded', () => {
    const streaming = (store: ChatStoreController, chars: number): void => {
      store.apply({
        type: 'session:turn_started',
        sessionId: 's',
        sequenceNumber: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
      });
      store.apply({
        type: 'agent:token',
        sessionId: 's',
        sequenceNumber: 2,
        timestamp: '2026-01-01T00:00:01.000Z',
        token: 'y'.repeat(chars),
        model: 'm',
        nodeId: 'n',
      });
      store.flush();
    };

    it('the "Esc to stop" hint never shares a row with the streamed text', async () => {
      const store = seed(30);
      const h = render(chatApp(store));
      setWindowSize(h.stdout, 80, 24);
      await settleFrames();
      streaming(store, 2000);
      await settleFrames();

      const rows = (h.lastFrame() ?? '').split('\n');
      const hintRow = rows.find((r) => r.includes('Esc to stop'));
      expect(hintRow).toBeDefined();
      expect(hintRow?.trim()).toBe('Esc to stop'); // …and nothing else on it
      expect(rows.length).toBeLessThanOrEqual(24);
    });

    it('the streamed content occupies at most a THIRD of the terminal, and shows the newest text', async () => {
      const store = seed(30);
      const h = render(chatApp(store));
      setWindowSize(h.stdout, 80, 24);
      await settleFrames();
      streaming(store, 2000);
      await settleFrames();

      const rows = (h.lastFrame() ?? '').split('\n');
      const contentRows = rows.filter((r) => r.includes('yyyy'));
      expect(contentRows.length).toBeLessThanOrEqual(liveAnswerRowBudget(24));
      expect(rows.some((r) => r.includes('…'))).toBe(true); // the tail is marked
    });

    it('the transcript viewport still renders — the live region does not swallow the whole frame', async () => {
      const store = seed(30);
      const h = render(chatApp(store));
      setWindowSize(h.stdout, 80, 24);
      await settleFrames();
      streaming(store, 2000);
      await settleFrames();
      expect(h.lastFrame() ?? '').toContain('MSG29'); // the newest transcript entry is still visible
    });
  });
});

/**
 * The ADR-0068 §e suspend PORT (2.6.F Step 5d) — the repo's first React→core capability bridge. `suspendTerminal`
 * exists only inside a mounted ink tree, while the slash dispatch that runs `/scrollback` and `/edit` lives outside
 * it. These pin both halves: the port is filled while mounted and EMPTIED on unmount — the latter is what makes a
 * hatch say "needs an interactive terminal" between a `/clear` swap's unmount and the next mount, instead of calling
 * into a dead ink instance.
 */
describe('ChatApp — the suspend port (ADR-0068 §e)', () => {
  it('attaches a WORKING suspendTerminal while mounted, and detaches on unmount', async () => {
    const port = createSuspendPort();
    expect(port.current()).toBeUndefined();

    const h = render(
      <ChatApp
        store={createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND)}
        onSubmit={async () => {}}
        shouldStop={() => false}
        onExit={() => {}}
        onError={() => {}}
        onModeChange={() => {}}
        suspendPort={port}
      />,
    );
    await waitFor(() => port.current() !== undefined);
    const suspend = port.current();
    expect(suspend).toBeDefined();

    // It must be ink's REAL suspendTerminal, not a stub: drive a callback through it. ink 7 hands the method out
    // UNBOUND off its prototype, so this also pins that our method-call form never loses `this`.
    let ran = false;
    await suspend?.(() => {
      ran = true;
      return Promise.resolve();
    });
    expect(ran).toBe(true);

    h.unmount();
    await settleFrames();
    expect(port.current()).toBeUndefined(); // a dead ink instance is never left reachable
  });

  it('mounts fine with NO port (a driver/test that wires none) — the hatches degrade, nothing throws', async () => {
    const h = render(
      <ChatApp
        store={createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND)}
        onSubmit={async () => {}}
        shouldStop={() => false}
        onExit={() => {}}
        onError={() => {}}
        onModeChange={() => {}}
      />,
    );
    await settleFrames();
    expect(h.lastFrame()).toBeDefined();
  });
});

/**
 * Mouse SELECTION + copy-on-select (2.6.F Step 6), driven through REAL SGR bytes. The unit tests pin the parser, the
 * reducer, `cellAt` and the row splitting in isolation; this pins the WIRING — that a press/drag/release on the alt
 * screen reaches the reducer with the viewport's measured geometry, and that the release hands the clipboard exactly
 * the text the highlight covered.
 */
describe('ChatApp — mouse selection (ADR-0068 §e Step 6)', () => {
  /** Three one-row transcript lines: notices render as their bare text, so the wrapped rows are exactly these. */
  const seedThree = (): ChatStoreController => {
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    store.notice('AAAA');
    store.notice('BBBB');
    store.notice('CCCC');
    return store;
  };

  const mountWithClipboard = (
    store: ChatStoreController,
    copied: string[],
  ): ReturnType<typeof render> =>
    render(
      <ChatApp
        store={store}
        alternateScreen
        onSubmit={async () => {}}
        shouldStop={() => false}
        onExit={() => {}}
        onError={() => {}}
        onModeChange={() => {}}
        clipboard={(text) => {
          copied.push(text);
          return { kind: 'written', characters: text.length };
        }}
      />,
    );

  it('a DRAG across the first row copies exactly the cells it covered', async () => {
    const copied: string[] = [];
    const h = mountWithClipboard(seedThree(), copied);
    await waitFor(() => (h.lastFrame() ?? '').includes('AAAA'));

    h.stdin.write('\x1b[<0;1;1M'); // press at terminal row 1, column 1 ⇒ line 0, column 0
    await settleFrames();
    h.stdin.write('\x1b[<32;3;1M'); // drag to column 3 ⇒ column 2 (inclusive)
    await settleFrames();
    h.stdin.write('\x1b[<0;3;1m'); // release ⇒ copy
    await settleFrames();

    expect(copied).toEqual(['AAA']); // columns 0..2 of 'AAAA'
  });

  it('a MULTI-ROW drag copies first-partial + last-partial, newline-joined', async () => {
    const copied: string[] = [];
    const h = mountWithClipboard(seedThree(), copied);
    await waitFor(() => (h.lastFrame() ?? '').includes('CCCC'));

    h.stdin.write('\x1b[<0;3;1M'); // press line 0, column 2
    await settleFrames();
    h.stdin.write('\x1b[<32;2;3M'); // drag to line 2 ('CCCC'), column 1
    await settleFrames();
    h.stdin.write('\x1b[<0;2;3m');
    await settleFrames();

    // First row from column 2 to its end, the middle row whole, the last row to its INCLUSIVE end column.
    expect(copied).toEqual(['AA\nBBBB\nCC']);
  });

  it('a plain CLICK copies NOTHING — it only clears any prior highlight', async () => {
    const copied: string[] = [];
    const h = mountWithClipboard(seedThree(), copied);
    await waitFor(() => (h.lastFrame() ?? '').includes('AAAA'));

    h.stdin.write('\x1b[<0;2;2M');
    await settleFrames();
    h.stdin.write('\x1b[<0;2;2m'); // release at the same cell
    await settleFrames();

    expect(copied).toEqual([]);
  });

  it('the WHEEL still scrolls while drag reporting is on, and never starts a selection', async () => {
    const copied: string[] = [];
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    for (let i = 0; i < 60; i += 1) store.notice(`row-${i}`);
    const h = mountWithClipboard(store, copied);
    await waitFor(() => (h.lastFrame() ?? '').includes('row-59'));

    h.stdin.write('\x1b[<64;5;5M'); // wheel up
    await settleFrames();
    expect(h.lastFrame() ?? '').not.toContain('row-59'); // the tail scrolled away
    h.stdin.write('\x1b[<64;5;5m'); // a wheel "release" is `other`/release — must not copy
    await settleFrames();
    expect(copied).toEqual([]);
  });

  it('after SCROLLING, a drag copies the line now shown on that row — not line 0', async () => {
    // The reason `offset` is in the viewport facts at all. A break that hardcodes `offset: 0` passes every test that
    // never scrolls first, and then silently copies the wrong lines for any user who did. The drag stays on an INNER
    // row: row 1 is the edge-scroll zone (see the auto-scroll tests below), and this test is about `offset`, not that.
    const copied: string[] = [];
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    for (let i = 0; i < 60; i += 1) store.notice(`row-${String(i).padStart(2, '0')}`);
    const h = mountWithClipboard(store, copied);
    await waitFor(() => (h.lastFrame() ?? '').includes('row-59'));

    for (let i = 0; i < 4; i += 1) {
      h.stdin.write('\x1b[<64;5;5M'); // wheel up: leave the tail
      await settleFrames();
    }
    const thirdRow = (h.lastFrame() ?? '').split('\n')[2]?.trim();
    expect(thirdRow).toMatch(/^row-\d\d$/);
    expect(thirdRow).not.toBe('row-02'); // we really did scroll away from the head

    h.stdin.write('\x1b[<0;1;3M'); // press the THIRD viewport row (terminal row 3)
    await settleFrames();
    h.stdin.write('\x1b[<32;99;3M'); // drag past its right edge ⇒ the whole row
    await settleFrames();
    h.stdin.write('\x1b[<0;99;3m');
    await settleFrames();

    expect(copied).toEqual([thirdRow]); // exactly the line the user could SEE on that row
  });

  it('reduces against the LIVE transcript, not the last measured one (an append between commits)', async () => {
    // `onMeasure` lags by up to a commit. A drag on a row that only exists because of a just-appended line must still
    // select it — otherwise the reducer clamps to the stale last line and copies the row above.
    const copied: string[] = [];
    const store = seedThree();
    const h = mountWithClipboard(store, copied);
    await waitFor(() => (h.lastFrame() ?? '').includes('CCCC'));

    store.notice('DDDD'); // the ref still says 3 lines; the store says 4
    h.stdin.write('\x1b[<0;1;4M'); // press terminal row 4 ⇒ the new line
    h.stdin.write('\x1b[<32;4;4M');
    h.stdin.write('\x1b[<0;4;4m');
    await settleFrames();

    expect(copied).toEqual(['DDDD']); // NOT 'CCCC' — the stale clamp would have landed one row up
  });

  it('selects the WRAPPED visual rows, not the raw entries — a dragged second row is the line’s second half', async () => {
    // The viewport shows WRAPPED rows; the clipboard must index the same array. Copying from the raw transcript
    // entries instead passes every test whose lines are short enough never to wrap — and then mis-selects for anyone
    // whose model wrote a paragraph.
    const copied: string[] = [];
    const store = createChatStore(false, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    const long = 'x'.repeat(100) + 'TAIL'; // cols = 100 in the harness ⇒ wraps to two rows
    store.notice(long);
    const h = mountWithClipboard(store, copied);
    await waitFor(() => (h.lastFrame() ?? '').includes('TAIL'));

    h.stdin.write('\x1b[<0;1;2M'); // press the SECOND wrapped row
    await settleFrames();
    h.stdin.write('\x1b[<32;99;2M'); // drag to its end
    await settleFrames();
    h.stdin.write('\x1b[<0;99;2m');
    await settleFrames();

    expect(copied).toEqual(['TAIL']); // the continuation row, not the (nonexistent) second entry
  });

  it('mounts without a clipboard port: selection still highlights, copy is inert (no throw)', async () => {
    const h = render(
      <ChatApp
        store={seedThree()}
        alternateScreen
        onSubmit={async () => {}}
        shouldStop={() => false}
        onExit={() => {}}
        onError={() => {}}
        onModeChange={() => {}}
      />,
    );
    await waitFor(() => (h.lastFrame() ?? '').includes('AAAA'));
    h.stdin.write('\x1b[<0;1;1M');
    await settleFrames();
    h.stdin.write('\x1b[<32;3;1M');
    await settleFrames();
    h.stdin.write('\x1b[<0;3;1m');
    await settleFrames();
    expect(h.lastFrame()).toBeDefined();
  });

  /**
   * THE COPY-ON-SELECT CONFIRMATION TOAST (2.6.F Step 6i). Success was silent because the only notice channel —
   * `store.note` — appends a transcript entry that re-wraps and SHIFTS the lines just selected. The toast renders
   * OUTSIDE the transcript, so it confirms the copy without disturbing the selection.
   */
  describe('the "Copied" toast', () => {
    /** Drive a press-drag-release that copies, and return the frame right after. */
    const copyOnce = async (h: ReturnType<typeof render>): Promise<void> => {
      await waitFor(() => (h.lastFrame() ?? '').includes('AAAA'));
      h.stdin.write('\x1b[<0;1;1M');
      await settleFrames();
      h.stdin.write('\x1b[<32;3;1M');
      await settleFrames();
      h.stdin.write('\x1b[<0;3;1m');
      await settleFrames();
    };

    it('appears after a copy, ABOVE the footer, and does not touch the transcript', async () => {
      const copied: string[] = [];
      const h = mountWithClipboard(seedThree(), copied);
      await copyOnce(h);
      expect(copied).toHaveLength(1); // the write happened
      const rows = (h.lastFrame() ?? '').split('\n');
      const toastRow = rows.findIndex((r) => r.includes('Copied'));
      const footerRow = rows.findIndex((r) => r.includes('turns'));
      expect(toastRow).toBeGreaterThanOrEqual(0);
      expect(toastRow).toBeLessThan(footerRow); // the toast sits just above the status footer
      // The transcript entries are unchanged — the toast is not a transcript line.
      expect(rows.some((r) => r.includes('AAAA'))).toBe(true);
    });

    it('auto-dismisses after COPIED_TOAST_MS', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const copied: string[] = [];
        const h = mountWithClipboard(seedThree(), copied);
        await copyOnce(h);
        expect(h.lastFrame() ?? '').toContain('Copied');
        await vi.advanceTimersByTimeAsync(COPIED_TOAST_MS + 50);
        await settleFrames();
        expect(h.lastFrame() ?? '').not.toContain('Copied');
      } finally {
        vi.useRealTimers();
      }
    });

    it('a TOO-LARGE selection shows the transcript note, NOT the toast', async () => {
      const h = render(
        <ChatApp
          store={seedThree()}
          alternateScreen
          onSubmit={async () => {}}
          shouldStop={() => false}
          onExit={() => {}}
          onError={() => {}}
          onModeChange={() => {}}
          clipboard={() => ({ kind: 'too-large', base64Length: 120_000, limit: 74_994 })}
        />,
      );
      await copyOnce(h);
      const frame = h.lastFrame() ?? '';
      expect(frame).toContain('too large'); // the note
      expect(frame).not.toContain('✓ Copied'); // …not the success toast
    });

    it('WITHOUT a clipboard port (copy-on-select off) there is no toast', async () => {
      const h = render(
        <ChatApp
          store={seedThree()}
          alternateScreen
          onSubmit={async () => {}}
          shouldStop={() => false}
          onExit={() => {}}
          onError={() => {}}
          onModeChange={() => {}}
        />,
      );
      await copyOnce(h);
      expect(h.lastFrame() ?? '').not.toContain('Copied');
    });
  });
});
