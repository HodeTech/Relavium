import { describe, expect, it } from 'vitest';

import { finalizeInkExit, emitIntro } from './chat-ink.js';

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

/**
 * WHERE the intro goes (2.6.F Step 6g, whole-phase Opus review). The alt buffer has no scrollback and ink's first
 * frame is `height: rows`, so a pre-mount `writeOut` is painted over and gone. `/clear`'s notice carries
 * `relavium chat-resume <id>` — the ONLY pointer back to the conversation it just ended — and the default renderer
 * was throwing it away.
 */
describe('emitIntro — the renderer decides where the intro survives', () => {
  const ports = (): {
    notices: string[];
    outs: string[];
    notice: (t: string) => void;
    writeOut: (t: string) => void;
  } => {
    const notices: string[] = [];
    const outs: string[] = [];
    return { notices, outs, notice: (t) => notices.push(t), writeOut: (t) => outs.push(t) };
  };

  it('FULL-SCREEN: into the transcript, where the viewport keeps it', () => {
    const p = ports();
    emitIntro(
      'Started a fresh conversation. Resume the old one with `relavium chat-resume id-0`.',
      true,
      p,
    );
    expect(p.notices).toEqual([
      'Started a fresh conversation. Resume the old one with `relavium chat-resume id-0`.',
    ]);
    expect(p.outs).toEqual([]); // never a pre-mount write: the alt buffer erases it
  });

  it('INLINE: printed above the live region, with its newline — byte-identical to before', () => {
    const p = ports();
    emitIntro('Resumed session id-0 (3 turns).', false, p);
    expect(p.outs).toEqual(['Resumed session id-0 (3 turns).\n']);
    expect(p.notices).toEqual([]);
  });

  it('a FRESH session has no intro, and neither sink is touched', () => {
    for (const alt of [true, false]) {
      const p = ports();
      emitIntro(undefined, alt, p);
      expect(p.notices).toEqual([]);
      expect(p.outs).toEqual([]);
    }
  });
});
