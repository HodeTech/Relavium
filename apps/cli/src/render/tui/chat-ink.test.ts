import { describe, expect, it } from 'vitest';

import { finalizeInkExit } from './chat-ink.js';

/**
 * `finalizeInkExit` unit tests (2.6.F Step 4a, ADR-0068 §c) — the ORDERING contract the driveInk unmount-before-
 * summary reorder exists to establish. `driveInk` itself renders through the real ink `render` (untestable without a
 * TTY + a full SessionHandle — the suite injects `deps.drive` to bypass it), so the ordering logic is isolated here
 * where plain spies can pin it: a future refactor moving the summary back ahead of the teardown (silently losing it
 * into the torn-down alt buffer whenever alt-screen is on) would fail these.
 */
describe('finalizeInkExit — unmount-before-summary order (ADR-0068 §c)', () => {
  it('on a cooperative resolve: tears down (exits the alt screen) BEFORE writing the summary, then resolves', async () => {
    const calls: string[] = [];
    const outcome = await finalizeInkExit(Promise.resolve(), {
      teardown: () => calls.push('teardown'),
      writeSummary: () => calls.push('summary'),
      outcome: () => ({ kind: 'exit' }),
    });
    // Teardown (which unmounts ink → exits the alt buffer) must run first, so the summary lands on the PRIMARY buffer.
    expect(calls).toEqual(['teardown', 'summary']);
    expect(outcome).toEqual({ kind: 'exit' });
  });

  it('on a reject (an unexpected turn-core throw): tears down, SKIPS the summary + outcome, and propagates unchanged', async () => {
    const calls: string[] = [];
    const boom = new Error('turn-core exploded');
    await expect(
      finalizeInkExit(Promise.reject(boom), {
        teardown: () => calls.push('teardown'),
        writeSummary: () => calls.push('summary'),
        outcome: () => ({ kind: 'exit' }),
      }),
    ).rejects.toBe(boom); // the rejection propagates → the command maps it to exit 1 (pre-2.6.F behavior preserved)
    expect(calls).toEqual(['teardown']); // teardown ran; the summary was NOT written on the error path
  });

  it('forwards the resolved outcome kind (a /clear swap ⇒ the caller re-drives, no summary clutter)', async () => {
    // The `writeSummary` callback owns the /exit-only suppression (driveInk gates on stopReason); the helper just
    // sequences it. Here writeSummary is a no-op (a /clear swap) and the outcome kind is forwarded verbatim.
    const outcome = await finalizeInkExit(Promise.resolve(), {
      teardown: () => {},
      writeSummary: () => {},
      outcome: () => ({ kind: 'clear' }),
    });
    expect(outcome).toEqual({ kind: 'clear' });
  });
});
