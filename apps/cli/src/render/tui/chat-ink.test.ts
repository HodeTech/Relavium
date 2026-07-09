import { describe, expect, it } from 'vitest';

import { finalizeInkExit } from './chat-ink.js';

/**
 * `finalizeInkExit` unit tests (2.6.F Step 4a, refined at Step 4b-3, ADR-0068 §c) — the teardown-then-outcome
 * sequencing. `driveInk` itself renders through the real ink `render` (untestable without a TTY + a full
 * SessionHandle — the suite injects `deps.drive` to bypass it), so the sequencing is isolated here where plain spies
 * can pin it. At Step 4b-3 the end-of-session SUMMARY no longer writes here — the alt-buffer exit moved UP to the
 * hoisted `runReplLoop`, so the summary rides on the outcome (`summaryText`) and the loop prints it after the single
 * alt-exit. These pin that teardown runs before the outcome resolves, and is SKIPPED-of-outcome on a reject.
 */
describe('finalizeInkExit — teardown-before-outcome order (ADR-0068 §c)', () => {
  it('on a cooperative resolve: tears down (unmount) BEFORE resolving the outcome (which carries the summary)', async () => {
    const calls: string[] = [];
    const outcome = await finalizeInkExit(Promise.resolve(), {
      teardown: () => calls.push('teardown'),
      outcome: () => {
        calls.push('outcome');
        return { kind: 'exit', summaryText: 'session over' };
      },
    });
    expect(calls).toEqual(['teardown', 'outcome']); // teardown (unmount) first, then the outcome is read
    // The summary rides on the outcome — the hoisted runReplLoop prints it AFTER the single alt-exit (primary buffer).
    expect(outcome).toEqual({ kind: 'exit', summaryText: 'session over' });
  });

  it('on a reject (an unexpected turn-core throw): tears down, SKIPS the outcome, and propagates unchanged', async () => {
    const calls: string[] = [];
    const boom = new Error('turn-core exploded');
    await expect(
      finalizeInkExit(Promise.reject(boom), {
        teardown: () => calls.push('teardown'),
        outcome: () => {
          calls.push('outcome');
          return { kind: 'exit' };
        },
      }),
    ).rejects.toBe(boom); // the rejection propagates → the command maps it to exit 1 (pre-2.6.F behavior preserved)
    expect(calls).toEqual(['teardown']); // teardown ran; the outcome (and its summary) was NOT read on the error path
  });

  it('forwards the resolved outcome kind (a /clear swap ⇒ the caller re-drives, no summary)', async () => {
    const outcome = await finalizeInkExit(Promise.resolve(), {
      teardown: () => {},
      outcome: () => ({ kind: 'clear' }), // a /clear swap carries no summaryText
    });
    expect(outcome).toEqual({ kind: 'clear' });
  });
});
